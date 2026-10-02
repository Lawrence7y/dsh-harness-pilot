/**
 * 窗口助手客户端：常驻 python 子进程（python/hp_helper.py）的 NDJSON 客户端。
 *
 * 为什么用常驻进程：每次动作都要 import pyautogui / uiautomation（约 1s），
 * 常驻后单次调用降到毫秒级；进程崩了会自动重启并重试一次。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
function helperScriptPath() {
    return join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'hp_helper.py');
}
function pythonCandidates(configured) {
    const candidates = [];
    const trimmed = configured.trim();
    if (trimmed.length > 0)
        candidates.push(trimmed);
    try {
        const where = spawnSync('where.exe', ['python'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        for (const line of `${where.stdout ?? ''}`.split(/\r?\n/)) {
            const path = line.trim();
            if (path.length > 0)
                candidates.push(path);
        }
    }
    catch {
        // where.exe 不存在时忽略
    }
    candidates.push('python', 'py', 'python3');
    return [...new Set(candidates)];
}
export class WindowHelper {
    pythonPath;
    child = null;
    sequence = 0;
    waiting = new Map();
    startPromise = null;
    hello = null;
    lastError = '';
    constructor(pythonPath) {
        this.pythonPath = pythonPath;
    }
    info() {
        return this.hello;
    }
    start() {
        const script = helperScriptPath();
        const failures = [];
        for (const python of pythonCandidates(this.pythonPath)) {
            const probe = spawnSync(python, ['-c', 'import pyautogui, uiautomation, win32gui, PIL'], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 40000,
            });
            if (probe.error !== undefined || probe.status !== 0) {
                const detail = probe.error?.message ?? `${String(probe.stderr ?? '').trim().slice(0, 200)}`;
                failures.push(`${python}: exit ${String(probe.status)} ${detail}`);
                continue;
            }
            const child = spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            const hello = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('window helper did not announce itself within 30s')), 30000);
                const reader = createInterface({ input: child.stdout });
                reader.on('line', (line) => {
                    let message;
                    try {
                        message = JSON.parse(line);
                    }
                    catch {
                        return;
                    }
                    const id = message.id;
                    if (id !== undefined && this.waiting.has(id)) {
                        const settle = this.waiting.get(id);
                        this.waiting.delete(id);
                        settle(message);
                        return;
                    }
                    if (message.hello !== undefined) {
                        this.hello = message;
                        clearTimeout(timer);
                        resolve(message);
                    }
                });
            });
            child.stderr.on('data', (chunk) => {
                this.lastError = chunk.toString('utf8').slice(0, 400);
            });
            child.on('exit', () => {
                if (this.child === child) {
                    this.child = null;
                    this.hello = null;
                }
                for (const [id, settle] of this.waiting) {
                    this.waiting.delete(id);
                    settle({ ok: false, error: `window helper exited unexpectedly${this.lastError ? `: ${this.lastError}` : ''}` });
                }
            });
            this.child = child;
            return hello;
        }
        return Promise.reject(new Error('cannot start the window helper: no python interpreter with pyautogui + uiautomation + pywin32 + Pillow was found ('
            + `${failures.join('; ')}). Install them (pip install pyautogui uiautomation pywin32 pillow) or set config.pythonPath.`));
    }
    async ensure() {
        if (this.child !== null && this.hello !== null)
            return this.hello;
        if (this.startPromise === null) {
            this.startPromise = this.start().finally(() => {
                this.startPromise = null;
            });
        }
        return await this.startPromise;
    }
    /** 已启动则为 true；用于能力探测而不触发启动副作用。 */
    get running() {
        return this.child !== null && this.hello !== null;
    }
    async call(cmd, params = {}, timeoutMs = 30000) {
        await this.ensure();
        const child = this.child;
        if (child === null || child.stdin.destroyed)
            throw new Error('window helper is not running');
        const id = ++this.sequence;
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error(`window helper timed out after ${timeoutMs}ms (cmd=${cmd})`));
            }, timeoutMs);
            this.waiting.set(id, (reply) => {
                clearTimeout(timer);
                if (reply.ok)
                    resolve(reply);
                else
                    reject(new Error(String(reply.error ?? `window helper failed (cmd=${cmd})`)));
            });
            child.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`);
        });
    }
    async windows(includeInvisible = false) {
        const reply = await this.call('windows', { include_invisible: includeInvisible }, 30000);
        return (reply.windows ?? []);
    }
    async find(match, timeoutMs = 20000) {
        const reply = await this.call('find', {
            ...(match.title ? { title: match.title } : {}),
            ...(match.process ? { process: match.process } : {}),
            ...(match.pid !== undefined ? { pid: match.pid } : {}),
        }, timeoutMs);
        return (reply.windows ?? []);
    }
    /** 轮询等待窗口出现（带面积门槛，避免抓到 0x0 的隐藏窗口）。 */
    async waitForWindow(match, timeoutMs = 20000) {
        const deadline = Date.now() + Math.max(500, timeoutMs);
        for (;;) {
            const found = await this.find(match, Math.max(2000, Math.min(8000, deadline - Date.now())));
            const usable = found.find(window => (window.rect?.width ?? 0) > 40 && (window.rect?.height ?? 0) > 40);
            if (usable !== undefined)
                return usable;
            if (Date.now() >= deadline)
                return undefined;
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }
    async focus(hwnd) {
        const reply = await this.call('focus', { hwnd }, 20000);
        return { focused: Boolean(reply.focused) };
    }
    async text(hwnd, options = {}) {
        const reply = await this.call('text', {
            hwnd,
            ...(options.pid !== undefined ? { pid: options.pid } : {}),
            ...(options.mode !== undefined ? { mode: options.mode } : {}),
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
        }, 45000);
        return { text: String(reply.text ?? ''), source: String(reply.source ?? 'none'), ...(reply.note !== undefined ? { note: String(reply.note) } : {}) };
    }
    async shot(path, options = {}) {
        const reply = await this.call('shot', {
            path,
            ...(options.hwnd !== undefined ? { hwnd: options.hwnd } : {}),
            ...(options.region !== undefined ? { region: options.region } : {}),
            ...(options.maxWidth !== undefined ? { max_width: options.maxWidth } : {}),
        }, 45000);
        return { path: String(reply.path), width: Number(reply.width), height: Number(reply.height), region: reply.region };
    }
    async type(text) {
        await this.call('type', { text }, 120000);
    }
    async key(keys, repeats = 1) {
        await this.call('key', { keys, repeats }, 30000);
    }
    async click(x, y, options = {}) {
        await this.call('click', { x, y, ...options }, 30000);
    }
    async launch(spec) {
        const reply = await this.call('launch', {
            command: spec.command,
            mode: spec.mode ?? 'terminal',
            ...(spec.title !== undefined ? { title: spec.title } : {}),
            ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
            ...(spec.waitMs !== undefined ? { wait_ms: spec.waitMs } : {}),
        }, Math.max(30000, (spec.waitMs ?? 20000) + 15000));
        return { pid: Number(reply.pid), host: String(reply.host ?? ''), window: (reply.window ?? null) };
    }
    async close(hwnd) {
        await this.call('close', { hwnd }, 15000);
    }
    /** 定位并点中窗口里的输入框；找不到返回 found:false（不算错误，调用方退化到直接打字）。 */
    async focusInput(hwnd, options = {}) {
        const reply = await this.call('input', {
            hwnd,
            ...(options.name !== undefined && options.name.length > 0 ? { name: options.name } : {}),
            ...(options.settleMs !== undefined ? { settle_ms: options.settleMs } : {}),
        }, 30000);
        return {
            found: Boolean(reply.found),
            ...(reply.element !== undefined ? { element: reply.element } : {}),
            ...(reply.clicked !== undefined ? { clicked: reply.clicked } : {}),
            ...(reply.reason !== undefined ? { reason: String(reply.reason) } : {}),
        };
    }
    /** 按可见名字点击窗口内元素（UIA）：打开面板、点「新建任务」这类按钮。 */
    async clickByName(hwnd, name, options = {}) {
        const reply = await this.call('click_name', {
            hwnd,
            name,
            ...(options.kind !== undefined ? { kind: options.kind } : {}),
            ...(options.settleMs !== undefined ? { settle_ms: options.settleMs } : {}),
        }, 45000);
        return {
            found: Boolean(reply.found),
            ...(reply.element !== undefined ? { element: reply.element } : {}),
            ...(reply.clicked !== undefined ? { clicked: reply.clicked } : {}),
            ...(reply.reason !== undefined ? { reason: String(reply.reason) } : {}),
            ...(reply.alternatives !== undefined ? { alternatives: reply.alternatives } : {}),
        };
    }
    /** 列出窗口内的可交互元素（诊断用；失败不抛错）。 */
    async elements(hwnd, options = {}) {
        const reply = await this.call('elements', {
            hwnd,
            ...(options.kind !== undefined ? { kind: options.kind } : {}),
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
        }, 45000);
        return (reply.selected ?? []);
    }
    dispose() {
        const child = this.child;
        this.child = null;
        this.hello = null;
        if (child !== null) {
            try {
                child.stdin.end();
            }
            catch {
                // 已关闭
            }
            try {
                child.kill();
            }
            catch {
                // 已退出
            }
        }
    }
}
