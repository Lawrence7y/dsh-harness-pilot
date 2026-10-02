import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'server', 'index.mjs');
const isWsl = process.platform === 'linux' && readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
if (!isWsl || process.env.HARNESS_PILOT_NATIVE_LINUX === '1') {
  await import('../server/index.mjs');
} else {
  const configured = process.env.HARNESS_PILOT_WINDOWS_NODE ?? 'C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node.exe';
  function convert(path, flag) {
    const converted = spawnSync('wslpath', [flag, path], { encoding: 'utf8' });
    if (converted.status !== 0) throw new Error('wslpath failed to convert runtime path');
    return converted.stdout.trim();
  }
  const nativeNode = configured.startsWith('/') ? configured : convert(configured, '-u');
  if (!existsSync(nativeNode)) throw new Error('Windows Node not found; set HARNESS_PILOT_WINDOWS_NODE');
  const env = { ...process.env };
  const inherited = new Map((env.WSLENV ?? '').split(':').filter(Boolean).map(entry => [entry.split('/')[0], entry]));
  for (const key of ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'HARNESS_PILOT_CONFIG', 'HARNESS_PILOT_STATE_DIR', 'HARNESS_PILOT_CALLBACKS', 'HARNESS_PILOT_PTY_MODULE']) {
    if (env[key]) inherited.set(key, `${key}/w`);
  }
  env.WSLENV = [...inherited.values()].join(':');
  // Translate optional paths because the task manager runs on Windows.
  for (const key of ['HARNESS_PILOT_CONFIG', 'HARNESS_PILOT_STATE_DIR']) {
    if (env[key]?.startsWith('/')) env[key] = convert(env[key], '-w');
  }
  const child = spawn(nativeNode, [convert(entry, '-w')], { stdio: 'inherit', env });
  child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.on('SIGTERM', () => child.kill()); process.on('SIGINT', () => child.kill());
}
