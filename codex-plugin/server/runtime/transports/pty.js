/**
 * pty 通道：在真正的伪终端（ConPTY）里跑交互式 harness，靠**文本**而不是像素来操控。
 *
 * 适用对象：只有全屏 TUI、没有一次性打印模式的 harness（写 prompt 进去 = 人敲键盘）。
 * 与 window 通道的区别：不碰窗口、不抢焦点、不依赖无障碍树；输出是原始 ANSI 流，
 * 这里用 @xterm/headless 把它还原成屏幕文本（可用时），否则退化为去 ANSI + 取尾部。
 *
 * 底层复用宿主已挂载的 `ctx.subprocess.spawnTerminal`（ConPTY + 整树回收），
 * 因此本插件不需要任何原生依赖。
 */
import { createRequire } from 'node:module';
import { buildArgv, probeCommand } from '../launcher.js';
import { stripAnsi } from '../text.js';
const COLS = 200;
const ROWS = 50;
/** 输出静默这么久，认为已经画完一屏。 */
const READY_QUIET_MS = 1500;
function loadScreenFactory() {
    try {
        const require = createRequire(import.meta.url);
        const module = require('@xterm/headless');
        const ctor = (module.Terminal ?? module.default?.Terminal);
        if (typeof ctor !== 'function')
            return undefined;
        return options => new ctor(options);
    }
    catch {
        return undefined;
    }
}
const screenFactory = loadScreenFactory();
export function probePty(target) {
    const probe = probeCommand(target.command);
    if (!probe.available)
        return { available: false, detail: probe.error };
    return {
        available: true,
        detail: `pty: ${probe.path}${screenFactory === undefined ? ' (no screen emulator: falling back to stripped raw output)' : ''}`,
    };
}
function renderScreen(screen) {
    if (screen === undefined)
        return '';
    const buffer = screen.buffer.active;
    const lines = [];
    for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        lines.push(line === undefined ? '' : line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1].trim().length === 0)
        lines.pop();
    return lines.join('\n');
}
/** 跑一次 pty 派发；永不 reject。 */
export async function dispatchPty(spec, spawnTerminal) {
    const started = Date.now();
    let argv;
    let resolved;
    try {
        const built = buildArgv(spec.target.command, [...spec.target.args, ...(spec.extraArgs ?? [])]);
        argv = built.argv;
        resolved = built.launcher.resolved;
    }
    catch (error) {
        return {
            transport: 'pty',
            text: '',
            diagnostic: error instanceof Error ? error.message : String(error),
            stopReason: 'error',
        };
    }
    const screen = screenFactory?.({ cols: COLS, rows: ROWS, scrollback: 4000, allowProposedApi: true });
    let raw = '';
    let lastOutputAt = Date.now();
    let delivered = false;
    let closed = false;
    let handle;
    try {
        handle = await spawnTerminal({
            argv,
            cwd: spec.cwd,
            env: { ...spec.target.env, TERM: 'xterm-256color' },
            rows: ROWS,
            cols: COLS,
            terminalType: 'xterm-256color',
            graceMs: 3000,
            signal: spec.signal,
        });
    }
    catch (error) {
        return {
            transport: 'pty',
            text: '',
            diagnostic: `cannot start a pty for "${spec.target.name}": ${error instanceof Error ? error.message : String(error)}`,
            stopReason: 'error',
        };
    }
    const feed = (chunk) => {
        raw += chunk;
        lastOutputAt = Date.now();
        try {
            screen?.write(chunk);
        }
        catch {
            // 屏幕模拟失败不影响原始文本回退
        }
        spec.onProgress?.(chunk);
    };
    handle.output.setEncoding?.('utf8');
    handle.output.on('data', (chunk) => { feed(chunk.toString()); });
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const waitQuiet = async (quietMs, deadline) => {
        for (;;) {
            if (closed)
                return true;
            if (Date.now() >= deadline)
                return false;
            if (Date.now() - lastOutputAt >= quietMs)
                return true;
            await sleep(120);
        }
    };
    const deadline = started + Math.max(2000, spec.timeoutMs);
    let stopReason = 'completed';
    let diagnostic;
    try {
        // 1) 等 TUI 画出首屏
        await waitQuiet(READY_QUIET_MS, Math.min(deadline, started + 30000));
        if (spec.signal.aborted) {
            stopReason = 'aborted';
        }
        else {
            // 2) 把 prompt 敲进去（多行按原样写入，TUI 自己处理换行）
            const text = spec.prompt.endsWith('\r') ? spec.prompt : `${spec.prompt}\r`;
            await handle.write(text);
            delivered = true;
            // 3) 等回答画完（静默 = 稳定）
            const settled = await waitQuiet(Math.max(1000, spec.target.window.settleMs), deadline);
            if (!settled) {
                stopReason = 'timeout';
                diagnostic = `pty run exceeded ${spec.timeoutMs}ms with output still arriving`;
            }
        }
    }
    catch (error) {
        stopReason = 'error';
        diagnostic = `pty interaction failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    finally {
        try {
            if (stopReason === 'aborted')
                await handle.signalForeground('SIGINT');
            await handle.terminate();
        }
        catch {
            // 已经退出
        }
        try {
            await Promise.race([handle.done, sleep(4000)]);
        }
        catch {
            // done 的失败不影响结果
        }
        closed = true;
    }
    if (spec.signal.aborted) stopReason = 'aborted';
    const screenText = renderScreen(screen).trim();
    const fallback = stripAnsi(raw).trim();
    const text = screenText.length > 0 ? screenText : fallback.slice(-12000);
    if (text.length === 0) {
        stopReason = stopReason === 'completed' ? 'error' : stopReason;
        diagnostic = (diagnostic === undefined ? '' : `${diagnostic}; `)
            + `the pty produced no readable text (harness "${spec.target.name}" may need the window channel instead)`;
    }
    return {
        transport: 'pty',
        text,
        ...(diagnostic === undefined ? {} : { diagnostic }),
        stopReason,
        facts: {
            command: resolved,
            pid: handle.pid,
            durationMs: Date.now() - started,
            delivered,
        },
    };
}
/** 打开一个长期存在的交互式 pty 会话（供 harness_open/harness_send 使用）。 */
export class PtySession {
    target;
    screen;
    handle;
    delivered = false;
    closed = false;
    buffer = '';
    constructor(target, screen, handle) {
        this.target = target;
        this.screen = screen;
        this.handle = handle;
    }
    static async open(target, options) {
        const { argv } = buildArgv(target.command, [...target.args]);
        const screen = screenFactory?.({ cols: COLS, rows: ROWS, scrollback: 4000, allowProposedApi: true });
        const handle = await options.spawnTerminal({
            argv,
            cwd: options.cwd,
            env: { ...target.env, TERM: 'xterm-256color' },
            rows: ROWS,
            cols: COLS,
            terminalType: 'xterm-256color',
            graceMs: 3000,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const session = new PtySession(target.name, screen, handle);
        handle.output.setEncoding?.('utf8');
        handle.output.on('data', (chunk) => {
            const text = chunk.toString();
            session.buffer += text;
            try {
                screen?.write(text);
            }
            catch {
                // 忽略渲染失败
            }
        });
        // 等首屏：先等到**有输出**，再等到输出静默（TUI 首帧常要 1s 以上，
        // 只按「静默」判断会在什么都没画的时候立刻返回空屏）。
        const deadline = Date.now() + 20000;
        let sawOutput = false;
        let lastLength = -1;
        for (;;) {
            await new Promise(resolve => setTimeout(resolve, 250));
            if (session.buffer.length > 0)
                sawOutput = true;
            const stable = sawOutput && session.buffer.length === lastLength;
            lastLength = session.buffer.length;
            if (stable || Date.now() > deadline)
                break;
        }
        return session;
    }
    get pid() {
        return this.handle.pid;
    }
    read() {
        const text = renderScreen(this.screen).trim();
        return { text: text.length > 0 ? text : stripAnsi(this.buffer).trim().slice(-12000), source: 'pty' };
    }
    async send(input) {
        if (input.text !== undefined && input.text.length > 0) {
            const payload = input.submit === false ? input.text : `${input.text}\r`;
            await this.handle.write(payload);
            this.delivered = true;
            return { note: `wrote ${input.text.length} chars to pty${input.submit === false ? '' : ' + Enter'}` };
        }
        return { note: 'nothing to send' };
    }
    hasDelivered() {
        return this.delivered;
    }
    get isClosed() {
        return this.closed;
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            await this.handle.terminate();
        }
        catch {
            // 已退出
        }
    }
}
//# sourceMappingURL=pty.js.map