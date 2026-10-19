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
import { DEFAULT_COORDINATION, EMPTY_COORDINATION, acquire, noteSwitch, release, } from './coordination.js';
import { redactAccount } from './poolconfig.js';
import { classifyFailure } from './quota.js';
import { decideAutoSwitch, replayPolicy } from './pool.js';
import { appendSwitchEvent, autoSwitchCount, lastSwitchAtMs } from './switchlog.js';
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
export function extractFailureSignal(input) {
    const text = [input.diagnostic, input.message].filter((x) => typeof x === 'string' && x.length > 0).join('\n');
    const out = {};
    if (text.length > 0)
        out.message = text.slice(0, 4000);
    // 显式字段（有些通道会把结构化信息放进 facts）。
    const factCode = input.facts?.errorCode ?? input.facts?.error_code ?? input.facts?.code;
    if (typeof factCode === 'string' && factCode.trim().length > 0)
        out.code = factCode.trim();
    const factStatus = input.facts?.status ?? input.facts?.statusCode ?? input.facts?.httpStatus;
    if (typeof factStatus === 'number')
        out.status = factStatus;
    if (typeof factStatus === 'string' && /^\d{3}$/.test(factStatus.trim()))
        out.status = Number(factStatus.trim());
    // 文本里的 JSON 片段（agy 的真实形状就是 `AGY_ERROR: {...}` 这种）。
    for (const raw of extractJsonObjects(text)) {
        try {
            const parsed = JSON.parse(raw);
            const code = firstString(parsed, ['code', 'error_code', 'errorCode', 'error_type', 'type']);
            const status = firstNumber(parsed, ['status', 'statusCode', 'status_code', 'http_status']);
            if (out.code === undefined && code !== undefined)
                out.code = code;
            if (out.status === undefined && status !== undefined)
                out.status = status;
            // agy 形状：`status` 是字符串（RESOURCE_EXHAUSTED）、`error_code` 是数字（429）。
            // 数字那个才是 HTTP 语义，优先级更高 —— 否则会把「用 429 承载的配额声明」误升格。
            const numericStatus = firstNumber(parsed, ['error_code', 'http_status', 'statusCode']);
            if (numericStatus !== undefined && numericStatus >= 100 && numericStatus < 600)
                out.status = numericStatus;
        }
        catch { /* 不是 JSON 就算了，不猜 */ }
    }
    // `code=` / `status=` 这类键值对（很多 CLI 的诊断里直接这么写）。
    if (out.status === undefined) {
        const m = /\b(?:http[_\s-]?)?status(?:\s*code)?\s*[=:]\s*(\d{3})\b/i.exec(text);
        if (m !== null)
            out.status = Number(m[1]);
    }
    // `HTTP 429` / `HTTP/1.1 503` 这类写法。
    if (out.status === undefined) {
        const m = /\bHTTP(?:\/\d(?:\.\d)?)?[\s-]+(\d{3})\b/i.exec(text);
        if (m !== null)
            out.status = Number(m[1]);
    }
    if (out.code === undefined) {
        const m = /\bcode\s*[=:]\s*"?([A-Za-z][A-Za-z0-9_.-]{2,63})"?/.exec(text);
        if (m !== null)
            out.code = m[1];
    }
    return out;
}
function firstString(obj, keys) {
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim().length > 0)
            return v.trim();
    }
    return undefined;
}
function firstNumber(obj, keys) {
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'number' && Number.isFinite(v))
            return v;
        if (typeof v === 'string' && /^\d+$/.test(v.trim()))
            return Number(v.trim());
    }
    return undefined;
}
/** 从文本里挑出**像 JSON 对象**的片段（按大括号配对，最多找 4 个）。 */
function extractJsonObjects(text) {
    const out = [];
    for (let start = text.indexOf('{'); start >= 0 && out.length < 4; start = text.indexOf('{', start + 1)) {
        let depth = 0;
        for (let i = start; i < text.length && i - start < 4000; i += 1) {
            const ch = text[i];
            if (ch === '{')
                depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    out.push(text.slice(start, i + 1));
                    break;
                }
            }
        }
    }
    return out;
}
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
export function exitCodeFromDiagnostic(diagnostic) {
    if (typeof diagnostic !== 'string' || diagnostic.length === 0)
        return undefined;
    const m = /exited with code\s+(-?\d+)/i.exec(diagnostic);
    if (m === null)
        return undefined;
    const code = Number(m[1]);
    return Number.isFinite(code) ? code : undefined;
}
export const EMPTY_RUNTIME = {
    frozen: {}, cooldownUntil: {}, breaker: { consecutiveFailures: 0 }, updatedAt: new Date(0).toISOString(),
};
export function freezeAccount(state, accountId, reason, atMs, ttlMs) {
    const freeze = {
        accountId,
        reason,
        at: new Date(atMs).toISOString(),
        ...(ttlMs === undefined ? {} : { untilMs: atMs + ttlMs }),
    };
    return { ...state, frozen: { ...state.frozen, [accountId]: freeze }, updatedAt: freeze.at };
}
export function isFrozen(state, accountId, nowMs) {
    const freeze = state.frozen[accountId];
    if (freeze === undefined)
        return false;
    // 没有 untilMs = 手动解冻前一直冻结（不做「时间到了就自动放行」的猜测）。
    if (freeze.untilMs === undefined)
        return true;
    return freeze.untilMs > nowMs;
}
export function thawAccount(state, accountId, atMs = Date.now()) {
    if (state.frozen[accountId] === undefined)
        return state;
    const frozen = { ...state.frozen };
    delete frozen[accountId];
    return { ...state, frozen, updatedAt: new Date(atMs).toISOString() };
}
export function setCooldown(state, accountId, untilMs, atMs = Date.now()) {
    return { ...state, cooldownUntil: { ...state.cooldownUntil, [accountId]: untilMs }, updatedAt: new Date(atMs).toISOString() };
}
/** 记一次失败：累加连续失败计数；达到阈值就**打开熔断**（记下打开到什么时候）。 */
export function noteFailure(state, reason, atMs, policy) {
    const consecutiveFailures = state.breaker.consecutiveFailures + 1;
    const shouldOpen = consecutiveFailures >= policy.maxConsecutiveFailures;
    const breaker = {
        consecutiveFailures,
        lastFailureAtMs: atMs,
        lastReason: reason,
        ...(shouldOpen
            ? { openUntilMs: atMs + policy.backoffBaseMs * Math.pow(policy.backoffFactor, Math.max(0, consecutiveFailures - policy.maxConsecutiveFailures)) }
            : {}),
    };
    return { ...state, breaker, updatedAt: new Date(atMs).toISOString() };
}
/** 记一次成功：**连续失败计数清零、熔断关闭**。成功就是成功，不保留惩罚。 */
export function noteSuccess(state, atMs) {
    if (state.breaker.consecutiveFailures === 0 && state.breaker.openUntilMs === undefined)
        return state;
    return { ...state, breaker: { consecutiveFailures: 0 }, updatedAt: new Date(atMs).toISOString() };
}
export function breakerOpen(state, nowMs) {
    return state.breaker.openUntilMs !== undefined && state.breaker.openUntilMs > nowMs;
}
/**
 * 把**运行时**状态（冻结 / 冷却）叠加到账号池上，再交给 `decideAutoSwitch`。
 *
 * 为什么必须有这一步：`pool.ts` 是**纯函数**，它只看调用方给的池；如果冻结只写进
 * `runtime` 却不叠加进池，那「账号冻结」就是一句注释 —— 被冻结的账号照样会被选成目标。
 * 这里是冻结**真正生效**的落点。
 */
