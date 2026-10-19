/**
 * `pilot-cli` LLM 适配器 + 「选择本路由不得写入部署默认模型」闸门。
 *
 * ## 这个文件解决什么
 * 宿主 DSH 的会话轮次此前**只能**由宿主自己的供应商产生（`opencode-go` / `deepseek`）。
 * 本文件向 `ctx.llm` 注册一条**自有路由** `pilot-cli`，让「选它」的会话轮次真的由
 * 外部 CLI 产生（经过本插件既有的 launcher / headless 通道，与 `harness_dispatch` 同一条路径）。
 *
 * ## 契约依据（全部指到运行版 0.2.0-rc.2 的 file:line，见 docs/verified/llm-adapter-contract.md）
 * - `ctx.llm.registerAdapter(providers, adapter)`：`dsh-llm/lib/index.js:1833`；
 *   返回「可调用 disposer + `.replace()`」，随 fiber 自动销毁（`ctx.effect`，`:1843`）。
 * - `LlmAdapter` 只有 `stream` 是必填；其余 6 个方法有默认实现（`:1670-1740`）。
 * - **`listModels` 必须实现**：返回 `[]` 的路由会被 `buildModelCatalog` 丢掉
 *   （`dsh-api-session-controller/lib/index.js:541` 的 `filter(group => group.models.length > 0)`），
 *   选择器里**完全不可见** —— 这是 Path A 生效的硬前提。
 * - chunk 只有 7 种，**没有独立的 error/end chunk**：错误与中止是 `finish` 的 reason
 *   （`dsh-llm/lib/typert.host.js:308,504`）。缺 `finish` 会退化为 `{kind:'stop'}`（`:1100-1103`）。
 * - 严格语法校验器 `dsh-llm/invariant` 在**当前 profile 未挂载**（实测 profile 里 grep 无 invariant）——
 *   所以现在是宽容行为兜底。**本文件不依赖那份宽容**：chunk 序列按严格语法闭合。
 * - 路由名撞名会**响亮失败**（`DUPLICATE_ADAPTER`，`:1863`）；本文件把它变成可读错误。
 *
 * ## ⚠️ 固有代价（必须让用户看见，绝不允许让人以为「切过去以后工具照常可用」）
 * 外部 CLI **不走 DSH 的工具协议**：适配器只产出 `text` 块，从不产出 `tool-call` 块；
 * 而 DSH 的工具执行由「装配好的 assistant 消息里**存在 tool-call 块**」触发
 * （`dsh-agent-loop/lib/index.js:1151-1155`）⇒ 这些轮次里 `executeToolCalls` **从不被调用**，
 * **DSH 自己的工具全部惰性**。CLI 自己的工具照常工作，但跑在 CLI 自己的沙箱里，
 * DSH 的审批 / fs 沙箱 / spill / 保留策略**看不到它们**。
 * 另外：`options.tools` / `options.toolHistory` 对本适配器只是**输入**（会被渲染进 CLI 的
 * prompt 里当说明文字），下游没有任何东西强制它们。
 * 这条文字同时出现在 `/harness-pilot/api/llm-adapter` 的 `costDisclosure` 字段里。
 *
 * ## 改道在哪一层（**本轮的关键修正：归因必须诚实**）
 * 绑定驱动的改道**曾经**挂在 `llm/stream` 上短路（自己产 chunk）。那能拿到内容，却**改不了请求**：
 * 会话日志的 `request/header` 取自 `prepareRequest` 解析出的 config（`dsh-agent-loop:1179-1218`），
 * assistant 消息的 `source` 就是 `{provider: request.provider, model: request.model}`（`:1136-1143`）
 * ⇒ 在响应层改道，日志必然把外部 CLI 的产出记成**宿主路由**（`opencode-go` / `deepseek`）= 归因不实。
 * 现在改在 **`agent/request` 瀑布**上改写 config（`{prepend:true, global:true}`，且**永远先 `await next()`**）：
 * 请求本身就带真实来源，`request/header` 与 `assistant/message.source` 随之诚实。
 * 三条附带规则（都在离线探针里固化，理由见 `requestRouteDecisionFor`）：
 * ① **改道必须丢掉 `reasoningEffort`**（适配器没声明 reasoning，带着会被 `dsh-llm:2177-2178` 判
 * `UNSUPPORTED_REASONING_EFFORT`，整轮直接失败）；
 * ② **绑定之后**用户又在选择器里显式选过模型 ⇒ 让路（否则宿主的 `[model changed: …]` 通知会
 * 每一轮追加一次且内容为假，而那次选择永远消费不掉）；
 * ②b **子代理会话（`header.origin === 'subagent'`）显式委托的路由** ⇒ **保持**：调用方是用宿主
 * `subagent` 工具的 `provider`/`model`（或 profile 的 `agentOptions`）**点名**外部 harness 的，
 * 那不是本插件的残留。⚠️ 实测缺陷（2026-10-14，本条就是修它）：旧判定只认「无绑定 + 无显式选择」，
 * 而委托**不写** `model/selection` 事件 ⇒ 子代理的路由被改回部署默认（子会话
 * `request/header.config` 实测为 `opencode-go/deepseek-v4.1-flash`）—— 外部 harness 一行都没跑，
 * 界面上却是一轮正常回复。**静默替换是最坏的一类不实**，所以这条判据必须排在残留恢复之前；
 * ③ 路由停在 `pilot-cli` 但**已无外部绑定**、且会话日志里**没有**「显式选过本路由」的记录 ⇒
 * 判定为本插件改道留下的残留，**恢复成部署默认模型**（否则「解除绑定」后会话会永远留在外部 CLI 上，
 * 与界面文案「未绑定、或绑定为原生 DSH 的会话，对话轮次仍由 DSH 自己的供应商执行」矛盾）。
 * ⚠️ ③ 的适用范围**只**是「本插件改写过的普通会话」—— 已由 ②b 把子代理会话排除在外。
 *
 * ## 闸门（用户设定的硬性前提）：选 `pilot-cli` 不得写入**部署默认模型**
 * 背景（VERIFIED）：选择器选任何模型都会 `selectModel` → `agentDefaultModel.saveSelection`
 * → `configEditor.edit(...)` 改写 `profiles\desktop\cordis.yml` 里的 `agent-default-model`
 * 条目（`dsh-api-session-controller/lib/index.js:736` → `dsh-agent-default-model/lib/index.js:53-66`
 * → `dsh-config-editor/lib/index.js:69-135`）。
 *
 * **拦截点是怎么选的（如实交代）**：
 * - 「cordis 的 config 写入事件」**不存在**：运行中宿主的**完整** Event 目录里，
 *   与配置写入最接近的只有 `app-boot/config-reload`（写完之后才发）与 `settings/document-updated`（事后），
 *   没有任何可否决写入的事件。
 * - 因此唯一的否决点是**方法级**：`agentDefaultModel.saveSelection` 是公开服务契约
 *   （Inspect 可读、有 description），且是全宿主**唯一**的部署默认模型写入点
 *   （全树只有 2 个调用点：`selectModel` 与 `initializeDefaultModel`）。
 * - 本文件的做法：在该服务的**原始实例**上加一个自有属性覆盖 `saveSelection`
 *   （只在我们自己的路由上短路，其余原样转发给**真原方法**），disposer 里 `delete` 还原。
 *   ⇒ 这是**方法级替换**，不是事件钩子。这一点在报告与 `/api/llm-adapter` 的
 *   `gate.mechanism` 字段里**明写**，不包装成「有官方钩子」。
 * - **装不上就不注册路由**：若需要闸门却装不上（找不到 `saveSelection`、宿主 API 漂移），
 *   本文件**不注册** `pilot-cli`，并把原因如实回报（用户的授权是**有条件的**：
 *   没有这个闸门就不做 Path A）。
 *
 * ## 未确定 / 未验证（不得当成已确证）
 * - 是否有**其它**路径能把 `pilot-cli` 写进部署默认值（例如设置页某个「设为默认」按钮）：
 *   **未查**。闸门只覆盖 `agentDefaultModel.saveSelection` 这一条（已确证它是选择器那条路径）。
 * - 本机 profile 之外的 profile（headless / web）是否挂了 `dsh-llm/invariant`：**未查**；
 *   本文件按严格语法写，正是为了不依赖「没挂」这件事。
 * - 若另一个插件也替换同一个方法，谁赢取决于顺序：**未验证**（已用 `Symbol.for` 标记做幂等，
 *   但跨插件无法协调）。
 * - 请求层改道依赖两条**没有写进契约**的宿主面：`agent/request` 的 `payload.agent.id`，以及
 *   `ctx.sessions.get(id)` 上的 `seq` / `eventAt(seq)`（只读会话日志，用来区分「用户显式选过
 *   `pilot-cli`」与「本插件改道残留」）。宿主实现若变，判定退化成「读不到 ⇒ 保持不动」
 *   （fail-safe：不会误改请求，但「选择器让路」与「残留恢复」会失效）。可见于
 *   `/llm-adapter` 的 `requestLayer.picks.readable === false`。
 * - **live 证据覆盖三条分支**（2026-10-13 22:43–22:45，本轮补第三条）：
 *   ① 「绑定 → 宿主路由 → 改道」与 ② 「解除绑定 → 残留恢复」用真实轮次 + 宿主落盘转录取证；
 *   ③ 「绑定之后用户又显式选过模型 ⇒ 让路」也做了 live 实测：绑定 `opencode`，再走**真实**
 *   `ctx.sessionController.selectModel` 选 `pilot-cli/qoderclicn`，然后开一轮 ——
 *   `requestLayer.heldPicks` 0→1、`rewrites` 不变，会话日志落到 `pilot-cli/qoderclicn`
 *   （**不是**绑定目标 `opencode`）。判据与命令见 `probe/verify-llm-adapter-request-layer.mjs`。
 * - **UI 仍未在浏览器里确认**：`client/client.js` 的新文案只做过离线渲染断言，没有截图证据。
 * - **界面/说明文案的机制名已同步**（2026-10-13 22:5x，本轮）：`client/client.js` 的选择器座位句
 *   与 `src/federation/binding.ts` 的 `scopeNoteFor` 原来写着「绑定驱动的 `llm/stream` 改道已生效」——
 *   改道搬到请求层之后那句就是**假话**，两处都已改写为「请求层 `agent/request` 改写」。
 * - **`purpose` 辅助调用：旧版本会被跟着带进外部 CLI，本轮已加护栏修掉**（实测，不是推断）：
 *   宿主按「会话最后一次 `request/header` 的路由」解析辅助调用的目标
 *   （`dsh-session-title:344/424`、`dsh-compaction-basic:293`），而那条路由已被本插件改写成
 *   `pilot-cli` ⇒ 加护栏之前，**改道过的会话里会话标题 / 压缩会跟着跑到外部 CLI 并消耗它的额度**。
 *   现在的两道护栏见下面「purpose guard」一节（`installAuxScopeGuard`）：会话标题在
 *   `sessionTitle.startProvider` 漏斗处就把 route 换成 `ctx.agentDefaultModel` 的当前原生默认选择；
 *   压缩这类直接 `ctx.llm.stream` 的辅助调用在 `llm/stream` 上被**就地改写**（只改 options、只 `next()` 一次）。
 *   证据：`probe/verify-llm-adapter-aux-scope.mjs`（读宿主落盘转录 + 本适配器自己的派发条数）。
 *   ⚠️ 会话标题那道护栏是 `sessionTitle.startProvider` 的**方法级替换**（内部方法，不在 Inspect 契约里），
 *   装不上时如实报 `auxScope().sessionTitle.status === 'failed'`，**行为退回加护栏之前**。
 *
 * ## 回滚（两步，见报告）
 * 1. 禁用本插件（路由随 fiber 销毁，选择器分组下一轮 `llm/adapters-updated` 后消失）；
 * 2. 确认部署默认模型**不是** `pilot-cli`（否则新会话每轮 `NO_ADAPTER`）。
 */
