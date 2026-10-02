import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function client(t) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-pilot-test-'));
  const fixture = join(directory, 'worker.mjs');
  writeFileSync(fixture, `
    const prompt = process.argv.at(-1);
    console.log('progress 中文 ' + JSON.stringify(process.argv.slice(2)));
    if (prompt === 'FAIL') { console.log('partial result'); process.exit(7); }
    setTimeout(() => { console.log('FINAL 中文'); }, prompt === 'WAIT' ? 30000 : 180);
  `);
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ targets: [{ name: 'fixture', command: process.execPath,
    args: [fixture], modelArgs: ['--model', '{model}'], order: ['headless'], transport: 'headless' }], maxConcurrent: 1 }));
  const child = spawn(process.execPath, [join(root, 'server/index.mjs')], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HARNESS_PILOT_CALLBACKS: '0', HARNESS_PILOT_CONFIG: config, HARNESS_PILOT_STATE_DIR: join(directory, 'tasks') } });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const pending = new Map(); let seq = 0;
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    const response = JSON.parse(line); const request = pending.get(response.id);
    if (request) { clearTimeout(request.timer); pending.delete(response.id); request.resolve(response); }
  });
  child.on('exit', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(stderr || 'MCP exited')); }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error('RPC timeout: ' + stderr)), 12000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  t.after(async () => {
    child.stdin.end(); await new Promise(resolve => child.once('exit', resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (name, args = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    if (response.result?.isError) throw new Error(response.result.content[0].text);
    return response.result.structuredContent;
  };
  return { rpc, call, directory };
}

test('MCP discovery, selected model, Unicode progress, cursor and persisted result', async t => {
  const { rpc, call, directory } = client(t);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  const listed = await rpc('tools/list'); assert.equal(listed.result.tools.length, 14);
  const started = await call('harness_start', { target: 'fixture', cwd: directory, prompt: 'OK', model: 'selected/model' });
  assert.equal(started.status, 'running');
  const done = await call('harness_wait', { task_id: started.task_id, timeout_ms: 5000 });
  assert.equal(done.status, 'completed'); assert.match(done.result.text, /FINAL 中文/);
  assert.match(done.result.text, /selected\/model/);
  const first = await call('harness_progress', { task_id: started.task_id, limit: 5 });
  const next = await call('harness_progress', { task_id: started.task_id, offset: first.next_offset });
  assert.ok(first.has_more); assert.match(first.text + next.text, /progress 中文/);
  const result = await call('harness_result', { task_id: started.task_id, limit: 5 });
  assert.ok(result.has_more); assert.equal(result.result.text.length, 5);
  await assert.rejects(call('harness_start', { target: 'fixture', cwd: 'relative', prompt: 'OK' }), /absolute/);
  await assert.rejects(call('harness_progress', { task_id: started.task_id, offset: -1 }), /range/);
});

test('nonzero exit with stdout remains error', async t => {
  const { call, directory } = client(t);
  const started = await call('harness_start', { target: 'fixture', cwd: directory, prompt: 'FAIL' });
  const result = await call('harness_wait', { task_id: started.task_id, timeout_ms: 5000 });
  assert.equal(result.status, 'error'); assert.match(result.result.diagnostic, /code 7/);
});

test('cancellation and concurrency limit', async t => {
  const { call, directory } = client(t);
  const started = await call('harness_start', { target: 'fixture', cwd: directory, prompt: 'WAIT' });
  await assert.rejects(call('harness_start', { target: 'fixture', cwd: directory, prompt: 'OK' }), /concurrency/);
  const cancelling = await call('harness_cancel', { task_id: started.task_id });
  assert.equal(cancelling.cancellation_requested, true);
  const result = await call('harness_wait', { task_id: started.task_id, timeout_ms: 5000 });
  assert.equal(result.status, 'aborted');
});

test('timeout is terminal and is not completed', async t => {
  const { call, directory } = client(t);
  const started = await call('harness_start', { target: 'fixture', cwd: directory, prompt: 'WAIT', timeout_ms: 1000 });
  const result = await call('harness_wait', { task_id: started.task_id, timeout_ms: 5000 });
  assert.equal(result.status, 'timeout');
});
