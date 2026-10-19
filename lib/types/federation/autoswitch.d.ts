/**
 * 自动切换的**真实执行侧**（第 4 阶段）。
 *
 * ## 为什么需要这个文件
 * `pool.ts` 里的 `decideAutoSwitch()` 只是**决策**：它回答「什么时候该切」，
 * 但**不会真的换账号重跑**。在此之前，界面上那个「额度耗尽后自动切换」开关
 * 打开之后什么都不会发生 —— 这属于「把开关当执行」，是用户明确点名的错误。
 *
 * 本文件把决策接到**真实执行**上：发起一次尝试 → 失败后**保守分类** → 决策 →
 * 并发租约 → 切换前验证目标账号身份与模型 → 记录事件 → 用新账号**再发一次真实尝试**。
 *
 * ## 六条不可越过的纪律（用户硬性要求，逐条落到代码）
 * 1. **未知 / 429 / 网络错误 / 认证失效一律不得误切**：只有
 *    `classifyFailure()` 给出 `state==='exhausted'` 且 `source==='structured-error'` 才可能切；
 *    其余一切（含 `unknown`）**只记录、不切换**。
 * 2. **不重放已完成的工具调用**；**结果不确定的写/提交/推送先核验实际状态**。
 *    调用方必须显式声明本次失败的**副作用边界**（`effects`），缺省即「未核验」→ 不重跑。
 * 3. **账号冻结 + 有限重试 + 冷却退避 + 熔断**：全部是**状态**，不是注释。
 * 4. **切换后必须验证**目标账号的身份与模型 —— 只看「切换返回成功」不算数。
 * 5. **切换不影响运行中的任务**：任务与它创建时的账号绑定；本模块从不读账号池默认值。
 * 6. **事件可追溯**：原因 / 前后脱敏账号 / 时间 / 恢复方式 / 结果 / 验证结论全部落账本。
 *
 * ## 这个模块**不做**什么
 *   · 不碰凭据：不读、不复制、不解密任何认证文件；
 *   · 不自己实现登录：登录/退出一律走各 CLI 的原生流程（见 accounts.ts）；
 *   · 不做 I/O 编排以外的策略发明：额度判定唯一来源是 `quota.ts` 的 `classifyFailure`。
 */
import { type CoordinationPolicy, type CoordinationState } from './coordination.js';
import { type QuotaRecord, type QuotaSourceKind, type QuotaState } from './quota.js';
import { type ActionState, type AuthStateLike, type PoolEntry, type SwitchPolicy } from './pool.js';
import { type SwitchLogFile, type SwitchEventRecord } from './switchlog.js';
/** 一次真实尝试的失败信号。**最可信的是结构化 code**。 */
export interface AttemptFailureSignal {
    readonly code?: string;
    readonly status?: number;
    readonly message?: string;
}
/**
 * 从一次**真实派发**的诊断文本 / facts 里抽出**结构化**失败信号。
 *
 * ## 为什么必须有这一步（否则执行侧永远切不动）
 * 执行侧只看 `diagnostic` 那句人话的话，`classifyFailure` 永远只能走「文本兜底」→ 永远
 * `unknown` → **自动切换永远不会发生**。那就是另一种形式的「把开关当执行」。
 *
 * ## 它**不**放宽任何判定
 * 这里只做「把 CLI 已经写出来的结构化字段读出来」，一条都不新增白名单：
 *   · agy 的真实形状 `{"status":"RESOURCE_EXHAUSTED","error_code":429,...}` → 读到 `status: 429`
 *     → 仍然是**瞬时**信号 → 判定器仍然输出 `unknown`（与 `docs/verified/quota-error-observations.md`
 *     记录的既有行为**逐字一致**，不因为「看起来像配额」就放宽）；
 *   · opencode 的 `Go usage limit exceeded` → 没有结构化字段 → 仍然走文本兜底 → `unknown`；
 *   · 只有 CLI 自己写出白名单 code（如 `quota_exhausted`）才会被判为耗尽 ——
 *     而那需要 CLI 真的这么说，不是我们猜的。
 *
 * 纯函数、无 I/O，可离线单测（`probe/verify-auto-switch-executor.mjs` 覆盖真实形状）。
 */