import { type PickerVisibilitySpec } from './model-visibility.js';
import { type HarnessLlmProvider } from './harness-llm.js';
export declare const ROUTE = "pilot-cli";
/**
 * **首建目录**等待模型发现的**总预算**（毫秒，全局一个截止时刻）。
 *
 * 语义：`listModels` 会等 `awaitModelsFor` 那条**整轮预热**；超过这个时间就退回同步缓存清单，
 * 绝不让一次目录构建被某条卡住的 CLI 拖死。
 * ⚠️ 它必须由提供方（`src/index.ts`）统一把握：宿主逐 provider 建目录，
 * 若每个 provider 各自竞速，第一个被建的会先超时（实测 `harness-antigravity` 只剩 1 个模型）。
 */
export declare const MODEL_AWAIT_BUDGET_MS = 20000;
/** 读取当前生效的自有路由集合。 */
export declare function ownedRoutes(): readonly string[];
/** 这个 provider 是不是本插件的自有路由。 */
export declare function isOwnedRoute(provider: unknown): boolean;
/** 写入当前生效集合（**唯一**写入点）。 */
export declare function setOwnedRoutes(routes: readonly string[]): void;
/** 历史常量：**基础**自有路由。新代码请用 `ownedRoutes()` / `isOwnedRoute()`。 */
export declare const OWNED_ROUTES: readonly string[];
/** 这条文案必须与用户可见的界面文案一致（见报告里的 handoff 项）。 */
export declare const COST_DISCLOSURE: string;
/** 只声明本文件真正用到的宿主面（`get` / `effect` / `on` / `logger`）。 */
export interface PilotCliCtx {
    get?<T>(name: string): T | undefined;
    effect?(fn: () => () => void, label?: string): void;
    on?(name: string, listener: (...args: never[]) => unknown, options?: unknown): unknown;
    logger?: {
        info?(message: string): void;
        warn?(message: string): void;
    };
}
export interface PilotCliLogger {
    info?(message: string): void;
    warn?(message: string): void;
}
/** 一条**可宣传**的外部 CLI 目标（由 index.ts 用本插件自己的注册表求出）。 */
export interface PilotCliTarget {
    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    /** 该目标的通道；只有 `auto`（一次性 CLI 阶梯）才会被宣传。 */
    readonly transport?: string;
    /**
     * 会话「推理等级」声明（与 TargetConfig.thinking 同形；2026-10-15）。
     * resolveModel 用它产出宿主 reasoning 元数据；dispatch 用它的 args 模板落命令行。
     */
    readonly thinking?: {
        readonly levels: readonly {
            readonly id: string;
            readonly name: string;
        }[];
        readonly default: string;
        readonly args: readonly string[];
    };
}
export declare const MODEL_CHOICE_SEP = "::";
/** 会话模型菜单里每目标的默认上限（`sessionModelLimit` 未提供时用它）。 */
export declare const SESSION_MODEL_LIMIT_FALLBACK = 10;
/** 每个目标最多向选择器宣传多少个真实模型（扁平列表的可读性上限；不影响实际可用模型）。 */
/** Native picker supports search. Never truncate a CLI's selectable catalog. */
export declare const MAX_MODELS_PER_TARGET = 10;
/** 把选择槽解析成（目标名，模型 | undefined）。不校验存在性 —— 校验在 stream，那里才能给可读错误。 */
export declare function splitModelChoice(id: string): {
    readonly target: string;
    readonly model: string | undefined;
};
/** 逆向：目标名 + 模型 ⇒ 选择槽 id。 */
export declare function composeModelChoice(target: string, model: string): string;
export interface PilotCliDispatchRequest {
    readonly target: string;
    readonly prompt: string;
    readonly accountId?: string;
    readonly sessionId?: string;
    readonly transport: string;
    readonly signal: AbortSignal;
    /**
     * 本轮要用的**模型 id**（可选）。
     *
     * ⚠️ 与 `stream()` 里那个 `model` **同名不同义**：那里是 `pilot-cli` 路由的**目标名**，
     * 这里是真正要交给 CLI 的模型。本字段存在的理由就是「绑定里的模型不能被静默丢掉」——
     * 见 `PilotCliDeps.frozenModelFor` 与 `streamFor()` 里 `const model = frozenModel ?? boundModel`。
     */
    readonly model?: string;
    /**
     * 会话选择的**推理等级**（可选；宿主已按 `resolveModel` 声明的词表校验过）。
     * dispatch 的默认实现把它按目标 `thinking.args` 模板落到命令行；目标没声明时不该出现。
     */
    readonly reasoningEffort?: string;
    /**
     * **已固化的账户配方**（团队路由专用）。
     *
     * 为什么需要它：`dispatch` 的默认实现会在**调用这一刻**用 `withAccountTarget()` 按
     * 「账号档案现在长什么样」重新合并配置目录与参数。对**团队成员**而言这是错的 ——
     * 成员的身份在 `harness_spawn_teammate` 的 `prepare()` 那一刻就冻结了，
     * 之后档案被改名/停用/删除都**不得**改变这位成员（`src/team-routing.ts` 的纪律）。
     *
     * 给了它 ⇒ 实现方**必须**用它，**不得**再调 `withAccountTarget`；`accountId` 只作为
     * 记录用的身份标签（`actual.accountId`），**不得**用它重新解算配方。
     * 不给 ⇒ 老行为完全不变。
     */
    readonly frozenAccount?: {
        readonly accountId: string;
        readonly args: readonly string[];
        readonly env: Readonly<Record<string, string>>;
        /** 已在构造处脱敏的作用范围说明。 */
        readonly note: string;
    };
}
export interface PilotCliDispatchResult {
    readonly ok: boolean;
    readonly text?: string;
    readonly stopReason?: string;
    readonly diagnostic?: string;
    readonly transport?: string;
    readonly mismatch?: readonly string[];
    /** 未 ok 时的可读原因。 */
    readonly reason?: string;
    readonly facts?: Readonly<Record<string, string | number | boolean | undefined>>;
}
export interface PilotCliBindingLike {
    readonly harnessKind?: string;
    readonly harnessId?: string;
    readonly accountId?: string;
    /** 绑定的写入时间（ISO 字符串，binding store 每条都有）。用于「绑定之后用户又显式选过模型」的判定。 */
    readonly setAt?: string;
}
export interface PilotCliDeps {
    readonly onExecution?: (sessionId: string, identity: import('./session-identity.js').SessionExecutionIdentity) => void;
    readonly logger?: PilotCliLogger;
    /** 可宣传目标（同步、**不得**起子进程：目录读取很频繁）。 */
    readonly targets: () => readonly PilotCliTarget[];
    /** 一次性派发。实现方必须显式指定通道，且**永不 reject**（异常折叠成 `{ok:false}`）。 */
    readonly dispatch: (input: PilotCliDispatchRequest) => Promise<PilotCliDispatchResult>;
    /** 会话绑定（binding store 当前值）。 */
    readonly bindingFor?: (sessionId: string) => PilotCliBindingLike | undefined;
    /** 账号池默认账号（优先级：显式 > 绑定 > 默认）。 */
    readonly defaultAccountId?: () => string;
    /**
     * **按目标分域**的账号池默认账号（与 `defaultAccountId` 二选一；同时给时以本字段为准）。
     *
     * 返回 `accountId: ''` + `ignoredReason` 表示「池里的默认账号不属于这条目标的 harness」——
     * 这时**不套用**它（但要把原因写进备注），绝不因此让整轮请求失败。
     */
    readonly defaultAccountFor?: (targetName: string) => {
        readonly accountId: string;
        readonly ignoredReason: string | null;
    };
    /**
     * **团队成员的冻结账户配方**（按会话 id 查；`undefined` = 该会话不是团队路由成员）。
     *
     * 存在的理由只有一条：成员的身份在创建那一刻冻结，之后账号档案的任何变化都**不得**
     * 改变这位成员。给了它 ⇒ 这一轮用**这一份**配方派发，且**不**再走按当下档案重算的路径。
     * 未挂载 / 返回 `undefined` ⇒ 行为与从前完全一致。
     */
    readonly frozenAccountFor?: (sessionId: string) => {
        readonly accountId: string;
        readonly args: readonly string[];
        readonly env: Readonly<Record<string, string>>;
        readonly note: string;
    } | undefined;
    /**
     * **团队成员冻结的模型 id**（按会话 id 查；`undefined` = 没有冻结模型）。
     *
     * 为什么不复用 `bindingFor(...).model`：那条路**本来就读不到** —— 改道决策产出的
     * `selection.model` 是**目标名**（`pilot-cli` 路由的 model 语义），与「模型 id」不是一回事。
     * 于是绑定里写着模型，CLI 却按自己的默认模型跑（**静默丢弃**）。
     * 本钩子把「成员创建时冻结的模型」直接交给派发，未挂载则退回 `bindingFor(...).model`。
     */
    readonly frozenModelFor?: (sessionId: string) => string | undefined;
    /**
     * 目标自报的**真实模型**（同步、只读缓存、**不得**起子进程：目录读取很频繁）。
     *
     * 为什么需要：`pilot-cli` 路由的 model 槽以前**只有目标名** ⇒ 选择器里看得见 harness，
     * 却没有「这个 harness 的哪个模型」可选（用户两条反馈的共同根因）。本钩子把发现层
     * （与 `/api/models` / `harness_models` 同一套解析器）的模型清单接进目录出口，
     * 形状是各 CLI `-m` 真正接受的 `provider/model`。未命中缓存 ⇒ 只宣传「默认模型」条目。
     */
    readonly modelsFor?: (targetName: string) => readonly string[] | undefined;
    /**
     * 缓存未命中时的**后台预热**入口（可不挂；挂了则下一次目录刷新就能看到真实模型）。
     * 实现方自己限流/去重；本模块只负责说“谁需要热”。
     */
    readonly warmModelsFor?: (targetName: string) => void;
    /**
     * **有界等待版**的模型发现（可选）。挂了就用它，`listModels` 会在**首次建目录**时
     * 等到这一组的模型真的报出来为止（上限见 `MODEL_AWAIT_BUDGET_MS`）。
     *
     * 背景（2026-10-15 实测缺陷）：宿主第一次 `modelCatalog()` 常常早于插件的后台预热完成，
     * 而 `listModels` 原本只读同步缓存 ⇒ 那一组只剩「CLI 默认模型」一条
     * （插件重载后实测 Qoder 国内 14 → 1、国际 2 → 1），要等下一次目录刷新才恢复 ——
     * 对用户就是「点开折叠看不到该 harness 的模型」。这里改成**等已在进行中的预热**。
     */
    readonly awaitModelsFor?: (targetName: string) => Promise<readonly string[] | undefined>;
    /**
     * 会话模型菜单里每个目标最多列多少个模型（0 = 不限）。未提供时用内置默认 10。
     *
     * 这是「会话精简 / 设置完整」这条切分的执行点：本机实测不限制时
     * 宿主模型目录会变成 734 条扁平条目（Pi 98 + OpenCode 486 + …），
     * 用户根本找不动。设置页的完整清单走 `/api/models`，**不受此值影响**。
     */
    readonly sessionModelLimit?: () => number;
    /**
     * **每个 harness 一条 LLM provider** 的规格（同步、便宜）。
     *
     * 由 `src/harness-llm.ts` 的 `buildHarnessLlmProviders()` 从目标表算出。给了它：
     *   · 这些 provider 会被一起注册进 `ctx.llm`（`registerAdapter(providers, adapter)` 本就收多路由）；
     *   · 它们在原生选择器里就是「一个 harness 一个分组」（宿主只按 provider 分组，无组级折叠）；
     *   · `listModels(provider)` 返回**该 harness 的全部模型**（不截断）；
     *   · 它们同时进入**自有路由集合**（闸门/purpose guard/请求层判定都认）。
     * 未挂载 ⇒ 只有历史 `pilot-cli` 一条路由，行为与本轮之前一致（可回滚）。
     */
    readonly harnessProviders?: () => readonly HarnessLlmProvider[];
    /**
     * **会话选择器可见性**（2026-10-15，用户要求「模型选择列表不要这么长」）：
     * Legacy hook retained for compatibility; listModels no longer applies GUI visibility.
     *
     * ⚠️ 只影响**宣传面**：执行校验（`streamForProvider`）仍用 `mergeHarnessModels` 的全量实时清单，
     * 所以「隐藏/超限」的模型只是不再出现在菜单里，**已选中它的会话照常执行**；
     * 子代理候选（`candidatesFor`）也不过这里 —— 两处互不牵连。
     */
    readonly pickerVisibility?: (providerId: string) => PickerVisibilitySpec;
}
export interface PromptInput {
    readonly system?: unknown;
    readonly messages?: unknown;
    readonly tools?: unknown;
    readonly purpose?: unknown;
}
/**
 * 把 DSH 的 `GenerateOptions` 渲染成**一次 CLI 调用的 prompt**。
 *
 * 这是适配器自己的渲染（契约允许：`messages`/`system`/`tools` 对适配器只是输入，
 * 见 llm-adapter-contract.md §4.4）。渲染是**显式**的：工具 schema 会被列出来当说明，
 * 并明写「DSH 不会执行它们」。
 */
