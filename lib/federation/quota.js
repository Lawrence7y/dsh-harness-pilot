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
// ── 明确的结构化额度错误码（白名单）──────────────────────────────────
// 只有在这里列出的 code 才算「明确的结构化错误」。
export const EXHAUSTION_CODES = [
    'quota_exhausted',
    'quotaexceeded',
    'insufficient_quota',
    'insufficient_credit',
    'insufficient_credits',
    'credit_exhausted',
    'usage_limit_reached',
    'billing_hard_limit_reached',
    'subscription_quota_exhausted',
];
/** 明确**不**等于额度耗尽的状态码：限流 / 超时 / 服务端故障 / 认证。 */
export const TRANSIENT_STATUSES = [408, 425, 429, 500, 502, 503, 504, 507];
export const AUTH_STATUSES = [401, 403];
/** 只有 402 在语义上确实表示「要付费/额度」。 */
export const PAYMENT_STATUS = 402;
/** 明确**不**等于额度耗尽的错误码前缀（网络层）。 */
export const TRANSIENT_ERROR_CODES = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
    'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
];
/**
 * 文本兜底模式：**仅在没有任何冲突信号时**才采信，且必须同时命中
 * 「额度类词」与「耗尽类词」，避免把一句 `rate limit exceeded` 误判。
 */
const QUOTA_WORDS = /(?:quota|credit|balance|额度|配额|余额)/i;
const EXHAUST_WORDS = /(?:exhaust|insufficient|depleted|reached|used\s*up|exceed|耗尽|不足|用完|已满)/i;
/** 出现这些词就直接否决文本兜底。 */
const TRANSIENT_WORDS = /(?:rate\s*limit|too\s*many\s*requests|throttl|temporar|timeout|timed\s*out|try\s*again|限流|频率|稍后重试)/i;
const AUTH_WORDS = /(?:unauthor|unauthenticated|forbidden|invalid\s*(?:api\s*)?key|token\s*(?:expired|invalid)|not\s*logged\s*in|登录|认证失败|凭据)/i;
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
export function classifyFailure(input) {
    const observedAt = input.observedAt ?? new Date().toISOString();
    const signals = [];
    const conflicts = [];
    const code = typeof input.code === 'string' ? input.code.trim().toLowerCase() : '';
    const status = typeof input.status === 'number' ? input.status : undefined;
    const message = typeof input.message === 'string' ? input.message : '';
    if (code.length > 0)
        signals.push(`code=${code}`);
    if (status !== undefined)
        signals.push(`status=${status}`);
    if (message.length > 0)
        signals.push('message=present');
    const isTransientCode = TRANSIENT_ERROR_CODES.some(prefix => code.toUpperCase().startsWith(prefix));
    const isTransientStatus = status !== undefined && TRANSIENT_STATUSES.includes(status);
    const isAuthStatus = status !== undefined && AUTH_STATUSES.includes(status);
    const messageLooksTransient = TRANSIENT_WORDS.test(message);
    const messageLooksAuth = AUTH_WORDS.test(message);
    // 1) 结构化 code 白名单 —— 最高优先级
    if (code.length > 0 && EXHAUSTION_CODES.includes(code)) {
        if (isTransientStatus)
            conflicts.push(`声明的 code=${code} 表示额度耗尽，但 HTTP ${status} 属于瞬时/服务端故障，两者矛盾`);
        if (isAuthStatus)
            conflicts.push(`声明的 code=${code} 表示额度耗尽，但 HTTP ${status} 属于认证问题，两者矛盾`);
        if (isTransientCode)
            conflicts.push(`code=${code} 与网络层瞬时错误码冲突`);
        return {
            accountId: input.accountId,
            state: 'exhausted',
            source: 'structured-error',
            reason: `结构化错误码 "${code}" 明确表示额度/配额耗尽`,
            observedAt,
            signals,
            conflicts,
        };
    }
    // 2) HTTP 402 Payment Required
    if (status === PAYMENT_STATUS) {
        return {
            accountId: input.accountId,
            state: 'exhausted',
            source: 'structured-error',
            reason: 'HTTP 402 Payment Required —— 服务端明确要求付费/额度',
            observedAt,
            signals,
            conflicts,
        };
    }
    // 3) 明确的瞬时 / 认证信号 → 一律 unknown（**绝不 exhausted**）
    const denyReasons = [];
    if (isTransientStatus)
        denyReasons.push(`HTTP ${status} 属于瞬时/服务端故障（限流或服务不可用），不是额度耗尽`);
    if (isTransientCode)
        denyReasons.push(`网络层瞬时错误码 ${code}，不是额度耗尽`);
    if (isAuthStatus)
        denyReasons.push(`HTTP ${status} 属于认证问题（应走「认证失效 → 重新登录」，不是额度耗尽）`);
    if (messageLooksTransient)
        denyReasons.push('错误文本含限流/超时/稍后重试等瞬时特征，不是额度耗尽');
    if (messageLooksAuth)
        denyReasons.push('错误文本含认证失效特征，不是额度耗尽');
    if (denyReasons.length > 0) {
        return {
            accountId: input.accountId,
            state: 'unknown',
            source: 'none',
            reason: denyReasons.join('；'),
            observedAt,
            signals,
            conflicts,
        };
    }
    // 4) 文本兜底：**即便像，也不判 exhausted**
    if (QUOTA_WORDS.test(message) && EXHAUST_WORDS.test(message)) {
        return {
            accountId: input.accountId,
            state: 'unknown',
            source: 'none',
            reason: '错误文本疑似额度相关，但文本是**不可信来源**，不足以判定额度耗尽；'
                + '需要原生额度接口或结构化 code 确认，故先记为「未知」',
            observedAt,
            signals,
            conflicts,
        };
    }
    // 5) 其余一律 unknown
    return {
        accountId: input.accountId,
        state: 'unknown',
        source: 'none',
        reason: '没有可识别的额度信号 —— 按「未知」处理（不得推断为耗尽）',
        observedAt,
        signals,
        conflicts,
    };
}
/** 原生额度接口的结果 → 记录。**接口没给剩余量时不许编一个数字出来。** */
export function fromNativeApi(accountId, payload, observedAt = new Date().toISOString()) {
    const state = payload.exhausted === true ? 'exhausted' : 'available';
    return {
        accountId,
        state,
        source: 'native-api',
        reason: payload.exhausted === true ? '原生额度接口报告已耗尽' : '原生额度接口可查询且未报告耗尽',
        observedAt,
        ...(typeof payload.remaining === 'number' ? { remaining: payload.remaining } : {}),
        ...(typeof payload.limit === 'number' ? { limit: payload.limit } : {}),
        ...(typeof payload.resetsAt === 'string' ? { resetsAt: payload.resetsAt } : {}),
    };
}
/** 从未查询过 / 查询不了 → 明确的「未知」。 */
export function unknownRecord(accountId, reason, observedAt = new Date().toISOString()) {
    return { accountId, state: 'unknown', source: 'none', reason, observedAt };
}
//# sourceMappingURL=quota.js.map