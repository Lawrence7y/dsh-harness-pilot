import { type SessionBinding } from './federation/binding.js';
import type { AccountSeed } from './federation/accounts.js';
import { type FrozenAccountRecipe } from './account-target.js';
import type { ResolvedConfig } from './config.js';
import type { TargetConfig } from './types.js';
/** 意图键：**团队**(Lead 会话) + 成员名。两个团队的同名成员在这里天然是两条。 */
export declare function teamIntentKey(leadSessionId: string, memberName: string): string;
/**
 * 一份**冻结**的账户配方 = `src/account-target.ts` 的同一个形状（**再导出**，不是第二份定义）。
 *
 * 冻结语义：账号启动参数 + 环境变量，取自**成员诞生那一刻**的档案值；此后档案改名/停用/删除
 * 都不得改变这位成员。原始 `accountId` **只**用于路由与 `SessionBinding.accountId`，
 * **绝不**进面向人的文案（文案一律用 `label`）。
 */
export type { FrozenAccountRecipe } from './account-target.js';
/**
 * 把「冻结的模型 id」变成**真的会进命令行**的参数。
 *
 * ## 为什么需要这一步（本轮实测抓到的第二个静默丢弃）
 * 目标自己的 `modelArgs` 是这个插件唯一会用的模型注入机制（`sessions.ts` 的
 * `withModel()`：`modelArgs.map(piece => piece.replace('{model}', chosen))`）。
 * 但**本机这些 qoder 目标的 `modelArgs` 是空的**（实测：`headlessArgv` 拼出来只有
 * `--config-dir … -p`），于是「冻了个模型」这句话在 argv 上**什么也没发生** ——
 * 这正是用户禁止的「静默丢 `model`」。
 *
 * 这里补上**已实测**的落点：该 CLI 自己的模型开关是 `-m, --model <model>`
 * （`qoderclicn --help`），且**真的生效**（实测：`--model Qwen3.8-Flash` 被接受；
 * `--model definitely-not-a-model-xyz` ⇒ **exit 42** 并列出可用模型）。
 * 也就是说「模型被真的用了」与「模型非法」两件事都由 CLI 自己**响亮**地判，不靠猜。
 *
 * ⚠️ 只在目标**没有**声明 `modelArgs` 时才补：目标声明了就走目标那条（不重复注入，
 * 那会变成两个模型开关，谁生效取决于 CLI —— 与账号的重复 `--config-dir` 是同一类错误）。
 */