export declare function renderPrompt(options: PromptInput): string;
/** 7 种 chunk 里本适配器真正产出的 4 种（严格闭合形态）。 */
export type PilotCliChunk = {
    type: 'block-start';
    index: number;
    blockType: 'text';
} | {
    type: 'text-delta';
    index: number;
    text: string;
} | {
    type: 'block-end';
    index: number;
    block: {
        type: 'text';
        text: string;
    };
} | {
    type: 'finish';
    reason: PilotCliFinishReason;
};
export type PilotCliFinishReason = {
    kind: 'stop';
} | {
    kind: 'aborted';
    failure: {
        message: string;
        code: string;
    };
} | {
    kind: 'error';
    failure: {
        message: string;
        code: string;
    };
};
export declare class PilotCliError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * 一次派发结果 → **严格闭合**的 chunk 序列。
 *
 * 纪律（为什么这样写）：
 * - `block-start` 先于任何 delta（严格语法要求同类型的开块存在）；
 * - 只产出 text 块 ⇒ **绝不触发 DSH 的工具执行**（这是固有代价，不是 bug）；
 * - **不产出 usage**：外部 CLI 的真实 token 数我们不知道，**不许编**；
 * - 终止恰好一个 `finish`；错误/中止走 reason，不走「异常 chunk」（协议里没有那种东西）；
 * - 空回复**不算成功**：`stopReason=completed` 但正文为空 ⇒ 报 `PILOT_CLI_EMPTY` 错误。
 *   （「退出码 0 / 界面显示完成」都不等于拿到了回复 —— 本项目反复栽在这上面。）
 */
