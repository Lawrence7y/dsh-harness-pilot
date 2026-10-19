/**
 * SubagentProvider：把每个 harness 注册成 DSH 的**具名子代理 provider**。
 *
 * 注册后，宿主标准的 subagent 工具（`tool-subagent` 配 `provider: harness-<名字>`）和
 * 本插件的 `harness_agent` 工具都能以「子代理」语义派发 —— 有 run id、有 stopReason、
 * 有 dispose 生命周期，符合 DSH 里其他外部 provider（claude-code / codex / acp）的形状。
 *
 * ── 2026-10-14 追加：**(target × account) 身份别名**（注册期注入）──────────────
 *
 * 目标：让「子代理任务用**指定账号**跑」这件事成立，而不是只能靠 `harness_task_start accountId=…`。
 *
 * 接线点为什么只能是**注册期**（三条都是本轮实测的契约原文，不是推断）：
 *   1. `SubagentStartRequest`（rc.2 `typert.host.js:779`）字段是
 *      `label / prompt / parent / signal / agentOptions / outputSchema / maxDepth / toolFilter / persona`
 *      —— **没有任何账号字段**；
 *   2. 唯一能夹带路由的 `AgentOptions`（`:243`）是
 *      `provider / model / reasoningEffort / maxTokens / subagentDepth` —— **同样没有账号字段**；
 *      而且本 provider 的能力广告是 `NO_START_CAPABILITIES`，宿主在 `start` **之前**就会拒掉
 *      per-child 选项（`agentOptions` 等），所以这条路连「塞进 agentOptions」都不可能。
 *   3. 于是 `start(request)` 里**只有 `request` 可用**，而 `request` 里没有账号 ——
 *      唯一的干净落点就是**注册那一刻**：为每个 (target × account) 组合注册一个 provider 名，
 *      把账号的启动配方（参数 + 环境变量）在**构造期**合并进该 provider 的目标。
 *
 * 三条纪律（用户明确要求，写进代码而不是只写进文档）：
 *   · **不静默改号/改 harness**：别名绑定的账号被停用或删除后，**新的**子代理任务
 *     **显式拒绝**（抛错、不创建 run、不执行任何 harness），并给出可读原因与恢复方式；
 *     绝不「换个账号凑一下」，也绝不回退到不带账号的同名 target。
 *   · **已创建任务的快照不变**：判活**只在** `start()` 那一刻做一次；判定通过后，这次 run
 *     用的是**注册期固化**的那份账号配方（`args`/`env` 已合并进不可变的目标对象）。
 *     之后账号被停用/删除/改名，都**不得**影响已经在跑或已经创建的任务。
 *   · **不输出原始 accountId**：provider.ts 产出的所有**文案**（拒绝原因、身份行、跳过说明）
 *     一律用 `redactAccount()` 的 `acct:…` 形式。唯一带档案 id 的地方是**别名 provider 名本身**
 *     —— 它是**选择器**（调用方必须能拼出来），与既有的 `harness_task_start accountId=…` 形参、
 *     以及既有「按账号目标」参数里的明文配置目录属于同一类**接口数据**。
 *
 * ⚠️ 仍未打通的一条（**如实说明，不伪造**）：**可继续 / 团队路径没有账号接线点**。
 *   宿主的 `ctx.subagents.startContinuable()` 要求 provider 实现 `prepareContinuable`
 *   （rc.2 `dsh-subagent/lib/index.js:3149-3152`：没有就抛
 *   `UNSUPPORTED_CAPABILITY "… does not support continuable children"`），而
 *   `ContinuableCreateRequest`（`typert.host.js:334`）只有 `sessionId / parent / signal`，
 *   `ContinuableStartSpec.request` 又是 `Omit<SubagentStartRequest, …>` —— 两处都没有账号字段。
 *   本 provider 是**一次性派发**的实现（没有 inbox / continuation 语义），因此这里**不**实现
 *   `prepareContinuable`：给团队路径伪造一个「看起来支持账号」的能力，比明说「不支持」更糟。
 */
import { type SubagentProvider } from '@deepseek-ai/dsh-subagent';
import { type AccountSeed } from './federation/accounts.js';
import type { SessionRegistry } from './sessions.js';
import type { TaskManager } from './tasks.js';
import type { DispatchOutcome, TargetConfig } from './types.js';
/**
 * 内部子代理 run 的停滞判定（毫秒）：超过这么久既无进度也无终态就标记 `stalled`。
 * 120s 是拍板值 —— 有些 harness 单轮确实会安静好几分钟，再长就失去预警意义。
 */
