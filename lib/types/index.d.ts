/**
 * @dsh-external/dsh-harness-pilot — 把其他 harness 接入 DeepSeek Harness。
 *
 * 两条使用路径（同一套通道）：
 *   1. 子代理派发：每个 harness 注册成 `ctx.subagents` 上的 `harness-<name>` provider，
 *      `harness_agent` / 标准 subagent 工具都能以子代理语义把任务交给它。
 *   2. 直接操控：`harness_dispatch` 一次性派发；`harness_open` + `harness_send`
 *      则以窗口/CDP/PTY 的方式交互操控（不依赖截图 OCR）。
 *
 * 三条对外面：
 *   - 工具（tools.ts）：DSH 内的模型调用面。
 *   - HTTP（本文件的 `/harness-pilot/api`）：设置页与**外部 agent**（如 Codex）的调用面，
 *     不需要在 DSH 里就能派任务 / 查模型 / 换模型。
 *   - 客户端（client/client.js）：设置页只读渲染。
 *
 * 通道梯子（自动选，选不到就如实报错，不会悄悄降级重复执行）：
 *   acp      → ACP 协议（opencode 等支持 ACP 的 harness，流式文本，最稳）
 *   headless → CLI 一次性打印模式（opencode run / agy --print / claude -p / codex exec）
 *   pty      → 宿主 ConPTY（ctx.subprocess.spawnTerminal），用于只有全屏 TUI 的 harness
 *   cdp      → Chromium DevTools 协议（Electron harness：读 DOM、写输入框、点发送）
 *   window   → 真实窗口（定位/聚焦/注入键盘 + 无障碍树或控制台缓冲区读文本；截图仅兜底）
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Config, type ResolvedConfig } from './config.js';
import { type LiveModelCatalog } from './subagent-cleanup.js';
import { type SessionExecutionIdentity } from './session-identity.js';
import { type HarnessOverride, type RegistryState } from './federation/registry.js';
import { type InventoryResult } from './federation/providers.js';
import { type CapabilityReport, type CatalogCandidate, type CatalogEditPlan, type CatalogEditRefusal, type CatalogEditResult, type CatalogOp, type SelectionOutcome } from './catalog-edit.js';
import { type SubagentModelsFacade } from './subagent-models.js';
import { AccountManagers } from './account-managers.js';
import { type AccountCrudAction, type AccountCrudResult, type AccountRegistryFile, type AccountSeed, type IsolationProfile, type NativeAuthAction, type NativeAuthPlanResult, type NativeAuthRunResult } from './federation/accounts.js';
import { type SessionBinding } from './federation/binding.js';
import { type PoolState } from './federation/poolconfig.js';
import type { AuthStateLike } from './federation/pool.js';
import type { QuotaRecord } from './federation/quota.js';
import type { AccountProfile, HarnessRecord } from './federation/types.js';
import { type McpBridge } from './mcp-bridge.js';
import { type FrozenTargetRecipe, type TeamRoute, type TeamRoutingEvent } from './team-routing.js';
import { SessionRegistry } from './sessions.js';
import { type RuntimeSettings } from './settings.js';
import { type ModelVisibilityFacade } from './model-visibility.js';
import { TaskManager } from './tasks.js';
import { type PilotCliHandle } from './llm-adapter.js';
import type { DispatchOutcome, DispatchSpec } from './types.js';
export declare const name = "@dsh-external/dsh-harness-pilot";
/**
 * 只声明**激活必需且注册顺序有保证**的核心服务（dsh-base 提供，先于本插件就位）。
 * subagents / webServer / 唤醒链服务不在这里：它们由子 fiber（等到再注册）或
 * 惰性解析处理 —— 见 apply() 里的「服务时序纪律」注释。
 */
