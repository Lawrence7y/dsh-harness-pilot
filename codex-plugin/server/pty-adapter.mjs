import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { killTree } from './runtime/transports/headless.js';

// Native terminal creation runs in an isolated worker so a blocked addon cannot block MCP.
export function loadPtyAdapter() {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.HARNESS_PILOT_PTY_MODULE, 'node-pty',
    ...(process.platform === 'win32' ? ['C:/dsh/node_modules/node-pty'] : [])].filter(Boolean);
  let modulePath;
  for (const candidate of candidates) {
    try { modulePath = require.resolve(candidate); break; } catch { /* Optional dependency. */ }
  }
  if (!modulePath) return undefined;
  return async spec => {
    if (spec.signal?.aborted) throw new Error('cancelled before PTY start');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', modulePath], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    const output = new PassThrough(); let diagnostics = ''; let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-1000); });
    const send = value => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); };
    const terminate = async () => { killTree(child.pid); child.stdin.destroy(); };
    const abort = () => { void terminate(); };
    spec.signal?.addEventListener('abort', abort, { once: true });
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timer = setTimeout(() => {
      rejectReady(new Error('native PTY startup timed out after 8s; worker terminated'));
      void terminate();
    }, 8000);
    child.on('error', error => rejectReady(error));
    child.on('exit', code => {
      clearTimeout(timer); spec.signal?.removeEventListener('abort', abort); output.end();
      resolveDone({ exitCode: code }); rejectReady(new Error(`PTY worker exited ${code}: ${diagnostics}`));
    });
    createInterface({ input: child.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'ready') { clearTimeout(timer); resolveReady(message.pid); }
      if (message.type === 'data') output.write(message.text);
      if (message.type === 'error') { clearTimeout(timer); rejectReady(new Error(message.message)); void terminate(); }
    });
    send({ type: 'init', spec: { argv: spec.argv, cwd: spec.cwd, env: spec.env, cols: spec.cols, rows: spec.rows, terminalType: spec.terminalType } });
    const pid = await ready;
    return { pid, output, done, write: async text => send({ type: 'write', text }),
      resize: async (cols, rows) => send({ type: 'resize', cols, rows }),
      signalForeground: async () => { send({ type: 'write', text: '\x03' }); return 1; }, terminate };
  };
}

if (process.argv[2] === '--worker') {
  const require = createRequire(import.meta.url); const pty = require(process.argv[3]); let terminal;
  const send = message => process.stdout.write(JSON.stringify(message) + '\n');
  const reader = createInterface({ input: process.stdin });
  reader.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.type === 'init') {
        const spec = message.spec;
        terminal = pty.spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env },
          cols: spec.cols, rows: spec.rows, name: spec.terminalType, useConpty: process.platform === 'win32' });
        terminal.onData(text => send({ type: 'data', text }));
        terminal.onExit(() => process.exit(0));
        send({ type: 'ready', pid: terminal.pid });
      } else if (message.type === 'write') terminal?.write(message.text);
      else if (message.type === 'resize') terminal?.resize(message.cols, message.rows);
    } catch (error) { send({ type: 'error', message: error.message }); process.exit(1); }
  });
  reader.on('close', () => { try { terminal?.kill(); } finally { process.exit(0); } });
}
