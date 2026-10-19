import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { AccountSeed } from './federation/accounts.js';
import type { NativeSessionStore, SessionMutex } from './native-sessions.js';
import type { ResolvedConfig } from './config.js';
import type { SessionRegistry } from './sessions.js';
import type { TeamRouteIntent } from './team-routing.js';
/** `ctx.subagents` 的最小面（缺失时 harness_agent 会明确报错）。 */
export interface SubagentStartLike {
    start(name: string, request: {
        label: string;
        prompt: ContentBlock[];
        parent: unknown;
        signal: AbortSignal;
        /**
         * per-child 选项。宿主只做「有值 ⇒ provider.capabilities.agentOptions 必须为真」这一道 gate
         * （rc.2 `dsh-subagent/lib/types/index.js:457-470`），字段级后果由 provider 承担。
         * 本插件用它承载「本次模型」；`HarnessProvider.start()` 真的把它落到 CLI 命令行。
         */
        agentOptions?: {
            provider?: string;
            model?: string;
            reasoningEffort?: string;
            maxTokens?: number;
        };
    }): Promise<{
        id: string;
        result: Promise<{
            output: readonly ContentBlock[];
            stopReason: string;
            diagnostic?: string;
        }>;
        dispose(): Promise<void>;
    }>;
    /**
     * 已注册的 provider 名（可选）。
     *
     * `harness_agent` 的 `accountId` 路径**必须**拿它核对「这个别名到底注册没有」——
     * 否则一个拼错/已删除的账号会被交给 `start()`，失败原因就变成宿主内部的一句话，
     * 而不是我们这条「显式拒绝 + 不 fallback」的判定。
     */
    list?(): readonly string[];
}
export interface ToolDeps {
    readonly config: ResolvedConfig;
    readonly registry: SessionRegistry;
    readonly subagents?: SubagentStartLike;
    /**
     * 会话级绑定（P5b）。`harness_dispatch` / `harness_agent` **没显式给 target/model 时**
     * 取它的值 —— 这就是会话页那套 Harness→账号→供应商→模型 选择的**真实作用点**。
     * 显式参数永远优先，绑定只补空缺。
     */
    readonly bindingFor?: (sessionId: string | undefined) => {
        harnessId?: string;
        model?: string;
        accountId?: string;
        harnessKind?: 'native' | 'external';
    } | undefined;
    /**
     * 当前**生效**的账号档案（内置 ± 用户增删改；已停用/删除的**不在**其中）。
     *
     * `harness_agent(accountId=…)` 用它判活：判据函数是 provider.ts 那**唯一**一份
     * `accountAliasRefusal`（不在就＝已停用/已删除）。**缺省时不猜** —— 那条路径显式拒绝，
     * 因为「注册过但已被删除」这件事没有它根本判不出来。
     */
    readonly accountSeeds?: () => readonly AccountSeed[];
    /**
     * **产品化团队身份**（`src/team-routing.ts`）。
     *
     * `harness_spawn_teammate` 的**全部**身份判定与冻结都走它，本文件不另写一套规则。
     * 缺省（未挂载）⇒ 该工具**显式拒绝**并说明原因，而不是退回「用成员名碰运气」。
     */
    readonly teamRouting?: TeamRoutingLike;
    /**
     * 团队服务（`ctx.agentTeams`）。缺省 ⇒ `harness_spawn_teammate` **显式拒绝**。
     * 用的是与探针 / 宿主 `spawn_teammate` 工具**同一个**服务方法，团队生命周期因此不变。
     */
    readonly agentTeams?: AgentTeamsSpawnLike;
    /**
     * `fresh` 上下文用的 provider 名（对应 agent-team 配置的 `freshProvider`，宿主缺省 `'spawn'`）。
     *
     * 用途**只是**把它写进请求（走宿主自己的配置语义）；`fork` 那一档刻意**不**跟着抄 —
     * 本插件不假装知道该 profile 的 `forkProvider`，所以只在 `fresh` 上用它，
     * 其余情况把宿主缺省 `'spawn'` 显式写出来，而不是留空让下游猜。
     */
    readonly teamFreshProvider?: string;
    /**
     * 持久原生会话层（可选；P1/P3）。缺省 = harness_sessions 的 persistent/release 动作显式报错。
     */
    readonly nativeSessions?: {
        readonly store: NativeSessionStore;
        readonly mutex: SessionMutex;
    };
}
/** 团队路由对工具面暴露的最小契约（实现见 `src/team-routing.ts`）。 */
export interface TeamRoutingLike {
    /** 校验并冻结一次成员身份。**必须**在真实的 `spawnTeammate` 之前调用。 */
    prepare(input: {
        readonly leadSessionId: string;
        readonly parentSessionId?: string;
        readonly memberName: string;
        readonly description?: string;
        readonly context?: 'fresh' | 'fork';
        readonly provider: string;
        readonly target: string;
        readonly accountId?: string;
        readonly model?: string;
    }): Promise<{
        readonly ok: true;
        readonly intent: TeamRouteIntent;
        readonly spec: {
            readonly target: string;
            readonly account: string | null;
            readonly model: string | null;
            readonly accountApplied: boolean;
            readonly modelApplied: boolean;
        };
    } | {
        readonly ok: false;
        readonly code: string;
        readonly reason: string;
    }>;
    /** 撤销未决意图（spawn 失败时必须调，否则留下永不兑现的身份）。 */
    abortIntent(leadSessionId: string, memberName: string, reason: string): boolean;
}
/** `harness_spawn_teammate` 需要的团队服务面（与探针/宿主工具**同一批**服务方法）。 */
export interface AgentTeamsSpawnLike {
    /**
     * 创建一名成员。
     * 契约：`caller` 必须是**活着的 Lead Agent**（宿主在 caller 不是 Lead 时抛 `TEAM_LEAD_REQUIRED`），
     * `request.signal` 必须是**真的** AbortSignal（`roster.js` 走 `AbortSignal.any`）。
     */
    spawnTeammate(caller: unknown, request: {
        readonly name: string;
        readonly description: string;
        readonly prompt: readonly ContentBlock[];
        readonly context: 'fresh' | 'fork';
        readonly provider: string;
        readonly signal: AbortSignal;
    }): Promise<{
        readonly member?: {
            readonly id?: string;
            readonly name?: string;
            readonly status?: string;
            readonly provider?: string;
        };
    }>;
}
/** 这个目标的模型是怎么被设定的（给人看的说明）。HTTP `/models` 也用它。 */
export declare function mechanismOf(target: {
    modelArgs: string[];
    acpArgs: string[];
    acpModel: string;
}): string;
/** 换模型只用到会话的这两件事：页面求值 + 真实鼠标（`mouse` 只有 CDP 会话有）。 */
export interface ModelSwitchSession {
    evaluate(expression: string): Promise<unknown>;
    mouse?(action: 'click' | 'move', x: number, y: number): Promise<void>;
}
export interface ModelSwitchReport {
    readonly ok: boolean;
    readonly before: string;
    readonly picked: string;
    readonly after: string;
    readonly via: string;
    readonly detail?: string;
}
/**
 * 只读地读出会话当前选中的模型（CDP 会话走 DOM 触发器）。
 * 非 CDP 会话没有页面求值，调用方应先判断 `session.evaluate`。
 */
