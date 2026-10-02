import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(root, 'scripts/start.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map(); let sequence = 0;
createInterface({ input: child.stdout }).on('line', line => {
  const response = JSON.parse(line); pending.get(response.id)?.(response.result); pending.delete(response.id);
});
function call(name, args = {}) {
  return new Promise(resolve => { const id = ++sequence; pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });
}
try {
  const result = await call('harness_list');
  if (result.isError) throw new Error(result.content[0].text);
  const catalog = result.structuredContent;
  console.log(JSON.stringify({ total: catalog.targets.length, available: catalog.targets.filter(t => t.available).map(t => t.name), unavailable: catalog.targets.filter(t => !t.available).map(t => t.name) }));
  const models = await call('harness_models', { target: 'opencode' });
  console.log(JSON.stringify({ model_count: models.structuredContent?.models?.length, sample: models.structuredContent?.models?.slice(0,8), note: models.structuredContent?.note ?? models.content }));
  if (process.argv.includes('--smoke')) {
    const ids = models.structuredContent.models;
    const model = ids.find(id => id === 'opencode-go/deepseek-v4.1-flash');
    if (!model) throw new Error('expected model not returned by opencode; no smoke task dispatched');
    const started = await call('harness_start', { target: 'opencode', model, cwd: root,
      prompt: 'Read-only connection test. Do not use any tools, modify files, execute commands, or access the network. Reply with exactly HARNESS-PILOT-OK.', timeout_ms: 60000, transport: 'acp', notify_complete: false });
    if (started.isError) throw new Error(started.content[0].text);
    const task_id = started.structuredContent.task_id;
    console.log(JSON.stringify({ started: started.structuredContent }));
    let done = await call('harness_wait', { task_id, timeout_ms: 30000 });
    if (!done.structuredContent.ready) done = await call('harness_wait', { task_id, timeout_ms: 30000 });
    console.log(JSON.stringify({ progress: (await call('harness_progress', { task_id })).structuredContent }));
    console.log(JSON.stringify({ result: done.structuredContent }));
    if (done.structuredContent.status !== 'completed' || !done.structuredContent.result.text.includes('HARNESS-PILOT-OK')) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { child.stdin.end(); }
