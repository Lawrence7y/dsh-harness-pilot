import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { CompletionCallback, originThread, appRequest } from '../server/callback.mjs';
import { TaskManager } from '../server/tasks.mjs';

test('origin uses tool metadata ahead of environment, including serialized turn metadata', () => {
  assert.equal(originThread({ 'x-codex-turn-metadata': '{"thread_id":"thread-metadata-123"}' }, { CODEX_THREAD_ID: 'thread-environment-123' }), 'thread-metadata-123');
  assert.equal(originThread({}, {}), null);
});

test('completed task automatically sends one original-thread receipt, without status polling', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hp-callback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const callback = new CompletionCallback({ pipePath: 'test', request: async (_pipe, method, params) => {
    calls.push({ method, params });
    if (method === 'tools/list') return { tools: [{ name: 'send_message_to_thread', namespace: 'codex_app' }] };
    return { success: true, contentItems: [{ type: 'inputText', text: '{"queued":true}' }] };
  } });
  await callback.check();
  const manager = new TaskManager({ directory, dispatch: async () => ({ stopReason: 'completed', text: 'done' }),
    onComplete: (task, config) => callback.deliver(task, config) });
  const task = manager.start({ target: 'test', cwd: directory, callback: { thread_id: 'thread-origin-123' } });
  await manager.tasks.get(task.task_id).promise;
  assert.equal(manager.status(task.task_id).callback.status, 'delivered');
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 1);
  const message = calls.find(call => call.method === 'tools/call').params;
  assert.equal(message.arguments.threadId, 'thread-origin-123');
  assert.equal(message.callerSource, 'codex'); assert.equal(message.hostId, 'local');
  assert.ok(message.arguments.prompt.includes(task.task_id));
  assert.ok(!message.arguments.prompt.includes('done\n'), 'untrusted harness output is not embedded as instructions');
});

test('ambiguous delivery is recorded and never automatically duplicated', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hp-uncertain-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let delivered = 0;
  const manager = new TaskManager({ directory, dispatch: async () => ({ stopReason: 'completed', text: 'done' }),
    onComplete: async () => { delivered++; const error = new Error('connection closed after write'); error.deliveryUncertain = true; throw error; } });
  const task = manager.start({ target: 'test', cwd: directory, callback: { thread_id: 'thread-origin-123' } });
  await manager.tasks.get(task.task_id).promise;
  assert.equal(manager.status(task.task_id).status, 'completed');
  assert.equal(manager.status(task.task_id).callback.status, 'uncertain');
  manager.result(task.task_id); manager.status(task.task_id);
  assert.equal(delivered, 1);
});

test('desktop framed transport works with fragmented response frames', async t => {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\harness-test-${randomUUID()}` : join(tmpdir(), `hp-${randomUUID()}.sock`);
  const server = net.createServer(socket => {
    let request = Buffer.alloc(0);
    socket.on('data', chunk => {
      request = Buffer.concat([request, chunk]);
      if (request.length < 4 || request.length < request.readUInt32LE(0) + 4) return;
      const incoming = JSON.parse(request.subarray(4, 4 + request.readUInt32LE(0)).toString('utf8'));
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: incoming.id, result: { ok: true } }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(header.subarray(0, 2));
      setTimeout(() => socket.end(Buffer.concat([header.subarray(2), body])), 10);
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual(await appRequest(pipe, 'tools/list', {}), { ok: true });
});