export declare function currentModelOf(session: {
    evaluate(expression: string): Promise<unknown>;
}): Promise<string>;
/**
 * 换模型：真实鼠标点开选择器 → 直接找目标项 → 找不到就逐个父行 hover 出子菜单再找 → 点中 → 读回。
 * 全过程不往页面里派发任何合成事件（那会把 ZCode 的求值卡死）。
 */
export declare function switchModel(session: ModelSwitchSession, wanted: string): Promise<ModelSwitchReport>;
/** 页面内换模型的成败与说明（`ok` 供调用方 fail-closed 判定）。 */
export interface InPageModelSwitchReport {
    readonly ok: boolean;
    readonly note: string;
    /**
     * **切换后从页面回读到的实际模型**（读不到就是 `''`）。
     *
     * 为什么必须有：这条路径以前只信页面自述的 `ok` —— 页面说点中了就算成功，
     * 而「点中的那一个是不是请求的那个」从未被独立核验（需求 ⑧：请求值 ≠ 实际值要提示、未知即未知）。
     */
    readonly after?: string;
    /** `after` 是否与请求一致（读不到时为 `false`，并且 note 里写明「读不到，无法确认」）。 */
    readonly matches?: boolean;
}
/** 没有真实鼠标的会话（理论上只剩非 CDP 通道）：保留原来的页面内合成事件路径。 */
export declare function switchModelInPage(session: {
    evaluate(expression: string): Promise<unknown>;
}, wanted: string): Promise<InPageModelSwitchReport>;
export declare function registerTools(ctx: any, deps: ToolDeps): void;
/** 从活 Agent 上读会话 id（宿主 Agent 形状：`agent.id` 与 `agent.session.header.id` 同值）。 */
export declare function readAgentSessionId(agent: unknown): string | undefined;
/**
 * 读调用方的**父会话**（＝它属于哪个团队）。
 *
 * `undefined` = 这个 Agent 是顶层（它自己就是 Lead/root）。**不要**把 `undefined`
 * 当成「没有团队」而拒绝 —— 顶层 Agent 正是 Lead 的正常形态。
 */
export declare function readAgentParentSessionId(agent: unknown): string | undefined;