export function applyRuntimeToPool(pool, runtime, nowMs) {
    const excluded = [];
    const out = pool.map((entry) => {
        const freeze = runtime.frozen[entry.accountId];
        const frozen = freeze !== undefined && isFrozen(runtime, entry.accountId, nowMs);
        const runtimeCooldown = runtime.cooldownUntil[entry.accountId] ?? 0;
        const declaredCooldown = entry.cooldownUntilMs ?? 0;
        // 冻结用「极远的冷却」表达：纯函数决策器因此必然跳过它，且不需要给决策器加特例。
        const cooldownUntilMs = frozen
            ? Number.MAX_SAFE_INTEGER
            : Math.max(declaredCooldown, runtimeCooldown);
        if (frozen)
            excluded.push(`${redactAccount(entry.accountId)}：已冻结（${freeze.reason}）`);
        else if (runtimeCooldown > nowMs)
            excluded.push(`${redactAccount(entry.accountId)}：处于切换后冷却（剩 ${Math.round((runtimeCooldown - nowMs) / 1000)}s）`);
        return { ...entry, cooldownUntilMs };
    });
    return { pool: out, excluded };
}
// ─────────────────────────── 副作用边界 → 重放判定 ───────────────────────────
/**
 * 把调用方声明的副作用边界翻成「能不能重跑」。
 *
 * **默认（未声明）不允许重跑** —— 这是本模块最重要的默认值。
 */
