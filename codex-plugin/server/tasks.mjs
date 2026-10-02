import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';

const TERMINAL = new Set(['completed', 'error', 'timeout', 'aborted', 'interrupted']);
export class TaskManager {
  constructor({ directory, dispatch, maxConcurrent = 4, onComplete }) {
    this.directory = directory; this.dispatch = dispatch; this.maxConcurrent = maxConcurrent;
    this.tasks = new Map(); this.events = new EventEmitter();
    this.onComplete = onComplete;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  path(id, suffix) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid task_id');
    return join(this.directory, id + suffix);
  }
  save(task) {
    const data = this.view(task);
    writeFileSync(this.path(task.id, '.json'), JSON.stringify(data, null, 2), { mode: 0o600 });
  }
  view(task) {
    return { task_id: task.id, target: task.target, model: task.model ?? null, cwd: task.cwd,
      status: task.status, created_at: task.createdAt, updated_at: task.updatedAt,
      elapsed_ms: (TERMINAL.has(task.status) ? task.updatedAt : Date.now()) - task.createdAt, log_path: this.path(task.id, '.log'),
      result_path: this.path(task.id, '.result.json'), output_chars: task.outputChars,
      progress_available: task.outputChars > 0, diagnostic: task.diagnostic ?? null,
      callback: task.callback ?? null };
  }
  start(input) {
    if ([...this.tasks.values()].filter(task => !TERMINAL.has(task.status)).length >= this.maxConcurrent)
      throw new Error(`concurrency limit reached (${this.maxConcurrent})`);
    if (!isAbsolute(input.cwd) || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory())
      throw new Error('cwd must be an existing absolute directory on the MCP host');
    const task = { id: randomUUID(), target: input.target, model: input.model, cwd: input.cwd,
      status: 'running', createdAt: Date.now(), updatedAt: Date.now(), outputChars: 0,
      controller: new AbortController(), callback: input.callback ? { ...input.callback, status: 'pending' } : null };
    this.tasks.set(task.id, task);
    writeFileSync(this.path(task.id, '.log'), '', { mode: 0o600 }); this.save(task);
    // The start response is immediate; this promise is owned by the MCP process.
    task.promise = this.run(task, input);
    return this.view(task);
  }
  async run(task, input) {
    let result;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; task.controller.abort(); }, input.timeout_ms ?? 600000);
    try {
      result = await this.dispatch({ ...input, signal: task.controller.signal,
        onProgress: text => {
          appendFileSync(this.path(task.id, '.log'), text, { encoding: 'utf8', mode: 0o600 });
          task.outputChars += text.length; task.updatedAt = Date.now();
          this.events.emit(task.id);
        } });
      if (!['completed', 'error', 'timeout', 'aborted'].includes(result?.stopReason))
        throw new Error('harness did not return a recognized terminal state');
      task.status = result.stopReason;
      if (task.status === 'completed' && !result.text?.trim()) {
        task.status = 'error'; result = { ...result, stopReason: 'error', diagnostic: 'harness returned no result' };
      }
      task.diagnostic = result.diagnostic;
    } catch (error) {
      task.status = task.controller.signal.aborted ? 'aborted' : 'error';
      task.diagnostic = error.message;
      result = { stopReason: task.status, text: '', diagnostic: error.message };
    }
    clearTimeout(deadline);
    if (timedOut && task.status !== 'completed') {
      task.status = 'timeout'; task.diagnostic = 'task deadline exceeded';
      result = { ...result, stopReason: 'timeout', diagnostic: task.diagnostic };
    }
    task.updatedAt = Date.now();
    writeFileSync(this.path(task.id, '.result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    this.save(task); this.events.emit(task.id);
    if (task.callback && this.onComplete) {
      task.callback.status = 'sending'; this.save(task);
      try {
        task.callback.receipt = await this.onComplete(this.view(task), task.callback);
        task.callback.status = 'delivered'; task.callback.delivered_at = Date.now();
      } catch (error) {
        task.callback.status = error.deliveryUncertain && !error.explicitRejection ? 'uncertain' : 'failed';
        task.callback.error = error.message;
      }
      this.save(task); this.events.emit(task.id);
    }
  }
  status(id) {
    const task = this.tasks.get(id);
    if (task) return this.view(task);
    let stored;
    try { stored = JSON.parse(readFileSync(this.path(id, '.json'), 'utf8')); }
    catch { throw new Error(`unknown task_id: ${id}`); }
    if (stored.callback?.status === 'sending') stored.callback = { ...stored.callback, status: 'uncertain', error: 'MCP process ended during callback delivery; not resent' };
    // A restarted server never claims that an old process is still running or completed.
    if (!TERMINAL.has(stored.status)) return { ...stored, status: 'interrupted', diagnostic: 'MCP process ended; task was not resumed' };
    return stored;
  }
  progress(id, offset = 0, limit = 12000) {
    const status = this.status(id);
    const log = readFileSync(this.path(id, '.log'), 'utf8');
    const text = log.slice(offset, offset + limit);
    return { ...status, text, offset, next_offset: offset + text.length, has_more: offset + text.length < log.length,
      progress_note: log.length ? 'harness process output; may include snapshots or diagnostics' : 'no process output yet; no percentage can be inferred' };
  }
  result(id) {
    const status = this.status(id);
    if (!TERMINAL.has(status.status)) return { ...status, ready: false };
    const path = this.path(id, '.result.json');
    return { ...status, ready: existsSync(path), result: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null };
  }
  async wait(id, timeout = 30000) {
    if (TERMINAL.has(this.status(id).status)) return this.result(id);
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.events.off(id, changed); resolve(); };
      const changed = () => { if (TERMINAL.has(this.status(id).status)) finish(); };
      const timer = setTimeout(finish, timeout);
      this.events.on(id, changed);
      changed();
    });
    return this.result(id);
  }
  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) { const status = this.status(id); return { ...status, cancellation_requested: false }; }
    if (TERMINAL.has(task.status)) return { ...this.view(task), cancellation_requested: false };
    task.controller.abort();
    return { ...this.view(task), cancellation_requested: true };
  }
  async shutdown() {
    const live = [...this.tasks.values()].filter(task => !TERMINAL.has(task.status));
    live.forEach(task => task.controller.abort());
    await Promise.allSettled([...this.tasks.values()].map(task => task.promise));
  }
}