export declare function extractFailureSignal(input: {
    readonly diagnostic?: string;
    readonly message?: string;
    readonly facts?: Readonly<Record<string, string | number | boolean | undefined>>;
}): AttemptFailureSignal;
/**
 * 从通道诊断里读回**子进程退出码**。
 *
 * ## 为什么必须读它（实测抓到的真实缺陷）
 * headless 通道在「进程非 0 退出、但**有** stdout」时给的是 `stopReason: 'completed'`
 * （见 `src/transports/headless.ts`：`if (code !== 0) finish('completed', 'harness exited with code N after producing output')`）。
 * 实测：一个**未登录**的账号派发出去，CLI 打印 `Not logged in · Please run /login` 并 exit 1，
 * 于是整件事被当成**成功** —— 执行侧连分类都没做（`not-classified`）。
 * 那等于「认证失效」这件事在自动切换这条链上根本不可见。
 *
 * 通道只在 **code !== 0** 时才写这句话，所以「读到了」= 真的非 0 退出，不是猜的。
 */
export declare function exitCodeFromDiagnostic(diagnostic: string | undefined): number | undefined;
/**
 * 本次失败尝试的**副作用边界**。由调用方如实声明 —— 这是「不得盲目重放」的强制点。
 *
 *   · `none`      —— 调用方核验过：**没有**任何写/提交/推送产生（例如失败发生在模型请求层）。
 *   · `uncertain` —— 有可能产生过，但结果不确定 → 必须先核验，**不重跑**。
 *   · `unknown`   —— 没核验（默认）→ **不重跑**。
 *
 * 为什么默认必须是 `unknown`：把「没查」当成「没有副作用」，正是「重复提交/重复推送」的成因。
 */
