export interface Launcher {
    /** 实际 spawn 的可执行文件。 */
    readonly file: string;
    /** 调用方参数之前的固定参数。 */
    readonly base: readonly string[];
    readonly kind: 'exe' | 'cmd' | 'ps1' | 'direct';
    /** 解析到的原始路径 / 命令，用于诊断。 */
    readonly resolved: string;
}
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
export declare function launchEnv(targetEnv?: Record<string, string>): Record<string, string>;
/** 解析一个 harness 命令；找不到时抛错，消息包含搜索过的位置。 */
export declare function resolveLauncher(command: string): Launcher;
export interface BuiltArgv {
    readonly launcher: Launcher;
    /**
     * 普通形态：每个参数单独传递，由 spawner 自己加引号
     * （node-pty / 默认的 child_process 都适用）。
     */
    readonly argv: string[];
    /**
     * verbatim 形态：整条命令行已由这里按 cmd.exe 规则拼好引号，
     * 必须配 `windowsVerbatimArguments: true` 原样传递，否则 Node 二次转义成 `\"…\"`
     * 让 cmd.exe 报「不是内部或外部命令」。
     */
    readonly verbatimArgv: string[];
    readonly verbatim: boolean;
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
export declare function buildArgv(command: string, args: readonly string[]): BuiltArgv;
/** 该命令在本机是否存在（用于 `harness_list` 的能力探测，不抛错）。 */
export declare function probeCommand(command: string): {
    available: boolean;
    path?: string;
    error?: string;
};