export function retryAllowedByEffects(boundary) {
    if (boundary === undefined) {
        return {
            allowed: false,
            action: 'verify-first',
            reason: '调用方**没有声明**本次失败的副作用边界 —— 未核验之前不重跑（把「没查」当成「没有副作用」正是重复提交/重复推送的成因）',
        };
    }
    if (boundary.kind === 'none') {
        return { allowed: true, action: 'run', reason: `副作用边界：none（${boundary.evidence}）` };
    }
    if (boundary.kind === 'uncertain') {
        const kinds = ['write', 'commit', 'push'];
        const verdicts = kinds.map((k) => replayPolicy('uncertain', k).action);
        return {
            allowed: false,
            action: 'verify-first',
            reason: `本次有 ${boundary.actions.length} 个**结果不确定**的动作（${boundary.actions.join('、') || '未列名'}）：`
                + `必须先核验实际状态（${boundary.evidence}）。判定器对 write/commit/push 的一致结论是 ${[...new Set(verdicts)].join('/')} —— **不得直接重放**。`,
        };
    }
    return { allowed: false, action: 'verify-first', reason: `副作用边界未知：${boundary.reason}` };
}
/** 完成态动作一律不得重放（纯判定，供调用方与探针复用）。 */
export function completedActionsMustNotReplay(actions) {
    return actions
        .filter((a) => a.state === 'completed')
        .map((a) => `${a.name}(${a.kind})：${replayPolicy('completed', a.kind).action} —— ${replayPolicy('completed', a.kind).reason}`);
}
// ─────────────────────────── 主流程 ───────────────────────────
/**
 * 「切换后验证」的判定：**只看切换动作返回成功不算数**。
 *
 * 必须同时满足：目标账号身份可读（真实只读探测）+ 请求的模型在目标账号可用。
 */
