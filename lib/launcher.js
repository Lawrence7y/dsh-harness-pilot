/**
 * 可执行文件解析：把 `opencode` / `agy` 这类「PATH 上的命令」解析成能真正 spawn 的目标。
 *
 * Windows 的坑：harness 在 PATH 上通常是 `.cmd` / `.ps1` shim（例如
 * `...\agy\bin\agy.cmd`、`...\workbuddy\...\opencode.cmd`），Node 不能直接执行
 * `.cmd`，`.ps1` 更是只能被 PowerShell 解释。这里统一处理：
 *   .exe / 其它原生可执行文件 → 直接 spawn
 *   .cmd / .bat              → cmd.exe /d /s /c "…"（含正确的引号规则）
 *   .ps1                     → powershell -NoProfile -File …
 */
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, isAbsolute } from 'node:path';
const EXT_RANK = { '.exe': 5, '.com': 4, '.cmd': 4, '.bat': 3, '.ps1': 2 };
/**
 * 启动**外部应用**时的子进程环境。
 *
 * 关键：清掉继承来的 `ELECTRON_RUN_AS_NODE`。Electron 只要看到这个变量就以 Node 模式
 * 运行 —— 不开窗、不初始化应用、直接跑完退出（exit 0）。宿主环境（Codex / 某些 agent
 * 运行时）会设置它，于是插件"带调试端口把 GUI 应用拉起来"会**静默失败**：没有窗口、
 * 没有 CDP 端点，最后等端点超时并回收进程，把用户的应用留在关闭状态。
 *
 * 实测证据：`"D:\Qoder CN\Qoder CN.exe" --version` 在泄漏该变量的环境下输出 `v24.18.0`
 * （Node 版本），清掉后才正常开窗（12 个进程）。
 *
 * 目标自己显式声明时以目标为准 —— 例如 zcode-cli 那种**就是要**当 Node 跑的 CLI
 * （`env: { ELECTRON_RUN_AS_NODE: '1' }`）。
 */
export function launchEnv(targetEnv = {}) {
    const inherited = { ...process.env };
    delete inherited.ELECTRON_RUN_AS_NODE;
    return { ...inherited, ...targetEnv };
}
function candidatesOnPath(command) {
    if (isAbsolute(command) || command.includes('\\') || command.includes('/'))
        return [command];
    const where = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const lines = `${where.stdout ?? ''}`.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    return lines;
}
function usable(path) {
    try {
        return existsSync(path) && statSync(path).isFile();
    }
    catch {
        return false;
    }
}
/** 解析一个 harness 命令；找不到时抛错，消息包含搜索过的位置。 */
export function resolveLauncher(command) {
    const trimmed = command.trim();
    if (trimmed.length === 0)
        throw new Error('target has no command configured');
    const candidates = candidatesOnPath(trimmed);
    const ranked = candidates
        .map(path => ({ path, rank: EXT_RANK[extname(path).toLowerCase()] ?? (usable(path) ? 1 : 0) }))
        .filter(entry => usable(entry.path))
        .sort((left, right) => right.rank - left.rank);
    const chosen = ranked[0];
    if (chosen === undefined) {
        throw new Error(`cannot resolve "${trimmed}" on this machine (searched: ${candidates.length > 0 ? candidates.join(', ') : 'where.exe found nothing'})`);
    }
    const extension = extname(chosen.path).toLowerCase();
    if (extension === '.cmd' || extension === '.bat') {
        const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
        // base 只保留开关；真正的脚本 + 参数由 buildArgv 统一加引号拼装。
        return { file: comspec, base: ['/d', '/s', '/c'], kind: 'cmd', resolved: chosen.path };
    }
    if (extension === '.ps1') {
        const shell = existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
        return { file: shell, base: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', chosen.path], kind: 'ps1', resolved: chosen.path };
    }
    return { file: chosen.path, base: [], kind: extension === '.exe' ? 'exe' : 'direct', resolved: chosen.path };
}
/**
 * 解析命令并按「参数追加」顺序拼出完整 argv。
 *
 * `.cmd` / `.bat` 必须经 cmd.exe，而 cmd 的引号规则很坑：外层引号会被 /s 吃掉，
 * 于是 Node 默认的转义会把带空格的参数拆开（实测 `agy --print "Reply with exactly …"`
 * 会报 unexpected argument "with"）。所以同时给出两种形态，调用方按 spawner 选：
 *   child_process → verbatimArgv + windowsVerbatimArguments
 *   node-pty      → argv
 */
export function buildArgv(command, args) {
    const launcher = resolveLauncher(command);
    if (launcher.kind === 'cmd') {
        const line = [launcher.resolved, ...args].map(quoteForCmd).join(' ');
        return {
            launcher,
            argv: [launcher.file, ...launcher.base, launcher.resolved, ...args],
            verbatimArgv: [launcher.file, ...launcher.base, `"${line}"`],
            verbatim: true,
        };
    }
    const argv = [launcher.file, ...launcher.base, ...args];
    return { launcher, argv, verbatimArgv: argv, verbatim: false };
}
/** 单参数按 cmd.exe 规则加引号；内嵌双引号用 cmd 的 `""` 写法转义（不是 `\"`）。 */
function quoteForCmd(value) {
    if (value.length > 0 && !/[\s"&|<>^]/.test(value))
        return value;
    return `"${value.replace(/"/g, '""')}"`;
}
/** 该命令在本机是否存在（用于 `harness_list` 的能力探测，不抛错）。 */
export function probeCommand(command) {
    if (command.trim().length === 0)
        return { available: false, error: 'no command configured' };
    try {
        const launcher = resolveLauncher(command);
        return { available: true, path: launcher.resolved };
    }
    catch (error) {
        return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
}
//# sourceMappingURL=launcher.js.map