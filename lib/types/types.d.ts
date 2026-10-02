/**
 * Shared vocabulary for every harness transport.
 *
 * 一条设计原则：transport 只负责「把任务送进去、把输出取出来」，不认识 DSH。
 * 这样每个 transport 都能被单独测试，也能在 provider / tool 两条调用路径上复用。
 */
/** 一条通往其他 harness 的具体通道。 */
export type TransportKind = 'headless' | 'acp' | 'pty' | 'window' | 'cdp';
/** `auto` 通道梯子顺序（前一个不可用就降到下一个）。 */
export declare const DEFAULT_TRANSPORT_ORDER: readonly TransportKind[];
/** 窗口级操控提示（GUI / 终端 harness）。 */
export interface WindowSpec {
    /** 窗口标题匹配：普通子串或 `/正则/`。 */
    title: string;
    /** 进程映像名匹配（如 `ZCode.exe`，普通子串）。 */
    process: string;
    /** `harness_open` 用来把窗口拉起来的命令行；留空表示该 harness 需要用户自己先打开。 */
    launch: string;
    /** 提交一条 prompt 的按键（默认回车）。 */
    submitKeys: string[];
    /** 打字前先按的快捷键，用来把焦点带到聊天输入框（GUI harness 常用，如 ZCode 的 ctrl+n）。 */
    openInputKeys: string[];
    /** prompt 内部换行的按键（很多 TUI 用 shift+enter / ctrl+j）。 */
    newlineKeys: string[];
    /** 等待窗口出现的上限。 */
    appearTimeoutMs: number;
    /** 文本静默多久算「输出稳定」。 */
    settleMs: number;
}
/** Chromium / Electron harness 的 CDP 通道提示。 */
export interface CdpSpec {
    /** 启动时附加的参数，用于打开调试端口（如 `--remote-debugging-port=9333`）。 */
    launchArgs: string[];
    /** 固定端口；0 表示每个会话自动挑一个空闲端口。 */
    port: number;
    /** 判断「正在回答」的 DOM 选择器（可选）。 */
    busySelector: string;
    /** 读取对话正文的选择器（可选；留空则用 body.innerText）。 */
    transcriptSelector: string;
    /** 输入框选择器（可选；留空则用自动启发式）。 */
    inputSelector: string;
    /** 发送按钮选择器（可选；留空则用 Enter / 自动启发式）。 */
    sendSelector: string;
}
/** 一个可派发任务的其他 harness。全部字段都有默认值，配置文件只需写差异。 */
export interface TargetConfig {
    /** 注册名，模型用它指定 harness（如 `opencode`、`zcode`）。 */
    name: string;
    /** `auto` 或固定通道名。 */
    transport: string;
    description: string;
    /** 可执行文件（裸名走 PATH）。 */
    command: string;
    /** headless / pty 的固定参数；prompt 默认追加在末尾。 */
    args: string[];
    /** 启动 ACP server 的参数（默认 `['acp']`）。 */
    acpArgs: string[];
    /** 会话内切换的 ACP 模型（走 session/set_config_option；ACP 没有 --model 参数）。 */
    acpModel: string;
    /**
     * 指定模型的 argv 模板：`{model}` 会被替换成模型 id。
     * 例：`['--model', '{model}']`（opencode/agy/claude）、`['-m', '{model}']`（codex）。
     */
    modelArgs: string[];
    /** 列出该 harness 可用模型的命令（如 `opencode`）。留空表示不支持列出。 */
    modelsCommand: string;
    /** 列模型命令的参数。 */
    modelsArgs: string[];
    /** 列模型结果缓存时长（毫秒）。 */
    modelsCacheMs: number;
    /** 列模型命令的超时（毫秒）。有的 harness 要联网拉列表，需要放宽。 */
    modelsTimeoutMs: number;
    /** true = prompt 走 stdin 而不是命令行参数。 */
    promptViaStdin: boolean;
    /** 覆盖工作目录；留空继承父会话 workspace。 */
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    /** `auto` 时的通道优先级。 */
    order: string[];
    window: WindowSpec;
    cdp: CdpSpec;
}
/** 一次派发的输入。 */
export interface DispatchSpec {
    /** 已解析的目标。 */
    readonly target: TargetConfig;
    /** 任务正文。 */
    readonly prompt: string;
    /** 运行目录（绝对路径）。 */
    readonly cwd: string;
    /** 调用方取消。 */
    readonly signal: AbortSignal;
    /** 硬超时（毫秒）。 */
    readonly timeoutMs: number;
    /** 追加在该目标固定参数之后的额外参数（例如 `--model opencode-go/deepseek-v4.1-flash`）。 */
    readonly extraArgs?: readonly string[];
    /** 本次派发使用的模型 id；按目标配置的 `modelArgs` / `acpModel` 落到对应机制上。 */
    readonly model?: string;
    /** 可选的过程输出回调（尽力而为）。 */
    readonly onProgress?: (chunk: string) => void;
}
export type DispatchStopReason = 'completed' | 'error' | 'aborted' | 'timeout';
/** 一次派发的结果。 */
export interface DispatchOutcome {
    readonly transport: TransportKind;
    /** harness 的回答正文（window/cdp 通道可能是屏幕快照文本）。 */
    readonly text: string;
    /** 未净完成时由通道给出的诊断。 */
    readonly diagnostic?: string;
    readonly stopReason: DispatchStopReason;
    /** 附加事实：窗口句柄、CDP 端口、退出码等。 */
    readonly facts?: Record<string, string | number | boolean | undefined>;
}
/** 读一屏的结果。 */
export interface ReadResult {
    readonly text: string;
    /** 文本来源：无障碍树 / 控制台缓冲区 / DOM / PTY。 */
    readonly source: string;
    readonly diagnostic?: string;
}
