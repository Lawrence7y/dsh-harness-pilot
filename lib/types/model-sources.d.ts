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
/** 来源（严格按用户给的优先级排序）。 */
export type ModelSource = 'cli-query' | 'native-config' | 'official-cache' | 'official-alias';
/** 用户在设置页要能一眼分开的四类。 */
export type ModelKind = 'selectable' | 'display-only' | 'alias' | 'current-default';
export declare const MODEL_SOURCE_ORDER: readonly ModelSource[];
export declare const MODEL_SOURCE_LABEL: Readonly<Record<ModelSource, string>>;
export declare const MODEL_KIND_LABEL: Readonly<Record<ModelKind, string>>;
/** 一条候选（来自某个来源的观测）。`selectable` 缺省为 true（能作为 `--model` 取值）。 */
export interface SourceObservation {
    readonly id: string;
    readonly selectable?: boolean;
    /** 该来源归属的供应商（原生目录里带 `vendor`/`provider` 时才有）。 */
    readonly provider?: string;
    /** 该来源为什么这样报（可核对的一句话，来自读取处，不在本模块编造）。 */
    readonly evidence?: string;
    /** 厂商元数据（上下文/输出上限/能力位/别名关系）；没有就不写。 */
    readonly meta?: Readonly<{
        name?: string;
        vendor?: string;
        maxInputTokens?: number;
        maxOutputTokens?: number;
        supportsToolCall?: boolean;
        supportsReasoning?: boolean;
        supportsImages?: boolean;
        relatedModels?: Readonly<Record<string, string>>;
    }>;
}
export interface ModelEntry {
    readonly id: string;
    readonly source: ModelSource;
    readonly sources: readonly ModelSource[];
    readonly kind: ModelKind;
    readonly selectable: boolean;
    readonly provider?: string;
    readonly evidence: string;
    /** 分类依据（结构化，便于断言）。 */
    readonly reason: string;
    /** 厂商元数据（厂商默认 / 名称 / vendor / 上下文与输出上限 / 能力位 / 别名关系）。 */
    readonly meta?: SourceObservation['meta'];
}
export interface ClassifyInput {
    /** ① 真实 CLI 查询结果（`--list-models` / `models` 命令的解析结果）。 */
    readonly cliQuery?: readonly SourceObservation[];
    /** ② CLI 自己的原生配置（settings.json / config.toml / zcode config.json…）。 */
    readonly nativeConfig?: readonly SourceObservation[];
    /** ③ 官方模型缓存/目录文件（models_cache.json / models.json / product config 缓存…）。 */
    readonly officialCache?: readonly SourceObservation[];
    /** ④ 有明确依据的官方别名（含 config 里已实测的档位）。 */
    readonly officialAlias?: readonly SourceObservation[];
    /** 该 CLI 当前配置的默认模型（不传 `--model` 时跑的那个）；没有证据就留空。 */
    readonly currentDefault?: string | null;
}
/**
 * 合并四类来源 → 逐条 `ModelEntry`。
 *
 * 顺序：主来源按 `MODEL_SOURCE_ORDER`，同来源内保持**观测顺序**（稳定性 = 可断言）。
 */
export declare function classifyModelEntries(input: ClassifyInput): ModelEntry[];
/** 便于 UI 显示与断言的分组计数。 */
export declare function countByKind(entries: readonly ModelEntry[]): Readonly<Record<ModelKind, number>>;
/** 该条目能否作为模型参数送出（选择器/`--model` 只允许这些）。 */
export declare function selectableIds(entries: readonly ModelEntry[]): string[];
export type DiscoveryStateCode = 'ready' | 'not-installed' | 'not-logged-in' | 'no-provider' | 'no-list-capability' | 'unknown';
export declare const DISCOVERY_STATE_LABEL: Readonly<Record<DiscoveryStateCode, string>>;
export interface DiscoveryStateInput {
    /** 真实入口解析到了吗（绝对路径存在 / 命令能在 PATH 找到）。 */
    readonly entryResolved: boolean;
    /** 该 CLI 是「需要登录才能用」的那一类吗（来自本插件自己的分类，不是猜）。 */
    readonly loginRequired?: boolean;
    /** 列举输出里出现了认证相关字样（`providers.ts` 的同一个判据）。 */
    readonly authBlocked?: boolean;
    /** 有没有任何列举能力：modelsCommand / modelsFile / 原生目录文件之一。 */
    readonly hasListCapability: boolean;
    /** 原生配置里到底有没有供应商/模型条目。 */
    readonly nativeConfigSeen: boolean;
    /** 本次真的问过 CLI 吗（`measure=false` 时没问）。 */
    readonly measured: boolean;
    /** 过滤后可用的可选模型数。 */
    readonly selectableCount: number;
    /** 补充说明（来自各处的证据文本，原样附上）。 */
    readonly notes?: readonly string[];
}
export interface DiscoveryState {
    readonly code: DiscoveryStateCode;
    readonly label: string;
    readonly evidence: string;
}
/**
 * 四态判定（**顺序即优先级**，只按证据，不猜）：
 *   ① 入口解析不到 ⇒ 未安装（后面的都无从谈起）
 *   ② 输出里有认证字样 ⇒ 未登录（**只降不升**：有认证字样时不宣称「有供应商」）
 *   ③ 没有列举能力（无命令也无目录文件）⇒ 没有模型列举能力
 *   ④ 有列举能力但一条可选模型都没有，且原生配置里也没有 ⇒ 没有配置供应商
 *   ⑤ 有可选模型 ⇒ 就绪
 *   ⑥ 其余（例如没测量）⇒ 未知（证据不足）—— **绝不**填成「就绪」
 */
export declare function discoveryStateOf(input: DiscoveryStateInput): DiscoveryState;