export declare function buildChunks(input: {
    readonly text: string;
    readonly stopReason: string;
    readonly diagnostic?: string;
    readonly target: string;
}): PilotCliChunk[];
/**
 * 闸门判定：**只**拦本插件自己的路由。
 *
 * 纯函数，便于离线断言与线上自检共用同一份判定；未知形状一律**转发**（fail-open 到原实现，
 * 因为被挡住的写入是宿主自己的合法行为，而我们对未知形状一无所知 —— 宁可不动）。
 */
export declare function gateDecisionFor(provider: unknown, owned?: readonly string[]): 'block' | 'delegate';
/**
 * 改道判定（第 3 步的规则集；**现在只被请求层复用**，见 `requestRouteDecisionFor`）。
 *
 * ⚠️ 它原来服务的是 `llm/stream` 上的响应层短路监听器 —— **那个监听器已移除**
 * （响应层的产出无法被诚实归因）。`purpose` 这一条保留下来，是因为请求层的判定里
 * `purpose` 恒为 `undefined`（agent loop 的一轮从不带 purpose），需要它把「辅助调用不进改道」
 * 这件事在离线判据里固定住。
 *
 * 规则（每条都有理由）：
 * - `options.provider === ROUTE` ⇒ `next`：本来就是我们自己的路由，**不**改道（否则会自己套自己）。
 * - `options.purpose !== undefined` ⇒ `next`：压缩 / 会话标题这类辅助调用**不由本插件改写**
 *   （它们不走 `agent/request`）。⚠️ 但这**不等于**它们落在宿主供应商上：宿主按会话最后一次
 *   `request/header` 的路由解析它们，而那条路由可能已被改道成 `pilot-cli` —— 实测见
 *   `probe/verify-llm-adapter-aux-scope.mjs`。
 * - 没有 `sessionId` 或没有绑定 ⇒ `next`。
 * - 绑定必须是 `harnessKind === 'external'`（`dsh` / 空 = native = 明确要求留在 DSH）。
 * - 绑定目标必须在**可宣传**集合里（否则会拿一个 CDP/窗口级目标去做一次性 headless 派发）。
 */
