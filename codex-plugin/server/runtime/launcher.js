import { existsSync, statSync, readFileSync, accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, isAbsolute, delimiter, join, dirname } from 'node:path';

function usable(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}
export function resolveLauncher(command) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('target has no command');
  command = command.trim();
  let candidates;
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) candidates = [command];
  else if (process.platform === 'win32') {
    const result = spawnSync('where.exe', [command], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    candidates = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
    candidates = candidates.flatMap(path => extname(path) ? [path] : [path, path + '.exe', path + '.cmd', path + '.bat', path + '.ps1']);
    const rank = path => ({ '.exe': 5, '.com': 4, '.cmd': 3, '.bat': 3, '.ps1': 2 }[extname(path).toLowerCase()] ?? 0);
    candidates.sort((a, b) => rank(b) - rank(a));
  } else candidates = (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, command));
  const resolved = candidates.find(path => {
    if (!usable(path)) return false;
    if (process.platform !== 'win32') { try { accessSync(path, constants.X_OK); } catch { return false; } }
    return true;
  });
  if (!resolved) throw new Error(`cannot resolve executable: ${command}`);
  const ext = extname(resolved).toLowerCase();
  if (process.platform === 'win32' && ['.cmd', '.bat'].includes(ext)) {
    // Resolve known transparent shims to native binaries: prompts never enter cmd.exe.
    const content = readFileSync(resolved, 'utf8');
    const native = content.match(/"(%(?:~dp0|dp0%)[^"]*\.exe)"\s+%\*/i);
    if (native) {
      const binary = native[1].replace(/^%(?:~dp0|dp0%)/i, dirname(resolved) + '\\');
      if (usable(binary)) return { file: binary, base: [], resolved: binary, kind: 'exe' };
    }
    const script = content.match(/"(%dp0%[^"\r\n]*\.(?:cjs|mjs|js))"\s+%\*/i);
    if (script) {
      const entry = script[1].replace(/^%dp0%/i, dirname(resolved) + '\\');
      if (usable(entry)) return { file: process.execPath, base: [entry], resolved, kind: 'direct' };
    }
    throw new Error(`unsupported command shim: ${resolved}; configure its native executable or node entrypoint`);
  }
  if (process.platform === 'win32' && ext === '.ps1') return {
    file: 'powershell.exe', base: ['-NoProfile', '-NonInteractive', '-File', resolved], resolved, kind: 'ps1',
  };
  return { file: resolved, base: [], resolved, kind: ext === '.exe' ? 'exe' : 'direct' };
}
export function buildArgv(command, args) {
  const launcher = resolveLauncher(command);
  const argv = [launcher.file, ...launcher.base, ...args];
  return { launcher, argv, verbatimArgv: argv, verbatim: false };
}
export function probeCommand(command) {
  try { return { available: true, path: resolveLauncher(command).resolved }; }
  catch (error) { return { available: false, error: error.message }; }
}
