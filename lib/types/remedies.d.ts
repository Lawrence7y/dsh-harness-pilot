export interface RelaunchRemedyInput {
    /** 目标名（zcode / mimo …）。 */
    readonly target: string;
    /** 进程映像名（ZCode.exe）。 */
    readonly image: string;
    /** 当前在跑的 pid 列表。 */
    readonly pids: readonly number[];
    /** 插件真正会使用的调试端口。 */
    readonly port: number;
    /** 端口扫描起点（用于解释端口是怎么选出来的）。 */
    readonly portBase: number;
    /** 目标可执行文件路径。 */
    readonly command: string;
    /** 已解析成具体端口的启动参数（含 --remote-debugging-port=<port>）。 */
    readonly launchArgs: readonly string[];
    /** 启动工作目录（可选）。 */
    readonly cwd?: string;
}
export interface RelaunchRemedy {
    /** 落盘的脚本绝对路径（写失败时为 undefined）。 */
    readonly scriptPath?: string;
    /** 脚本写失败的原因（best-effort，不阻断）。 */
    readonly scriptError?: string;
    /** 渲染好的、可直接贴给人看的整块文本。 */
    readonly text: string;
}
/**
 * 生成补救物。**永不抛异常** —— 写脚本失败也要把命令清单给全。
 */
export declare function buildRelaunchRemedy(input: RelaunchRemedyInput): RelaunchRemedy;
