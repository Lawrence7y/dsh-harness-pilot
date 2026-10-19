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
import type { TargetConfig } from './types.js'

/** 区域：只有真正存在「国内版 / 国际版」两套 CLF 的产品才填，其余留空。 */
export type HarnessRegion = '' | 'cn' | 'intl'

/** 目标的形态：CLI（可 headless 派发）/ IDE / 桌面 App。只用于文案，不参与分组。 */
export type HarnessKind = 'cli' | 'ide' | 'app' | 'unknown'

export interface HarnessClass {
  /** 产品身份（分组键的一半）。例如 `qoder` / `claude-code` / `workbuddy`。 */
  readonly key: string
  /** 展示名（不含区域后缀）。 */
  readonly label: string
  /** 区域；`''` = 不分区域。 */
  readonly region: HarnessRegion
  readonly kind: HarnessKind
}

/**
 * **显式分类表**（内置目标全覆盖；离线探针会断言覆盖率）。
 *
 * 顺序无关。键 = 目标名。
 */
const CLASSES: Readonly<Record<string, Omit<HarnessClass, 'region'> & { region?: HarnessRegion }>> = {
  // ⚠️ WorkBuddy / Qoder / Antigravity 已不在本插件：账号型接入（WB 双版 + Qoder 双区）拆到
  // `@dsh-external/dsh-model-connect`；Antigravity 按 2026-10-15 用户指示改走 call-agy 技能
  // （CLI 多账号经实测不可行：无 login/status 子命令、两个数据根开关均无效，见 probe/out/agy-isolation.json）。
  // 2026-10-15 二次收缩：opencode 全家 / command-code / grok / cursor 按用户指示删除；
  // zcode / kimi / minimax 因「无法获取模型」删除（kimi 未登录无 provider；zcode CLI 无枚举机制；
  // minimax 仅 GUI 且 shim 失效）。这里登记的**只有本插件仍接的 CLI/桌面型 harness**。

  // ── MiMo（桌面端；MiMo Code CLI 已卸载，2026-10-15 用户指示）──
  'mimo': { key: 'mimo', label: 'MiMo', kind: 'app' },

  // ── 单条产品 ──
  'claude': { key: 'claude-code', label: 'Claude Code', kind: 'cli' },
  'codex': { key: 'codex', label: 'Codex', kind: 'cli' },
  'pi': { key: 'pi', label: 'Pi', kind: 'cli' },
}

/** 目标名 → 身份。未登记的目标**如实降级**（`key = 目标名`），不猜产品。 */
export function classifyTarget(target: Pick<TargetConfig, 'name'>): HarnessClass {
  const found = CLASSES[target.name]
  if (found === undefined) return { key: target.name, label: target.name, region: '', kind: 'unknown' }
  return { key: found.key, label: found.label, region: found.region ?? '', kind: found.kind }
}

/** 该目标名是否在显式表里（探针用它断言覆盖率）。 */
export function isClassified(name: string): boolean {
  return CLASSES[name] !== undefined
}

/** 全部分类表里的目标名（探针用来核对内置目标表是否有漏项）。 */
export function classifiedNames(): string[] {
  return Object.keys(CLASSES)
}

/** 区域展示后缀；`''` 时不加。 */
export function regionLabel(region: HarnessRegion): string {
  return region === 'cn' ? '国内' : region === 'intl' ? '国际' : ''
}

/**
 * 分组行 id：`<key>` 或 `<key>::<region>`。
 *
 * ⚠️ 这个 id 是**用户可见的「一条 harness」**的身份，也是本插件对外（设置页 / 概览接口）
 * 表示「一条 entry」的键。它**不**直接当 LLM provider 名用（那是 `harness-<id>`，
 * 由调用方拼，见 `providerIdFor()`）。
 */
export function harnessRowId(identity: Pick<HarnessClass, 'key' | 'region'>): string {
  return identity.region === '' ? identity.key : `${identity.key}::${identity.region}`
}