export declare const DEFAULT_STALL_TIMEOUT_MS = 120000;
/**
 * 别名 provider 名（**选择器**）：`harness-<target>-acct-<档案 id>`。
 *
 * 档案 id 的字符集由 `accounts.ts` 的 `ACCOUNT_ID_RE` 限制为 `a-z0-9._-`，
 * 所以这个名字一定是安全的 provider 名（不含空格/路径分隔符/大写歧义）。
 */
export declare function accountAliasNameFor(target: TargetConfig, accountId: string): string;
/**
 * 同一个别名的**脱敏写法**（`harness-<target>-acct-‹acct:…›`）：**所有文案**都用它，
 * 这样 provider.ts 的输出里永远不会出现原生档案 id。
 */
export declare function redactedAccountAliasName(target: TargetConfig, accountId: string): string;
/**
 * 把一串 provider 名渲染成**脱敏**形式：别名名结尾的档案 id 换成 `acct:…`，其余原样。
 *
 * 用途：注册日志与界面文案。别名名本身是**选择器**（调用方要能拼出来，所以含档案 id 是接口事实），
 * 但日志属于**输出** —— 本项目的纪律是输出里不出现原始 id。给 `accountIds` 传当前生效档案 id 即可。
 */
export declare function redactProviderNames(names: readonly string[], accountIds: readonly string[]): string[];
/**
 * 一个别名 provider 的账号绑定。**在注册期构造一次**，此后不可变 ——
 * 「已创建任务的快照不变」正是靠这一点（判活是唯一的活动部分，且只在 `start()` 用一次）。
 */
export interface AccountAliasBinding {
    /** 原始档案 id。**只在内部使用**（identity / 判活），绝不进入文案。 */
    readonly accountId: string;
    /** 脱敏显示名（`acct:…`）：文案里只用它。 */
    readonly label: string;
    /** 别名 provider 名（＝选择器，含档案 id）。 */
    readonly providerName: string;
    /** 该别名的脱敏写法，文案用。 */
    readonly redactedName: string;
    /**
     * **新任务**准入判定：每个 `start()` 开始时问一次。
     *
     * 返回 `undefined` = 该账号仍可用于新任务；返回字符串 = 可读拒绝原因（调用方原样抛出）。
     * 刻意做成**函数**而不是注册期快照：账号被停用/删除后，新任务必须立刻被拒 ——
     * 而「已创建」的任务根本不走这里，所以它们不受影响。
     */
    readonly refusalOfNewTask: () => string | undefined;
    /**
     * **执行前**门禁（只在受管 bootstrap 上挂）：每个 `start()` 开始时 `await` 一次。
     *
     * 与 `refusalOfNewTask` 的分工（这是两种不同的东西，不能互相顶替）：
     *   · `refusalOfNewTask` = **纯函数**的档案判活（该账号此刻还在不在、有没有额外停用原因）；
     *   · `runtimeGate`     = **真实测量**的运行前提（随包适配器指纹 + 厂商 CLI 实测版本）。
     *     它要起一个只读的 `--version` 子进程，所以是 async；结论同样只在 `start()` 用一次。
     *
     * 返回 `undefined` = 放行；返回字符串 = 可读拒绝原因（调用方原样抛出 ⇒ 连 run 都不会有）。
     */
    readonly runtimeGate?: () => Promise<string | undefined>;
}
/** 可注入的 `ctx.subagents` 最小面。 */
export interface SubagentRegistryLike {
    registerProvider(provider: SubagentProvider): () => void;
    /** 已有的 provider 名（用于幂等跳过；缺失时不做跳过）。 */
    list?(): string[];
}
/**
 * 别名注册的**环境依赖**：账号档案从哪来、配置目录根在哪、还有什么额外的停用判定。
 *
 * ⚠️ `accounts()` 必须是**惰性**函数：它每次都要返回「当前生效」的档案列表
 * （内置 ± 用户增删改；已停用/删除的**不在**其中）。理由有两条：
 *   · 注册期要拿它生成别名集合；
 *   · **判活**也要拿它 —— 判活绝不能只看注册期快照，否则「删了账号还能用」。
 */
