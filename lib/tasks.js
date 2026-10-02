/**
 * 异步任务管理：把一次 harness 派发放到后台跑，落盘进度/结果，
 * 并在**终态时主动回执**——把交付内容送回发起的 DSH 会话并唤醒它继续任务。
 *
 * 形状与 Codex 版 harness-pilot 的 TaskManager 对齐（`.json` / `.log` / `.result.json`
 * 三件套、`callback.status` 状态机），方便两侧工具互通；差别是回执不是走
 * Codex desktop 的 `send_message_to_thread`，而是走 DSH 侧的会话唤醒（见 wake.ts）。
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
const TERMINAL = new Set(['completed', 'error', 'timeout', 'aborted', 'interrupted']);
export class TaskManager {
    directory;
    dispatch;
    onComplete;
    log;
    tasks = new Map();
    events = new EventEmitter();
    maxConcurrent;
    constructor(deps) {
        this.directory = deps.directory;
        this.dispatch = deps.dispatch;
        this.onComplete = deps.onComplete;
        this.maxConcurrent = Math.max(1, Math.round(deps.maxConcurrent));
        this.log = deps.log ?? (() => { });
        this.events.setMaxListeners(64);
        mkdirSync(this.directory, { recursive: true });
    }
    setMaxConcurrent(value) {
        this.maxConcurrent = Math.max(1, Math.round(value));
    }
    path(id, suffix) {
        if (!/^[0-9a-f-]{36}$/.test(id))
            throw new Error('invalid task_id');
        return join(this.directory, id + suffix);
    }
    save(task) {
        writeFileSync(this.path(task.id, '.json'), JSON.stringify(this.view(task), null, 2), { encoding: 'utf8' });
    }
    view(task) {
        return {
            task_id: task.id,
            target: task.target,
            model: task.model,
            cwd: task.cwd,
            ...(task.transport === undefined ? {} : { transport: task.transport }),
            status: task.status,
            created_at: task.createdAt,
            updated_at: task.updatedAt,
            elapsed_ms: (TERMINAL.has(task.status) ? task.updatedAt : Date.now()) - task.createdAt,
            log_path: this.path(task.id, '.log'),
            result_path: this.path(task.id, '.result.json'),
            output_chars: task.outputChars,
            progress_available: task.outputChars > 0,
            diagnostic: task.diagnostic ?? null,
            callback: task.callback,
        };
    }
    /** 立即返回任务视图；真正的派发在后台跑，终态触发回执。 */
    start(input) {
        const running = [...this.tasks.values()].filter(task => !TERMINAL.has(task.status)).length;
        if (running >= this.maxConcurrent) {
            throw new Error(`harness task concurrency limit reached (${this.maxConcurrent}); wait or harness_task_cancel`);
        }
        if (!isAbsolute(input.cwd) || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) {
            throw new Error('cwd must be an existing absolute directory');
        }
        const task = {
            id: randomUUID(),
            target: input.target.name,
            model: input.model ?? null,
            cwd: input.cwd,
            ...(input.transport === undefined ? {} : { transport: input.transport }),
            status: 'running',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            outputChars: 0,
            controller: new AbortController(),
            callback: { ...input.callback, status: 'pending' },
            result: null,
        };
        this.tasks.set(task.id, task);
        writeFileSync(this.path(task.id, '.log'), '', { encoding: 'utf8' });
        this.save(task);
        // start 的返回不等派发；这个 promise 由 TaskManager 持有，终态时自己收尾。
        task.promise = this.run(task, input);
        return this.view(task);
    }
    async run(task, input) {
        let result = null;
        let timedOut = false;
        const deadline = setTimeout(() => {
            timedOut = true;
            task.controller.abort();
        }, Math.max(1000, input.timeoutMs));
        try {
            result = await this.dispatch({
                target: input.target,
                prompt: input.prompt,
                cwd: task.cwd,
                signal: task.controller.signal,
                timeoutMs: input.timeoutMs,
                ...(input.model === undefined ? {} : { model: input.model }),
                ...(input.extraArgs === undefined ? {} : { extraArgs: input.extraArgs }),
                onProgress: (chunk) => {
                    try {
                        appendFileSync(this.path(task.id, '.log'), chunk, { encoding: 'utf8' });
                    }
                    catch { /* 落盘失败不影响派发 */ }
                    task.outputChars += chunk.length;
                    task.updatedAt = Date.now();
                    this.events.emit(task.id);
                },
            }, input.transport === undefined ? {} : { transport: input.transport });
            task.transport = result.transport;
            if (result.stopReason === 'completed' && result.text.trim().length === 0) {
                task.status = 'error';
                task.diagnostic = 'harness returned no result';
            }
            else {
                task.status = result.stopReason;
                task.diagnostic = result.diagnostic;
            }
        }
        catch (error) {
            task.status = task.controller.signal.aborted ? 'aborted' : 'error';
            task.diagnostic = error instanceof Error ? error.message : String(error);
            result = { stopReason: task.status, text: '', transport: 'headless', diagnostic: task.diagnostic };
        }
        clearTimeout(deadline);
        if (timedOut && task.status !== 'completed') {
            task.status = 'timeout';
            task.diagnostic = 'task deadline exceeded';
            if (result === null)
                result = { stopReason: 'timeout', text: '', transport: 'headless', diagnostic: task.diagnostic };
        }
        task.updatedAt = Date.now();
        task.result = {
            stopReason: task.status,
            text: result?.text ?? '',
            ...(result?.transport === undefined ? {} : { transport: result.transport }),
            ...(result?.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
            ...(result?.facts === undefined ? {} : { facts: result.facts }),
        };
        try {
            writeFileSync(this.path(task.id, '.result.json'), JSON.stringify(task.result, null, 2), { encoding: 'utf8' });
        }
        catch { /* 结果文件写失败不挡回执 */ }
        this.save(task);
        this.events.emit(task.id);
        await this.deliver(task);
    }
    /** 终态回执：通知发起会话（失败只记录，不重发——重复唤醒比漏唤醒更糟）。 */
    async deliver(task) {
        const callback = task.callback;
        if (callback === null || !callback.notify)
            return;
        if (callback.sessionId.length === 0) {
            callback.status = 'skipped';
            callback.error = 'no originating session to wake (session id was empty)';
            this.save(task);
            return;
        }
        if (this.onComplete === undefined) {
            callback.status = 'skipped';
            callback.error = 'no completion handler wired in this composition';
            this.save(task);
            return;
        }
        callback.status = 'sending';
        this.save(task);
        try {
            const receipt = await this.onComplete(this.view(task), callback, task.result);
            callback.status = 'delivered';
            callback.receipt = receipt;
            callback.deliveredAt = Date.now();
        }
        catch (error) {
            const err = error;
            callback.status = err.deliveryUncertain === true && err.explicitRejection !== true ? 'uncertain' : 'failed';
            callback.error = err instanceof Error ? err.message : String(error);
            this.log(`harness-pilot: completion receipt for ${task.id} -> ${callback.status}: ${callback.error}`);
        }
        this.save(task);
        this.events.emit(task.id);
    }
    status(id) {
        const task = this.tasks.get(id);
        if (task !== undefined)
            return this.view(task);
        let stored;
        try {
            stored = JSON.parse(readFileSync(this.path(id, '.json'), 'utf8'));
        }
        catch {
            throw new Error(`unknown task_id: ${id}`);
        }
        // 重启后诚实降级：上个进程没跑完的任务不当成还在跑，也不补发回执。
        if (stored.callback?.status === 'sending') {
            stored.callback = { ...stored.callback, status: 'uncertain', error: 'process ended during callback delivery; not resent' };
        }
        if (!TERMINAL.has(stored.status)) {
            return { ...stored, status: 'interrupted', diagnostic: 'harness-pilot process ended; task was not resumed' };
        }
        return stored;
    }
    list() {
        const ids = new Set(this.tasks.keys());
        try {
            for (const file of readdirSync(this.directory)) {
                if (file.endsWith('.json') && !file.endsWith('.result.json'))
                    ids.add(file.slice(0, -'.json'.length));
            }
        }
        catch { /* 目录刚建或不可读时只列内存里的 */ }
        return [...ids]
            .map(id => {
            try {
                return this.status(id);
            }
            catch {
                return null;
            }
        })
            .filter((view) => view !== null)
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, 100);
    }
    /** 进度：从 .log 里取一段（增量拉取用 offset）。 */
    progress(id, offset = 0, limit = 12000) {
        const status = this.status(id);
        let log = '';
        try {
            log = readFileSync(this.path(id, '.log'), 'utf8');
        }
        catch { /* 新任务可能还没有日志 */ }
        const text = log.slice(offset, offset + limit);
        return {
            ...status,
            text,
            offset,
            next_offset: offset + text.length,
            has_more: offset + text.length < log.length,
            progress_note: log.length > 0
                ? 'harness process output; may include snapshots or diagnostics'
                : 'no process output yet; no percentage can be inferred',
        };
    }
    /** 终态结果；没到终态时 ready=false。 */
    result(id) {
        const status = this.status(id);
        if (!TERMINAL.has(status.status))
            return { ...status, ready: false, result: null };
        const live = this.tasks.get(id);
        if (live?.result != null)
            return { ...status, ready: true, result: live.result };
        const path = this.path(id, '.result.json');
        if (!existsSync(path))
            return { ...status, ready: false, result: null };
        try {
            return { ...status, ready: true, result: JSON.parse(readFileSync(path, 'utf8')) };
        }
        catch {
            return { ...status, ready: false, result: null };
        }
    }
    cancel(id) {
        const task = this.tasks.get(id);
        if (task === undefined) {
            return { view: this.status(id), cancellation_requested: false };
        }
        if (TERMINAL.has(task.status)) {
            return { view: this.view(task), cancellation_requested: false };
        }
        task.controller.abort();
        return { view: this.view(task), cancellation_requested: true };
    }
    /** 等到终态（最多 timeoutMs），用于工具里的「等一小段再看」。 */
    async wait(id, timeoutMs = 30000) {
        if (TERMINAL.has(this.status(id).status))
            return this.result(id);
        await new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer);
                this.events.off(id, changed);
                resolve();
            };
            const changed = () => {
                if (TERMINAL.has(this.status(id).status))
                    finish();
            };
            const timer = setTimeout(finish, timeoutMs);
            this.events.on(id, changed);
            changed();
        });
        return this.result(id);
    }
    async shutdown() {
        const live = [...this.tasks.values()].filter(task => !TERMINAL.has(task.status));
        for (const task of live)
            task.controller.abort();
        await Promise.allSettled([...this.tasks.values()].map(task => task.promise ?? Promise.resolve()));
    }
}
//# sourceMappingURL=tasks.js.map