export declare function modelArgsFor(target: TargetConfig, model: string | undefined): readonly string[];
/** 冻结的目标配方：目标名 + 该目标此刻的有效配置 + 账户配方 + 固定模型。 */
export interface FrozenTargetRecipe {
    readonly target: string;
    readonly targetConfig: TargetConfig;
    readonly account?: FrozenAccountRecipe;
    readonly model?: string;
    readonly frozenAt: string;
}
/** 一次「成员身份意图」。写在 spawn **之前**；spawn 失败必须显式撤销。 */
export interface TeamRouteIntent {
    readonly key: string;
    readonly leadSessionId: string;
    readonly memberName: string;
    readonly description: string;
    readonly context: 'fresh' | 'fork';
    readonly provider: string;
    readonly frozen: FrozenTargetRecipe;
    readonly createdAt: string;
    /** 解析出来的子会话 id（由 `team/member` 或 `agent/created` 填入）。 */
    childSessionId?: string;
    /** 解析来源，用于审计「这条绑定是怎么来的」。 */
    resolvedVia?: string;
}
/** 一份已解析（可被路由使用）的路由记录。 */
export interface TeamRoute {
    readonly childSessionId: string;
    readonly leadSessionId: string;
    readonly memberName: string;
    readonly target: string;
    readonly accountId?: string;
    readonly accountLabel?: string;
    readonly model?: string;
    readonly binding: SessionBinding;
    readonly via: string;
    readonly resolvedAt: string;
    /**
     * **冻结配方本体**，随记录一起落盘。
     *
     * ⚠️ 这一格是本轮真机实测**补出来的**：最初只把 `frozen` 放在内存里的**意图**对象上，
     * 于是「记录落盘了、配方没落盘」—— 插件一重载（或进程一重启），
     * `routes` 从文件恢复了、`intents` 却是空的，`frozenRecipeOf()` 返回 `undefined`，
     * 结果一条**看着在册**的成员在派发时被拒成「不在路由表里」。
     * 冷恢复要读的是**已绑定的快照**，那就必须让这条记录**自足**。
     */
    readonly frozen: FrozenTargetRecipe;
}
/** 路由表落盘形状（供重启后审计；内存表仍是运行期唯一判据）。 */
export interface TeamRoutingStateFile {
    readonly version: 1;
    readonly routes: Readonly<Record<string, TeamRoute>>;
    readonly updatedAt: string;
}
/** 每次解析/拒绝的一条记录（`GET /harness-pilot/api/team/routing` 原样返回）。 */
export interface TeamRoutingEvent {
    readonly time: string;
    readonly seq: number;
    readonly event: string;
    readonly detail?: Record<string, unknown>;
}
export interface ResolveOutcome {
    /** 解析出来的绑定；`undefined` = 这个子会话不在路由表里（应当走原生）。 */
    readonly binding?: SessionBinding;
    /** 为什么没绑上（可读原因；`undefined` = 绑上了或压根不相关）。 */
    readonly reason?: string;
    readonly route?: TeamRoute;
}
export type PrepareRefusalCode = 'NOT_TEAM_LEAD_SESSION' | 'UNKNOWN_TARGET' | 'TARGET_NOT_DISPATCHABLE' | 'ACCOUNT_REFUSED' | 'ACCOUNT_RECIPE_FAILED' | 'DUPLICATE_MEMBER_INTENT' | 'ACCOUNT_REQUIRES_POOL_HARNESS' | 'MODEL_NOT_OFFERED';
export interface PrepareRefusal {
    readonly ok: false;
    readonly code: PrepareRefusalCode;
    readonly reason: string;
}
export interface PrepareAccepted {
    readonly ok: true;
    readonly intent: TeamRouteIntent;
    /**
     * 参数的**机器可读回执**：调用方据此证明「两个参数都进了产物」，
     * 而不是只看到一句「已接受」。`model` 为 `null` = 真的没给，**不是**被丢掉。
     */
    readonly spec: {
        readonly target: string;
        readonly account: string | null;
        readonly model: string | null;
        readonly accountApplied: boolean;
        readonly modelApplied: boolean;
    };
}
export interface TeamRoutingDeps {
    readonly config: Pick<ResolvedConfig, 'resolvedTargets'>;
    /** 当前**生效**的账号档案（惰性；已停用/删除的不在其中）。 */
    readonly accountSeeds: () => readonly AccountSeed[];
    readonly homeDir: () => string;
    /** 精确账户解算器（可选，缺省即产品化实现）。 */
    readonly resolveAccount?: (accountId: string, seeds: readonly AccountSeed[]) => {
        ok: true;
        recipe: FrozenAccountRecipe;
    } | {
        ok: false;
        reason: string;
    };
    /** 落盘的**权威**绑定出口（＝ `POST /session/binding` 同一条链）；缺省时只写内存。 */
    readonly writeBinding?: (binding: SessionBinding) => void;
    readonly stateFile?: string;
    readonly now?: () => Date;
    /** 诊断出口（插件 logger）。**只用于如实记一条**，不参与任何判定。 */
    readonly log?: (message: string) => void;
    /**
     * 兜底解析回调：`(childSessionId, parentSessionId) => 成员名 | undefined`。
     *
     * `agent/created` 那一刻能拿到的只有 `(子会话 id, 父会话 id)`，成员名要靠**宿主自己的**
     * 已落盘事实反查（团队日志 `team/member` / 成员 prompt 抬头）。反查不到就**不绑** ——
     * 本模块绝不按模糊名字跨团队命中。缺省时兜底路径直接放弃（并记一条）。
     */
    readonly resolveChild?: (childSessionId: string, parentSessionId: string) => {
        readonly memberName?: string;
        readonly via?: string;
    };
    /**
     * 该目标**自己报出**的模型清单（可选；缺省则不做模型清单校验）。
     *
     * 用途只有一个：模型给错时**在创建成员之前**就拒绝，而不是让成员诞生后每一轮都失败。
     * 读不到（抛错/返回空）时**不据此拒绝** —— 「没测到」不等于「不存在」，
     * 那种情况下模型照传，合法性由 CLI 自己判（它判得很响亮：非法模型 ⇒ 非 0 退出 + 可用清单）。
     */
    readonly knownModels?: (target: TargetConfig) => Promise<readonly string[]>;
    /** 清单来源说明（写进拒绝原因与审计记录，让「凭什么说不合法」可追溯）。 */
    readonly knownModelsSource?: string;
}
/**
 * 账户解算器：**再导出唯一来源**（`src/account-target.ts` 的 `resolveAccountRecipe()`）。
 *
 * 历史：这里曾自己拼一份（`resolveAccountLaunch` + 手工组装 recipe），而它产出的 `args`
 * 对受管账号是**相对**的 `['workbuddy-managed.cjs', <档案 id>]` —— 派发侧再前置到已经是
 * 完整元组的目标参数前面，就拼出「两个 wrapper、两个 id」（两个 WB 账号 2/2，见
 * `docs/verified/managed-account-target-fix.md` §5.0）。
 * 现在这里只是**同一个函数**的再导出：「账号 → 启动配方」在全仓只有一处实现。
 */
