/**
 * 额度状态判定（账号池的地基）。
 *
 * ## 为什么这个模块必须极度保守
 * 「额度耗尽 → 自动换账号」是本插件里**破坏性最强**的自动化：判错一次就会
 * 把还能用的账号停掉、把任务搬到别的账号、甚至重复消耗配额。
 * 因此这里的第一原则是：
 *
 *   **只有「原生额度接口」或「明确的结构化额度错误」才能得出 `exhausted`。
 *     其它一切 —— 网络错误、认证失效、5xx、超时、限流 —— 一律 `unknown`。**
 *
 * 把短暂限流当成额度耗尽，会把一个好账号冷却掉并在账号之间来回横跳；
 * 把认证失效当成额度耗尽，会掩盖真正需要用户重新登录的问题。两者都必须避免。
 *
 * ## 本机实测结论（决定了这里的默认行为）
 * 实测 `qoderclicn --help`（108 行）只有 `login` / `status`，**没有任何 quota/usage/credit 子命令**；
 * `codebuddy --help`（105 行）同样没有。**也就是说这些 Harness 目前根本不提供原生额度接口**，
 * 所以额度状态在真实环境里默认就是 `unknown` —— 这不是偷懒，而是如实反映能力边界。
 * 结构化错误是当前唯一可用的来源。
 */
/** 额度状态。三态，且**默认是 unknown**。 */
export type QuotaState = 'available' | 'exhausted' | 'unknown';
/** 额度判定的来源，必须能说清「你凭什么这么说」。 */
export type QuotaSourceKind = 'native-api' | 'structured-error' | 'none';
export interface QuotaRecord {
    readonly accountId: string;
    readonly state: QuotaState;
    readonly source: QuotaSourceKind;
    /** 判定依据的可读说明（结构化错误要带上原始 code）。 */
    readonly reason: string;
    /** 观测时间（ISO）。界面上要显示「额度信息及其更新时间」。 */
    readonly observedAt: string;
    /** 剩余额度（原生接口给得出才填；给不出必须留空，不许猜）。 */
    readonly remaining?: number;
    readonly limit?: number;
    /** 原生接口给出的重置时间。 */
    readonly resetsAt?: string;
}
export declare const EXHAUSTION_CODES: readonly string[];
/** 明确**不**等于额度耗尽的状态码：限流 / 超时 / 服务端故障 / 认证。 */
export declare const TRANSIENT_STATUSES: readonly number[];
export declare const AUTH_STATUSES: readonly number[];
/** 只有 402 在语义上确实表示「要付费/额度」。 */
export declare const PAYMENT_STATUS = 402;
/** 明确**不**等于额度耗尽的错误码前缀（网络层）。 */
export declare const TRANSIENT_ERROR_CODES: readonly string[];
export interface FailureInput {
    /** 该失败属于哪个账号。 */
    readonly accountId: string;
    readonly observedAt?: string;
    /** 结构化错误码（最可信）。 */
    readonly code?: string;
    /** HTTP 状态码（若该错误来自 HTTP）。 */
    readonly status?: number;
    /** 原始错误文本（**最不可信**，仅作兜底）。 */
    readonly message?: string;
}
export interface QuotaVerdict {
    readonly accountId: string;
    readonly state: QuotaState;
    readonly source: QuotaSourceKind;
    readonly reason: string;
    readonly observedAt: string;
    /** 参与判定的信号，便于事后复盘。 */
    readonly signals: readonly string[];
    /** 相互矛盾的信号（例如「结构化说耗尽，但状态码是 429」）—— 必须显示出来。 */
    readonly conflicts: readonly string[];
}
/**
 * 判定一次失败是否意味着**额度耗尽**。
 *
 * 规则（顺序即优先级）：
 *   1. 结构化 code 命中白名单 → `exhausted`（若同时带 429/5xx，记录 conflict，但仍采信显式 code）；
 *   2. HTTP 402 → `exhausted`；
 *   3. 命中任何**瞬时**或**认证**信号 → **`unknown`**（明确否决，绝不 exhausted）;
 *   4. 文本同时命中「额度词 + 耗尽词」且不含瞬时/认证词 → `unknown`（**仍不判 exhausted**）,
 *      因为文本是不可信来源; 只记录为「疑似」，交由原生接口或结构化 code 确认；
 *   5. 其余 → `unknown`。
 *
 * 注意第 4 条：**文本永远不足以判定额度耗尽**。这不是保守过头，而是因为
 * 「把限流当耗尽」的代价（误停账号、账号间横跳、重复消耗）远大于「漏判」的代价（显示未知）。
 */
export declare function classifyFailure(input: FailureInput): QuotaVerdict;
/** 原生额度接口的结果 → 记录。**接口没给剩余量时不许编一个数字出来。** */
export declare function fromNativeApi(accountId: string, payload: {
    remaining?: number;
    limit?: number;
    resetsAt?: string;
    exhausted?: boolean;
}, observedAt?: string): QuotaRecord;
/** 从未查询过 / 查询不了 → 明确的「未知」。 */
export declare function unknownRecord(accountId: string, reason: string, observedAt?: string): QuotaRecord;
