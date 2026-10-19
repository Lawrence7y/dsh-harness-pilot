import { mergeHarnessModels } from './harness-llm.js';
/** 宿主那条例目的 id（profile patch 里的 `id:`）。 */
export const SUBAGENT_MODEL_NS = 'subagent-model-selection-settings';
export function routeKey(route) {
    return `${route.provider}\u0000${route.model}`;
}
/** 把任意来源的值规整成 route 数组（形状不对的条目**丢弃并计数**，不静默当合法）。 */
export function normalizeRoutes(value) {
    if (!Array.isArray(value))
        return { routes: [], dropped: 0 };
    const out = [];
    const seen = new Set();
    let dropped = 0;
    for (const raw of value) {
        const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
        const provider = typeof record?.provider === 'string' ? record.provider.trim() : '';
        const model = typeof record?.model === 'string' ? record.model.trim() : '';
        if (provider.length === 0 || model.length === 0) {
            dropped += 1;
            continue;
        }
        const key = routeKey({ provider, model });
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({ provider, model });
    }
    return { routes: out, dropped };
}
/**
 * 读当前白名单。
 *
 * 优先用 **服务**（`subagentModelSelection.current()`，它就是运行期生效值），
 * 同时用 **设置文档**（`settings.describe()`）取 `revision` —— 写入要用它做乐观锁。
 * 两者都不在 ⇒ `available:false`（如实说明，不返回空表冒充「没有白名单」）。
 */
export function readPolicy(settings, selection) {
    let revision = null;
    let documentValue;
    let documentSeen = false;
    try {
        const descriptors = settings?.describe?.({ redactSecrets: false }) ?? [];
        const found = descriptors.find((row) => row.ns === SUBAGENT_MODEL_NS);
        if (found !== undefined) {
            documentSeen = true;
            documentValue = found.value;
            revision = typeof found.revision === 'number' && Number.isFinite(found.revision) ? found.revision : null;
        }
    }
    catch { /* 读文档失败：下面按服务或不可用处理 */ }
    let serviceValue;
    let serviceSeen = false;
    try {
        const current = selection?.current?.();
        if (current !== undefined) {
            serviceSeen = true;
            serviceValue = current;
        }
    }
    catch { /* 服务读失败：同上 */ }
    if (!documentSeen && !serviceSeen) {
        return {
            available: false,
            reason: settings === undefined && selection === undefined
                ? '宿主既没有 `settings` 服务也没有 `subagentModelSelection` 服务（本组合没挂载子代理模型选择）'
                : `没有读到「${SUBAGENT_MODEL_NS}」这一条目（该 profile 可能没有启用子代理模型选择）`,
            revision: null, enabled: null, allowed: [], dropped: 0,
        };
    }
    const source = serviceSeen ? serviceValue : documentValue;
    const record = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const normalized = normalizeRoutes(record.allowedModels);
    return {
        available: true,
        reason: serviceSeen ? '值取自 subagentModelSelection.current()（运行期生效值）' : '值取自 settings.describe()（设置文档）',
        revision,
        enabled: typeof record.enabled === 'boolean' ? record.enabled : null,
        allowed: normalized.routes,
        dropped: normalized.dropped,
    };
}
export function planPolicyChange(current, add, remove) {
    const have = new Set(current.map(routeKey));
    const additions = [];
    const alreadyPresent = [];
    for (const route of add) {
        const key = routeKey(route);
        if (have.has(key)) {
            alreadyPresent.push(route);
            continue;
        }
        have.add(key);
        additions.push(route);
    }
    const removalKeys = new Set(remove.map(routeKey));
    const removals = [];
    const missing = [];
    for (const route of remove) {
        if (removalKeys.has(routeKey(route)) && current.some((entry) => routeKey(entry) === routeKey(route)))
            removals.push(route);
        else
            missing.push(route);
    }
    const removalSet = new Set(removals.map(routeKey));
    const next = [...current.filter((route) => !removalSet.has(routeKey(route))), ...additions];
    return { additions, removals, alreadyPresent, missing, next };
}
export function candidatesFor(providers, modelsOf, allowed) {
    const enabled = new Set(allowed.map(routeKey));
    const out = [];
    for (const spec of providers) {
        for (const model of mergeHarnessModels(spec, modelsOf)) {
            const route = { provider: spec.id, model: model.id };
            out.push({
                provider: spec.id,
                model: model.id,
                name: `${spec.name} · ${model.id}`,
                enabled: enabled.has(routeKey(route)),
            });
        }
    }
    return out;
}
/**
 * 应用差分：`settings.update(ns, {allowedModels: next}, revision)` + **独立回读**。
 *
 * ⚠️ 只改 `allowedModels` 这一个数组；`enabled` 与其他 profile 内容一律不动
 * （`update` 只合并传入字段，`dsh-settings/lib/index.js:470-472`）。
 */
export async function applyPolicyChange(settings, selection, plan, expectedRevision) {
    const requested = { additions: plan.additions.length, removals: plan.removals.length };
    if (settings?.update === undefined) {
        return { ok: false, reason: '宿主 `settings.update` 不可用 ⇒ 不写（不会退化成直接改 profile 文件）', requested, readback: null, verified: false, conflict: false };
    }
    if (plan.additions.length === 0 && plan.removals.length === 0) {
        return { ok: true, reason: '差分是空的：没有任何需要写入的变更', requested, readback: readPolicy(settings, selection), verified: true, conflict: false };
    }
    try {
        await settings.update(SUBAGENT_MODEL_NS, { allowedModels: plan.next }, expectedRevision ?? undefined);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const conflict = /changed since it was read|Conflict/i.test(message);
        return { ok: false, reason: conflict ? `白名单在读取之后被别人改过（乐观锁拒绝写入）：${message}` : `写入失败：${message}`, requested, readback: null, verified: false, conflict };
    }
    const readback = readPolicy(settings, selection);
    const want = new Set(plan.next.map(routeKey));
    const got = new Set(readback.allowed.map(routeKey));
    const verified = want.size === got.size && [...want].every((key) => got.has(key));
    return {
        ok: verified,
        reason: verified
            ? `已写入并独立回读一致（${plan.next.length} 条；本次 +${requested.additions} / -${requested.removals}）`
            : `写入返回成功，但**独立回读与目标不一致**（目标 ${want.size} 条 vs 实际 ${got.size} 条）—— 以回读为准，不认为已生效`,
        requested, readback, verified, conflict: false,
    };
}
//# sourceMappingURL=subagent-models.js.map