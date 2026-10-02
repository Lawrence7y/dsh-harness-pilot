import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../server/tasks.mjs';

test('completed result survives MCP restart and unfinished task is interrupted', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hp-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = new TaskManager({ directory, dispatch: async () => ({ stopReason: 'completed', text: 'persisted' }) });
  const started = manager.start({ target: 'fake', cwd: directory });
  await manager.wait(started.task_id, 1000);
  const restarted = new TaskManager({ directory, dispatch: async () => { throw new Error('must not redispatch'); } });
  assert.equal(restarted.result(started.task_id).result.text, 'persisted');
  const stale = '12345678-1234-1234-1234-123456789abc';
  writeFileSync(manager.path(stale, '.json'), JSON.stringify({ status: 'running', task_id: stale }));
  assert.equal(restarted.status(stale).status, 'interrupted');
  assert.equal(restarted.result(stale).ready, false);
  assert.throws(() => restarted.result('../escape'), /unknown task/);
});

test('empty answer does not pass as completed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hp-empty-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = new TaskManager({ directory, dispatch: async () => ({ stopReason: 'completed', text: '' }) });
  const started = manager.start({ target: 'fake', cwd: directory });
  const result = await manager.wait(started.task_id, 1000);
  assert.equal(result.status, 'error');
});