export declare function routeDecisionFor(input: {
    readonly provider: unknown;
    readonly purpose: unknown;
    readonly sessionId: unknown;
    readonly binding: PilotCliBindingLike | undefined;
    readonly advertised: readonly string[];
}): {
    readonly action: 'next' | 'route';
    readonly reason: string;
    readonly target?: string;
};
/** 会话日志里一条事件的最小面（只读 `type` / `time` / `data`）。 */
export interface SessionEventLike {
    readonly type?: unknown;
    readonly time?: unknown;
    readonly data?: unknown;
}
/** 用户在**选择器**里显式选过的模型（宿主 `selectForNextRequest` 会 append `model/selection`）。 */
export interface ExplicitPick {
    readonly provider: string;
    readonly model: string;
    /** 事件时间（ms，宿主写入的 `event.time`；拿不到记 0）。 */
    readonly time: number;
}
/** 增量折叠状态：`seq` = 已消费的事件数，`pick` = 到目前为止最新的一次显式选择。 */
export interface PickFold {
    readonly seq: number;
    readonly pick: ExplicitPick | null;
}
/**
 * 折叠 `model/selection` 事件（纯函数）。
 *
 * 这是**唯一**能区分「用户显式选了 pilot-cli」与「本插件改道留下的路由」的持久记录：
 * - `session.requestHeader()` 只记最后用过的路由，两种情况一模一样；
 * - `sessionProjections` 的 `modelSelection` 视图把已消费的选择并进 `lastUsed`，同样分不出来
 *   （`dsh-api-session-controller/lib/index.js:2072-2088`）。
 * `model/selection` 只由 `selectForNextRequest` 追加（= 选择器那条路，`:319-322`）。
 */
export declare function foldExplicitPicks(events: readonly SessionEventLike[], from: PickFold): PickFold;
/** 一次请求层判定要看的全部输入（**纯数据**，便于离线固化）。 */
export interface RequestDecisionInput {
    /** 内层瀑布（含 GUI 选择器）解析出来的 config，原样传进来。 */
    readonly resolved: {
        readonly provider?: unknown;
        readonly model?: unknown;
    } | undefined;
    readonly sessionId: unknown;
    /**
     * 发起这次请求的会话**归属**（宿主 `session.header.origin`；rc.2 `dsh-session` 的
     * `validateSessionHeader` 只允许 `'subagent'` 这一个取值，本仓库已实测读到）。
     *
     * 为什么它是**必需**判据（2026-10-14 实测缺陷，不是防御性编程）：
     * `pilot-cli` 路由有两个来源，旧判定把第二个当成了第一个：
     *   · ① **本插件按绑定改写**出来的 —— 用「无绑定 + 无显式选择」判成残留是对的；
     *   · ② **调用方显式委托**给外部 harness 的 —— 宿主 `subagent` 工具的 `provider`/`model`、
     *     或 profile 里的 `agentOptions` 就是这样把子代理放到 `pilot-cli/<目标>::<模型>` 上的。
     *     它表现为 `origin='subagent'` 的子会话，而它的会话日志里**不会有** `model/selection`
     *     事件（那条只由 GUI 选择器写）⇒ ② 被误判成 ①，子代理**自己点名**的外部路由被改回部署
     *     默认模型（实测：子会话 `request/header.config` 变成 `opencode-go/deepseek-v4.1-flash`）。
     *     后果是外部 harness **一行都没跑**，而界面上是一轮正常回复 —— 静默替换，最坏的一类不实。
     */
    readonly sessionOrigin?: unknown;
    readonly binding: PilotCliBindingLike | undefined;
    /** 可宣传的目标名（= 能做一次性 headless 派发的目标）。 */
    readonly advertised: readonly string[];
    /** 会话日志里最新的显式选择；`null` = 没有；`undefined` = 读不到。 */
    readonly lastPick: ExplicitPick | null | undefined;
    /** 会话日志是否**真的**读到了（false ⇒ 绝不恢复残留，宁可不动）。 */
    readonly picksReadable: boolean;
    /** 部署默认模型（用于恢复残留）。 */
    readonly defaultSelection: {
        readonly provider?: unknown;
        readonly model?: unknown;
        readonly reasoningEffort?: unknown;
    } | undefined;
}
export interface RequestDecision {
    readonly action: 'next' | 'rewrite' | 'restore';
    readonly reason: string;
    /** rewrite 时的目标（外部 CLI 名）。 */
    readonly target?: string;
    /** 要写进 config 的 provider/model（rewrite = 本插件路由；restore = 宿主默认模型）。 */
    readonly selection?: {
        readonly provider: string;
        readonly model: string;
        readonly reasoningEffort?: string;
    };
}
/** 一次请求层判定的留档（接口对外暴露，便于取证）。 */
export interface RequestLayerDecision {
    readonly at: string;
    readonly sessionId: string;
    /** 会话归属（`header.origin`）；`'subagent'` = 这次请求是子代理会话发出的。 */
    readonly sessionOrigin: string | null;
    readonly action: 'next' | 'rewrite' | 'restore';
    readonly reason: string;
    readonly target: string | null;
    readonly from: {
        readonly provider: string;
        readonly model: string;
    };
    readonly to: {
        readonly provider: string;
        readonly model: string;
        readonly reasoningEffort?: string;
    } | null;
    readonly binding: {
        readonly harnessKind: string | null;
        readonly harnessId: string | null;
        readonly setAt: string | null;
    } | null;
    readonly explicitPick: ExplicitPick | null;
}
/** 请求层改道的运行状态（每次读取都**重新取**，不是固定快照）。 */
export interface RequestLayerState {
    readonly installed: boolean;
    readonly layer: 'agent/request';
    readonly prepend: boolean;
    readonly global: boolean;
    readonly decisions: number;
    readonly rewrites: number;
    readonly restores: number;
    /** 「绑定之后用户又显式选过模型 ⇒ 我们让路」的次数。 */
    readonly heldPicks: number;
    /**
     * 「子代理会话（`origin='subagent'`）显式委托的 `pilot-cli` 路由被**保留**」的次数。
     *
     * 这个计数器是 2026-10-14 那个实测缺陷的**现场指标**：修之前它恒为 0，而
     * `restores` 会涨（子代理的路由被当成残留改回部署默认模型）。
     */
    readonly subagentKept: number;
    /** 判定自身出错并被原样放行的次数（0 才是正常）。 */
    readonly errors: number;
    readonly lastDecision: RequestLayerDecision | null;
    readonly lastError: string | null;
    readonly picks: {
        readonly readable: boolean | null;
        readonly sessionId: string | null;
        readonly pick: ExplicitPick | null;
    };
}
/**
 * 请求层改道判定（纯函数，运行期**同一份**实现）。
 *
 * 与响应层的 `routeDecisionFor` 共用「绑定 → 可宣传目标」那几条规则，另外加了三条请求层独有的：
 * 选择器优先、`reasoningEffort` 必须丢、无绑定时的残留恢复。
 */
export declare function requestRouteDecisionFor(input: RequestDecisionInput): RequestDecision;
/**
 * 把判定结果落到 config 上（纯函数）。
 *
 * `dropReasoningEffort` 只在改道时开：外部 CLI 的推理档位不是 DSH 的 effort，
 * 且适配器没声明 reasoning ⇒ 留着会被 `dsh-llm` 判成 `UNSUPPORTED_REASONING_EFFORT`。
 */
export declare function applyRequestSelection(resolved: unknown, selection: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}, dropReasoningEffort: boolean): Record<string, unknown>;
/** 原生默认选择的**可用形状**（provider + model 都是非空字符串）。 */
export interface NativeSelection {
    readonly provider: string;
    readonly model: string;
}
/**
 * 从 `ctx.agentDefaultModel.currentSelection()` 的返回值里取出可用路由。
 *
 * 三条拒绝规则（都要计数，不许静默）：
 * - 不是 `{provider, model}` 形状（服务没挂 / API 漂移 / 读到 `undefined`）⇒ 读不到；
 * - provider 或 model 是空串 ⇒ 读不到；
 * - provider ∈ 本插件自有路由 ⇒ **不许把自己指给自己**（闸门保证部署默认模型不会被写成
 *   `pilot-cli`，但真出现时这里必须拒绝，否则就是把辅助调用从一条死路换到另一条死路）。
 */
