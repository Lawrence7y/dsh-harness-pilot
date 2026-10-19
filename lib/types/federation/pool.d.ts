/**
 * 账号池与自动切换决策（**纯函数**，可离线单测）。
 *
 * ## 设计原则
 * 1. **只在「明确额度耗尽」时自动切换。** `unknown` 一律不触发 —— 否则短暂限流会把账号池搅乱。
 * 2. **只在用户启用的账号池内、且 harness / 区域 / 供应商 / 模型兼容的账号之间切换。**
 * 3. **切换前验证目标账号的认证与可用性**；认证失效的账号不是候选。
 * 4. **无法保持原模型时按用户策略停止并提示**，**绝不静默换模型**（默认策略就是 `stop`）。
 * 5. **有上限、有退避、有熔断**：切换次数上限、最小切换间隔、连续失败熔断；
 *    全部账号不可用时**暂停并说明恢复条件**，不无限循环。
 * 6. **不做自动注册 / 自动获取新账号**；凭据始终由原生认证与受保护存储管理，本模块只做决策。
 *
 * 本模块**不执行**任何 I/O，也不碰凭据：决策与执行分离，便于先把「什么时候该切」论证清楚。
 */
import type { QuotaRecord } from './quota.js';
export interface PoolEntry {
    readonly accountId: string;
    readonly harnessId: string;
    /** 服务区域。跨区域切换必须显式声明兼容，否则不做候选。 */
    readonly region: string;
    /** 用户是否把该账号纳入自动切换池。 */
    readonly enabled: boolean;
    /** 越小越优先。 */
    readonly priority: number;
    /** 该账号可用的供应商（留空表示不限制）。 */
    readonly providers?: readonly string[];
    /** 该账号可用的模型（留空表示不限制）。 */
    readonly models?: readonly string[];
    /** 冷却截止（毫秒时间戳）。 */
    readonly cooldownUntilMs?: number;
    /**
     * 切到该账号之后要设置的冷却时长（毫秒）。**执行侧**（`autoswitch.ts`）在切换成功后读它，
     * 于是「冷却」不是一句注释，而是真的会挡住下一轮。
     */
    readonly cooldownMs?: number;
    /** 与当前账号区域兼容的显式声明（跨区域时才需要）。 */
    readonly regionCompatibleWith?: readonly string[];
}
export interface SwitchPolicy {
    /** 用户是否启用「额度耗尽后自动切换」。**默认关闭**。 */
    readonly autoSwitchEnabled: boolean;
    readonly maxSwitchesPerTask: number;
    /** 两次自动切换之间的最小间隔（退避基准）。 */
    readonly backoffBaseMs: number;
    readonly backoffFactor: number;
    /** 连续失败多少次后熔断。 */
    readonly maxConsecutiveFailures: number;
    /**
     * 目标账号无法保持原模型时的策略。
     * `stop` = 停止并提示（**默认，也是唯一不静默的选项**）；`switch-model` = 允许换模型但必须显式标注。
     */
    readonly onModelUnavailable: 'stop' | 'switch-model';
}
export declare const DEFAULT_POLICY: SwitchPolicy;
export type AuthStateLike = 'model-request-authorized' | 'identity-readable' | 'login-ok' | 'auth-invalid' | 'unknown';
export interface AutoSwitchInput {
    readonly now: number;
    readonly harnessId: string;
    readonly currentAccountId: string;
    /** 当前任务正在用的模型（要尽量保住）。 */
    readonly currentModel?: string;
    readonly currentProvider?: string;
    readonly pool: readonly PoolEntry[];
    readonly quota: Readonly<Record<string, QuotaRecord>>;
    readonly auth: Readonly<Record<string, AuthStateLike>>;
    readonly switchesSoFar: number;
    readonly consecutiveFailures: number;
    readonly lastSwitchAtMs?: number;
    readonly policy: SwitchPolicy;
    /**
     * 该 harness 是否支持**原生跨账号恢复会话**。
     * false 时要走「脱敏交接检查点 + 新会话」，并如实告知上下文保留边界。
     */
    readonly nativeSessionResumable: boolean;
}
export interface SwitchEvent {
    readonly at: string;
    readonly reason: string;
    readonly fromAccountId: string;
    readonly toAccountId: string;
    readonly recovery: 'native-resume' | 'checkpoint-new-session';
    /** 交接边界：哪些保留了、哪些丢了。**必须写清楚**。 */
    readonly boundary: string;
    readonly result: 'switched' | 'failed';
}
export type PoolDecision = {
    readonly action: 'stay';
    readonly reason: string;
} | {
    readonly action: 'switch';
    readonly targetAccountId: string;
    readonly reason: string;
    /** 是否保住了原模型。false 时必须配合 policy=switch-model 且界面上要显式标注。 */
    readonly modelPreserved: boolean;
    readonly recovery: SwitchEvent['recovery'];
    readonly boundary: string;
    readonly note: string;
} | {
    readonly action: 'pause';
    readonly reason: string;
    readonly recovery: string;
};
/**
 * 决定：继续用当前账号 / 切到某个账号 / 暂停等人工处理。
 *
 * 顺序即优先级，任何一步不满足都**不会**发生切换。
 */
export declare function decideAutoSwitch(input: AutoSwitchInput): PoolDecision;
/**
 * 生成切换事件记录。
 * 用户的硬性要求：切换事件要包含**原因、前后脱敏账号、时间、恢复方式和结果**。
 */
export declare function makeSwitchEvent(decision: Extract<PoolDecision, {
    action: 'switch';
}>, fromAccountId: string, redact: (accountId: string) => string, result: SwitchEvent['result'], at?: string): SwitchEvent;
/**
 * 「结果不确定的写操作」重放保护。
 *
 * 用户明确要求：切换账号**不得**盲目重放整个任务或重复执行已完成的工具调用；
 * 对结果不确定的写入 / 提交 / 推送，必须先核验实际状态。
 *
 * 返回该动作**现在应该怎么做**：
 *   · 已完成 → `skip`（绝不重复执行）
 *   · 结果不确定 → `verify-first`（先核验，**不允许**直接重放）
 *   · 未开始 → `run`
 */
export type ActionState = 'not-started' | 'completed' | 'uncertain';
export declare function replayPolicy(state: ActionState, kind: 'read' | 'write' | 'commit' | 'push'): {
    readonly action: 'run' | 'skip' | 'verify-first';
    readonly reason: string;
};
