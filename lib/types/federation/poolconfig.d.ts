/**
 * 账号池配置 + **手动**一键切换。
 *
 * ## 为什么先做「手动」而不是「自动」
 * 自动切换依赖额度判定，而额度在本机**没有原生接口**（见 quota.ts），只能靠结构化错误，
 * 证据面较窄；手动切换则是用户明确点一下、意图无歧义。因此先把**手动**这条链路打通并验收，
 * 自动再往上接 —— 顺序反过来会先把一个判据不够硬的自动化放出去。
 *
 * ## 这个模块负责什么
 *   · 账号池配置（哪些账号在池内、是否启用、优先级、冷却、是否允许自动切换、默认账号）；
 *   · 手动切换的**决策与事件记录**（验证目标账号、算出恢复方式与交接边界、写切换账本）。
 *
 * ## 这个模块**不**负责什么（必须说清）
 *   · **不执行**真实派发，**不碰凭据**，不复制/解密任何认证文件；
 *   · 不做自动注册、获取新账号；
 *   · 登录/退出仍由各 Harness **自己的**原生流程负责。本模块只做规划与记账；
 *     真正把命令交给 CLI 的是 `accounts.ts` 的 `planNativeAuth` / `runNativeAuth`
 *     （它们调用的是 CLI 自己的 `login` / `logout` / `status` 子命令，**不自己实现登录协议**）。
 */
import { existsSync } from 'node:fs';
import { type AccountSeed } from './accounts.js';
import type { QuotaRecord } from './quota.js';
import type { AuthStateLike, SwitchPolicy } from './pool.js';
export interface PoolEntryConfig {
    readonly accountId: string;
    readonly harnessId: string;
    readonly region: string;
}
export interface PoolState {
    readonly version: 1;
    /** 用户是否启用「额度耗尽后自动切换」。**默认关闭**。 */
    readonly autoSwitchEnabled: boolean;
    /** 默认账号（只影响**新建**任务；不影响正在运行的任务）。 */
    readonly defaultAccountId?: string;
    readonly policy: Omit<SwitchPolicy, 'autoSwitchEnabled'>;
    readonly entries: Readonly<Record<string, {
        readonly enabled: boolean;
        readonly priority: number;
        /** 冷却毫秒数（不是时间戳）。切换后按它设置冷却。 */
        readonly cooldownMs: number;
        /**
         * 该账号可用的模型清单（用户显式声明）。留空 = 未声明。
         * 自动切换**只**用它做「模型兼容」判定 —— 没声明就明说「未能核对」，
         * 绝不拿一个猜出来的清单去替代。
         */
        readonly models?: readonly string[];
    }>>;
    readonly updatedAt: string;
}
/** 从账号种子生成初始池：**默认不启用任何自动行为**。 */
export declare function defaultPoolState(at?: string, seeds?: readonly AccountSeed[]): PoolState;
/**
 * 读账号池配置。
 *
 * `seeds` 传**当前生效**的账号列表（内置 ± 用户增删改）。为什么必须传：
 * 用户新加的档案如果不在补默认值的种子里，它在池里就永远没有条目，
 * 于是「新账号默认不启用」会退化成「新账号根本不出现在界面上」。
 */
