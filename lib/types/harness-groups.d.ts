/**
 * Harness **身份归类**与**分组**（纯函数，零宿主依赖；离线与运行期同一份实现）。
 *
 * ## 为什么必须有这一层（用户要求 + 实测事实）
 * 用户真正要看到的是「**我装了哪些 CLI、它们有哪些模型**」：
 *   · 同一个产品的 CLI / IDE / TUI / 桌面端 / 不同账号配方，在用户眼里是**一个** harness；
 *   · **唯一**允许拆成两条的是「国内版 / 国际版」（用户明确要求）；
 *   · MIMO 只剩桌面端一个目标（MiMo Code CLI 已于 2026-10-15 按用户指示卸载）。
 *
 * 这个分类同时是**会话与子代理选择器里「按 harness 折叠」的键**：宿主原版选择器按
 * `session.modelCatalog()` 的 **provider 分组**渲染，两级钻取（供应链列表 → 该供应商的模型），
 * 所以「一个 harness = 一个 provider 分组」就天然得到折叠语义，**不需要改客户端**。
 *
 * ## 纪律
 *   · 分类是**显式表**，不是聪明的字符串剥壳：`classifyTarget()` 认不出就落到
 *     `key = 目标名`、`kind = 'unknown'`，并且离线探针会对内置目标逐个断言「必须显式归类」
 *     —— 新目标不会被悄悄混进某个组。
 *   · **区域只有 qoder / workbuddy 会拆**（用户只允许这两个拆）。其它 harness 一律 `region: ''`。
 *   · 标签用中文，和设置页/选择器的其余文案一致。
 */
import type { TargetConfig } from './types.js';
/** 区域：只有真正存在「国内版 / 国际版」两套 CLF 的产品才填，其余留空。 */
export type HarnessRegion = '' | 'cn' | 'intl';
/** 目标的形态：CLI（可 headless 派发）/ IDE / 桌面 App。只用于文案，不参与分组。 */
export type HarnessKind = 'cli' | 'ide' | 'app' | 'unknown';
export interface HarnessClass {
    /** 产品身份（分组键的一半）。例如 `qoder` / `claude-code` / `workbuddy`。 */
    readonly key: string;
    /** 展示名（不含区域后缀）。 */
    readonly label: string;
    /** 区域；`''` = 不分区域。 */
    readonly region: HarnessRegion;
    readonly kind: HarnessKind;
}
/** 目标名 → 身份。未登记的目标**如实降级**（`key = 目标名`），不猜产品。 */
export declare function classifyTarget(target: Pick<TargetConfig, 'name'>): HarnessClass;
/** 该目标名是否在显式表里（探针用它断言覆盖率）。 */
export declare function isClassified(name: string): boolean;
/** 全部分类表里的目标名（探针用来核对内置目标表是否有漏项）。 */
export declare function classifiedNames(): string[];
/** 区域展示后缀；`''` 时不加。 */
export declare function regionLabel(region: HarnessRegion): string;
/**
 * 分组行 id：`<key>` 或 `<key>::<region>`。
 *
 * ⚠️ 这个 id 是**用户可见的「一条 harness」**的身份，也是本插件对外（设置页 / 概览接口）
 * 表示「一条 entry」的键。它**不**直接当 LLM provider 名用（那是 `harness-<id>`，
 * 由调用方拼，见 `providerIdFor()`）。
 */
export declare function harnessRowId(identity: Pick<HarnessClass, 'key' | 'region'>): string;
/**
 * 会话/子代理选择器里该 harness 分组的 **LLM provider 名**。
 *
 * 只允许 `[a-z0-9-]`（provider 名会被写进 profile 的 `allowedModels`、也会出现在日志里）：
 * `::` 换成 `-`。例：`qoder::cn` → `harness-qoder-cn`。
 */
export declare function providerIdFor(identity: Pick<HarnessClass, 'key' | 'region'>): string;
/** 分组行的人类标签（含区域后缀）。 */
export declare function harnessRowLabel(identity: Pick<HarnessClass, 'label' | 'region'>): string;
/**
 * 该 harness 的**登录形态**（决定设置页显示什么）：
 *   · `accounts`    —— 由本插件的**账号档案**管理（可加/切/退/删），当前登录账号要显示出来；
 *   · `cli-managed` —— 登录态由 CLI 自己管（本插件只如实读取/说明，不假装能切账号）；
 *   · `unknown`     —— 尚未探测出结论（**不得**默认说「不需要登录」）。
 */
export type HarnessLoginMode = 'accounts' | 'cli-managed' | 'unknown';
export declare function loginModeOf(key: string): HarnessLoginMode;
export declare function classifyHarnessId(harnessId: string): {
    key: string;
    region: HarnessRegion;
};
/** 一个分组行里的一个目标。 */
export interface HarnessGroupMember<T> {
    readonly target: T;
    readonly identity: HarnessClass;
}
/** 一个分组行：用户眼里的「一条 harness」。 */
export interface HarnessGroup<T> {
    readonly id: string;
    readonly key: string;
    readonly region: HarnessRegion;
    readonly label: string;
    /** 该组里所有目标（**不截断**：CLI/IDE/账号配方都在这里，供详情区按需展开）。 */
    readonly members: readonly HarnessGroupMember<T>[];
}
/**
 * 把目标表折成「一条 harness」的分组（顺序：先按标签，再国内在前、国际在后）。
 *
 * **不截断、不去重成假象**：同一组里的多个目标全部保留在 `members` 里 —— 上层要展示
 * 细节时不会因为折叠而丢信息（用户要求：不能靠隐藏信息掩盖功能缺失）。
 */
export declare function groupTargets<T extends Pick<TargetConfig, 'name'>>(targets: readonly T[]): HarnessGroup<T>[];
/** 一条 harness 的索引行。 */
export interface HarnessGroupIndex {
    /** 稳定 id（`<key>` 或 `<key>::<region>`）；也是「一条 harness」的身份。 */
    readonly id: string;
    readonly key: string;
    readonly region: HarnessRegion;
    /** 人类标签（含区域后缀）。 */
    readonly label: string;
    /** 会话/子代理选择器里的 provider 名（`harness-<id>`）。 */
    readonly providerId: string;
    readonly login: HarnessLoginMode;
    /** 属于这条 harness 的**全部**目标名（不截断）。 */
    readonly members: readonly string[];
    /** 其中**能做一次性派发**的（`transport: 'auto'` 或 `'cdp'`，与 harness-llm.isDispatchable 同一口径）—— 只有这些能进会话/子代理选择。 */
    readonly dispatchable: readonly string[];
}
/**
 * 生成分组索引。
 *
 * @param targets 当前生效的目标（内置 ± profile 追加 ± 用户覆盖）
 * @param accountHarnessIds 当前账号档案各自的 `harnessId`（用来算 `accounts` 归属与「有没有档案」）
 */
export declare function buildGroupIndex(targets: readonly Pick<TargetConfig, 'name' | 'transport'>[], accountHarnessIds?: readonly string[], accountIds?: readonly string[]): (HarnessGroupIndex & {
    readonly accountCount: number;
    readonly accountIds: readonly string[];
})[];