export interface AccountAliasOptions {
    /** 当前生效的账号档案（惰性读取）。 */
    readonly accounts: () => readonly AccountSeed[];
    /** 配置目录根（`resolveAccountLaunch` 在档案未给 configDir 时用；缺省取 USERPROFILE/HOME）。 */
    readonly homeDir?: string;
    /**
     * 额外的「现在还能不能用于**新任务**」判定。返回字符串 = 拒绝原因；`undefined` = 可用。
     *
     * ⚠️ 不要拿「账号池里 `enabled=false`」当停用：池的 `enabled` 是**自动切换候选**语义，
     * `defaultPoolState()` 给**每个**账号的初值都是 `false` —— 拿它判活会把所有账号一律拒掉。
     * 本插件里「停用」的真实语义是：内置档案的**墓碑**（delete → tombstones）与新增档案的**删除**，
     * 两者都表现为「该 id 不在 `effectiveSeeds()` 里」，即本模块默认就能判出来。
     */
    readonly refusalFor?: (accountId: string) => string | undefined;
    /** 别名名生成（默认 `harness-<target>-acct-<id>`；给测试与定制留口）。 */
    readonly aliasName?: (target: TargetConfig, accountId: string) => string;
    /** 跳过某个别名的可读原因（名字冲突 / 档案不属于该目标 / 配方解析失败 …）。 */
    readonly onSkip?: (note: string) => void;
    /**
     * 「账号 → 目标」的合并函数（可选回退口；**唯一实现** = `src/account-target.ts` 的
     * `withAccountTarget()`）。正常路径由 `registerProviders()` 的注入形参给（见
     * `AccountMergeLike` 的注释：注入是为了切断 `provider.ts ↔ account-target.ts` 循环）。
     */
    readonly withAccount?: AccountMergeLike;
}
/**
 * 「账号 → 目标」的合并函数形状（**唯一实现** = `src/account-target.ts` 的 `withAccountTarget()`）。
 *
 * ⚠️ 普通账号这一格此前在**本模块里自己拼了一份** `args` / `env` 合并，与 `index.ts`、
 * `team-routing.ts` 各写一份 —— 同一个能力四处实现，正是本项目反复吃的亏。
 * 现在改成**注入同一处**（由 `src/index.ts` 在 `registerProviders()` 处注入），
 * 本模块不再自己拼参数。返回形状与 `withAccountTarget()` 逐字一致。
 */
