import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

if (!process.argv.includes('--send') || !process.env.CODEX_THREAD_ID) {
  throw new Error('This test sends one completion receipt to the current Codex chat; --send and CODEX_THREAD_ID are required.');
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const report = process.env.HARNESS_PILOT_SMOKE_FILE;
const save = value => { if (report) writeFileSync(report, JSON.stringify(value, null, 2)); console.log(JSON.stringify(value)); };
const child = spawn(process.execPath, [join(root, 'server/index.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
let sequence = 0; const pending = new Map();
createInterface({ input: child.stdout }).on('line', line => {
  const response = JSON.parse(line); const request = pending.get(response.id);
  if (request) { clearTimeout(request.timer); pending.delete(response.id); request.resolve(response.result); }
});
const call = (name, args = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; const timer = setTimeout(() => reject(new Error('smoke RPC timeout')), 20000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name, arguments: args, _meta: { 'x-codex-turn-metadata': { thread_id: process.env.CODEX_THREAD_ID } },
  } }) + '\n');
});
try {
  const capability = await call('harness_callback_status');
  if (!capability.structuredContent?.available) throw new Error(JSON.stringify(capability));
  const models = await call('harness_models', { target: 'opencode', refresh: true });
  const model = 'opencode-go/deepseek-v4.1-flash';
  if (!models.structuredContent?.models.includes(model)) throw new Error('smoke model not returned by actual harness');
  const response = await call('harness_start', {
    target: 'opencode', model, cwd: root, transport: 'acp', timeout_ms: 60000, notify_complete: true,
    prompt: 'This is a read-only completion-callback connection test. Do not use tools, execute commands, modify files, or access the network. Reply with exactly: HARNESS-PILOT-CALLBACK-OK',
    continuation_instruction: '这是唯一一次自动唤醒验证。请读取回执对应结果，核对 completed、HARNESS-PILOT-CALLBACK-OK 及 callback 投递状态，确认同一会话自动续办。不要派发第二个测试任务。',
  });
  if (response.isError) throw new Error(response.content[0].text);
  save({ phase: 'dispatched', thread_id: process.env.CODEX_THREAD_ID, ...response.structuredContent });
  // Keep the MCP channel alive for delivery. No status/progress/wait polling occurs.
  setTimeout(() => child.stdin.end(), 90000);
} catch (error) {
  save({ phase: 'failed', error: error.message }); child.stdin.end(); process.exitCode = 1;
}
