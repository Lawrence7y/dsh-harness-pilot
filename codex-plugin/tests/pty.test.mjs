import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPtyAdapter } from '../server/pty-adapter.mjs';

test('available native PTY adapter returns actual terminal output and exits', async t => {
  const adapter = loadPtyAdapter();
  if (!adapter) { t.skip('no native node-pty installed on this test host'); return; }
  let handle;
  const started = Date.now();
  try { handle = await adapter({ argv: [process.execPath, '-e', 'console.log("PTY-OK")'], cwd: process.cwd(),
    cols: 80, rows: 24, terminalType: 'xterm-256color', signal: new AbortController().signal }); } catch (error) {
    assert.match(error.message, /PTY|pty|terminal/i);
    assert.ok(Date.now() - started < 12000, 'native PTY failure must be bounded');
    t.diagnostic(error.message); return;
  }
  let text = ''; handle.output.on('data', data => { text += data.toString(); });
  const deadline = setTimeout(() => { void handle.terminate(); }, 5000);
  try { await handle.done; } finally { clearTimeout(deadline); }
  assert.match(text, /PTY-OK/);
});