export declare const inject: string[];
export { Config };
interface LoggerLike {
    info?(message: string): void;
    warn?(message: string): void;
}
/** 一条要注册进宿主 webServer 的路由。 */
interface WebServerRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** 宿主 webServer 的最小面：注册一条 HTTP 路由，并（仅供自愈）看到内部路由表。 */
interface WebServerLike {
    register(route: WebServerRoute): () => void;
    /** 运行期就是 Service 实例上的三张 Map（编译期是私有字段，所以这里是可选 + unknown）。 */
    exact?: unknown;
    prefixes?: unknown;
    upgrades?: unknown;
}
/**
 * 清掉 webserver 路由表里以 `path` 开头的残留条目 —— 与超级模组的 `dev_clear_routes`
 * 同一套做法：直接操作 Service 实例上的 `exact` / `prefixes` / `upgrades` 三张 Map。
 *
 * 为什么需要：热重载被打断（旧 fiber 的 disposer 没跑完）时，路由表里会留下同路径的
 * 旧条目，`register()` 于是抛 `duplicate prefix route`，而插件重启又不会自己清 —— 结果
 * 就是接口静默 404。这里先清残留再重试一次，把「一次被打断的重载」变成自愈。
 *
 * 已知残留风险：若旧 fiber 的 disposer 在**我们重新注册之后**才迟到执行，它按路径
 * `table.delete(path)` 会把我们新注册的这条一起删掉（表按 path 索引，分不清世代）。
 * 这种迟到 disposer 无法从外部拦截；届时网页端会再一次 404，重新加载插件即可恢复。
 *
 * 导出仅为 probe/verify-route-heal.mjs 能直接驱动它（插件入口的其余导出同理）。
 */
export declare function clearStaleRoutes(webServer: WebServerLike, path: string): string[];
/**
 * 注册 `/harness-pilot/api` 前缀路由，失败时自愈：
 *   1. `register` 抛错（多半是中断重载留下的同路径残留）→ 清掉残留；
 *   2. 再试一次；
 *   3. 还是失败 → 用 warn 把两次的原始错误都打出来（不吞）。
 *
 * 另外做两件宿主 API 不保证的事：
 *   · **世代守卫**：`register()` 返回的 disposer 是按 **path** 删除的（宿主内部表以
 *     path 为键，分不清世代）。插件被重新 apply 时新 fiber 先注册、旧 fiber 的 disposer
 *     迟到执行，会把新注册的这条一起删掉。守卫让陈旧代的 disposer 退化为 no-op。
 *   · **注册后核对**：`register()` 返回 disposer 只说明没抛错，不代表请求能命中；
 *     这里立刻查一次前缀表，不在就给出明确 warn。
 *
 * @returns 注册成功时为该路由的 disposer（带世代守卫），否则 undefined。
 */
export declare function registerApiRoute(webServer: WebServerLike, handler: WebServerRoute['handler'], logger: LoggerLike | undefined): (() => void) | undefined;
/**
 * 建 `/harness-pilot/api` 的 handler。它复用**同一个** SessionRegistry（不再造第二个），
 * 所以 HTTP 与工具看到的是同一批会话。
 *
 * 鉴权：Config.apiToken 非空时，所有请求都要带 `x-harness-pilot-token` 且完全一致，
 * 否则 401；为空则放行 —— webServer 默认只监听 127.0.0.1，本机进程本来就能直连
 * localhost，令牌只用于「不想让任意本机进程/浏览器页面随便使唤 harness」的场景。
 *
 * 端点：
 *   GET  /overview            （?models=1 会去问每个 harness 的模型，慢）
 *   GET  /probe?target=…      通道梯子可用性
 *   POST /models              { target?, refresh? }              → { target, models, note, mechanism }
 *   POST /dispatch            { target, prompt, model?, transport?, timeout_ms?, cwd? }
 *                             → { target, transport, stopReason, text, diagnostic?, facts? }
 *   POST /send                打开/复用会话：{ target, model?, cwd?, launch? } → { sessionId, transport, currentModel }
 *                             向已有会话写入：{ sessionId, text?, submit?, wait_ms? } → { sessionId, …, text, source }
 *   GET  /llm-adapter         Path A：pilot-cli 路由 + 部署默认模型闸门 + 选择器目录 + 代价披露（**只读、不花钱**）
 *   POST /llm-adapter/gate-test    { action: 'blocked' | 'delegated' } → 闸门两条分支自检（**都零 profile 写入**）
 *   POST /llm-adapter/select-model { model, sessionId? } → 走真实 @Remote('selectModel') 并比 profile 哈希
 *   POST /llm-adapter/stream  { model, prompt, sessionId?, timeout_ms? } → 经真实路由跑一轮（**会花钱**）
 *
 * 导出仅为 probe/verify-api-handler.mjs 能用假 registry / 假 req-res 离线驱动它。
 */