/**
 * 会话/子代理选择器里该 harness 分组的 **LLM provider 名**。
 *
 * 只允许 `[a-z0-9-]`（provider 名会被写进 profile 的 `allowedModels`、也会出现在日志里）：
 * `::` 换成 `-`。例：`qoder::cn` → `harness-qoder-cn`。
 */
export function providerIdFor(identity: Pick<HarnessClass, 'key' | 'region'>): string {
  return `harness-${harnessRowId(identity).replace(/::/g, '-').replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`
}

/** 分组行的人类标签（含区域后缀）。 */
export function harnessRowLabel(identity: Pick<HarnessClass, 'label' | 'region'>): string {
  const suffix = regionLabel(identity.region)
  return suffix.length === 0 ? identity.label : `${identity.label}（${suffix}）`
}

/**
 * 该 harness 的**登录形态**（决定设置页显示什么）：
 *   · `accounts`    —— 由本插件的**账号档案**管理（可加/切/退/删），当前登录账号要显示出来；
 *   · `cli-managed` —— 登录态由 CLI 自己管（本插件只如实读取/说明，不假装能切账号）；
 *   · `unknown`     —— 尚未探测出结论（**不得**默认说「不需要登录」）。
 */
export type HarnessLoginMode = 'accounts' | 'cli-managed' | 'unknown'

const LOGIN_MODES: Readonly<Record<string, HarnessLoginMode>> = {
  qoder: 'accounts',
  workbuddy: 'accounts',
  antigravity: 'accounts',
  'claude-code': 'cli-managed',
  codex: 'cli-managed',
}

export function loginModeOf(key: string): HarnessLoginMode {
  return LOGIN_MODES[key] ?? 'unknown'
}

/**
 * 账号档案的 `harnessId` → 分组身份（**同一套产品身份**，不与目标分类漂移）。
 *
 * 实测本机档案用的 harnessId：`qoder-cn`（国内）/`qoder`（国际）/`workbuddy`（国内）/
 * `workbuddy-ai`（国际）。表里没有的 harnessId 按 `key = harnessId`、`region = ''` 降级，
 * **不猜**区域。
 */
const ACCOUNT_HARNESS_IDS: Readonly<Record<string, { key: string, region: HarnessRegion }>> = {
  'qoder-cn': { key: 'qoder', region: 'cn' },
  'qoder': { key: 'qoder', region: 'intl' },
  'qoder-intl': { key: 'qoder', region: 'intl' },
  'workbuddy': { key: 'workbuddy', region: 'cn' },
  'workbuddy-ai': { key: 'workbuddy', region: 'intl' },
  'antigravity': { key: 'antigravity', region: '' },
  'agy': { key: 'antigravity', region: '' },
}

export function classifyHarnessId(harnessId: string): { key: string, region: HarnessRegion } {
  return ACCOUNT_HARNESS_IDS[harnessId] ?? { key: harnessId, region: '' }
}

/** 一个分组行里的一个目标。 */
export interface HarnessGroupMember<T> {
  readonly target: T
  readonly identity: HarnessClass
}

/** 一个分组行：用户眼里的「一条 harness」。 */
export interface HarnessGroup<T> {
  readonly id: string
  readonly key: string
  readonly region: HarnessRegion
  readonly label: string
  /** 该组里所有目标（**不截断**：CLI/IDE/账号配方都在这里，供详情区按需展开）。 */
  readonly members: readonly HarnessGroupMember<T>[]
}

/**
 * 把目标表折成「一条 harness」的分组（顺序：先按标签，再国内在前、国际在后）。
 *
 * **不截断、不去重成假象**：同一组里的多个目标全部保留在 `members` 里 —— 上层要展示
 * 细节时不会因为折叠而丢信息（用户要求：不能靠隐藏信息掩盖功能缺失）。
 */
