import type { TargetConfig } from './types.js';
export interface NativeCatalogEntry {
    readonly id: string;
    readonly provider?: string;
    readonly selectable: boolean;
    readonly source: 'official-alias' | 'native-cache' | 'native-config' | 'native-catalog' | 'configured-alias';
    readonly evidence: string;
    /**
     * 该条目在 CLI 原生配置里的**角色**。
     *
     * `default` = 这条就是该 CLI 当前配置的默认模型（不传 `--model` 时跑的那个）。
     * ⚠️ 必须显式标出来，**不许**靠「evidence 里有没有『当前模型』这几个字」猜 ——
     * 那样文案一改就静默失效（本项目栽过多次「靠字符串约定代替契约」的坑）。
     */
    readonly role?: 'default';
    /** 厂商 product config 里带的**元数据**（仅展示用；没有就不写，不编造）。 */
    readonly meta?: {
        readonly name?: string;
        readonly vendor?: string;
        readonly maxInputTokens?: number;
        readonly maxOutputTokens?: number;
        readonly supportsToolCall?: boolean;
        readonly supportsReasoning?: boolean;
        readonly supportsImages?: boolean;
        /** 厂商自己的别名关系（形如 `{lite: fast-model, reasoning: fast-model}`）。 */
        readonly relatedModels?: Readonly<Record<string, string>>;
    };
}
export interface NativeModelCatalog {
    readonly entries: readonly NativeCatalogEntry[];
    readonly selectableModels: string[];
    readonly note: string;
}
/**
 * 读厂商 **product config**（`…/cache/acc-product-config-v3.json`）里的 `models[]` 名册。
 *
 * ## 安全边界（**只有这一条读法**，离线探针静态断言）
 * 该文件里**确实有** `authentication` 一类凭据键（本机实测的顶层键里就有），
 * 所以这里**只取 `models` 数组**，并且每个条目只取白名单字段：
 * `id` / `name` / `vendor` / `isDefault` / `maxInputTokens` / `maxOutputTokens` /
 * `supportsToolCall` / `supportsReasoning` / `supportsImages` / `relatedModels`。
 * **不读取、不返回、不落盘**任何令牌/密钥/认证字段（`json()` 只解析整份文件，取值走白名单）。
 *
 * ## 归类纪律
 * 名册里的 id **一律 `selectable: false` + 来源 `native-cache`**：
 * 本机实测 CLI `--model` **不接受**名册里的底层 id（会响亮拒绝），
 * 所以它们只能「仅展示」；只有 `modelsFixed`（CLI 自己 `--help` 列的档位）才是可选。
 * `isDefault: true` 的条目给 `role: 'default'`（这才是「当前默认模型」的真实证据）。
 */
export declare function readProductConfigRoster(file: string): NativeCatalogEntry[];
/** Read specific allowlisted name fields only; never expose auth/cache identity, URLs or options. */
export declare function discoverLocalModelCatalog(target: TargetConfig, home?: string): NativeModelCatalog;
