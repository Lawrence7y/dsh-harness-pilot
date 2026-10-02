import { createInterface } from 'node:readline';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './runtime/config.js';
import { SessionRegistry } from './runtime/sessions.js';
import { WindowHelper } from './runtime/helper.js';
import { mechanismOf, switchModel, currentModelOf, listModelOptions } from './runtime/gui-models.js';
import { TaskManager } from './tasks.mjs';
import { loadPtyAdapter } from './pty-adapter.mjs';
import { CompletionCallback, originThread } from './callback.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const configPath = process.env.HARNESS_PILOT_CONFIG;
const raw = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
// Discover the current Codex executable instead of retaining a release hash.
if (process.platform === 'win32') {
  process.env.PATHEXT ??= '.COM;.EXE;.BAT;.CMD;.PS1';
  const home = process.env.USERPROFILE ?? homedir();
  const additional = [join(home, 'AppData', 'Local', 'agy', 'bin'), join(home, '.mimocode', 'bin')];
  process.env.PATH = [...additional, process.env.PATH ?? process.env.Path ?? ''].join(';');
  const bin = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  if (existsSync(bin)) {
    const paths = readdirSync(bin).map(dir => join(bin, dir, 'codex.exe')).filter(existsSync);
    if (paths.length) raw.targets = [{ name: 'codex', command: paths.at(-1) }, ...(raw.targets ?? [])];
  }
}
const config = resolveConfig(raw);
const helper = new WindowHelper(config.pythonPath);
const spawnTerminal = loadPtyAdapter();
const registry = new SessionRegistry({ config, helper, spawnTerminal,
  log: (level, message) => process.stderr.write(`[${level}] ${message}\n`) });
const guiLocks = new Set();
const completionCallback = new CompletionCallback();
const tasks = new TaskManager({ directory: process.env.HARNESS_PILOT_STATE_DIR ?? join(homedir(), '.harness-pilot', 'tasks'),
  maxConcurrent: raw.maxConcurrent ?? 4,
  onComplete: (task, callback) => completionCallback.deliver(task, callback),
  dispatch: async input => {
    const target = registry.target(input.target);
    const gui = ['cdp', 'window'].includes(target.transport);
    if (guiLocks.has(target.name)) throw new Error('this GUI harness already has an active task');
    if (gui) guiLocks.add(target.name);
    try {
      let transport = input.transport ?? 'auto';
      if (input.model && gui) {
        const session = await registry.open(target, { cwd: input.cwd, launch: true });
        if (!session.evaluate || !session.mouse) throw new Error('GUI model selection requires a CDP session with real mouse input');
        const report = await switchModel(session, input.model);
        if (!report.ok) throw new Error(`model selection failed: ${report.detail}`);
        input.onProgress(`[model] selected ${report.after}\n`);
        transport = 'cdp';
      } else if (input.model && !target.modelArgs.length && !target.acpArgs.length) {
        throw new Error('this harness does not support per-task model selection; no task was sent');
      }
      if (input.signal.aborted) return { transport, stopReason: 'aborted', text: '', diagnostic: 'cancelled before dispatch' };
      return await registry.dispatch({ target, prompt: input.prompt, cwd: input.cwd,
        signal: input.signal, timeoutMs: input.timeout_ms ?? target.timeoutMs,
        model: gui ? undefined : input.model, onProgress: input.onProgress, autoApprove: input.auto_approve === true }, { transport });
    } finally { if (gui) guiLocks.delete(target.name); }
  } });