/** createApiHandler 的可选扩展面：异步任务 + 运行时设置 + 联邦注册表（离线探针可不传）。 */
export interface ApiExtras {
    accountDefaults?: {
        state(): unknown;
        select(id: string): unknown;
    };
    workBuddyAccounts?: (action: string, accountId: string, handle?: string, label?: string) => unknown;
    accountManagers?: AccountManagers;
    tasks?: TaskManager;
    settings?: () => RuntimeSettings;
    applySettings?: (raw: unknown) => RuntimeSettings;
    /** P1 联邦注册表。离线探针不传时 /registry 返回 503 而不是假装有数据。 */
    registry?: {
        readonly list: (measure: boolean) => Promise<HarnessRecord[]>;
        readonly state: () => RegistryState;
        readonly update: (target: string, patch: HarnessOverride) => RegistryState;
    };
    /** P3 供应商/模型四态发现。未挂载时 /providers 返回 503。 */
    providers?: (targetName: string, measure: boolean) => Promise<InventoryResult>;
    /**
     * P4 供应商/模型的**可编辑操作** + **受约束选择**。未挂载时 `/catalog*` 返回 503（不假装有数据）。
     *
     * `measure=true` 才会真的跑一次该 CLI 的**只读**管理子命令帮助（`<入口> <sub> --help`，
     * 零副作用、零额度）。false 时只给宿主面与声明面的判定，并把「未探测」如实写进证据。
     */
    catalog?: {
        readonly capabilities: (targetName: string, measure: boolean) => Promise<CapabilityReport>;
        readonly candidates: (targetName: string, measure: boolean) => Promise<{
            readonly target: string;
            readonly candidates: readonly CatalogCandidate[];
            readonly byAvailability: Readonly<Record<string, number>>;
            readonly note: string;
        }>;
        readonly select: (input: {
            readonly target: string;
            readonly model: string;
            readonly allowUnlisted?: boolean;
            readonly minAvailability?: string;
        }) => Promise<SelectionOutcome>;
        readonly plan: (input: {
            readonly target: string;
            readonly op: CatalogOp;
            readonly accountId?: string;
            readonly providerId?: string;
            readonly models?: readonly string[];
            readonly currentDeclared?: readonly string[];
            readonly registryUrl?: string;
            readonly allowUnlisted?: boolean;
            readonly confirmWritesUserConfig?: boolean;
        }) => Promise<CatalogEditPlan | CatalogEditRefusal>;
        readonly execute: (plan: CatalogEditPlan | CatalogEditRefusal, targetName: string) => Promise<CatalogEditResult>;
    };
    /** P2 账号档案（含三态、隔离披露、切换语义）。未挂载时 /accounts 返回 503。 */
    accounts?: (measure: boolean) => Promise<AccountProfile[]>;
    /**
     * **同步**模型清单出口（与原生模型目录出口是**同一份实现**）。
     *
     * 用途：`/llm-adapter` 的逐目标诊断 —— 宿主的 `listModels` 里任一目标解析抛错都会被
     * `listDshModels` 的 per-provider try/catch 折成 `models: []`，看起来只是「这个 harness 没模型」。
     * 这里让每一步都能单独 try/catch 并如实回报。
     */
    modelsFor?: (targetName: string) => readonly string[] | undefined;
    /** 上一条出口**逐目标**留下的错误（某条目标解析失败时的可读原因；诊断出口如实回报）。 */
    modelsErrorFor?: (targetName: string) => string | undefined;
    /**
     * 子代理模型白名单的门面（宿主 `settings` + `subagentModelSelection` 两个服务）。
     * 未挂载 ⇒ `/subagent-model-selection` 返回 503（不假装能读能写）。
     */
    subagentModels?: SubagentModelsFacade;
    nativeModelCatalog?: () => Promise<LiveModelCatalog>;
    /**
     * **会话模型选择器可见性**的门面（`src/model-visibility.ts`）。
     * 未挂载 ⇒ `/model-visibility` 返回 503，概览的每组 `picker` 摘要省略（不假装有配置）。
     */
    modelVisibility?: ModelVisibilityFacade;
    /** P5b 会话级绑定（Harness→账号→供应商→模型）。 */
    binding?: {
        readonly get: (sessionId: string) => SessionBinding | undefined;
        readonly set: (input: {
            sessionId: string;
            harnessId?: string;
            accountId?: string;
            provider?: string;
            model?: string;
            reasoningEffort?: string;
            permissionMode?: string;
        }) => SessionBinding;
    };
    /** P9 账号池与切换账本。 */
    pool?: {
        readonly state: () => PoolState;
        /** 派发时用：默认账号（显式 accountId 优先于它）。 */
        readonly defaultAccountId?: () => string;
        readonly update: (patch: {
            autoSwitchEnabled?: boolean;
            defaultAccountId?: string | null;
            entry?: {
                accountId: string;
                enabled?: boolean;
                priority?: number;
                cooldownMs?: number;
                models?: readonly string[] | null;
            };
            policy?: Partial<PoolState['policy']>;
        }) => PoolState;
        readonly events: (scope: {
            kind: 'session' | 'task' | 'member';
            id: string;
        }) => unknown;
        readonly recent: () => unknown;
        readonly auditRedaction: () => string[];
        /** 并发协调状态（租约 / 近期切换 / 任务分配），用于核对协调层是否真的在用。 */
        readonly coordination: () => unknown;
        /** 第 4 阶段：自动切换执行侧的运行时状态（冻结 / 冷却 / 熔断）。 */
        readonly autoSwitchRuntime?: () => unknown;
        /** 第 4 阶段：最近一次自动切换执行的完整轨迹（含每次真实尝试）。 */
        readonly autoSwitchLastResult?: () => unknown;
        /** 第 4 阶段：解冻（给账号=只解冻它；不给=全部）。 */
        readonly autoSwitchReset?: (accountId?: string) => unknown;
        readonly manualSwitch: (input: {
            scope: {
                kind: 'session' | 'task' | 'member';
                id: string;
            };
            harnessId: string;
            fromAccountId: string;
            toAccountId: string;
            currentModel?: string;
            currentProvider?: string;
            authOfTarget: AuthStateLike;
            quotaOfTarget?: QuotaRecord;
            modelsOfTarget?: readonly string[];
            nativeSessionResumable: boolean;
            uncertainWriteActions?: readonly string[];
        }) => Promise<{
            ok: boolean;
            result: unknown;
        }>;
    };
    /**
     * 进程池的只读出口（并发闸门 / owned 进程 / 取消 / 空闲回收证据）。
     * 未挂载时 `/diag/processpool` 返回 503，**不**假装有数据。
     *
     * 为什么要有它：并发上限现在**跟着设置页走**（见 `apply()` 里的 `applyPoolPolicy()`），
     * 而「此刻池的上限到底是多少、它拥有哪些 pid、取消有没有真的终止、空闲回收前后
     * 完整进程集合差多少」过去只能读落盘文件才知道。这里只读、不触发任何动作。
     */
    processPool?: () => {
        readonly describe: () => unknown;
        readonly eventLog: () => unknown;
    };
    /**
     * 当前**生效**的账号档案（内置 ± 用户增删改）。未挂载时回落到内置种子 ——
     * 老组合（离线探针）行为不变。
     */
    accountSeeds?: () => readonly AccountSeed[];
    /**
     * 第 3 阶段：账号档案的**动态管理** + **原生登录/退出入口**。
     * 未挂载时相关端点一律 503，而不是假装有数据。
     */
    accountAdmin?: {
        readonly registry: () => AccountRegistryFile;
        readonly crud: (action: AccountCrudAction) => AccountCrudResult;
        readonly isolation: (harnessId: string) => IsolationProfile;
        readonly planNativeAuth: (accountId: string, action: NativeAuthAction) => NativeAuthPlanResult;
        readonly runNativeAuth: (accountId: string, action: NativeAuthAction) => Promise<NativeAuthRunResult>;
    };
    /**
     * 第 4 阶段：**自动切换执行侧**的派发缝。
     * 未挂载时 /dispatch 原样直连 registry（老组合行为不变）。
     */
    autoSwitchDispatch?: (spec: DispatchSpec, options: {
        transport?: string;
    }) => Promise<DispatchOutcome>;
    /**
     * Path A：`pilot-cli` LLM 适配器句柄（`src/llm-adapter.ts`）。
     * 未挂载时 `/llm-adapter*` 一律 503，而不是假装有数据。
     */
    llmAdapter?: PilotCliHandle;
    /**
     * 把一条消息写进 DSH 会话并唤醒它（**与完成回执同一条链**：`resolveAgent`（不在线先 resume）
     * → `agent.followup` → `sessions.flush`）。只给「改道归因」取证用 —— **会真的跑一轮模型调用**。
     */
    wake?: (sessionId: string, text: string) => Promise<string>;
    /** 幂等 adopt / 新建一个 DSH 会话（传同一个 id 不会重复造会话），返回 sessionId。 */
    createSession?: (sessionId: string) => Promise<string>;
    /**
     * **只读**会话事件日志（给取证用）。
     * ⚠️ 取证必须读宿主自己写的日志，而不是采信本插件自报 —— 这正是上一轮归因不实的教训。
     */
    sessionLog?: (sessionId: string) => SessionLogRead;
    executionIdentity?: (sessionId: string) => SessionExecutionIdentity | undefined;
    conversationModelPolicy?: () => {
        mode: string;
        installed: boolean;
        reason?: string;
    };
    /**
     * 团队子会话绑定取证探针（U1）。未挂载时 `/probe/team/*` 返回 503，
     * 而不是让探针脚本以为「探针跑了但没结论」。
     */
    teamProbe?: TeamMemberProbeExtras;
    /**
     * **MCP 桥接句柄**（`src/mcp-bridge.ts`）。未挂载时 `/mcp-bridge*` 返回 503。
     *
     * 这里暴露的是**入口的脱敏视图与事件**（不含令牌），以及两个只给探针用的动作：
     * `open`（给某个活会话开一个入口，用来在**真实成员作用域**上做协议/鉴权/白名单取证）
     * 与 `close`（立刻关掉，用来证明「取消 ⇒ 入口同步失效」）。
     */
    mcpBridge?: McpBridge;
    /**
     * **产品化团队路由**（`src/team-routing.ts`）。
     *
     * 它给 HTTP 面提供三件事，全部**只读**（写入只发生在 `harness_spawn_teammate` 的
     * 「先冻结、后 spawn」那一步）：
     *   ① `GET /team/routing` —— 用户可见的**成员 → Harness/账号/模型**名单（账号只出脱敏标签）；
     *   ② `GET /team/events`  —— 解析/拒绝的审计记录（`resolve.written` / `prepare.refused` …）；
     *   ③ `dispatch` —— 按**该成员冻结的账户配方**执行这一轮（不按查询时刻的档案重算）。
     *
     * 未挂载时 `/team/*` 返回 503，而不是让调用方以为「查了但没有」。
     */
    teamRouting?: TeamRoutingExtras;
    /**
     * 一条**诊断**日志出口（可选）。`createApiHandler` 本身拿不到插件的 `logger`
     * （它不是参数），而 `/dispatch` 里的桥接失败必须有人看得见 —— 所以由挂载方注入。
     * **只用于「如实记一条」**，不参与任何判定、不影响响应形状。
     */
    log?: (message: string) => void;
}
/**
 * **团队子会话绑定取证探针**（`src/index.ts` 与 `probe/**` 之外不引用）。
 *
 * 它存在的理由：团队成员的子会话 id 由 `roster.js:232` 在**插件外部**随机生成，插件唯一能
 * 插入的接缝是 `agent/created` 钩子。而「新生成员能不能在**它自己的第一次 LLM 请求之前**
 * 拿到绑定」这个时序**是方案 C 唯一的未知数（U1）**，只能实测、不能推断。
 *
 * 因此本探针做两件事，且**只做这两件事**：
 *   ① **观测**：把 `agent/created` 与每一次 `llm/stream`（含该会话当时的绑定）追加进一条
 *      **单一日志**（`probe/out/team-member-binding.jsonl`），带自增 `seq` ——
 *      判定「绑定早于第一次请求」用**日志先后**，不靠毫秒时间戳（同毫秒时它分不出来）。
 *   ② **驱动**：用宿主的真实入口（`sessionController.create` + `agentTeams.spawnTeammate`）
 *      造出**真的**团队成员子会话，好让 ① 有东西可观测。
 *
 * ⚠️ 边界：它**不是**产品功能。绑定策略（谁绑到哪个目标/账号）由调用方显式给出，
 * 插件**不猜** —— 从 `spawn_teammate` 的 prompt 里只能读出成员名，读不出目标与账号。
 */
