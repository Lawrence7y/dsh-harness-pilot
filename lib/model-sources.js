/**
 * 模型条目的**来源分级**、**四类归类**与**四态判定**（纯函数，零 IO）。
 *
 * ## 用户要求（原文）
 * 「模型目录要补全，来源优先级：**真实 CLI 查询 → 原生配置 → 官方模型缓存 → 有明确依据的官方模型别名**；
 *  设置里要展示完整的 provider+模型清单，**不得任意截断**，**不得拿宿主的模型目录冒充外部 CLI 的模型目录**，
 *  也不得**编造模型**；并区分**可选择模型 / 仅供展示的底层模型 / 模型别名 / 当前默认模型**，
 *  以及说明**未安装 / 未登录 / 没有配置供应商 / 没有模型列举能力**。」
 *
 * ## 本模块的纪律
 *   · **来源是事实不是猜测**：某条 id 只出现在它**真的被观测到**的来源里；
 *     同时被多个来源报出时必须**全部列出**（`sources`），主来源按用户给的优先级取第一个。
 *   · **不编造**：没有任何来源报出的 id 不会出现在结果里；空就是空。
 *   · **不夸大**：`selectable=false` 的条目（例如 WorkBuddy 原生目录里的 `r-*`，CLI 会响亮拒绝）
 *     一律归 `display-only`，且 `selectable=false` —— 绝不因为「目录里有」就说能选。
 *   · 四态只按**证据**判：入口解析得到吗？输出里有认证字样吗？有没有列举能力？有没有选出任何模型？
 */
export const MODEL_SOURCE_ORDER = ['cli-query', 'native-config', 'official-cache', 'official-alias'];
export const MODEL_SOURCE_LABEL = {
    'cli-query': '真实 CLI 查询',
    'native-config': '原生配置',
    'official-cache': '官方模型缓存',
    'official-alias': '有明确依据的官方别名',
};
export const MODEL_KIND_LABEL = {
    selectable: '可选择模型',
    'display-only': '仅供展示的底层模型',
    alias: '模型别名',
    'current-default': '当前默认模型',
};
const asList = (value) => value ?? [];
/**
 * 合并四类来源 → 逐条 `ModelEntry`。
 *
 * 顺序：主来源按 `MODEL_SOURCE_ORDER`，同来源内保持**观测顺序**（稳定性 = 可断言）。
 */
export function classifyModelEntries(input) {
    const buckets = [
        { source: 'cli-query', list: asList(input.cliQuery) },
        { source: 'native-config', list: asList(input.nativeConfig) },
        { source: 'official-cache', list: asList(input.officialCache) },
        { source: 'official-alias', list: asList(input.officialAlias) },
    ];
    const order = [];
    const byId = new Map();
    for (const bucket of buckets) {
        for (const observation of bucket.list) {
            const id = observation.id.trim();
            if (id.length === 0)
                continue;
            const row = byId.get(id) ?? { sources: [], selectable: false, selectableClaims: 0, notes: [] };
            if (!row.sources.includes(bucket.source))
                row.sources.push(bucket.source);
            // `selectable` 缺省 true；只要**有一个**来源说能选，就算能选（并且记下是几个来源说的）。
            if (observation.selectable !== false) {
                row.selectable = true;
                row.selectableClaims += 1;
            }
            if (observation.evidence !== undefined && observation.evidence.length > 0 && row.notes.length < 4)
                row.notes.push(observation.evidence);
            if (observation.provider !== undefined)
                row.provider = observation.provider;
            if (observation.meta !== undefined)
                row.meta = { ...row.meta, ...observation.meta };
            if (!byId.has(id)) {
                byId.set(id, row);
                order.push(id);
            }
        }
    }
    const defaultId = typeof input.currentDefault === 'string' && input.currentDefault.trim().length > 0
        ? input.currentDefault.trim()
        : null;
    const out = [];
    for (const id of order) {
        const row = byId.get(id);
        const sources = MODEL_SOURCE_ORDER.filter((source) => row.sources.includes(source));
        const source = sources[0] ?? 'official-cache';
        const isDefault = defaultId !== null && id === defaultId;
        const kind = isDefault
            ? 'current-default'
            : !row.selectable
                ? 'display-only'
                : row.sources.includes('official-alias')
                    ? 'alias'
                    : 'selectable';
        const reason = isDefault
            ? '该 CLI 原生配置里写着它就是当前默认模型'
            : kind === 'display-only'
                ? '没有任何来源说它可以作为 CLI 的模型参数（只在原生目录里可见）'
                : kind === 'alias'
                    ? '来自有明确依据的别名/档位（CLI 自己认这个名字）'
                    : '来自该 CLI 自己能列出的模型清单';
        out.push({
            id,
            source,
            sources,
            kind,
            selectable: isDefault ? row.selectable : row.selectable,
            ...(row.provider === undefined ? {} : { provider: row.provider }),
            evidence: `${sources.map((s) => MODEL_SOURCE_LABEL[s]).join(' + ')}${row.notes.length > 0 ? `：${row.notes.join('；')}` : ''}`,
            reason,
            ...(row.meta === undefined ? {} : { meta: row.meta }),
        });
    }
    return out;
}
/** 便于 UI 显示与断言的分组计数。 */
export function countByKind(entries) {
    const counts = { selectable: 0, 'display-only': 0, alias: 0, 'current-default': 0 };
    for (const entry of entries)
        counts[entry.kind] += 1;
    return counts;
}
/** 该条目能否作为模型参数送出（选择器/`--model` 只允许这些）。 */
export function selectableIds(entries) {
    return entries.filter((entry) => entry.selectable).map((entry) => entry.id);
}
export const DISCOVERY_STATE_LABEL = {
    ready: '就绪',
    'not-installed': '未安装',
    'not-logged-in': '未登录',
    'no-provider': '没有配置供应商',
    'no-list-capability': '没有模型列举能力',
    unknown: '未知（证据不足）',
};
/**
 * 四态判定（**顺序即优先级**，只按证据，不猜）：
 *   ① 入口解析不到 ⇒ 未安装（后面的都无从谈起）
 *   ② 输出里有认证字样 ⇒ 未登录（**只降不升**：有认证字样时不宣称「有供应商」）
 *   ③ 没有列举能力（无命令也无目录文件）⇒ 没有模型列举能力
 *   ④ 有列举能力但一条可选模型都没有，且原生配置里也没有 ⇒ 没有配置供应商
 *   ⑤ 有可选模型 ⇒ 就绪
 *   ⑥ 其余（例如没测量）⇒ 未知（证据不足）—— **绝不**填成「就绪」
 */