export function groupTargets<T extends Pick<TargetConfig, 'name'>>(targets: readonly T[]): HarnessGroup<T>[] {
  const byId = new Map<string, { key: string, region: HarnessRegion, label: string, members: HarnessGroupMember<T>[] }>()
  for (const target of targets) {
    const identity = classifyTarget(target)
    const id = harnessRowId(identity)
    let bucket = byId.get(id)
    if (bucket === undefined) {
      bucket = { key: identity.key, region: identity.region, label: identity.label, members: [] }
      byId.set(id, bucket)
    }
    bucket.members.push({ target, identity })
  }
  const regionRank = (region: HarnessRegion): number => (region === 'cn' ? 0 : region === 'intl' ? 1 : 2)
  return [...byId.entries()]
    .map(([id, bucket]) => ({ id, key: bucket.key, region: bucket.region, label: bucket.label, members: bucket.members }))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-Hans-CN')
      || regionRank(left.region) - regionRank(right.region)
      || left.id.localeCompare(right.id))
}

// ────────────────────────────────────────────────────────────────────────────
// 分组索引（给 HTTP 面用）：**只做索引，不复制数据**
// ────────────────────────────────────────────────────────────────────────────
//
// 设置页与会话/子代理选择器需要「一条 harness」这个视角，而现有接口已经有
// 每目标的模型、每个账号档案的状态 —— 所以这里**只**产出「哪条 harness 由哪些目标/账号组成」，
// 模型与账号明细由调用方拿既有接口（`/overview?models=1`、`/api/accounts`）拼。
// 这样做的好处：不会有第二份会漂移的数据源（本项目栽过「同一能力多出口不一致」四次）。

/** 一条 harness 的索引行。 */
export interface HarnessGroupIndex {
  /** 稳定 id（`<key>` 或 `<key>::<region>`）；也是「一条 harness」的身份。 */
  readonly id: string
  readonly key: string
  readonly region: HarnessRegion
  /** 人类标签（含区域后缀）。 */
  readonly label: string
  /** 会话/子代理选择器里的 provider 名（`harness-<id>`）。 */
  readonly providerId: string
  readonly login: HarnessLoginMode
  /** 属于这条 harness 的**全部**目标名（不截断）。 */
  readonly members: readonly string[]
  /** 其中**能做一次性派发**的（`transport: 'auto'` 或 `'cdp'`，与 harness-llm.isDispatchable 同一口径）—— 只有这些能进会话/子代理选择。 */
  readonly dispatchable: readonly string[]
}

/**
 * 生成分组索引。
 *
 * @param targets 当前生效的目标（内置 ± profile 追加 ± 用户覆盖）
 * @param accountHarnessIds 当前账号档案各自的 `harnessId`（用来算 `accounts` 归属与「有没有档案」）
 */
export function buildGroupIndex(
  targets: readonly Pick<TargetConfig, 'name' | 'transport'>[],
  accountHarnessIds: readonly string[] = [],
  accountIds: readonly string[] = [],
): (HarnessGroupIndex & { readonly accountCount: number, readonly accountIds: readonly string[] })[] {
  const groups = groupTargets(targets)
  return groups.map((group) => {
    const members = group.members.map((member) => member.target.name)
    const dispatchable = group.members
      .filter((member) => ['auto', 'cdp'].includes(member.target.transport ?? 'auto'))
      .map((member) => member.target.name)
    // 账号归属按**档案的 harnessId**（同一套产品身份表）算，**不**按名字前缀猜：
    // 客户端因此不必再实现一份「区域归属」判断（那种第二份实现必然漂移）。
    const owned = accountHarnessIds
      .map((harnessId, index) => ({ harnessId, id: accountIds[index] ?? '' }))
      .filter((entry) => harnessRowId(classifyHarnessId(entry.harnessId)) === group.id)
    return {
      id: group.id,
      key: group.key,
      region: group.region,
      label: harnessRowLabel(group),
      providerId: providerIdFor(group),
      login: loginModeOf(group.key),
      members,
      dispatchable,
      accountCount: owned.length,
      accountIds: owned.map((entry) => entry.id).filter((id) => id.length > 0),
    }
  })
}
