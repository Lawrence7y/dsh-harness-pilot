import type { AccountSeed } from './federation/accounts.js';
import type { TargetConfig } from './types.js';
/**
 * 一份**冻结**的账户配方（账号启动参数 + 环境变量），与该账号档案此刻的最新值一致。
 *
 * ⚠️ 它是**不可变快照**：构造它的那一刻起，档案改名/停用/删除都不得改变它 ——
 * 团队成员的身份、别名 provider 的目标都是靠这一点成立的。
 */
export interface FrozenAccountRecipe {
    /** 原始档案 id。**只**用于路由与 `SessionBinding.accountId`，**绝不**进面向人的文案。 */
    readonly accountId: string;
    /** 脱敏标签（`acct:…`），所有文案用它。 */
    readonly label: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly configDir: string;
    readonly isolationNote: string;
}
/** `withAccountTarget()` 的产物形状（`task-tools.ts` 与 `tools.ts` 直接用这个契约）。 */
export type AccountTargetOutcome = {
    readonly ok: true;
    readonly target: TargetConfig;
    readonly note: string;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** 解算器注入面（默认实现就是下面那个纯函数）。 */
export type AccountRecipeResolver = (accountId: string, seeds: readonly AccountSeed[]) => {
    readonly ok: true;
    readonly recipe: FrozenAccountRecipe;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** 账号是否**受管 bootstrap**（WorkBuddy 的厂商内部协议适配器那条路）。 */
export declare function isManagedBootstrapSeed(seed: AccountSeed): boolean;
/** 目标自身的 `args` / `env` 里引用了哪些账号的默认配置目录（含被明文写死的那种）。 */
export declare function accountIdsCarriedByTarget(target: TargetConfig): readonly string[];
/** 受管 WorkBuddy 的已验收账号 id（与 wrapper 内建白名单一致；升级需重新验收）。 */
export declare const NATIVE_MANAGED_WORKBUDDY_IDS: readonly string[];
/** 目标 argv 里烘焙的账号引用。 */
export interface BakedAccountRef {
    /** `managed-wrapper`：受管 wrapper 的账号 id；`config-dir`：`--config-dir` 档案目录。 */
    readonly kind: 'managed-wrapper' | 'config-dir';
    /** wrapper 的账号 id，或档案目录绝对路径。 */
    readonly value: string;
}
/** 从目标 argv 识别烘焙账号引用；没有则 undefined（该目标不靠 argv 绑定账号）。 */
export declare function bakedAccountRefOf(target: Pick<TargetConfig, 'args'>): BakedAccountRef | undefined;
/** 绑定比较键（类型+值；config-dir 的值做过路径规范化，Windows 大小写不敏感）。 */
export declare function bakedAccountRefKey(ref: BakedAccountRef): string;
/** 目标是否**已经**把该账号的配置目录写进自己的 `args` / `env`（同一套判定，别名注册也在用）。 */
export declare function targetCarriesAccountConfigDir(target: TargetConfig, configDir: string): boolean;
/**
 * 「目标已经把该账号的**完整启动配方**带在身上」的逐项判定。
 *
 * 五项缺一不可（任何一项不成立都**不算**同账号，也就不会走「整份复用」那条路）：
 *   ① 目标 `args` / `env` 里出现该账号的配置目录；
 *   ② 目标 `command` 与该档案的 `launch.command` 指向同一个可执行文件；
 *   ③ 该档案的 `launch.args`（`{configDir}` 已替换）是目标 `args` 的**前缀**；
 *   ④ 该档案 `launch.env` 的每个键值都已在目标 `env` 里**逐字相同**地存在；
 *   ⑤ 档案自己给出的 `configDir` 确实就是那个被写进目标的目录。
 *
 * 这就是用户口径里的「用**真实完整配方**确认同账号，**不靠名字猜**」。
 */
export declare function sameAccountRecipe(target: TargetConfig, seed: AccountSeed, homeDir: string): boolean;
/** 普通合并：账号参数前置、账号 env 覆盖目标 env。 */
export declare function mergePlainAccountInto(target: TargetConfig, accountArgs: readonly string[], accountEnv: Readonly<Record<string, string>>): TargetConfig;
/**
 * 别名注册用的**策略级**合并（与 `withAccountTarget()` 的第 ④ 分支同源、同一条实现）。
 *
 * 输入是**已解算好**的账号配方（别名规划在调用它之前已经核过「档案在不在」、
 * 「目标是不是已经写着该档案的配置目录」两件事）。判定顺序与 `withAccountTarget()` 一致：
 * ① 目标已带着**别人的**真实配置目录 ⇒ 拒绝；② 目标已按真实完整配方带着**同一账号** ⇒ 整份复用；
 * ③ 其余 ⇒ `mergePlainAccountInto()` 的普通合并。
 */
export declare function mergeAccountByPolicy(input: {
    readonly target: TargetConfig;
    readonly seed: AccountSeed;
    readonly launch: {
        readonly args: readonly string[];
        readonly env: Readonly<Record<string, string>>;
        readonly configDir: string;
    };
    readonly seeds: readonly AccountSeed[];
    readonly homeDir: string;
}): AccountTargetOutcome;
/**
 * 受管目标的**完整启动元组**逐项核对（在 `provider.ts` 的 `managedAccountAliasRefusal()` 之外
 * 再加一道**显式**闸门，返回可读原因 = 拒绝）。
 *
 * 逐项含义（缺一项都会让「跑的是哪个账号」变得不可判定）：
 *   · `command`          —— 已验收的那个厂商可执行文件（受管模式要它自己的 Node 模式）；
 *   · `args` / `acpArgs` —— **绝对** wrapper 恰好 1 次 + 档案 id 恰好 1 次 + 各自的旗标，
 *                           且**不得残留**相对 wrapper 名（缺陷就是这个形状）；
 *   · `env`              —— `ELECTRON_RUN_AS_NODE=1`（档案侧与目标侧都要有）；
 *   · `configDir`        —— 档案配置目录必须是 `~/.dsh/harness-accounts/<档案 id>`；
 *   · 版本前缀           —— 必须**声明**（真实测量与哈希门禁在 `managedBootstrapRuntimeGate()`，
 *                           本函数不冒充它，只保证「配方不是无门禁的」）。
 */
export declare function managedRecipeTupleProblem(target: TargetConfig, seed: AccountSeed, home: string): string | undefined;
/**
 * 认领一个**受管 bootstrap**账号在给定目标上的**已验收启动计划**（整份复用，不叠加）。
 *
 * 计划来源就是别名 provider 用的那一处：`planAccountAliases()` → 内部的
 * `managedAccountAliasRefusal()` 已经逐项核过厂商 exe / 绝对 wrapper / 档案 id / `-p` /
 * `--acp` / `ELECTRON_RUN_AS_NODE` / 配置目录 / 版本前缀。这里**不另写第二套配方校验**，
 * 只在它之外补一道 `managedRecipeTupleProblem()` 的显式核对，并把「认领不到」变成
 * **显式拒绝**（脱敏、不 fallback、不换账号）。
 */
export declare function claimManagedAccountRecipe(target: TargetConfig, seed: AccountSeed, home: string, seeds: readonly AccountSeed[]): {
    readonly ok: true;
    readonly target: TargetConfig;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * 账户解算器：**产品化默认实现**。
 *
 * 直接复用 `resolveAccountLaunch`（账号池/派发/别名 provider 三方共用的**同一处**实现）——
 * 本模块**不**另写一份账户配方逻辑，否则「派发用 A 配方、路由用 B 配方」这种不一致迟早出现。
 */
export declare function resolveAccountRecipe(accountId: string, seeds: readonly AccountSeed[], homeDir: string): {
    readonly ok: true;
    readonly recipe: FrozenAccountRecipe;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** 合并所需的三个入参（账号 id / 目标 / 解算器注入点）。 */
export interface AccountTargetInput {
    readonly target: TargetConfig;
    readonly accountId: string;
    /** 当前**生效**的账号档案（内置 ± 用户增删改）。 */
    readonly seeds: readonly AccountSeed[];
    readonly homeDir: string;
    /**
     * 解算器注入点（缺省 = `resolveAccountRecipe()`）。
     *
     * ⚠️ **不用来换一套语义**：注入方只负责「把账号解成配方」，合并/拒绝/脱敏一律在本函数里。
     */
    readonly resolveRecipe?: AccountRecipeResolver;
}
/**
 * **唯一**的「把账号配方套到目标上」实现。**六个产品入口全部走这里**（见文件头）。
 *
 * 四条分支，全部**显式**、全部可判：
 *   ① 受管 bootstrap 账号 ⇒ `claimManagedAccountRecipe()` 认领**完整元组**（整份复用）；
 *   ② 目标**已经**带着该账号的真实完整配方（Qoder 型硬绑定目标）⇒ **整份复用目标**，
 *      并逐项复核同账号 ⇒ **不重复注入**同值 `--config-dir`；
 *   ③ 目标带着**别人**的账号配置目录 ⇒ **显式拒绝**（不许把 A 的目录当 B 的账号用）；
 *   ④ 其余（目标自身不带账号）⇒ 既有语义：**档案参数前置、档案环境变量覆盖目标 env**，
 *      且**必须**通过同 Harness 判定。
 *
 * 任何一条不成立都返回 `{ok:false, reason}` —— 调用方必须原样拒绝，**不得**回退到别的账号、
 * 也不得回退到「不带账号的目标」。
 */
export declare function withAccountTarget(input: AccountTargetInput): AccountTargetOutcome;
export interface ScopedDefaultAccount {
    /** 真正要套用的账号 id（不属于本目标时为空 = 不套用）。 */
    readonly accountId: string;
    /** 非空 = 为什么**没**套用池默认账号（调用方应把它写进 note/诊断，绝不静默丢弃）。 */
    readonly ignoredReason: string | null;
}
/**
 * 把「账号池默认账号」按**目标所属 Harness** 解析（唯一实现）。
 *
 * ⚠️ 判据用 `src/harness-groups.ts` 的**产品身份表**（`classifyTarget` / `classifyHarnessId`），
 * **不**用 `seedForTarget(target.name)?.id`：实测踩到过 —— 内置 WorkBuddy 账号档案的 `targetName`
 * 写成了账号 id（`workbuddy-a`，见 `src/federation/accounts.ts:162`），于是 `seedForTarget('wb-managed-a')`
 * 解析不到，回落成目标名 ⇒ 把**唯一正确的配对**（workbuddy-a × wb-managed-a）判成「不是同一个 Harness」。
 * 身份表是这一层唯一的一份实现，两边都按它归一化。
 */
export declare function defaultAccountForTarget(input: {
    readonly targetName: string;
    readonly candidate: string;
    readonly seeds: readonly AccountSeed[];
}): ScopedDefaultAccount;
/** 一个会话**冻结**的账户配方（团队路由成员）：与 `FrozenAccountRecipe` 同形，带脱敏 note。 */
export interface FrozenAccountForDispatch {
    readonly accountId: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    /**
     * 该账号的配置目录（**冻结那一刻**的值）。
     *
     * 用它判「目标是否已经按真实完整配方带着这个账号」（硬绑定目标 ⇒ 整份复用、不重复注入）。
     * 缺省时退回按当前档案解出来的配置目录 —— 那一格只影响「是否识别为硬绑定」，
     * 影响不到「最终 argv 是什么」的判定（后者另有 `frozenTargetConfig` 逐项比对）。
     */
    readonly configDir?: string;
    /** 已在构造处脱敏的作用范围说明。 */
    readonly note: string;
    /**
     * 冻结时的**目标配置本体**（`FrozenTargetRecipe.targetConfig`）。
     *
     * 用途是**篡改/错配判据**，不是装饰：派发前把「冻结目标 + 冻结账号」再走一遍本模块的
     * 合并，结果必须与冻结的那一份**逐字相同**（命令 / headless 参数 / ACP 参数 / env）。
     * 对不上 ⇒ 显式拒绝（不静默换账号、也不静默换目标）。
     *
     * 缺省（旧记录没带）⇒ 不做这一项比对，其余判定照常 —— 旧记录仍按既有语义可用。
     */
    readonly frozenTargetConfig?: TargetConfig;
}
/** 目标的四项启动元组是否逐字相同（命令 / headless 参数 / ACP 参数 / 环境变量）。 */
export declare function sameTargetTuple(left: TargetConfig, right: TargetConfig): boolean;
/**
 * 「目标身份」的比较口径：**剥掉账号那一层**之后逐项比对。
 *
 * 四项：目标名（必须相等）、命令、headless 参数、ACP 参数、环境变量。
 * 为什么不能直接比抹平后的整元组：冻结快照里的目标可能**已经**含账号参数
 * （`qoder-cn-acct-a` 那种把 `--config-dir` 写在 argv 里的目标），
 * 而「当下目标」是同一份配置 —— 两者只在「账号那一层是否已被合并进 args」上不同。
 */
export declare function sameTargetUnbound(current: TargetConfig, frozen: TargetConfig, seeds: readonly AccountSeed[], homeDir: string): boolean;
/**
 * 把**冻结**配方合并进目标（团队成员的每一轮派发走这里）。
 *
 * 与 `withAccountTarget()` 的关系（这是本轮收口的关键一格）：
 *   · **不**按「查询时刻的账号档案」重算 —— 冻结就是冻结，档案改名/停用/删除都不得
 *     改变一位已经存在的成员（`docs/verified/team-routing.md` 的纪律）；
 *   · 但**合并规则**与 `withAccountTarget()` 同源：受管账号**整份复用**目标的完整元组，
 *     普通账号才前置（且目标若已硬绑定同一账号则整份复用，不重复注入）。
 *
 * 修复前的形状（**已确证**，见 `docs/verified/managed-account-target-fix.md` §5.0）：
 * `team-routing.ts` 的 `resolveAccountRecipe()` 走 `resolveAccountLaunch()` ⇒ 冻结下来的
 * `args` 是**相对**的 `['workbuddy-managed.cjs', <档案 id>]`；派发侧按
 * `[...frozen.args, ...found.args]` 合并 ⇒ `["workbuddy-managed.cjs", <id>, "<绝对 wrapper>", <id>, "-p"]`
 * （相对残留 1、档案 id ×2，两个 WB 账号 **2/2**）。
 *
 * @returns `ok:false` + 可读原因 = 冻结配方与该目标**不是同一个账号**（显式拒绝，不换号）。
 */
export declare function applyAccountToTarget(target: TargetConfig, account: FrozenAccountForDispatch, options: {
    readonly seeds: readonly AccountSeed[];
    readonly homeDir: string;
    /** 目标名（受管配对判定要用它；与 `target.name` 同值，显式传是为了让调用点自证）。 */
    readonly targetName?: string;
}): {
    readonly ok: true;
    readonly target: TargetConfig;
    readonly reused: boolean;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** 目标名的规范 Harness 身份（`seedForTarget` 的兜底原样保留：目标名本身就是种子 id 的情况）。 */
export declare function harnessIdOfTarget(targetName: string): string;