export type AccountMergeLike = (target: TargetConfig, accountId: string, seeds: readonly AccountSeed[]) => {
    readonly ok: true;
    readonly target: TargetConfig;
    readonly note: string;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** 规划出来的一个别名（纯数据，不含注册副作用 —— 探针与单测直接用这个）。 */
export interface PlannedAccountAlias {
    readonly name: string;
    /** 已经把账号配方合并进去的目标（**不可变**：注册后不再改）。 */
    readonly target: TargetConfig;
    readonly binding: AccountAliasBinding;
}
/**
 * 判定一个别名绑定的账号**现在**能不能用于新任务。**纯函数**（只读入参），便于离线验收。
 *
 * 三态分明：
 *   · 账号在 `accounts()` 里、也没有额外拒绝原因 → `undefined`（可用）；
 *   · 账号**不在** `accounts()` 里 → 「已停用或删除」（内置 delete = 墓碑，新增 delete = 移出）；
 *   · 账号在，但 `refusalFor` 给了原因 → 原样带出该原因。
 */
export declare function accountAliasRefusal(target: TargetConfig, accountId: string, options: AccountAliasOptions): string | undefined;
/** Recipe validation only; runtime version/hash/auth evidence cannot be inferred from this check. */
export declare function managedAccountAliasRefusal(target: TargetConfig, seed: AccountSeed, home: string): string | undefined;
/** 随包受管适配器的绝对路径（与 `managedAccountAliasRefusal` 校验的是**同一个**文件）。 */
export declare function packagedManagedAdapterPath(): string;
/**
 * 厂商 CLI 的 headless 入口：从**已配方校验**的 `vendorExecutable` 推导，不另写一份机器路径。
 * 实测该入口就是 `docs/verified/harness-probe.json` 记录的那一个（`--version` 短路返回 `2.156.0`）。
 */
export declare function managedVendorCliEntry(seed: AccountSeed): string | undefined;
export interface ManagedVersionProbe {
    readonly version: string | undefined;
    readonly detail: string;
    readonly argv: readonly string[];
    readonly exitCode: number | null;
}
/**
 * **真实测量**厂商 CLI 版本：`ELECTRON_RUN_AS_NODE=1 <厂商 exe> <随包 codebuddy-headless.js> --version`。
 *
 * 为什么用厂商 exe 而不是另找一个 `node.exe`：`(command, ELECTRON_RUN_AS_NODE=1)` 这一对
 * **就是配方里已经校验过的那一对**（`seed.launch.command` / `seed.launch.env`）；
 * 再引入第二个解释器路径等于又造一份「本机路径知识」，换机器/升级就会失效。
 * 只读、零额度、不碰账号配置目录、不读任何凭据文件。
 */
export declare function measureManagedVendorVersion(seed: AccountSeed, timeoutMs?: number): Promise<ManagedVersionProbe>;
/**
 * **执行前**门禁：哈希 + 实测版本，两条都过才放行。返回 `undefined` = 放行，字符串 = 拒绝原因。
 *
 * `seed.launch.mode !== 'managed-bootstrap'` 时**不做**任何测量（普通账号没有这套协议依赖，
 * 给它加门禁只会制造无理由的失败）—— 这一点是显式的，不是「测不到就跳过」。
 */
export declare function managedBootstrapRuntimeGate(seed: AccountSeed, targetName: string): Promise<string | undefined>;
/** Ordinary accounts use exact target names; managed accounts reuse only validated, baked recipes. */
export declare function planAccountAliases(targets: readonly TargetConfig[], options: AccountAliasOptions, 
/**
 * 「账号 → 目标」的合并实现（**依赖注入**，不是可选装饰）。
 *
 * 值来自 `src/account-target.ts` 的 `withAccountTarget()` —— 「账号 → 目标」的**唯一**实现。
 * 这里刻意用**注入**而不是 `import`：`account-target.ts` 需要本模块的
 * `planAccountAliases()` / `packagedManagedAdapterPath()`，若本模块反过来 import 它，
 * 就形成 `provider.ts ↔ account-target.ts` **循环**。依赖注入把这个回路切断，
 * 两侧的 import 图因此都是单向的（核对见 `account-target.ts` 文件头）。
 *
 * 缺省时（探针/单测直接调本函数）退回 `options.withAccount`；两者都没有 ⇒
 * 普通账号**如实跳过**并说明，绝不自己再拼一份合并规则。
 */
injectedMerge?: AccountMergeLike): {
    readonly aliases: readonly PlannedAccountAlias[];
    readonly skipped: readonly string[];
};
/**
 * 一次 run 的真实身份行。
 *
 * `outcome` 缺失 = 派发还没回报身份（例如抛错路径）：此时**如实写未回报**，
 * 并把原因带出来，而不是省略这一行 —— 省略会让人以为「这次没有身份这回事」。
 *
 * `ledgerId` = 这次 run 在**本插件账本**里的 id（＝子代理 run id），
 * 身份行里带上它，子代理页面/作业详情就能指向完整执行记录。
 *
 * `alias` = 这次 run 走的是 **(target × account) 别名**（注册期注入）。带上它，身份行才会
 * 说明「账号是从哪来的」，而不是留下与不带账号路径相同的那句「不接受账号参数」。
 */
export declare function subagentIdentityNote(target: TargetConfig, outcome?: DispatchOutcome, ledgerId?: string, alias?: AccountAliasBinding): string;
/** `agentOptions` 的折算结果：要么给一个要注入的模型，要么给一条可读的拒绝原因。 */
export interface ChildAgentOptionsDecision {
    /** 要真正注入外部 CLI 的模型 id（`undefined` = 本次没有模型面请求）。 */
    readonly model?: string;
    /** 非空 = 显式拒绝的原因（调用方原样抛出，连 run 都不创建）。 */
    readonly refusal?: string;
}
/**
 * 把宿主的 per-child `agentOptions` 折成**本 provider 真正能兑现的那一部分**（纯函数，可离线固化）。
 *
 * 兑现规则：
 *   · `provider`：只接受本插件路由（`pilot-cli`）或未给。给了宿主供应商，说明调用方想让它
 *     跑在 DSH 自己的模型上 —— 那不该经由「外部 harness 的子代理 provider」，显式拒绝。
 *   · `model`：接受裸模型名，也接受 `目标名::模型` 组合；组合的前缀必须是**本 provider 的目标**，
 *     否则就是「点了另一个 harness，却想用这个 provider 跑」—— 拒绝，绝不悄悄换。
 *   · `target.modelArgs` 为空时**拒绝**：没有任何机制能把模型落到命令行，
 *     接受等于静默丢弃（旧行为），那是本项目明确禁止的一类不实。
 *   · `reasoningEffort` / `maxTokens`：拒绝（理由见上）。
 *   · `subagentDepth`：接收不解释（宿主记账）。
 */
export declare function childAgentOptionsDecision(target: TargetConfig, raw: unknown): ChildAgentOptionsDecision;
/**
 * 本插件注册的每个 harness provider 的**能力广告**（唯一一份，导出以便离线探针直接断言）。
 *
 * 只把 `agentOptions` 打开，其余照抄 `NO_START_CAPABILITIES` 的 false：
 *   · `outputSchema` / `depthLimit` / `toolFilter` / `persona` 我们**兑现不了** ——
 *     外部 CLI 的产出是纯文本，没有结构化输出、也不受 DSH 的递归预算/工具过滤/人格约束；
 *     开着它们等于对宿主撒谎（宿主会照信，然后在需要时拿到一个兑现不了的承诺）。
 *   · `agentOptions` 打开的唯一理由：**真的**能兑现 per-child 的 `model`
 *     （`childAgentOptionsDecision()` → `sessions.dispatch({model})` → 目标 `modelArgs`）。
 */
export declare const HARNESS_PROVIDER_CAPABILITIES: any;
/** 该 harness 的子代理 provider 名（`harness-opencode`、`harness-zcode` …）。 */
export declare function providerNameFor(target: TargetConfig): string;
/**
 * `registerProviders()` 的选项：旧的数字形参仍然接受（已有调用点不该因扩展被迫改签名）。
 *
 * 账号相关字段全部可选：**不给 `accounts` 就完全按旧行为注册**（只注册 `harness-<target>`
 * 与 `harness-pilot`），于是「没接线」与「接了线」在行为上可分辨，也不会因为漏传参数而崩。
 */
export type RegisterProvidersOptions = Partial<AccountAliasOptions> & {
    /** 内部子代理 run 的停滞判定（毫秒）；缺省 `DEFAULT_STALL_TIMEOUT_MS`。 */
    readonly stallTimeoutMs?: number;
};
/**
 * 为每个目标注册一个 provider；默认目标额外注册 `harness-pilot` 别名；
 * 给了 `options.accounts` 时**再**为每个 (target × account) 注册一个**身份别名**
 * （`harness-<target>-acct-<档案 id>`，账号配方在注册期烘进构造）。
 * 返回实际注册的 provider 名（按注册顺序），供日志与工具描述使用。
 *
 * 幂等：同名 provider 已存在（同一个包被两条 loader 行加载）时跳过，
 * 否则重复注册会让第二条 loader 行的 fiber 失败（宿主 `registerProvider` 对重名抛
 * `DUPLICATE_PROVIDER`）。
 *
 * ⚠️ 两条**如实说明**的边界：
 *   · 别名的集合是**注册期**算出来的。之后用户**新增**的账号档案不会自动多出一个 provider
 *     名字（要等下一次插件重载）；而**停用/删除**是**不需要**重载的 —— 判活在 `start()` 里
 *     实时做，新任务会被显式拒绝。
 *   · `harness-pilot` 这个默认别名**不带**账号变体（它是「默认目标」的短名，不是账号选择器）。
 *
 * `injectedMerge`（第 7 形参）= 「账号 → 目标」的**唯一**合并实现，由调用方注入
 * `src/account-target.ts` 的 `withAccountTarget()`。为什么是注入而不是 import：
 * 见 `AccountMergeLike` 的注释（切断 `provider.ts ↔ account-target.ts` 循环）。
 * 不注入 ⇒ 普通账号别名**如实跳过**（绝不自己再拼一份合并规则）。
 */
export declare function registerProviders(registry: SubagentRegistryLike, sessions: SessionRegistry, tasks: TaskManager, targets: readonly TargetConfig[], defaultTarget: string, optionsOrStallTimeout?: number | RegisterProvidersOptions, injectedMerge?: AccountMergeLike): string[];