export type EffectBoundary = {
    readonly kind: 'none';
    readonly evidence: string;
} | {
    readonly kind: 'uncertain';
    readonly actions: readonly string[];
    readonly evidence: string;
} | {
    readonly kind: 'unknown';
    readonly reason: string;
};
/** 一次真实尝试的结果。`attempt` 回调返回它。 */
export interface AttemptOutcome {
    readonly ok: boolean;
    /** 失败时的原始信号；**没有**的话分类器只能给 unknown（保守方向，安全）。 */
    readonly failure?: AttemptFailureSignal;
    /** 通道/CLI **实际**回报的账号（用于核对「换了账号真的换了」）。 */
    readonly actualAccountId?: string;
    readonly actualModel?: string;
    readonly nativeSessionId?: string;
    readonly text?: string;
    readonly diagnostic?: string;
    /** 本次失败尝试的副作用边界；缺省=未核验。 */
    readonly effects?: EffectBoundary;
    /**
     * 这次「额度耗尽」的证据性质。**缺省按 `injected` 记** ——
     * 真实额度耗尽无法在不烧掉用户额度的前提下复现，所以默认方向必须是「不声称真实」。
     * 只有拿到了真实观测（真实 429/结构化错误原文来自真实进程）才允许写 `observed-live`。
     */
    readonly exhaustionProvenance?: 'observed-live' | 'injected';
}
/** 切换后对目标账号的验证结论（真实只读探测 + 模型清单核对）。 */
export interface TargetVerification {
    readonly identityOk: boolean;
    readonly modelOk: boolean;
    /** 验证做了什么、看到了什么。必须能复述。 */
    readonly detail: string;
    /** 目标账号的脱敏标签（可选，用于事件 detail）。 */
    readonly targetLabel?: string;
}
export interface AutoSwitchExecutionInput {
    readonly scope: {
        readonly kind: 'session' | 'task' | 'member';
        readonly id: string;
    };
    readonly harnessId: string;
    /**
     * 任务**创建时固化**的账号。全程不变 —— 这就是「改默认账号不会串到运行中任务」的落点。
     */
    readonly accountId: string;
    readonly model?: string;
    readonly provider?: string;
    readonly policy: SwitchPolicy;
    readonly pool: readonly PoolEntry[];
    readonly quota: Readonly<Record<string, QuotaRecord>>;
    readonly auth: Readonly<Record<string, AuthStateLike>>;
    readonly nativeSessionResumable: boolean;
    /** 账号池默认账号（**只用于核对**：本模块不得因为它的变化而改变 attempt 的账号）。 */
    readonly poolDefaultAccountId?: string;
    /** 真实尝试缝：给账号，返回结果。**这是唯一执行入口**。 */
    readonly attempt: (accountId: string, index: number) => Promise<AttemptOutcome>;
    /** 切换前/后验证目标账号（真实只读探测）。 */
    readonly verifyTarget: (accountId: string, model: string | undefined) => Promise<TargetVerification>;
    readonly now?: () => number;
    readonly policyCoordination?: CoordinationPolicy;
    /** 起始的运行时状态（进程内持久）。 */
    readonly runtime?: AutoSwitchRuntimeState;
    /** 起始的并发协调状态（进程内持久）。 */
    readonly coordination?: CoordinationState;
    /** 起始的切换账本。 */
    readonly switchLog?: SwitchLogFile;
}
export interface AutoSwitchAttemptRecord {
    readonly index: number;
    /** **脱敏**账号标签。 */
    readonly account: string;
    readonly outcome: 'ok' | 'failed';
    readonly quotaState: QuotaState | 'not-classified';
    readonly failureSource: QuotaSourceKind | 'none';
    readonly failureReason: string;
    readonly switchedHere: boolean;
    readonly diagnostic?: string;
}
export interface AutoSwitchDecisionRecord {
    readonly at: string;
    readonly action: string;
    readonly reason: string;
    readonly targetAccount?: string;
}
export interface AutoSwitchExecutionResult {
    readonly ok: boolean;
    /** 最终实际使用的账号（原始 id，**只在本进程内用**；出口必须脱敏）。 */
    readonly finalAccountId: string;
    readonly attempts: readonly AutoSwitchAttemptRecord[];
    readonly decisions: readonly AutoSwitchDecisionRecord[];
    readonly events: readonly SwitchEventRecord[];
    readonly runtime: AutoSwitchRuntimeState;
    readonly coordination: CoordinationState;
    readonly switchLog: SwitchLogFile;
    readonly notes: readonly string[];
    /** 停止原因（失败时）。 */
    readonly stopReason?: string;
    /**
     * ⚠️ **证据性质**：本次执行里「额度耗尽」是真实观测还是结构化注入。
     * 真实额度耗尽无法在不烧掉用户额度的前提下复现，所以任何 `injected` 都必须单独标注。
     */
    readonly exhaustionEvidence: 'observed-live' | 'injected' | 'none';
}
export interface AccountFreeze {
    readonly accountId: string;
    readonly reason: string;
    readonly at: string;
    /** 冻结到期时间戳；undefined = 一直冻结到用户手动解冻。 */
    readonly untilMs?: number;
}
export interface BreakerState {
    readonly consecutiveFailures: number;
    readonly openUntilMs?: number;
    readonly lastFailureAtMs?: number;
    readonly lastReason?: string;
}
export interface AutoSwitchRuntimeState {
    /** 账号 → 冻结记录。这是「账号冻结」的真实落点。 */
    readonly frozen: Readonly<Record<string, AccountFreeze>>;
    /** 账号 → 冷却截止（毫秒）。切换成功后按池里的 `cooldownMs` 设置。 */
    readonly cooldownUntil: Readonly<Record<string, number>>;
    readonly breaker: BreakerState;
    readonly updatedAt: string;
}
export declare const EMPTY_RUNTIME: AutoSwitchRuntimeState;
export declare function freezeAccount(state: AutoSwitchRuntimeState, accountId: string, reason: string, atMs: number, ttlMs?: number): AutoSwitchRuntimeState;
export declare function isFrozen(state: AutoSwitchRuntimeState, accountId: string, nowMs: number): boolean;
export declare function thawAccount(state: AutoSwitchRuntimeState, accountId: string, atMs?: number): AutoSwitchRuntimeState;
export declare function setCooldown(state: AutoSwitchRuntimeState, accountId: string, untilMs: number, atMs?: number): AutoSwitchRuntimeState;
/** 记一次失败：累加连续失败计数；达到阈值就**打开熔断**（记下打开到什么时候）。 */
export declare function noteFailure(state: AutoSwitchRuntimeState, reason: string, atMs: number, policy: SwitchPolicy): AutoSwitchRuntimeState;
/** 记一次成功：**连续失败计数清零、熔断关闭**。成功就是成功，不保留惩罚。 */
export declare function noteSuccess(state: AutoSwitchRuntimeState, atMs: number): AutoSwitchRuntimeState;
export declare function breakerOpen(state: AutoSwitchRuntimeState, nowMs: number): boolean;
/**
 * 把**运行时**状态（冻结 / 冷却）叠加到账号池上，再交给 `decideAutoSwitch`。
 *
 * 为什么必须有这一步：`pool.ts` 是**纯函数**，它只看调用方给的池；如果冻结只写进
 * `runtime` 却不叠加进池，那「账号冻结」就是一句注释 —— 被冻结的账号照样会被选成目标。
 * 这里是冻结**真正生效**的落点。
 */