export interface TeamMemberProbeTarget {
    /** 成员名（`spawn_teammate` 的 `name`）。 */
    readonly name: string;
    /** 绑定的外部 Harness 目标名（须在本 profile 的目标表里且为 `transport=auto`）。 */
    readonly target: string;
    /** 账号档案 id（如 `qoder-cn-a`）。 */
    readonly accountId?: string;
    /** 固定模型（写进绑定的 `model` 字段），可选。 */
    readonly model?: string;
}
export interface TeamMemberProbeSpec {
    readonly name: string;
    readonly context?: 'fresh' | 'fork';
    readonly prompt?: string;
}
/** 观测日志里的一条。`seq` 是**唯一**的先后判据。 */
export interface TeamMemberProbeEntry {
    readonly time: string;
    readonly seq: number;
    readonly event: string;
    readonly sessionId?: string;
    readonly teammate?: string;
    readonly parentId?: string;
    readonly detail?: Record<string, unknown>;
}
export interface TeamMemberProbeStatus {
    readonly bindings: readonly {
        readonly sessionId: string;
        readonly teammate: string;
        readonly harnessId: string;
        readonly accountId: string | null;
        readonly seq: number;
    }[];
    readonly logPath: string;
    readonly bindingsPath: string;
    readonly observationInstalled: boolean;
    readonly missingTargets: readonly string[];
}
/** 探针的接线面（由 `apply` 里的真实服务实现，见 `createTeamMemberProbe`）。 */
export interface TeamMemberProbeExtras {
    readonly status: () => TeamMemberProbeStatus;
    /** 声明「哪个成员名绑到哪个目标/账号」。**必须**在 spawn 之前调用。 */
    readonly configure: (targets: readonly TeamMemberProbeTarget[]) => TeamMemberProbeStatus;
    /**
     * 建 Lead 会话（缺省时）→ `spawnTeammate` → 返回成员行与本次的观测日志。
     *
     * `options.freshLead` 会**丢掉缓存的 Lead** 另建一个：团队有成员数上限（`maxMembers` 默认 8），
     * 而同一个 Lead 是跨轮累积的 —— 不换 Lead，跑几轮就会撞上 `TEAM_MEMBER_LIMIT`，
     * 而那会把「探针自己把名额用完了」误报成「能力缺失」。
     */
    readonly spawn: (spec: readonly TeamMemberProbeSpec[], options?: {
        readonly freshLead?: boolean;
    }) => Promise<unknown>;
    /** 名单（与 `list_agents` 工具同一个服务方法）。 */
    readonly members: () => Promise<unknown>;
    /**
     * Lead → 成员投递（与 `send_message` / `followup_task` 工具同一个服务方法）。
     *
     * `leadSessionId` 显式指定 **caller** 是哪个会话的 Agent；缺省时用探针自己的全局 Lead
     * （与改动前一致）。要驱动**产品** Lead 的团队就必须显式传它 —— 见 `ensureLead` 的注释。
     */
    readonly send: (to: string, message: string, delivery?: 'quiet' | 'wakeup', leadSessionId?: string) => Promise<unknown>;
    /** 中断某个成员当轮（与 `interrupt_agent` 工具同一个服务方法）。`leadSessionId` 语义同 `send`。 */
    readonly interrupt: (targetName: string, leadSessionId?: string) => Promise<unknown>;
    /** 把会话解绑成原生（走与 `POST /session/binding` 同一条链）—— A/B 对照用。 */
    readonly unbind: (sessionId: string) => unknown;
    readonly logs: (limit: number) => readonly TeamMemberProbeEntry[];
    readonly clear: () => {
        readonly removed: number;
        readonly logPath: string;
    };
}
/**
 * **产品化团队路由**的 HTTP 接线面（实现：`TeamRoutingTable` + 下面 `teamRoutingExtras`）。
 *
 * 与上面那个**探针**的区别是本文件里最要紧的一条纪律：探针的意图表按**成员名**索引
 * （`desired: Map<string, TeamMemberProbeTarget>`），因此**没有 Lead/team 隔离**；
 * 产品路由按 **(Lead 会话, 成员名)** 存意图、按 **childSessionId** 解析，两者不共用状态。
 * 这也意味着一件事必须说出来：**旧探针路径留下的意图不会影响产品路由**（反之亦然）。
 */