export function judgeTargetVerification(verification, modelRequested) {
    if (!verification.identityOk) {
        return {
            ok: false,
            reason: `切换后验证**失败**：目标账号身份不可读。${verification.detail}`
                + '（只看「切换返回成功」是不够的 —— 身份读不到就说明这次切换没有真正落到实处）',
        };
    }
    if (modelRequested !== undefined && modelRequested.length > 0 && !verification.modelOk) {
        return {
            ok: false,
            reason: `切换后验证**失败**：目标账号不支持请求的模型「${modelRequested}」。${verification.detail}`
                + '（按「绝不静默换模型」的纪律，本次不切换）',
        };
    }
    return { ok: true, reason: `切换后验证通过：${verification.detail}` };
}
/** 一次尝试的失败是否「明确额度耗尽」。**这是唯一允许自动切换的条件。** */
export function exhaustionOnly(verdict) {
    return verdict.state === 'exhausted' && verdict.source === 'structured-error';
}
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
export async function executeWithAutoSwitch(input) {
    const now = input.now ?? (() => Date.now());
    const coordPolicy = input.policyCoordination ?? DEFAULT_COORDINATION;
    const maxAttempts = Math.max(1, Math.min(1 + input.policy.maxSwitchesPerTask, 8));
    let runtime = input.runtime ?? EMPTY_RUNTIME;
    let coordination = input.coordination ?? EMPTY_COORDINATION;
    let switchLog = input.switchLog ?? { version: 1, events: [], updatedAt: new Date(0).toISOString() };
    const attempts = [];
    const decisions = [];
    const events = [];
    const notes = [];
    let account = input.accountId;
    let exhaustionEvidence = 'none';
    let lastDiagnostic;
    /**
     * 决策器要读的额度表 = 调用方给的历史 + **本次刚观测到的判定**。
     *
     * ⚠️ 这一步曾经漏掉过：分类器算出了 `exhausted`，却没写回这张表，
     * 于是 `decideAutoSwitch` 看到的仍是 `unknown` → 永远 stay → **自动切换是死接线**。
     * 探针（A 组）就是靠「attempt 只被调了一次」把它抓出来的。
     */
    const observedQuota = { ...input.quota };
    const recordDecision = (action, reason, targetAccount) => {
        decisions.push({ at: new Date(now()).toISOString(), action, reason, ...(targetAccount === undefined ? {} : { targetAccount: redactAccount(targetAccount) }) });
    };
    const finish = (ok, stopReason) => ({
        ok,
        finalAccountId: account,
        attempts,
        decisions,
        events,
        runtime,
        coordination,
        switchLog,
        notes,
        ...(stopReason === undefined ? {} : { stopReason }),
        exhaustionEvidence,
    });
    for (let index = 0; index < maxAttempts; index += 1) {
        const outcome = await input.attempt(account, index);
        if (outcome.ok) {
            runtime = noteSuccess(runtime, now());
            attempts.push({
                index, account: redactAccount(account), outcome: 'ok', quotaState: 'not-classified',
                failureSource: 'none', failureReason: '尝试成功', switchedHere: index > 0,
            });
            notes.push(`第 ${index + 1} 次尝试（账号 ${redactAccount(account)}）成功 —— 未发生自动切换。`);
            return finish(true);
        }
        lastDiagnostic = outcome.diagnostic;
        const verdict = classifyFailure({
            accountId: account,
            ...(outcome.failure?.code === undefined ? {} : { code: outcome.failure.code }),
            ...(outcome.failure?.status === undefined ? {} : { status: outcome.failure.status }),
            ...(outcome.failure?.message === undefined ? {} : { message: outcome.failure.message }),
        });
        if (exhaustionOnly(verdict))
            exhaustionEvidence = outcome.exhaustionProvenance ?? 'injected';
        // 把本次判定写回额度表 —— 否则决策器读不到，切换永远不会发生。
        observedQuota[account] = {
            accountId: account,
            state: verdict.state,
            source: verdict.source,
            reason: verdict.reason,
            observedAt: verdict.observedAt,
        };
        attempts.push({
            index,
            account: redactAccount(account),
            outcome: 'failed',
            quotaState: verdict.state,
            failureSource: verdict.source,
            failureReason: verdict.reason,
            switchedHere: index > 0,
            ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic.slice(0, 400) }),
        });
        // ── ③ 保守门禁：只有「明确的结构化额度耗尽」才可能切换 ──
        if (!exhaustionOnly(verdict)) {
            const why = verdict.state === 'unknown'
                ? `额度状态判定为「未知」—— **未知不触发自动切换**（避免把限流/网络/认证问题误当成额度耗尽）。判定依据：${verdict.reason}`
                : `额度状态为「${verdict.state}」而非明确耗尽 —— 不触发自动切换。判定依据：${verdict.reason}`;
            recordDecision('stay', why);
            notes.push(why);
            return finish(false, why);
        }
        if (verdict.conflicts.length > 0) {
            notes.push(`⚠️ 判定器记录了**矛盾信号**（仍按显式结构化 code 采信）：${verdict.conflicts.join('；')}`);
        }
        // ── ④ 副作用边界：不得盲目重放 ──
        const effectVerdict = retryAllowedByEffects(outcome.effects);
        if (!effectVerdict.allowed) {
            const why = `本次失败**没有**满足「可安全重跑」的条件：${effectVerdict.reason}`;
            recordDecision('pause', why);
            notes.push(why);
            // 额度确实耗尽这件事仍要落到运行时状态里（账号冻结），但**不**重跑。
            runtime = freezeAccount(runtime, account, verdict.reason, now());
            runtime = noteFailure(runtime, verdict.reason, now(), input.policy);
            return finish(false, why);
        }
        // ── ⑤ 冻结 + 熔断 ──
        runtime = freezeAccount(runtime, account, `额度耗尽：${verdict.reason}`, now());
        runtime = noteFailure(runtime, verdict.reason, now(), input.policy);
        if (breakerOpen(runtime, now())) {
            const why = `熔断已打开（连续失败 ${runtime.breaker.consecutiveFailures} 次 ≥ 阈值 ${input.policy.maxConsecutiveFailures}），`
                + `到 ${new Date(runtime.breaker.openUntilMs ?? 0).toISOString()} 前不再自动切换`;
            recordDecision('pause', why);
            notes.push(why);
            return finish(false, why);
        }
        // ── ⑥ 决策（纯函数；上限/退避/冷却/区域/供应商/模型/认证全在这里）──
        const switchesSoFar = autoSwitchCount(switchLog, input.scope.id);
        const lastSwitch = lastSwitchAtMs(switchLog, input.scope.id);
        // 冻结 / 冷却**必须先叠加进池**，否则被冻结的账号照样会被选成目标。
        const withRuntime = applyRuntimeToPool(input.pool, runtime, now());
        for (const note of withRuntime.excluded)
            notes.push(`候选排除：${note}`);
        const decision = decideAutoSwitch({
            now: now(),
            harnessId: input.harnessId,
            currentAccountId: account,
            ...(input.model === undefined ? {} : { currentModel: input.model }),
            ...(input.provider === undefined ? {} : { currentProvider: input.provider }),
            pool: withRuntime.pool,
            quota: observedQuota,
            auth: input.auth,
            switchesSoFar,
            consecutiveFailures: runtime.breaker.consecutiveFailures,
            ...(lastSwitch === undefined ? {} : { lastSwitchAtMs: lastSwitch }),
            policy: input.policy,
            nativeSessionResumable: input.nativeSessionResumable,
        });
        recordDecision(decision.action, decision.reason, 'targetAccountId' in decision ? decision.targetAccountId : undefined);
        if (decision.action !== 'switch') {
            notes.push(`决策为 ${decision.action}：${decision.reason}${'recovery' in decision ? ` | 恢复条件：${decision.recovery}` : ''}`);
            return finish(false, decision.reason);
        }
        // ── ⑦ 并发租约：同一目标账号同一时刻只允许一个切换者 ──
        const leaseTry = acquire(coordination, {
            accountId: decision.targetAccountId, holder: input.scope.id, purpose: 'switch', now: now(),
        }, coordPolicy);
        coordination = leaseTry.state;
        if (!leaseTry.result.ok) {
            const why = `目标账号正被另一个任务执行切换类动作，本次不并发进行：${leaseTry.result.reason}`;
            recordDecision('pause', why, decision.targetAccountId);
            notes.push(why);
            return finish(false, why);
        }
        // ── ⑧ 切换前/后的**真实验证**（身份 + 模型）──
        const verification = await input.verifyTarget(decision.targetAccountId, input.model);
        const judged = judgeTargetVerification(verification, input.model);
        if (!judged.ok) {
            switchLog = appendSwitchEvent(switchLog, {
                scope: input.scope,
                harnessId: input.harnessId,
                fromAccount: redactAccount(account),
                toAccount: redactAccount(decision.targetAccountId),
                reason: `自动切换被拒（切换后验证未通过）：${judged.reason}`,
                recovery: 'none',
                boundary: '未发生切换',
                result: 'refused',
                trigger: 'auto-quota',
                modelPreserved: false,
                ...(input.model === undefined ? {} : { model: input.model }),
                detail: `验证细节：${verification.detail}`,
            });
            // 拒绝也是事实，必须进本次执行的事件列表（只写账本不返回 = 调用方看不到）。
            events.push(switchLog.events[switchLog.events.length - 1]);
            coordination = release(coordination, decision.targetAccountId, input.scope.id);
            recordDecision('pause', judged.reason, decision.targetAccountId);
            notes.push(judged.reason);
            return finish(false, judged.reason);
        }
        // ── ⑨ 记账 + 冷却 + 真的换账号 ──
        switchLog = appendSwitchEvent(switchLog, {
            scope: input.scope,
            harnessId: input.harnessId,
            fromAccount: redactAccount(account),
            toAccount: redactAccount(decision.targetAccountId),
            reason: `自动切换（额度明确耗尽）：${decision.reason}`,
            recovery: decision.recovery,
            boundary: decision.boundary,
            result: 'switched',
            trigger: 'auto-quota',
            modelPreserved: decision.modelPreserved,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            detail: `切换后验证：${judged.reason}；副作用边界：${effectVerdict.reason}`,
        });
        events.push(switchLog.events[switchLog.events.length - 1]);
        const targetEntry = input.pool.find((p) => p.accountId === decision.targetAccountId);
        const cooldownMs = targetEntry?.cooldownMs ?? coordPolicy.suppressionMs;
        const switchedAt = now();
        runtime = setCooldown(runtime, decision.targetAccountId, switchedAt + cooldownMs, switchedAt);
        coordination = noteSwitch(coordination, decision.targetAccountId, switchedAt);
        coordination = release(coordination, decision.targetAccountId, input.scope.id);
        notes.push(`已从 ${redactAccount(account)} 自动切换到 ${redactAccount(decision.targetAccountId)}（恢复方式：${decision.recovery}）。`
            + `交接边界：${decision.boundary}`);
        if (!decision.modelPreserved) {
            notes.push(`⚠️ ${decision.note}`);
        }
        account = decision.targetAccountId;
    }
    const why = `已达到本次执行的尝试上限（${maxAttempts} 次：1 次原始 + 最多 ${input.policy.maxSwitchesPerTask} 次自动切换）`;
    recordDecision('pause', why);
    notes.push(why);
    if (lastDiagnostic !== undefined)
        notes.push(`最后一次诊断：${lastDiagnostic.slice(0, 300)}`);
    return finish(false, why);
}
//# sourceMappingURL=autoswitch.js.map