export function discoveryStateOf(input) {
    const notes = (input.notes ?? []).filter((note) => note.trim().length > 0);
    const withNotes = (evidence) => notes.length === 0 ? evidence : `${evidence}；证据：${notes.join('；')}`;
    if (!input.entryResolved) {
        return { code: 'not-installed', label: DISCOVERY_STATE_LABEL['not-installed'], evidence: withNotes('没有解析到该 CLI 的可执行入口（不在 PATH，配置里的绝对路径也不存在）') };
    }
    if (input.authBlocked === true) {
        return { code: 'not-logged-in', label: DISCOVERY_STATE_LABEL['not-logged-in'], evidence: withNotes('该 CLI 的输出里出现认证相关字样（未登录/401/token 失效）：模型清单不算「可用」，也不宣称已配置供应商') };
    }
    if (!input.hasListCapability) {
        return {
            code: 'no-list-capability', label: DISCOVERY_STATE_LABEL['no-list-capability'],
            evidence: withNotes(input.loginRequired === true
                ? '这条 harness 需要登录，但它**没有**任何列出模型的命令或原生目录文件 ⇒ 只能靠会话/子代理里手输模型名'
                : '这条 CLI 没有配置任何列出模型的命令，也没有可读的原生目录文件 ⇒ 本插件无法替它列出模型（不知道 ≠ 没有）'),
        };
    }
    if (input.selectableCount === 0) {
        // ⚠️ **没有测量过**时不许说「没有配置供应商」：那是把「没去问」说成「没有」。
        // 先把「证据不足」如实报出来，UI 再提示用户点「测量」去问一次。
        if (!input.measured) {
            return { code: 'unknown', label: DISCOVERY_STATE_LABEL.unknown, evidence: withNotes('还没有真的问过这条 CLI（当前显示的是静态配置/缓存信息，不能据此判断有没有供应商）') };
        }
        if (!input.nativeConfigSeen) {
            return {
                code: 'no-provider', label: DISCOVERY_STATE_LABEL['no-provider'],
                evidence: withNotes('列举命令跑通了但一条模型都没有，原生配置里也没有供应商条目 ⇒ 看起来是还没配置供应商（也可能是该账号下没有可用模型）'),
            };
        }
        return { code: 'unknown', label: DISCOVERY_STATE_LABEL.unknown, evidence: withNotes('有原生配置条目，但没有任何可以作为 CLI 模型参数的条目（不猜是哪一种）') };
    }
    if (input.selectableCount > 0) {
        return { code: 'ready', label: DISCOVERY_STATE_LABEL.ready, evidence: withNotes(`有 ${input.selectableCount} 个可以作为 CLI 模型参数的条目`) };
    }
    return { code: 'unknown', label: DISCOVERY_STATE_LABEL.unknown, evidence: withNotes('现有证据不足以判定四态中的哪一种（不猜、不填成「就绪」）') };
}
//# sourceMappingURL=model-sources.js.map