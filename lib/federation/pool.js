export const DEFAULT_POLICY = {
    autoSwitchEnabled: false,
    maxSwitchesPerTask: 2,
    backoffBaseMs: 60_000,
    backoffFactor: 2,
    maxConsecutiveFailures: 3,
    onModelUnavailable: 'stop',
};
const COOLDOWN = (ms) => `${Math.round(ms / 1000)}s`;
/**
 * 决定：继续用当前账号 / 切到某个账号 / 暂停等人工处理。
 *
 * 顺序即优先级，任何一步不满足都**不会**发生切换。
 */
export function decideAutoSwitch(input) {
    const { policy, now } = input;
    // ① 用户没启用自动切换 → 绝不自动动
    if (!policy.autoSwitchEnabled) {
        return { action: 'stay', reason: '用户未启用「额度耗尽后自动切换」，保持当前账号（手动切换仍可用）' };
    }
    // ② 只有**明确**额度耗尽才自动切；unknown / available 一律不动
    const quota = input.quota[input.currentAccountId];
    const state = quota?.state ?? 'unknown';
    if (state !== 'exhausted') {
        return {
            action: 'stay',
            reason: state === 'available'
                ? '当前账号额度可用，无需切换'
                : `当前账号额度状态为「未知」（${quota?.reason ?? '尚未查询'}）—— 未知**不**触发自动切换，避免把限流/故障误当成额度耗尽`,
        };
    }
    // ③ 熔断：连续失败过多
    if (input.consecutiveFailures >= policy.maxConsecutiveFailures) {
        return {
            action: 'pause',
            reason: `连续失败 ${input.consecutiveFailures} 次，已达熔断阈值 ${policy.maxConsecutiveFailures}，停止自动切换以免反复消耗账号`,
            recovery: '请检查该 Harness 的服务状态与账号认证；确认恢复后再手动切换或重新启用自动切换',
        };
    }
    // ④ 切换次数上限
    if (input.switchesSoFar >= policy.maxSwitchesPerTask) {
        return {
            action: 'pause',
            reason: `本任务已自动切换 ${input.switchesSoFar} 次，达到上限 ${policy.maxSwitchesPerTask}，不再继续切换`,
            recovery: '需要继续请手动切换，或提高本任务的切换上限后重试',
        };
    }
    // ⑤ 退避：距上次切换太近就不切（指数退避）
    if (input.lastSwitchAtMs !== undefined) {
        const wait = policy.backoffBaseMs * Math.pow(policy.backoffFactor, Math.max(0, input.switchesSoFar - 1));
        const elapsed = now - input.lastSwitchAtMs;
        if (elapsed < wait) {
            return {
                action: 'pause',
                reason: `距上次切换仅 ${COOLDOWN(elapsed)}，未达退避间隔 ${COOLDOWN(wait)}，本次不切换（避免账号间来回横跳）`,
                recovery: `等待约 ${COOLDOWN(wait - elapsed)} 后重试，或手动切换`,
            };
        }
    }
    // ⑥ 找候选：启用 + 同 harness + 区域/供应商兼容 + 未被判定耗尽 + 不在冷却 + 认证未失效
    const skipped = [];
    const candidates = [];
    for (const entry of input.pool) {
        if (entry.accountId === input.currentAccountId)
            continue;
        if (!entry.enabled) {
            skipped.push(`${entry.accountId}: 不在启用的账号池内`);
            continue;
        }
        if (entry.harnessId !== input.harnessId) {
            skipped.push(`${entry.accountId}: 属于别的 Harness(${entry.harnessId})`);
            continue;
        }
        const regionOk = entry.region === input.pool.find(p => p.accountId === input.currentAccountId)?.region
            || (entry.regionCompatibleWith ?? []).includes(regionOf(input, input.currentAccountId));
        if (!regionOk) {
            skipped.push(`${entry.accountId}: 区域不兼容(${entry.region})`);
            continue;
        }
        if (input.currentProvider !== undefined && entry.providers !== undefined && entry.providers.length > 0
            && !entry.providers.includes(input.currentProvider)) {
            skipped.push(`${entry.accountId}: 不支持当前供应商(${input.currentProvider})`);
            continue;
        }
        const candState = input.quota[entry.accountId]?.state ?? 'unknown';
        if (candState === 'exhausted') {
            skipped.push(`${entry.accountId}: 额度也已耗尽`);
            continue;
        }
        if (entry.cooldownUntilMs !== undefined && entry.cooldownUntilMs > now) {
            skipped.push(`${entry.accountId}: 冷却中(剩 ${COOLDOWN(entry.cooldownUntilMs - now)})`);
            continue;
        }
        const auth = input.auth[entry.accountId] ?? 'unknown';
        if (auth === 'auth-invalid') {
            skipped.push(`${entry.accountId}: 认证已失效`);
            continue;
        }
        candidates.push(entry);
    }
    if (candidates.length === 0) {
        return {
            action: 'pause',
            reason: `当前账号额度已耗尽，且账号池内没有可用的目标账号：${skipped.join('；') || '池内没有其它账号'}`,
            recovery: '请在「Harness 管理 → 账号池」中启用或登录其它账号；本插件**不会**自动注册账号或获取新账号',
        };
    }
    // ⑦ 按优先级挑；同优先级时选冷却更早结束的
    candidates.sort((a, b) => (a.priority - b.priority) || ((a.cooldownUntilMs ?? 0) - (b.cooldownUntilMs ?? 0)));
    const target = candidates[0];
    if (target === undefined) {
        return { action: 'pause', reason: '候选账号排序异常，保守起见不切换', recovery: '请重试或手动切换' };
    }
    // ⑧ 模型必须尽量保住；保不住要按用户策略处理，**绝不静默换模型**
    const models = target.models;
    const modelPreserved = input.currentModel === undefined
        || models === undefined || models.length === 0
        || models.includes(input.currentModel);
    if (!modelPreserved && policy.onModelUnavailable === 'stop') {
        return {
            action: 'pause',
            reason: `目标账号 ${target.accountId} 不支持当前模型「${input.currentModel}」，按策略 stop 停止切换，**不会静默换模型**`,
            recovery: `请为该账号启用该模型，或把策略改为 switch-model（会显式标注换成了哪个模型），或手动处理后重试`,
        };
    }
    const authConfidence = input.auth[target.accountId] === 'model-request-authorized'
        ? '认证与模型请求均已验证可用'
        : '认证未失效（但未取得「模型请求已验证」级别的证据）';
    const recovery = input.nativeSessionResumable ? 'native-resume' : 'checkpoint-new-session';
    const boundary = input.nativeSessionResumable
        ? '该 Harness 支持原生跨账号恢复：优先用原生机制保留并恢复会话'
        : '该 Harness **不支持**跨账号恢复会话：将用可追溯、脱敏的交接检查点新建会话；'
            + '**原生历史（工具调用记录、文件状态、模型侧上下文）不会随账号一起迁移**，新会话只带检查点里明确写下的内容';
    return {
        action: 'switch',
        targetAccountId: target.accountId,
        reason: `当前账号 ${input.currentAccountId} 额度已明确耗尽（${quota?.reason ?? '结构化错误判定'}），切换到池内更优的 ${target.accountId}`,
        modelPreserved,
        recovery,
        boundary,
        note: modelPreserved
            ? `目标账号可用性：${authConfidence}；模型保持为「${input.currentModel ?? '(未指定)'}」`
            : `⚠️ 目标账号不支持原模型，按 policy=switch-model 切换；**模型已改变**，必须显式提示`,
    };
}
function regionOf(input, accountId) {
    return input.pool.find(p => p.accountId === accountId)?.region ?? '';
}
/**
 * 生成切换事件记录。
 * 用户的硬性要求：切换事件要包含**原因、前后脱敏账号、时间、恢复方式和结果**。
 */
export function makeSwitchEvent(decision, fromAccountId, redact, result, at = new Date().toISOString()) {
    return {
        at,
        reason: decision.reason,
        fromAccountId: redact(fromAccountId),
        toAccountId: redact(decision.targetAccountId),
        recovery: decision.recovery,
        boundary: decision.boundary,
        result,
    };
}
export function replayPolicy(state, kind) {
    if (state === 'completed') {
        return { action: 'skip', reason: `${kind} 已完成 —— 换账号也**不得**重复执行` };
    }
    if (state === 'uncertain') {
        if (kind === 'read') {
            return { action: 'run', reason: '只读操作，重跑无副作用' };
        }
        return {
            action: 'verify-first',
            reason: `${kind} 的结果不确定（既没确认成功也没确认失败）：必须先核验实际状态（例如查远端/查工作区），**不得**直接重放`,
        };
    }
    return { action: 'run', reason: `${kind} 尚未开始，可以执行` };
}
//# sourceMappingURL=pool.js.map