export declare function applyRuntimeToPool(pool: readonly PoolEntry[], runtime: AutoSwitchRuntimeState, nowMs: number): {
    readonly pool: readonly PoolEntry[];
    readonly excluded: readonly string[];
};
/**
 * 把调用方声明的副作用边界翻成「能不能重跑」。
 *
 * **默认（未声明）不允许重跑** —— 这是本模块最重要的默认值。
 */
export declare function retryAllowedByEffects(boundary: EffectBoundary | undefined): {
    readonly allowed: boolean;
    readonly action: 'run' | 'skip' | 'verify-first';
    readonly reason: string;
};
/** 完成态动作一律不得重放（纯判定，供调用方与探针复用）。 */
export declare function completedActionsMustNotReplay(actions: readonly {
    readonly name: string;
    readonly kind: 'read' | 'write' | 'commit' | 'push';
    readonly state: ActionState;
}[]): string[];
/**
 * 「切换后验证」的判定：**只看切换动作返回成功不算数**。
 *
 * 必须同时满足：目标账号身份可读（真实只读探测）+ 请求的模型在目标账号可用。
 */
export declare function judgeTargetVerification(verification: TargetVerification, modelRequested: string | undefined): {
    readonly ok: boolean;
    readonly reason: string;
};
/** 一次尝试的失败是否「明确额度耗尽」。**这是唯一允许自动切换的条件。** */
export declare function exhaustionOnly(verdict: {
    state: QuotaState;
    source: QuotaSourceKind;
}): boolean;
/**
 * 真实执行：带自动切换的一次派发。
 *
 * 顺序（任何一步不满足都**不会**发生切换，且都会留下原因）：
 *   ① 用**任务创建时**的账号发一次真实尝试；
 *   ② 成功 → 收工（并清零熔断计数）；
 *   ③ 失败 → `classifyFailure`（**保守**）→ 非「明确额度耗尽」→ 停，**绝不切**；
 *   ④ 明确额度耗尽 → 副作用边界判定：没核验过/不确定 → 停（先核验，不重放）；
 *   ⑤ 冻结该账号 + 记失败 + 熔断检查；
 *   ⑥ `decideAutoSwitch`（上限/退避/冷却/模型兼容/区域/认证）→ 非 switch → 停；
 *   ⑦ 目标账号**并发租约**（同一账号同一时刻只允许一个切换者）；
 *   ⑧ 切换前**真实验证**目标账号身份与模型 → 不通过 → 记 refused 事件并停；
 *   ⑨ 记 `switched` 事件 + 目标账号冷却 → 用新账号回到 ①。
 */
export declare function executeWithAutoSwitch(input: AutoSwitchExecutionInput): Promise<AutoSwitchExecutionResult>;
