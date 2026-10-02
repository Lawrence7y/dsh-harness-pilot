import type { WindowHelper } from './helper.js';
import { type SpawnTerminal } from './transports/pty.js';
import type { DispatchOutcome, DispatchSpec, ReadResult, TargetConfig, TransportKind } from './types.js';
import { type ResolvedConfig } from './config.js';
import { type DshProviderModels } from './models.js';
/** 长期存活的交互式会话（窗口 / CDP / pty）。 */
export interface InteractiveSession {
    readonly id: string;
    readonly target: TargetConfig;
    readonly transport: TransportKind;
    readonly detail: string;
    read(options: {
        limit: number;
        mode?: 'auto' | 'uia' | 'console';
    }): Promise<ReadResult>;
    send(input: {
        text?: string;
        submit?: boolean;
    }): Promise<{
        note: string;
    }>;
    /** 只有 CDP 会话能求值页面 JS（用于按文字点按钮、打开面板）。 */
    evaluate?(expression: string): Promise<unknown>;
    /** 只有 CDP 会话能派发真实鼠标事件（某些 GUI 的菜单只认真实 pointerdown）。 */
    mouse?(action: 'click' | 'move', x: number, y: number): Promise<void>;
    /** 窗口会话：按可见名字点 UIA 元素（GUI harness 打开面板/新建任务）。 */
    clickElement?(name: string): Promise<{
        found: boolean;
        detail: string;
    }>;
    close(): Promise<void>;
    readonly summary: LiveSessionSummary;
}
export interface LiveSessionSummary {
    readonly id: string;
    readonly target: string;
    readonly transport: TransportKind;
    readonly detail: string;
    readonly openedAt: number;
    readonly closed: boolean;
}
export interface SessionDeps {
    readonly config: ResolvedConfig;
    readonly helper: WindowHelper;
    /** 宿主 `ctx.subprocess.spawnTerminal`；缺失时 pty 档自动跳过。 */
    readonly spawnTerminal?: SpawnTerminal;
    /** 宿主 `ctx.llm`：用于读出「本 profile 已配置的供应商模型」。 */
    readonly llm?: {
        listProviders(): {
            id: string;
            name: string;
        }[];
        listModels(provider: string): Promise<{
            id: string;
        }[]>;
    };
    readonly log?: (level: 'info' | 'warn', message: string) => void;
}
/** 单个 harness 在设置页/概览里的画像。 */
export interface TargetOverview {
    readonly name: string;
    readonly description: string;
    readonly transport: string;
    readonly order: string[];
    readonly command: string;
    readonly commandPath?: string;
    readonly available: boolean;
    readonly reason?: string;
    /** 目标默认模型（ACP 会话内切换的那个）或空。 */
    readonly model: string;
    /** 是否支持「派发时指定模型」。 */
    readonly canSelectModel: boolean;
    /** harness 自己列出的模型（仅在请求 models 时填充）。 */
    readonly models: string[];
    readonly modelsNote: string;
}
export interface Overview {
    readonly plugin: {
        name: string;
        version: string;
    };
    readonly defaultTarget: string;
    readonly targets: TargetOverview[];
    readonly sessions: LiveSessionSummary[];
    readonly dsh: {
        providers: DshProviderModels[];
    };
    readonly generatedAt: number;
}
export declare class SessionRegistry {
    private readonly deps;
    private readonly sessions;
    /** harness 模型列表缓存（按目标名，避免每次起进程问）。 */
    private readonly modelCache;
    private readonly acpModule;
    private readonly cdpModule;
    private readonly windowModule;
    private counter;
    constructor(deps: SessionDeps);
    private log;
    private acp;
    private cdp;
    private window;
    /** 通道预检：只判断「这一档能不能用」，不派发任务（避免失败后重复执行）。 */
    preflight(kind: TransportKind, target: TargetConfig): Promise<{
        available: boolean;
        detail: string;
    }>;
    /** 按梯子选一档并跑一次任务；失败不会自动换档重跑（避免重复执行）。 */
    dispatch(spec: DispatchSpec, options?: {
        transport?: string;
    }): Promise<DispatchOutcome>;
    private run;
    /** 打开一个长期交互会话（GUI harness 优先 CDP，其次窗口，最后 pty）。 */
    open(target: TargetConfig, options: {
        cwd: string;
        launch?: boolean;
    }): Promise<InteractiveSession>;
    private wrapPty;
    private create;
    private mintId;
    list(): LiveSessionSummary[];
    get(id: string): InteractiveSession | undefined;
    close(id: string): Promise<boolean>;
    disposeAll(): Promise<void>;
    /** 供工具层使用：把目标名解析成 TargetConfig。 */
    target(name: string | undefined): TargetConfig;
    /** harness 自报的模型列表（带缓存）；modelsCommand 未配置时返回空。 */
    targetModels(target: TargetConfig): Promise<{
        models: string[];
        note: string;
    }>;
    /** 清掉模型缓存（UI 上「刷新模型」用）。 */
    clearModelCache(): void;
    /**
     * 设置页/概览用的全量画像：目标 + 可用性 + 模型 + 活跃会话 + DSH 已配置的供应商模型。
     * `models: true` 会去问每个 harness（起进程，慢），默认只用缓存/静态信息。
     */
    overview(options?: {
        models?: boolean;
    }): Promise<Overview>;
}