export declare function nativeSelectionOf(value: unknown): NativeSelection | undefined;
/** 一次辅助调用落点判定的留档（两种入口共用）。 */
export interface AuxScopeRecord {
    readonly at: string;
    readonly entry: 'llm/stream' | 'sessionTitle.startProvider';
    readonly action: 'next' | 'rewrite';
    readonly reason: string;
    readonly purpose: string | null;
    readonly from: {
        readonly provider: string;
        readonly model: string;
    } | null;
    readonly to: {
        readonly provider: string;
        readonly model: string;
    } | null;
}
/** `llm/stream` 监听器的判定输入（**纯数据**，便于离线固化）。 */
export interface AuxScopeInput {
    readonly provider: unknown;
    /** `purpose` 是宿主对「这不是用户的一轮」的标记；agent loop 的一轮**从不带它**。 */
    readonly purpose: unknown;
    /** 调用方给的对象是不是冻结的（冻结 ⇒ **不能**就地改写）。 */
    readonly frozen: boolean;
    /** 该对象是否已带本插件的一次性标记（＝我们改写过的对象又回来了）。 */
    readonly marked?: boolean;
    readonly defaultSelection: {
        readonly provider?: unknown;
        readonly model?: unknown;
    } | undefined;
}
export interface AuxScopeDecision {
    readonly action: 'next' | 'rewrite';
    readonly reason: string;
    readonly selection?: NativeSelection;
}
/**
 * `llm/stream` 辅助调用判定（纯函数，运行期**同一份**实现）。
 *
 * 规则顺序即优先级，每条都有理由：
 * 1. `purpose === undefined` ⇒ `next`：**用户的轮次一律不碰**（主会话选择不变，1.3 不受影响）；
 * 2. `marked` ⇒ `next`：本插件已改写过的对象又回到这里（＝发生了我们没设计过的重入）；计数并放行。
 *    这一条必须排在 provider 判定**之前** —— 我们改写后的对象 provider 已经不再是本插件路由，
 *    排在后面就永远不可达（那会让「重入观测」变成一个恒为 0 的假计数器）；
 * 3. `provider !== ROUTE` ⇒ `next`：本来就不在本插件路由上，**不是我们的污染，我们不接手**；
 * 4. 原生默认选择读不到 / 就是本插件路由 ⇒ `next`：**没有可去的宿主供应商**，宁可保持原样
 *    （改前行为）也不猜一个；
 * 5. `frozen` ⇒ `next`：冻结对象改不了 ⇒ 放行并计数（**不许**抛，也不许复制出一份偷偷派发）；
 * 6. 其余 ⇒ `rewrite`：就地改成原生默认选择。
 */
export declare function auxScopeDecisionFor(input: AuxScopeInput): AuxScopeDecision;
export interface AuxRouteOverride {
    readonly changed: boolean;
    readonly reason: string;
    /** 交给下游的 route（未改时**原样**返回入参，绝不复制）。 */
    readonly route: unknown;
    readonly selection?: NativeSelection;
}
/**
 * `sessionTitle.startProvider` 的 route 判定（纯函数）。
 *
 * 三种情形：route 不是 `{provider, model}` 形状 / provider 不是本插件路由 / 原生默认读不到
 * ⇒ **原样返回**（`changed:false`）；只有「route 正是被本插件改道成 `pilot-cli` 的那条」
 * 才换成原生默认选择。**幂等**：换过之后 provider 不再是 `pilot-cli`，再进来必然不改。
 */
export declare function auxRouteOverrideFor(route: unknown, defaultSelection: unknown): AuxRouteOverride;
/**
 * 就地改写一个**未冻结**的 options 对象：换 provider/model、丢掉显式 `reasoningEffort`、
 * 打上一次性标记。
 *
 * - 丢 `reasoningEffort`：与请求层改道同一条理由 —— 辅助调用的 effort 是**为原来那条路由**表达的，
 *   换路由后留着可能被 `dsh-llm` 判 `UNSUPPORTED_REASONING_EFFORT`（`dsh-llm:2177-2178`）；
 *   我们**不替宿主模型声称**任何档位（适配器默认档位由宿主自己materialize）。
 * - 标记用 `defineProperty` 且 `enumerable:false`：不会被展开/序列化带走，只服务于「重入观测」。
 *
 * @returns 实际发生的动作（便于计数与取证）。
 */
export declare function applyAuxSelectionInPlace(options: unknown, selection: NativeSelection): {
    readonly ok: boolean;
    readonly droppedReasoningEffort: boolean;
    readonly error?: string;
};
/** 哈希一个文件（读不到返回 `null`）；只用于「profile 有没有被改写」的证据，**不返回内容**。 */
export declare function hashFileOrNull(file: string): string | null;
/** 一个 profile 文件在一次观测里的样子（**只有哈希与 mtime，没有内容**）。 */
export interface ProfileFileSnapshot {
    readonly role: 'configEditor-document' | 'composition';
    readonly path: string;
    readonly hash: string | null;
    readonly mtime: string | null;
}
export interface ProfileEvidence {
    readonly path: string | null;
    readonly hash: string | null;
    readonly mtime: string | null;
    readonly files: readonly ProfileFileSnapshot[];
    readonly note: string;
}
/**
 * 前后两次观测的对比。哈希**与** mtime 都要一致才算没被改写 ——
 * 只看哈希会漏掉「内容相同但文件被重写」（writeFileAtomic 走 rename，mtime 一定变）。
 */
export declare function compareProfileSnapshots(before: readonly ProfileFileSnapshot[], after: readonly ProfileFileSnapshot[]): {
    readonly rows: readonly Record<string, unknown>[];
    readonly unchanged: boolean;
};
/** 文件 mtime（毫秒字符串）；读不到返回 `null`。哈希+mtimes 一起看，识别「内容相同但被重写」。 */
export declare function mtimeOrNull(file: string): string | null;
export interface GateRecord {
    readonly at: string;
    readonly provider: string;
    readonly model: string;
}
export interface GateState {
    /** `armed` = 已装上并且会拦；`not-needed` = 宿主根本没有写入路径；`failed` = 需要但装不上。 */
    readonly status: 'armed' | 'not-needed' | 'failed';
    readonly reason: string;
    readonly mechanism: string;
    readonly service: string;
    readonly method: string;
    readonly ownedRoutes: readonly string[];
    /** 覆盖的是不是**真原方法**（原型链上那一个）—— 证明非自有 provider 仍然走宿主实现。 */
    readonly baseIsPrototypeMethod: boolean;
    readonly baseIdentity: string;
    readonly profilePath: string | null;
    readonly blocked: number;
    readonly delegated: number;
    readonly lastBlocked: GateRecord | null;
    readonly lastDelegated: GateRecord | null;
    readonly installedAt: string | null;
}
export interface GateHandle {
    /**
     * **每次调用都重新取快照**。计数器是活的，绝不能把快照对象固定下来 ——
     * 实测踩过：固定对象会让 `blocked`/`delegated` 永远显示 0，看着像「闸门没生效」。
     */
    snapshot(): GateState;
    dispose(): void;
}
/**
 * 装闸门。**返回 `status !== 'armed'` 时调用方必须据此决定是否注册路由。**
 *
 * 两种「不需要闸门」的情形（此时该状态是**结论**，不是偷懒）：
 * - `ctx.agentDefaultModel` 未挂载 ⇒ 没有这个服务，选择器那条路径根本不存在；
 * - `ctx.configEditor` 未挂载 ⇒ `saveSelection` 第二行就 `return`，**不可能**有任何 profile 写入。
 */