export interface TeamRoutingExtras {
    /** 只读名单：成员 → Harness / 账号（脱敏标签）/ 模型 / 解析来源。 */
    readonly routes: () => readonly TeamRoute[];
    /** 未兑现的意图（已冻结、还没解析出子会话 id）。用于「冻结了却从没落地」这类判定。 */
    readonly pending: () => readonly {
        readonly leadSessionId: string;
        readonly memberName: string;
        readonly target: string;
        readonly resolved: boolean;
    }[];
    readonly events: (limit: number) => readonly TeamRoutingEvent[];
    /**
     * 该会话的**冻结配方本体**（派发侧的权威来源；`undefined` = 不在表里或记录不自足）。
     *
     * ⚠️ 这里**逐字**用 team-routing 的 `FrozenTargetRecipe`，不再手抄一份窄化形状：
     * `targetConfig`（成员诞生那一刻的目标本体）是 `applyAccountToTarget()` 的**错配判据**所必需的
     * —— 手抄一份漏掉它，就会让「冻结了 A 账号、却派到别的目标上」这条路径重新变得不可判。
     */
    readonly recipeOf: (sessionId: string) => FrozenTargetRecipe | undefined;
    /**
     * 按**该成员冻结的账户配方**执行这一轮派发。
     *
     * `accountId` **不是**「再合并一次账号」：账号配方在 `prepare()` 那一刻就已经固化进冻结产物，
     * 这里只是把**那一份**交给下游。所以成员在跑的期间账号档案被停用/改名/删除，都改变不了
     * 已经创建的这位成员（新成员会被 `prepare()` 拒绝）。
     */
    readonly dispatch: (spec: {
        readonly target: string;
        readonly prompt: string;
        readonly cwd: string;
        readonly signal: AbortSignal;
        readonly sessionId?: string;
        readonly accountId?: string;
    }) => Promise<{
        readonly ok: true;
        readonly text: string;
        readonly transport: string;
        readonly stopReason: string;
        readonly note?: string;
        readonly facts?: Readonly<Record<string, string | number | boolean | undefined>>;
    } | {
        readonly ok: false;
        readonly reason: string;
    }>;
}
/** 一次只读会话日志读取的结果（拿不到就如实说为什么，不假装）。 */
export interface SessionLogRead {
    readonly available: boolean;
    readonly reason?: string;
    readonly seq?: number;
    readonly header?: unknown;
    readonly events?: readonly {
        readonly type: string;
        readonly seq: number;
        readonly time: number;
        readonly data: unknown;
    }[];
}
export declare function createApiHandler(registry: SessionRegistry, config: ResolvedConfig, extras?: ApiExtras): WebServerRoute['handler'];
/** 从成员 prompt 里读出成员名 —— 这是**唯一**能从「插件外生成」的子会话反查身份的信息。 */
export declare function teammateNameFromPrompt(prompt: readonly unknown[] | undefined): string | undefined;
/**
 * 从 **Lead 的会话日志**里读出某个新生子会话对应的成员名。
 *
 * 为什么这是首选接缝（而 prompt 文本不是）：`agent-team` 的 `TeamRoster.spawnAdmitted`
 * 先 `journal.appendAndFlush(root, 'team/member', {member})`（`roster.js:240-249`，
 * `member.id === childId`），**之后**才 `subagents.startContinuable(...)`（`:252`）。
 * 因此子代理 `agent/created` 触发时，这条 `team/member` 事件**一定**已经在 Lead 的
 * 会话日志里（`journal.js:53-55` 的 `session.append` 是同步的）。
 *
 * 反过来，子会话自己的日志在那一刻**只有** `subagent/descriptor` 一条
 * （`descriptor-seed.js:20-21`：`Session.create(childId, seed)` + `append('subagent/descriptor')`），
 * 初始 prompt 要等 `startContinuable` 返回后才由 `submitMaterialized` 投进 inbox
 * （`continuation.js:200-209`）—— 所以「读子会话的 prompt」在 `agent/created` 时**必然读不到**。
 */