const str = { type: 'string', minLength: 1 };
const bool = { type: 'boolean' };
const number = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const target = { target: str };
const id = { task_id: str };
const schemas = new Map();
const handlers = new Map();
function tool(name, description, properties, required, handler, readOnly = true) {
  const definition = { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: !readOnly } };
  schemas.set(name, definition); handlers.set(name, handler);
}
tool('harness_list', '列出本机 harness、可执行文件可用性和通道；命令存在不等于已登录或任务必定可执行。', {}, [], async () => {
    const overview = await registry.overview({ models: false });
  return { ...overview, plugin: { name: 'harness-pilot', version: pluginVersion }, backend: 'standalone-local', pty_available: Boolean(spawnTerminal),
    dependencies: 'ACP/CDP optional; window requires Python packages; PTY uses optional installed node-pty',
    targets: overview.targets.map(entry => ({ ...entry,
      model_selection: ['cdp', 'window'].includes(entry.transport) ? 'GUI via CDP (verify at runtime)' : entry.canSelectModel ? 'CLI/ACP' : 'unsupported' })) };
});
tool('harness_probe', '只读探测指定 harness 各通道，不发送任务、不启动 GUI。', target, ['target'], async args => {
  const entry = registry.target(args.target); const ladder = [];
  for (const transport of entry.order) ladder.push({ transport, ...await registry.preflight(transport, entry) });
  return { target: entry.name, ladder };
});
tool('harness_models', '查询 harness 自己声明的模型列表与选择机制；目录不保证当前账号有权限。GUI 可读取已连接会话的可见模型。',
  { ...target, refresh: bool, session_id: str }, ['target'], async args => {
    const entry = registry.target(args.target);
    if (args.refresh) registry.clearModelCache();
    if (args.session_id) {
      const session = registry.get(args.session_id);
      if (!session || session.target.name !== entry.name || !session.evaluate) throw new Error('matching CDP session required');
      const visible = await listModelOptions(session);
      return { target: entry.name, current_model: await currentModelOf(session), visible,
        note: 'only currently visible options; closed menus may yield no models' };
    }
    return { target: entry.name, ...await registry.targetModels(entry), mechanism: mechanismOf(entry) };
  });
tool('harness_start', '启动外部子代理后台任务并立即返回 task_id。默认完成时主动回执唤醒原 Codex 会话，无需轮询；原会话先检查工作再按用户目标继续。仅用户要求手动等待时 notify_complete=false。auto_approve 仅控制 ACP allow_once。',
  { ...target, prompt: str, cwd: str, model: str, transport: { type: 'string', enum: ['auto', 'acp', 'headless', 'pty', 'cdp', 'window'] },
    timeout_ms: number(1000, 7200000), auto_approve: bool, notify_complete: bool, continuation_instruction: str }, ['target', 'prompt', 'cwd'], async (args, context = {}) => {
    registry.target(args.target);
    if (Buffer.byteLength(args.prompt) > 1048576) throw new Error('prompt exceeds 1 MiB');
    const notify = args.notify_complete ?? (process.env.HARNESS_PILOT_CALLBACKS !== '0');
    let callback;
    if (notify) {
      const threadId = originThread(context.metadata);
      if (!threadId) throw new Error('origin Codex thread metadata missing; no task dispatched. Use notify_complete=false for manual mode.');
      await completionCallback.check();
      callback = { thread_id: threadId, instruction: args.continuation_instruction ?? null };
    }
    return tasks.start({ ...args, callback });
  }, false);
tool('harness_callback_status', '只读检查原会话 ID 和桌面完成回执通道；不发消息、不启动任务。', {}, [], async (_args, context = {}) => {
  const threadId = originThread(context.metadata);
  if (!threadId) return { available: false, diagnostic: 'origin thread metadata missing' };
  try { return { ...await completionCallback.check(), thread_id: threadId, mode: 'completion-event', requires_polling: false }; }
  catch (error) { return { available: false, thread_id: threadId, diagnostic: error.message }; }
});
tool('harness_status', '读取后台任务状态；不把超时、失败或进程中断当作成功。', id, ['task_id'], args => tasks.status(args.task_id));
tool('harness_progress', '按字符游标读取增量过程输出；部分 harness 仅在结束时输出，不伪造百分比。',
  { ...id, offset: number(0, Number.MAX_SAFE_INTEGER), limit: number(1, 50000) }, ['task_id'], args => tasks.progress(args.task_id, args.offset, args.limit));
tool('harness_result', '读取终态结果。长正文分页，完整原始结果保存于 result_path。',
  { ...id, offset: number(0, Number.MAX_SAFE_INTEGER), limit: number(1, 50000) }, ['task_id'], args => pageResult(tasks.result(args.task_id), args));
tool('harness_wait', '最多等待 60 秒直到任务终止；运行中返回 ready=false，可继续等待或读取进度。',
  { ...id, timeout_ms: number(0, 60000) }, ['task_id'], async args => pageResult(await tasks.wait(args.task_id, args.timeout_ms), {}));