export declare function installDefaultModelGate(ctx: PilotCliCtx, logger?: PilotCliLogger): GateHandle;
export interface AuxScopeStreamState {
    readonly installed: boolean;
    readonly layer: 'llm/stream';
    readonly prepend: boolean;
    readonly global: boolean;
    /** 本监听器被**进入**的次数（含主轮，主轮在判定第 1 条就放行）。 */
    readonly entries: number;
    /** 其中 `purpose !== undefined` 的次数（＝真正的辅助调用）。 */
    readonly auxEntries: number;
    readonly rewrites: number;
    readonly passThrough: number;
    /** `purpose` 在、provider 是本插件路由、但对象**冻结** ⇒ 按原样放行（应为 0）。 */
    readonly frozenSkips: number;
    /** 放行次数 —— **必须等于 `entries`**（每次进入恰好 `next()` 一次，绝不吞流）。 */
    readonly nextCalls: number;
    readonly errors: number;
    readonly lastDecision: AuxScopeRecord | null;
    readonly lastError: string | null;
}
export interface AuxScopeTitleState {
    /** `armed` = 已装上并会改；`not-needed` = 宿主没这个服务；`failed` = 需要却装不上（**行为退回改前**）。 */
    readonly status: 'armed' | 'not-needed' | 'failed';
    readonly reason: string;
    readonly service: string;
    readonly method: string;
    /** 覆盖的是不是原型链上的**真原方法**（证明只是加了前置改写，没有替换掉宿主实现）。 */
    readonly baseIsPrototypeMethod: boolean;
    readonly baseIdentity: string;
    /** 被本包装看到的 `startProvider` 调用次数。 */
    readonly calls: number;
    /** 其中真的把 route 换成原生默认选择的次数。 */
    readonly overrides: number;
    readonly lastOverride: AuxScopeRecord | null;
    readonly installedAt: string | null;
}
export interface AuxScopeState {
    readonly installed: boolean;
    readonly note: string;
    /** 原生默认选择的读取情况（`readable:false` ⇒ 两道护栏都**不动**任何东西）。 */
    readonly nativeDefault: {
        readonly readable: boolean;
        readonly provider: string | null;
        readonly model: string | null;
        readonly reads: number;
        /** 读取中被拒的次数（形状不对也算一次：`readable:false` 且 `failures>0` ⇒ 服务在，但读不出可用路由）。 */
        readonly failures: number;
        readonly lastError: string | null;
    };
    readonly stream: AuxScopeStreamState;
    readonly sessionTitle: AuxScopeTitleState;
    readonly recursion: {
        readonly mechanism: string;
        readonly entries: number;
        readonly nextCalls: number;
        /** 恒为 1 才正常：同步重入（唯一可能的递归形状）会把它抬到 ≥2。 */
        readonly maxSyncDepth: number;
        /** 恒为 0 才正常：我们改写过的对象一次也没有再回到本监听器。 */
        readonly markedReentries: number;
        readonly note: string;
    };
    readonly lastDecision: AuxScopeRecord | null;
    readonly lastError: string | null;
}
export interface AuxScopeHandle {
    /** **每次调用重新构造快照**（计数器是活的；固定快照会让它永远显示 0）。 */
    snapshot(): AuxScopeState;
    dispose(): void;
}
/**
 * 装 purpose guard。返回值的 `status` 必须被如实对外报出 ——
 * `sessionTitle.failed` 意味着**会话标题这条护栏没生效**，不得当成「已修」。
 */
export declare function installAuxScopeGuard(ctx: PilotCliCtx, logger?: PilotCliLogger): AuxScopeHandle;
export interface PilotCliRecord {
    readonly at: string;
    readonly kind: 'route' | 'redirect';
    readonly target: string;
    readonly sessionId?: string;
    readonly accountId?: string;
    readonly stopReason: string;
    readonly chars: number;
    readonly ms: number;
    readonly error?: string;
    readonly mismatch?: readonly string[];
}
/**
 * 适配器：把 DSH 的一轮请求交给外部 CLI。
 *
 * **不继承宿主的 `LlmAdapter` 类**（刻意的）：本插件 `node_modules/@deepseek-ai/dsh-llm` 是
 * 从 asar 抽出的**另一份模块实例**，`class extends` 会引入「两份同类」的隐性风险；
 * 而 `registerAdapter` 只做鸭子类型校验（`providerInfo` 的 id/name，`dsh-llm:1864-1865`）。
 * 这里把 7 个方法**显式全部实现**，不依赖任何默认实现。
 */