export { resolveAccountRecipe } from './account-target.js';
/** 路由表：**产品**团队身份的唯一权威处（探针不再参与产品判定）。 */
export declare class TeamRoutingTable {
    private readonly deps;
    private readonly intents;
    private readonly routes;
    private readonly events;
    private seq;
    constructor(deps: TeamRoutingDeps);
    /** 追加一条记录。**同步**：判定依据是先后顺序，异步落盘会把先后变成猜测。 */
    private log;
    logs(limit?: number): readonly TeamRoutingEvent[];
    /** 某次 spawn 观测到的 `seq` 水位 —— 用于「这一步到底写没写」的取证。 */
    seqWatermark(): number;
    /**
     * 校验并冻结一次成员身份。**必须在 `spawnTeammate` 之前调用。**
     *
     * 位置纪律（与 provider.ts 的别名判活同级）：判活发生在**任何副作用之前**，
     * 判定失败 ⇒ 返回可读原因，调用方**不得**继续 spawn（「停用/删除账号 ⇒ 新建拒绝」就落在这里）。
     *
     * `async` 是因为模型清单校验要读该 CLI 自己报出的清单 —— 那是**唯一**能判
     * 「这个模型该 CLI 认不认」的依据，不能靠猜。
     */
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
    }): Promise<PrepareAccepted | PrepareRefusal>;
    /** 撤销一份未决意图（spawn 失败时**必须**调；否则会留下一个永不兑现的身份）。 */
    abortIntent(leadSessionId: string, memberName: string, reason: string): boolean;
    pendingIntents(): readonly {
        readonly key: string;
        readonly leadSessionId: string;
        readonly memberName: string;
        readonly target: string;
        readonly resolved: boolean;
    }[];
    /**
     * 用 **(Lead 会话, 成员名)** 解析并**立刻写入**绑定。
     *
     * 这是主路径：`team/member` 事件带齐三项，且发生在成员首轮之前。
     */
    resolveByIntent(input: {
        readonly leadSessionId: string;
        readonly memberName: string;
        readonly childSessionId: string;
        readonly via: string;
    }): ResolveOutcome;
    /**
     * 兜底路径：只知道 `(childSessionId, parentSessionId)`，成员名由调用方**反查**得到。
     *
     * 与主路径的区别是「成员名从哪来」；**隔离键不变** —— 仍然是 `(Lead 会话, 成员名)` 两级，
     * 因为没有成员名就无从在该 Lead 下定位意图（宁可**不绑**，也不猜）。
     *
     * `memberName` 不给时走 `deps.resolveChild` 反查（宿主自己的已落盘事实）；反查不到
     * **保持未绑**并记一条 `resolve.deferred` —— 后续仍可由主路径补上。
     */
    resolveByChild(input: {
        readonly childSessionId: string;
        readonly parentSessionId: string;
        readonly memberName?: string;
        readonly via: string;
    }): ResolveOutcome;
    private commit;
    /** 冷恢复：**读已绑定的快照**（不重算、不按当下配置重新决定身份）。 */
    resolve(sessionId: string): ResolveOutcome;
    /** 面向查询的只读快照（按钮/文案一律用 `accountLabel`，不出原始 id）。 */
    snapshot(): readonly TeamRoute[];
    /**
     * 该会话此刻的冻结配方（账号 args/env + 目标配置 + 固定模型）。
     *
     * 用途：派发侧想**严格**按冻结配方执行时取它 —— 不按查询时刻的账号档案重算。
     * `undefined` = 这个会话不在路由表里。
     *
     * 取值顺序体现了上面 `TeamRoute.frozen` 那条教训：**先读记录自带的配方**
     * （它落过盘、冷恢复也在），内存意图只作为同进程内的补充来源。
     */
    frozenRecipeOf(sessionId: string): FrozenTargetRecipe | undefined;
    private load;
    private persist;
    /** 默认落盘位置（插件 home 下，与 `session-bindings.json` 同目录、**不同文件**）。 */
    static defaultStateFile(home: string): string;
}
/**
 * 从成员 prompt 里读成员名 —— **次选**接缝，保留作为对照。
 *
 * 工具路径的 prompt 抬头是宿主的固定文案（`tool-agent-team/lib/index.js:276-278`：
 * `You are teammate "<name>".`）。`team/member` 事件本身带 `member.name`，所以主路径
 * 用不到它；这里保留是为了在事件缺失时**仍有**一条可解释的来源，而不是让调用方去猜。
 */
export declare function teammateNameFromPrompt(prompt: readonly unknown[] | undefined): string | undefined;
/** 脱敏一行 provider 名（复用 provider.ts 那份实现，避免第二套脱敏规则）。 */
export declare function redactProviderList(names: readonly string[], accountIds: readonly string[]): string[];
