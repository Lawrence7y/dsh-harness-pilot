import type { TargetConfig } from './types.js';
import { type NativeCatalogEntry } from './native-model-catalog.js';
import { type DiscoveryState, type ModelEntry } from './model-sources.js';
export interface HarnessModels {
    readonly models: string[];
    /** 查询方式（给 UI/模型看的说明）。 */
    readonly note: string;
    /** Full native catalog, including explicitly display-only entries. */
    readonly catalog?: readonly NativeCatalogEntry[];
    /**
     * **结构化**的逐条分类（来源 / 四类 / 能否作为模型参数）。`models` 是它的可选子集，
     * 保留是为了不让既有调用方（选择器、任务工具、探针）断掉。
     */
    readonly entries?: readonly ModelEntry[];
    /** 四态（未安装 / 未登录 / 没有配置供应商 / 没有模型列举能力 / 就绪 / 未知）+ 证据。 */
    readonly state?: DiscoveryState;
}
/**
 * 把各处观测到的名字汇成结构化条目。
 *
 * 来源映射（**唯一一处**，不许在别处再写一遍）：
 *   · 真实 CLI 查询输出 → `cli-query`
 *   · 原生目录里 `source==='native-config'`（settings.json / config.toml / zcode config.json）→ `native-config`
 *   · 原生目录里 `native-cache` / `native-catalog`（models_cache.json、models.json、厂商 product 缓存）→ `official-cache`
 *   · 原生目录里 `official-alias` / `configured-alias`，以及 `modelsFixed` 登记档位 → `official-alias`
 */
export declare function modelEntriesFor(input: {
    readonly cliQuery?: readonly string[];
    readonly catalog?: readonly NativeCatalogEntry[];
    readonly modelsFixed?: readonly string[];
    readonly catalogFile?: {
        readonly models: readonly string[];
        readonly note: string;
    };
    readonly cliQueryEvidence?: string;
}): ModelEntry[];
/** 四态输入的采集（把「有没有入口 / 有没有列举能力 / 有没有原生配置」三件事集中判一次）。 */
export declare function harnessStateFor(input: {
    readonly target: TargetConfig;
    readonly catalog: readonly NativeCatalogEntry[];
    readonly entries: readonly ModelEntry[];
    readonly entryResolved: boolean;
    readonly authBlocked: boolean;
    readonly measured: boolean;
    readonly loginRequired: boolean;
    readonly notes: readonly string[];
}): DiscoveryState;
/**
 * **概览**用的四态：只依赖缓存/静态可得的信息（**不起进程**）。
 *
 * 缓存里有四态就直接用（那是一次真实测量的结论，`/api/models` 存进去的）；
 * 没有就把 `measured:false` 如实传下去 —— 于是结果是「未知（证据不足）」而不是
 * 「没有配置供应商」（后者是**把没问过说成没有**）。
 */
export declare function overviewStateFor(input: {
    readonly target: TargetConfig;
    readonly catalog: readonly NativeCatalogEntry[];
    readonly entries: readonly ModelEntry[];
    readonly probeAvailable: boolean;
    readonly cachedState?: DiscoveryState;
    readonly notes: readonly string[];
}): DiscoveryState;
/**
 * 从 harness 自带的模型**目录文件**里读出模型 id（WorkBuddy/CodeBuddy 的 `models.json` 就是这种）。
 *
 * ⚠️ 安全边界（与 `federation/providers.readConfiguredNames` 同一纪律）：**只提取名字字段**
 * （`id` / `model` / `modelId` / `name`），绝不读取任何值字段 —— 这类目录文件里可能紧挨着密钥
 * （本机那份就带 `apiKey`）。读出的候选再过两道护栏：形状必须像模型 id，且像令牌的一律丢。
 */
export declare function readModelCatalogFile(file: string): HarnessModels;
/**
 * 目标的「入口」是否**真的存在**。
 *
 * ⚠️ 只看 `command` 是不够的：本机实测（2026-10-14 卸载 `command-code` 之后）
 * `command` 是 `node`（存在！），而被删掉的是**参数里那个绝对路径**
 * `…\node_modules\command-code\dist\index.mjs` ⇒ 进程能起来、脚本找不到，
 * 输出是 `Cannot find module`，于是被误判成「列举命令跑通了但没有模型」= **没有配置供应商**。
 * 那是把「没装」说成「没配」—— 四态的判据必须包含「参数里的文件在不在」。
 *
 * 只检查**绝对路径**且**带脚本/可执行后缀**的参数（相对路径可能是 CLI 自己解析的子命令，
 * 拿它当入口会误报）。
 */
export declare function missingEntryArgOf(target: Pick<TargetConfig, 'args'>): string | null;
/** 跑一次 `modelsCommand` 并解析出模型 id 列表；失败不抛错，返回空列表 + 原因。 */
export declare function listHarnessModels(target: TargetConfig, timeoutMs?: number): Promise<HarnessModels>;
/**
 * 从命令输出里解析模型 id：一行一个，取每行的第一个字段再校验。
 *
 * 各家输出格式差别很大：opencode 是一行一个纯 id；agy 是 `id<TAB>显示名`；
 * pi 是 `provider/id` 加说明文字。所以只取首个 token，并过滤说明行。
 *
 * ⚠️ **本函数已被取代，不要再拿它当解析器**：它对**空白对齐的表格**（`pi --list-models`）
 * 会取到**供应商列**（连表头词 `provider` 一起）当成模型 —— 实测 pi 被报成 7 个「模型」。
 * `listHarnessModels` 现已改走发现层那**唯一**一份解析器
 * （`./federation/providers.js` 的 `parseModelListOutput`，输出 `provider/model`）。
 * 这里**保留导出**只为不让既有探针的 import 断掉（`probe/verify-catalog-edit.mjs` 会 import 它）。
 */
export declare function parseModels(output: string): string[];
/** DSH 侧已配置的供应商路由与模型（llm 服务缺失时返回空）。 */
export interface DshProviderModels {
    readonly id: string;
    readonly name: string;
    readonly models: string[];
}
interface LlmLike {
    listProviders(): {
        id: string;
        name: string;
    }[];
    listModels(provider: string): Promise<{
        id: string;
    }[]>;
}
export declare function listDshModels(llm: LlmLike | undefined): Promise<DshProviderModels[]>;
export {};