tool('harness_cancel', '请求取消任务；以随后读取到的终态为准。GUI 取消停止本插件监测，远端生成可能需要在产品中停止。',
  id, ['task_id'], args => tasks.cancel(args.task_id), false);
tool('harness_tasks', '列出本 MCP 进程派发的任务；旧任务可凭 task_id 从磁盘读取。', {}, [], () => ({ tasks: [...tasks.tasks.values()].map(task => tasks.view(task)) }));
tool('harness_open', '打开或连接一个 GUI 会话。仅在用户要求使用该 harness 时调用；model 会实际操作其选择器并验证选中值。',
  { ...target, cwd: str, model: str, launch: bool }, ['target', 'cwd'], async args => {
    if (guiLocks.has(args.target)) throw new Error('GUI harness is busy');
    const session = await registry.open(registry.target(args.target), { cwd: args.cwd, launch: args.launch !== false });
    let selection;
    if (args.model) {
      if (!session.evaluate || !session.mouse) throw new Error('model selection requires CDP');
      selection = await switchModel(session, args.model);
      if (!selection.ok) throw new Error(`model selection failed: ${selection.detail}`);
    }
    return { ...session.summary, session_id: session.id, model_selection: selection,
      current_model: session.evaluate ? await currentModelOf(session) : null };
  }, false);
tool('harness_read', '只读获取已连接 GUI/终端会话的当前屏幕文本；屏幕文本不代表任务完成。',
  { session_id: str, limit: number(1, 50000) }, ['session_id'], async args => {
    const session = registry.get(args.session_id); if (!session) throw new Error('unknown session_id');
    return { session_id: session.id, ...await session.read({ limit: args.limit ?? 12000 }) };
  });
tool('harness_send', '向已有真实 GUI/终端会话发送文本。仅在用户授权派发时使用；会影响产品当前会话。',
  { session_id: str, text: str, submit: bool }, ['session_id', 'text'], async args => {
    const session = registry.get(args.session_id); if (!session) throw new Error('unknown session_id');
    if (guiLocks.has(session.target.name)) throw new Error('GUI harness is busy');
    return { session_id: session.id, ...await session.send({ text: args.text, submit: args.submit !== false }) };
  }, false);

function pageResult(value, args) {
  if (!value.result) return value;
  const text = value.result.text ?? ''; const offset = args.offset ?? 0; const limit = args.limit ?? 12000;
  return { ...value, result: { ...value.result, text: text.slice(offset, offset + limit) }, offset,
    next_offset: Math.min(text.length, offset + limit), total_chars: text.length, has_more: offset + limit < text.length };
}
function validate(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  for (const key of schema.required) if (!(key in args)) throw new Error(`missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key]; if (!field) throw new Error(`unknown argument: ${key}`);
    if (field.type === 'string' && (typeof value !== 'string' || !value.trim())) throw new Error(`${key} must be non-empty text`);
    if (field.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
    if (field.type === 'integer' && (!Number.isSafeInteger(value) || value < field.minimum || value > field.maximum)) throw new Error(`${key} outside allowed range`);
    if (field.enum && !field.enum.includes(value)) throw new Error(`invalid ${key}`);
  }
}
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
async function handle(message) {
  if (message.id === undefined) return;
  const respond = result => send({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': {
      const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
      respond({ protocolVersion: versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'harness-pilot', version: pluginVersion } }); break;
    }
    case 'ping': respond({}); break;
    case 'tools/list': respond({ tools: [...schemas.values()] }); break;
    case 'tools/call': {
      const name = message.params?.name; const definition = schemas.get(name);
      if (!definition) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool' } }); break; }
      try {
        const args = message.params.arguments ?? {}; validate(definition.inputSchema, args);
        const result = await handlers.get(name)(args, { metadata: message.params._meta ?? {} });
        respond({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) { respond({ isError: true, content: [{ type: 'text', text: error.message }] }); }
      break;
    }
    default: send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
}
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(0), 5000); deadline.unref();
  await tasks.shutdown();
  await registry.disposeAll(); helper.dispose(); process.exit(0);
}
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', line => {
  let message;
  try { message = JSON.parse(line); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'invalid request' } }); return;
  }
  handle(message).catch(error => process.stderr.write(error.stack + '\n'));
});
reader.on('close', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