export declare function teammateFromLeadJournal(ctxAny: {
    get?<T>(name: string): T | undefined;
}, leadId: string, childId: string): string | undefined;
/** 一个会话日志里的**事件类型序列**（只读，给 U2 的触发时机取证用）。 */
export declare function sessionEventTypes(ctxAny: {
    get?<T>(name: string): T | undefined;
}, sessionId: string): readonly string[] | null;
/** 探针的落地位置（`probe/out/` 是既有约定：所有取证文件都在这里）。 */
export declare function teamProbePaths(root: string): {
    logPath: string;
    bindingsPath: string;
};
/**
 * 建探针。`ctx` 是**插件自己的 ctx**（无 scope tag ⇒ `agent/created` 监听器全局被接纳，
 * 见 `dsh-scope/lib/index.js:327-338` 的 `tag === void 0 → true`）。
 *
 * `bindingSink` 是**可选**的落盘出口：传了就把绑定写进正式绑定表（与
 * `POST /session/binding` 同一条链）；不传则只记在探针内存里。这个开关让探针既能证明
 * 「绑定真的会被路由读到」，也能在离线自检里不碰任何文件。
 */
export declare function createTeamMemberProbe(ctx: unknown, root: string, config: ResolvedConfig, bindingSink?: (binding: SessionBinding) => void): TeamMemberProbeExtras;
export declare function apply(ctx: Context, rawConfig: unknown): void;
