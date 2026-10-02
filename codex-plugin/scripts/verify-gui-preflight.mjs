// Read-only verification against a fresh MCP process; never sends a GUI prompt.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(root, 'scripts/start.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let sequence = 0;
createInterface({ input: child.stdout }).on('line', line => {
  const reply = JSON.parse(line);
  pending.get(reply.id)?.(reply);
  pending.delete(reply.id);
});
async function call(name, args = {}) {
  const reply = await new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  if (reply.error || reply.result?.isError) throw new Error(JSON.stringify(reply));
  return reply.result.structuredContent;
}
try {
  const catalog = await call('harness_list');
  console.log(JSON.stringify({ plugin: catalog.plugin, total: catalog.targets.length }));
  for (const target of ['zcode', 'qoder-cn-app']) {
    const probe = await call('harness_probe', { target });
    console.log(JSON.stringify(probe));
    if (probe.ladder[0].available || !probe.ladder.find(entry => entry.transport === 'window')?.available) {
      process.exitCode = 1;
    }
  }
} finally {
  child.stdin.end();
}