export declare function loadPoolState(file: string, seeds?: readonly AccountSeed[]): PoolState;
export declare function savePoolState(file: string, state: PoolState): void;
export declare function updatePoolState(state: PoolState, patch: {
    autoSwitchEnabled?: boolean;
    defaultAccountId?: string | null;
    entry?: {
        accountId: string;
        enabled?: boolean;
        priority?: number;
        cooldownMs?: number;
        models?: readonly string[] | null;
    };
    /** 档案被删除时把它的池条目一并移除 —— 否则界面上会留下永远点不动的幽灵条目。 */
    dropEntry?: string;
    policy?: Partial<PoolState['policy']>;
}, at?: string): PoolState;
export interface ManualSwitchInput {
    /** 作用域：会话 / 任务 / 团队成员。事件按它归档，详情页据此显示。 */
    readonly scope: {
        readonly kind: 'session' | 'task' | 'member';
        readonly id: string;
    };
    readonly harnessId: string;
    /** 当前账号（**已脱敏**的标签由本模块生成，调用方只给 id）。 */
    readonly fromAccountId: string;
    readonly toAccountId: string;
    readonly currentModel?: string;
    readonly currentProvider?: string;
    /** 目标账号的认证状态（由只读身份探测得到）。 */
    readonly authOfTarget: AuthStateLike;
    /** 目标账号的额度状态（没有原生接口时是 unknown）。 */
    readonly quotaOfTarget?: QuotaRecord;
    /** 目标账号支持的模型（留空=不限制）。 */
    readonly modelsOfTarget?: readonly string[];
    readonly regionOfTarget: string;
    readonly regionOfCurrent: string;
    readonly regionCompatible: boolean;
    readonly nativeSessionResumable: boolean;
    /** 结果不确定的写操作数量 —— 有的话必须提醒先核验，不得重放。 */
    readonly uncertainWriteActions?: readonly string[];
}
export type ManualSwitchOutcome = {
    readonly ok: false;
    readonly reason: string;
    readonly recovery: string;
} | {
    readonly ok: true;
    readonly fromAccount: string;
    readonly toAccount: string;
    readonly recovery: 'native-resume' | 'checkpoint-new-session';
    readonly boundary: string;
    readonly modelPreserved: boolean;
    readonly warnings: readonly string[];
};
/** 账号脱敏：只保留尾部少量字符，且**不可反推**。 */
export declare function redactAccount(accountId: string): string;
/**
 * 手动切换的判定。**纯函数**：不 I/O、不碰凭据。
 *
 * 与自动切换共用同一批纪律：
 *   · 目标必须在启用的池内、同 Harness、区域兼容；
 *   · 目标认证**不得**为 auth-invalid（否则应当先重新登录，而不是切换）；
 *   · 额度已耗尽的目标**不是**合法目标（换过去等于白换）；
 *   · 模型保不住要**显式**回报，绝不静默换模型；
 *   · 结果不确定的写操作要**提醒先核验**，不得盲目重放。
 */
export declare function planManualSwitch(input: ManualSwitchInput): ManualSwitchOutcome;
/** 目标账号是否在**启用的**池内。不在就不允许作为切换目标。 */
export declare function isEligibleTarget(state: PoolState, accountId: string): {
    ok: boolean;
    reason: string;
};
/**
 * 把一个账号档案解析成**可执行的启动配方**：要加的参数、要设的环境变量、以及它的配置目录。
 *
 * 这是「切换真的改变执行」的落点 —— 没有它，账号切换就只是账本上的一行字。
 *
 * 各 Harness 的隔离机制不同，`AccountSeed.launch` 如实记录了实测结论：
 *   · Qoder：`--config-dir <dir>`，且 `.auth/` 就在该目录内 → **认证真正隔离**；
 *   · WorkBuddy：配置目录可用环境变量指定，但**认证存储是厂商共享的**（不随目录变化），
 *     所以这里给的是配置目录环境变量，**不代表认证被隔离**（见 accounts.ts 的隔离披露）。
 *
 * **不碰凭据**：这里只拼参数与环境变量，从不读取、复制或解密任何认证文件。
 */
export declare function resolveAccountLaunch(accountId: string, homeDir: string, seeds?: readonly AccountSeed[]): {
    readonly ok: true;
    readonly args: readonly string[];
    readonly env: Record<string, string>;
    readonly configDir: string;
    /** 隔离的**真实范围**，界面上要照实显示，不能笼统说「已隔离」。 */
    readonly isolationNote: string;
} | {
    readonly ok: false;
    readonly reason: string;
};
export { existsSync };
