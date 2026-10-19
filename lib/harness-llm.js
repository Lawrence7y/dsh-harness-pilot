import { buildGroupIndex } from './harness-groups.js';
/**
 * 目标是否**账号固化**（这条目标自带某个账号的启动配方）。
 *
 * 两条实测形态：
 *   · `--config-dir <账号目录>`（Qoder 系：`.auth/` 就在该目录里，认证真隔离）；
 *   · **受管 bootstrap wrapper**（WorkBuddy 系：`…/workbuddy-managed.cjs <账号 id> …`，
 *     由适配器把厂商存储映射到该账号目录）。
 * 两种都属于「这条目标已经绑了账号」，因此分组默认执行目标要**优先**选它们 ——
 * 否则会退到不带账号的那条 CLI（＝静默用全局账号），那正是用户明确禁止的。
 */
export function isAccountPinned(target) {
    if (target.args.some((arg) => arg.includes('--config-dir')))
        return true;
    if (Object.values(target.env).some((value) => value.includes('--config-dir')))
        return true;
    return target.args.some((arg) => /(?:^|[\\/])[^\\/]*-managed\.cjs$/i.test(arg));
}
/**
 * 该目标能否做**一次性派发**。
 *
 * `transport: 'auto'`（CLI/一次性打印）与 `'cdp'`（拉起桌面 App → CDP 注入输入 → 读回）都可以
 * —— 2026-10-15 真实矩阵实测：mimo / antigravity / qoder-cn 桌面端经 cdp 通道端到端回话成功，
 * 「cdp 只能 GUI 操控」的旧结论已过时。`'window'`（裸窗口键鼠）不在此列：实测会把输入打进
 * 命令面板等错误目标，只作为 cdp 失败后的兜底，不当可承诺的派发通道。
 */
function isDispatchable(target) {
    const transport = target.transport ?? 'auto';
    return transport === 'auto' || transport === 'cdp';
}
/**
 * 由目标表生成 provider 规格（顺序与 `buildGroupIndex` 一致：按标签、国内在前）。
 *
 * 只产出**至少有一条可派发目标**的组：没有可派发目标的组（纯 IDE/GUI）不进模型目录
 * —— 那会造出「菜单里能选、选了什么也不跑」的假条目。
 */
export function buildHarnessLlmProviders(targets, accountHarnessIds = [], accountIds = []) {
    const groups = buildGroupIndex(targets, accountHarnessIds, accountIds);
    const byName = new Map(targets.map((target) => [target.name, target]));
    const out = [];
    for (const group of groups) {
        const dispatchable = group.dispatchable.filter((name) => {
            const target = byName.get(name);
            return target !== undefined && isDispatchable(target);
        });
        if (dispatchable.length === 0)
            continue;
        const pinned = dispatchable.filter((name) => {
            const target = byName.get(name);
            return target !== undefined && isAccountPinned(target);
        });
        const primaryTarget = pinned[0] ?? dispatchable[0] ?? '';
        out.push({
            id: group.providerId,
            name: `外部 CLI · ${group.label}`,
            groupId: group.id,
            key: group.key,
            region: group.region,
            targets: dispatchable,
            primaryTarget,
            accountPinned: pinned,
        });
    }
    return out;
}
/**
 * 把「该 harness 各目标自己报的模型」合并成一份**不截断**的清单。
 *
 * 契约：
 *   · 同 id 的模型只出一条（`sources` 记下所有报过它的目标）；
 *   · 每条都带**真实执行目标**（`primaryTarget` 优先，其次是从它发现的那个目标）；
 *   · `providers` 里给定的目标集合是**上限**：不在这条 harness 里的目标不会被合并进来
 *     （避免把 DSH 自己或别的 CLI 的模型混进这条 harness）。
 */
export function mergeHarnessModels(provider, modelsOf) {
    const order = [];
    const byId = new Map();
    // 先问默认执行目标，再问其余目标 —— 顺序决定「同 id 用哪条目标跑」。
    const preferred = [provider.primaryTarget, ...provider.targets.filter((name) => name !== provider.primaryTarget)];
    for (const targetName of preferred) {
        if (targetName.length === 0)
            continue;
        const models = modelsOf(targetName);
        if (models === undefined)
            continue;
        for (const raw of models) {
            const id = raw.trim();
            if (id.length === 0)
                continue;
            const found = byId.get(id);
            if (found === undefined) {
                byId.set(id, { sources: [targetName], target: targetName });
                order.push(id);
                continue;
            }
            found.sources.push(targetName);
            // 默认执行目标报过它 ⇒ 优先用默认目标执行（`preferred` 已保证它排在最前）。
            if (targetName === provider.primaryTarget)
                found.target = targetName;
        }
    }
    const merged = order.map((id) => {
        const entry = byId.get(id);
        return {
            id,
            name: id,
            description: `${id}（该 harness 自报的模型；本次将由「${entry.target}」执行`
                + (entry.sources.length > 1 ? `；另有 ${entry.sources.length - 1} 条同族目标也报过它` : '')
                + '）',
            target: entry.target,
            sources: entry.sources,
        };
    });
    // Multiple pinned accounts must remain addressable after deduplicating common model ids.
    // These are routing aliases for observed models, not new vendor models.
    if (provider.accountPinned.length > 1) {
        for (const target of provider.accountPinned) {
            if (!provider.targets.includes(target))
                continue;
            for (const raw of modelsOf(target) ?? []) {
                const model = raw.trim(), id = `${target}::${model}`;
                if (!model || merged.some(row => row.id === id))
                    continue;
                merged.push({ id, name: `${model} · ${target}`, target, executionModel: model,
                    sources: [target], description: `账号执行路由：由「${target}」运行模型「${model}」；不是新的厂商模型。` });
            }
        }
    }
    return merged;
}
/** 分组规格查找（provider 名 → 规格）。 */
export function providerSpecFor(providers, providerId) {
    return providers.find((entry) => entry.id === providerId);
}
/** 「CLI 默认档」的保留 model id（该 harness 不指定模型，用它自己的默认模型）。 */
export const CLI_DEFAULT_MODEL_ID = 'cli-default';
//# sourceMappingURL=harness-llm.js.map