export declare class PilotCliAdapter {
    private readonly deps;
    private readonly record;
    constructor(deps: PilotCliDeps, record: (entry: PilotCliRecord) => void);
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    /** 不声明重试策略 ⇒ 用宿主默认（重试一次外部 CLI 是安全的：每次调用都是独立的一次性进程）。 */
    providerRetryPolicy(_provider: string): undefined;
    /** 图片计价：外部 CLI 这条链路不传图（渲染时如实标注「图片内容对 CLI 不可见」），故无价可报。 */
    imageRequestPricing(_provider: string, _model: string): undefined;
    /**
     * **必须实现**：返回空数组的路由会被 `buildModelCatalog` 丢掉，选择器里完全不可见
     * （`dsh-api-session-controller/lib/index.js:541`）。
     *
     * ## 2026-10-14 起：一个 harness = 一个 provider（分组即折叠）
     * 宿主只按 provider 分组，且没有组级折叠原语（见 `src/harness-llm.ts` 文件头）。
     * 所以这里对**每条 `harness-*` 路由**返回**该 harness 的全部模型**（`cli-default` 之外逐条列出，
     * **不截断**：用户明确要求「点开折叠后才是该 harness 的全部模型」，`sessionModelLimit` 不再作用于这里）。
     *
     * ## 选择器可见性与子智能体独立
     * 宿主子智能体设置同样读取本目录，故不能在这里按会话显示设置删模型。
     * 分组/逐模型/数量配置由 client/grouped-models.js 的会话菜单消费；原生子代理保留全量。
     *
     * ## 历史路由 `pilot-cli` 为什么返回空
     * 它仍然**注册着**（绑定驱动改道、团队成员冻结配方、既有 profile 的 `allowedModels` 都还引用它），
     * 但不再往目录里塞扁平条目 —— 否则同一份模型会在选择器里出现两遍（用户明确反对重复）。
     * 空组会被 `buildModelCatalog` 丢掉 ⇒ 菜单里根本不显示这一组；而显式点名它的请求照常派发
     * （`resolveModel` 原样返回，目录成员资格不控制路由：`dsh-llm/lib/types/index.js:585`）。
     */
    listModels(provider: string): Promise<readonly {
        provider: string;
        id: string;
        name: string;
        description?: string;
    }[]>;
    /**
     * 对 `listModels` 宣传过的任何模型**都不得抛错**（否则整组会从目录里消失，
     * 且选择时报 `session/model-unavailable`）。这里不校验存在性 —— 校验放在 `stream`，
     * 那时才能给出「有哪些可用」的可读错误。
     *
     * `contextWindow` **不声明**：外部 CLI 的真实上下文窗口我们不知道，编一个数字比不写更糟。
     */
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<{
        provider: string;
        id: string;
        name: string;
        reasoning?: {
            efforts: readonly {
                id: string;
                name: string;
            }[];
            defaultEffort?: string;
        };
    }>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: {
            provider: string;
            id: string;
            name: string;
        };
        stream: (options: unknown) => AsyncIterable<PilotCliChunk>;
    }>;
    /** 契约要求的唯一必填方法。 */
    stream(options: unknown): AsyncIterable<PilotCliChunk>;
    /**
     * 按 **provider + model** 决定「这次到底跑哪条目标、带什么模型」。
     *
     * 两条路由形态：
     *   · `pilot-cli`（历史/内部）：model = 目标名 或 `目标名::模型`；
     *   · `harness-<key>[-<region>]`（新，面向用户）：model = 该 harness 的模型 id，
     *     或保留值 `cli-default`（用它自己的默认档）。**过期/未知的模型 id 显式拒绝**
     *     （不静默换一个模型跑 —— 那正是「一选就报错」里最难查的一类）。
     */
    private streamForProvider;
    /**
     * 真正的实现。`stream()`（路由直达）与 `llm/stream` 监听器（绑定改道）都走这里，
     * 保证两条入口的 chunk 序列与错误语义**完全一致**。
     */
    streamFor(options: unknown, selection: {
        readonly target: string;
        readonly model?: string;
        readonly accountId?: string;
        readonly origin: 'route' | 'redirect';
        /**
         * 非空 = **显式拒绝**这次派发（例如「模型 id 不在该 harness 当前清单里」）。
         * 与 `target === ''` 的报错同一条路：产出 `finish` 错误 + 记账，绝不换成别的模型跑。
         */
        readonly refusal?: string;
    }): AsyncIterable<PilotCliChunk>;
}
export interface PilotCliRegistration {
    readonly ok: boolean;
    readonly route: string;
    readonly reason: string;
    readonly registered: boolean;
    /** 注册后宿主返回的「可调用 disposer + replace」句柄是否拿到。 */
    readonly handleShape: string;
    /** 本次实际注册的**全部**路由（`pilot-cli` + 每个 harness 分组）；未注册时不写。 */
    readonly routes?: readonly string[];
}
export interface PilotCliHandle {
    /** 闸门当前状态（每次调用重新快照）。 */
    gate(): GateState;
    /** 适配器注册情况。 */
    registration(): PilotCliRegistration;
    /** 可宣传目标。 */
    targets(): readonly string[];
    /** 最近若干次派发 / 改道记录（最新的在后）。 */
    records(): readonly PilotCliRecord[];
    /**
     * **响应层**（`llm/stream`）监听器的安装情况。
     * 自本轮起「短路产 chunk 的改道」**已移除**：在那一层短路产出的内容，会话日志会把 source 记成宿主路由
     * ⇒ 归因不实。这个字段如实报「未安装」与原因，不再假装改道还在那一层。
     * ⚠️ `installed:false` **只**指那种监听器。本插件另有一个**只改写请求、绝不产 chunk** 的
     * `llm/stream` 监听器（purpose guard），它的状态在 `auxGuard` 里（**不是**在 `installed` 里）。
     */
    listener(): {
        readonly installed: boolean;
        readonly layer: 'llm/stream';
        readonly note: string;
        readonly auxGuard: AuxScopeState;
    };
    /** **请求层**（`agent/request`）改道的安装情况、计数器与最近一次判定。 */
    requestLayer(): RequestLayerState;
    /**
     * **purpose guard**（辅助调用不得跑进外部 CLI）的安装情况、计数器与最近一次判定。
     *
     * 两层：`llm/stream` 上只改写不派发的监听器（压缩等直接 `ctx.llm.stream` 的辅助调用），
     * 以及 `sessionTitle.startProvider` 的前置 route 改写（会话标题）。
     * `sessionTitle.status !== 'armed'` ⇒ **会话标题这条护栏没生效**，不得当成已修。
     */
    auxScope(): AuxScopeState;
    /** 会话日志里的显式选择折叠（只读诊断；`sessionId` 给了就现场读一次）。 */
    picks(sessionId?: string): {
        readonly readable: boolean;
        readonly pick: ExplicitPick | null;
    };
    /** 只读决策查询：不调用任何宿主写入路径。 */
    gateDecision(provider: unknown): {
        readonly provider: string;
        readonly decision: 'block' | 'delegate';
    };
    /**
     * 闸门自检（**两条分支都不写 profile**，理由见注释）：
     * - `blocked`：用**真实**的 `agentDefaultModel.saveSelection({provider: ROUTE, model})` —— 与
     *   `selectModel` 第 736 行**同一个服务、同一个方法、同一个形状**；应被拦住。
     * - `delegated`：用 `saveSelection(undefined)` —— 非自有形状 ⇒ 转发给**真原方法**；原方法在
     *   解析 `next.provider` 时自己抛 TypeError，且**发生在任何 edit / 写文件之前** ⇒ 同样零写入，
     *   但它证明了「非自有 provider 确实到达了宿主自己的实现」。
     * 返回前后两次 profile 文件哈希（**只给哈希，不给内容**）。
     */
    gateSelfTest(action: 'blocked' | 'delegated'): Promise<Record<string, unknown>>;
    /**
     * 经**真实注册的路由**跑一次请求（`ctx.llm.stream({provider: ROUTE, …})`）。
     * ⚠️ 会真的调用外部 CLI（可能消耗额度）。只给显式的诊断入口用。
     */
    streamThroughRoute(input: {
        readonly model: string;
        /**
         * 走哪条**自有路由**。省略 = 历史路由 `pilot-cli`（model 槽 = 目标名 / `目标名::模型`）；
         * 给了 `harness-<key>[-<region>]` 就走「一个 harness 一条 provider」那条新路
         * （model 槽 = 该 harness 的模型 id，或 `cli-default`）。
         */
        readonly provider?: string;
        readonly prompt: string;
        /** 带上会话 id 时，账号按「显式 > 绑定 > 账号池默认」解析 —— 与真实轮次完全同一条链。 */
        readonly sessionId?: string;
        readonly timeoutMs?: number;
    }): Promise<Record<string, unknown>>;
    /** 选择器读的**服务端入口**原件：与 `ctx.remote.session.modelCatalog()` 是同一个服务（见返回值里的 source）。 */
    modelCatalog(): Promise<Record<string, unknown>>;
    /** 当前 profile 文档的哈希与 mtime（**只给哈希，不给内容**）；同时覆盖 patch 文档与组成文件。 */
    profileEvidence(): ProfileEvidence;
    /**
     * 走**真实的选择器服务端入口**：`ctx.sessionController.selectModel({provider: ROUTE, …})`。
     * 会新建一个会话（测试用），并在调用前后比 profile 哈希 —— 这是「选择 pilot-cli 后 profile 未被改写」的正面证据。
     */
    selectModelThroughPicker(input: {
        readonly provider: string;
        readonly model: string;
        readonly sessionId?: string;
    }): Promise<Record<string, unknown>>;
    /** 在当前进程里显式列出适配器注册表（不经 GUI），用于证明注册与否。 */
    listProviders(): readonly string[];
}
export declare function registerPilotCli(ctx: PilotCliCtx, deps: PilotCliDeps): PilotCliHandle;
