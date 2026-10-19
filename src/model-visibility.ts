/**
 * **会话模型选择器的可见性配置**（2026-10-15，用户原话）：
 * 「让模型选择列表不要这么长、这么臃排」「在设置中能够选择哪些 CLI 的哪些模型不显示在模型列表中」。
 *
 * 宿主原生菜单是「全部供应商的模型平铺在一个滚动列表」（`dsh-client-ui-model-selection` 的
 * `filteredGroups.map(group => h(MenuGroup, …))`，组只是粘性标题、没有折叠原语），所以
 * 本插件通过公开槽位提供 provider→模型二级菜单；这份配置仅决定该会话菜单展示哪些模型。
 * `PilotCliAdapter.listModels(provider)` 保持完整，避免误伤共用目录的原生子智能体设置。
 *
 * ## 三条语义边界（不许模糊）
 * 1. **隐藏 ≠ 不可用**：执行校验（`streamForProvider`）走的是 `mergeHarnessModels` 的**全量实时清单**，
 *    与 `listModels` 无关 —— 已经选了某个后来被隐藏的模型的会话**照常执行**；只是选择器不再宣传它。
 * 2. **只影响会话选择器**：子代理白名单的候选（`candidatesFor`）直接调 `mergeHarnessModels`，
 *    不过本配置 —— 子代理面照旧全量，两处互不牵连。
 * 3. **配置是显式的**：每组上限默认 `DEFAULT_PICKER_LIMIT`，设置页能看到并逐组改；
 *    完整清单永远在设置页可见（「选择器显示 M / 共 N」），**不是**把信息藏起来。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginHome } from './settings.js'

export interface ModelVisibilityDoc {
  readonly version: 1
  readonly updatedAt: string
  /** 每条 harness（provider id）在会话选择器里最多显示多少个模型；0 = 不限。**缺键 = 用默认值**。 */
  readonly groupLimit: Readonly<Record<string, number>>
  /** 整组隐藏：该 harness 连「CLI 默认模型」一起不出现在会话选择器。 */
  readonly hiddenGroups: readonly string[]
  /** 组内隐藏：这些模型 id 不进选择器（已选中的会话不受影响，仍执行）。 */
  readonly hiddenModels: Readonly<Record<string, readonly string[]>>
}

/** 每组默认显示上限（不含「CLI 默认模型」那条）。10 是「常用 CLI 的全集 ≈ pi/agy 之外」的量级；可逐组改。 */
export const DEFAULT_PICKER_LIMIT = 10
export const PICKER_LIMIT_MAX = 500
/** 「CLI 默认模型」的保留 id —— 隐藏它等价于「这条 harness 我不想在会话里手选」。 */
export const CLI_DEFAULT_VISIBLE_ID = 'cli-default'

/** 一条 provider 在某一刻的**生效**可见性（解析默认值之后的形状）。 */
export interface PickerVisibilitySpec {
  readonly groupHidden: boolean
  /** 生效上限（0 = 不限）。 */
  readonly limit: number
  readonly hidden: readonly string[]
}

export const EMPTY_VISIBILITY_SPEC: PickerVisibilitySpec = { groupHidden: false, limit: 0, hidden: [] }

/** 把文档解析成某条 provider 的生效值（纯函数；未知 provider ⇒ 全默认 + 不隐藏）。 */
export function pickerVisibilityFor(doc: ModelVisibilityDoc, providerId: string): PickerVisibilitySpec {
  const groupHidden = doc.hiddenGroups.includes(providerId)
  const rawLimit = doc.groupLimit[providerId]
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
    ? Math.min(PICKER_LIMIT_MAX, Math.max(0, Math.round(rawLimit)))
    : DEFAULT_PICKER_LIMIT
  return { groupHidden, limit, hidden: doc.hiddenModels[providerId] ?? [] }
}

/**
 * 按生效值裁剪一组模型行（**保序**：裁剪只删不排，同 id 多次出现也只按位置处理 —— 上游 `mergeHarnessModels` 已去重）。
 * `hidden` 里的 id 直接删；`limit > 0` 时再取前 `limit` 条。返回**同一批对象的引用**，不复制不改写。
 */
export function filterPickerModels<T extends { readonly id: string }>(
  models: readonly T[],
  hidden: ReadonlySet<string>,
  limit: number,
): readonly T[] {
  const kept = models.filter((model) => !hidden.has(model.id))
  return limit > 0 ? kept.slice(0, Math.round(limit)) : kept
}

// ── 落盘 ────────────────────────────────────────────────────────────────────

export function modelVisibilityPath(): string {
  return join(pluginHome(), 'model-visibility.json')
}

function cleanIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id.length === 0 || id.length > 300 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= 2000) break
  }
  return out
}

function cleanLimitMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.trim().length === 0 || key.length > 200) continue
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    out[key.trim()] = Math.min(PICKER_LIMIT_MAX, Math.max(0, Math.round(raw)))
  }
  return out
}

/** 任意输入收敛成一份完整、合法的文档（缺字段补默认，类型错当缺省；**不抛**）。 */
export function normalizeModelVisibility(raw: unknown): ModelVisibilityDoc {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const hiddenModels: Record<string, string[]> = {}
  if (input.hiddenModels !== null && typeof input.hiddenModels === 'object' && !Array.isArray(input.hiddenModels)) {
    for (const [key, value] of Object.entries(input.hiddenModels as Record<string, unknown>)) {
      if (typeof key !== 'string' || key.trim().length === 0) continue
      const list = cleanIdList(value)
      if (list.length > 0) hiddenModels[key.trim()] = list
    }
  }
  return {
    version: 1,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt.length > 0 ? input.updatedAt : '',
    groupLimit: cleanLimitMap(input.groupLimit),
    hiddenGroups: cleanIdList(input.hiddenGroups),
    hiddenModels,
  }
}

/** 读盘；文件不存在/损坏都回「全默认」（不抛 —— 可见性配置坏了不该打挂模型目录）。 */
export function loadModelVisibility(): ModelVisibilityDoc {
  try {
    if (!existsSync(modelVisibilityPath())) return normalizeModelVisibility({})
    return normalizeModelVisibility(JSON.parse(readFileSync(modelVisibilityPath(), 'utf8')))
  } catch {
    return normalizeModelVisibility({})
  }
}

/**
 * 原子写回（tmp + rename）；**写之前把上一份留成 `*.prev.json`**（单层撤销，与子代理白名单的
 * 写前快照同一纪律）。返回最终落盘的文档（updatedAt 已补）。
 */
export function saveModelVisibility(next: ModelVisibilityDoc): ModelVisibilityDoc {
  const path = modelVisibilityPath()
  mkdirSync(join(path, '..'), { recursive: true })
  const finalDoc: ModelVisibilityDoc = { ...next, updatedAt: new Date().toISOString() }
  try {
    if (existsSync(path)) writeFileSync(`${path}.prev.json`, readFileSync(path, 'utf8'), 'utf8')
  } catch { /* 撤销档写不进去不阻塞主写入 */ }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(finalDoc, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return finalDoc
}

// ── 变更（API 的纯内核，探针直接测）───────────────────────────────────────

/** 一次可见性变更（全部字段可选；`reset` 优先级最高，把这条 provider 恢复成全默认）。 */
export interface VisibilityPatch {
  readonly providerId: string
  readonly groupHidden?: boolean
  /** 生效上限；0 = 不限。缺省 = 不动。 */
  readonly limit?: number
  readonly hideModels?: readonly string[]
  readonly showModels?: readonly string[]
  readonly reset?: boolean
}

export type VisibilityPatchResult =
  | { readonly ok: true; readonly next: ModelVisibilityDoc; readonly note: string }
  | { readonly ok: false; readonly reason: string }

export function applyVisibilityPatch(doc: ModelVisibilityDoc, patch: VisibilityPatch): VisibilityPatchResult {
  const providerId = patch.providerId.trim()
  if (providerId.length === 0 || providerId.length > 200) {
    return { ok: false, reason: 'providerId 缺失或超长' }
  }
  const notes: string[] = []
  const groupLimit: Record<string, number> = { ...doc.groupLimit }
  const hiddenModels: Record<string, readonly string[]> = {}
  for (const [key, value] of Object.entries(doc.hiddenModels)) hiddenModels[key] = [...value]
  let hiddenGroups = [...doc.hiddenGroups]

  if (patch.reset === true) {
    delete groupLimit[providerId]
    delete hiddenModels[providerId]
    hiddenGroups = hiddenGroups.filter((id) => id !== providerId)
    notes.push('已恢复默认（上限回默认值、隐藏清空）')
  } else {
    if (patch.limit !== undefined) {
      if (typeof patch.limit !== 'number' || !Number.isFinite(patch.limit) || patch.limit < 0 || patch.limit > PICKER_LIMIT_MAX) {
        return { ok: false, reason: `limit 必须是 0–${PICKER_LIMIT_MAX} 的数字（0 = 不限）` }
      }
      groupLimit[providerId] = Math.round(patch.limit)
      notes.push(`上限 = ${Math.round(patch.limit) === 0 ? '不限' : String(Math.round(patch.limit))}`)
    }
    if (patch.groupHidden !== undefined) {
      const was = hiddenGroups.includes(providerId)
      if (patch.groupHidden === true && !was) { hiddenGroups.push(providerId); notes.push('整组隐藏') }
      if (patch.groupHidden === false && was) {
        hiddenGroups = hiddenGroups.filter((id) => id !== providerId)
        notes.push('取消整组隐藏')
      }
    }
    if (patch.hideModels !== undefined || patch.showModels !== undefined) {
      const current = new Set(hiddenModels[providerId] ?? [])
      const hide = cleanIdList(patch.hideModels)
      const show = cleanIdList(patch.showModels)
      let changed = 0
      for (const id of hide) if (!current.has(id)) { current.add(id); changed += 1 }
      for (const id of show) if (current.delete(id)) changed += 1
      if (changed > 0) {
        if (current.size === 0) delete hiddenModels[providerId]
        else hiddenModels[providerId] = [...current].sort()
        notes.push(`模型显隐 ${changed} 处`)
      }
    }
  }
  // ⚠️ 空变更 = **幂等成功**，不是错误（2026-10-15 用户反馈「选为不显示后无法保存」）：
  // 目标状态与当前一致（重复保存/双击/并发的另一端已写入）时，返回 400 会让面板把它当
  // 「保存失败」渲染——而用户要的状态其实已经在了。这里按成功返回、落盘保持原样。
  if (notes.length === 0) {
    return { ok: true, next: { version: 1, updatedAt: doc.updatedAt, groupLimit, hiddenGroups, hiddenModels }, note: '无需变更（当前配置已是目标状态）' }
  }
  return {
    ok: true,
    next: { version: 1, updatedAt: doc.updatedAt, groupLimit, hiddenGroups, hiddenModels },
    note: notes.join('；'),
  }
}

/**
 * 给 HTTP 层用的门面（与 `SubagentModelsFacade` 同一模式：宿主服务只在装配期拿得到，
 * 路由处理器拿不到 `ctx`）。由 `index.ts` 在挂载期构造一次；离线探针不挂 ⇒ 路由 503。
 */
export interface ModelVisibilityFacade {
  /** 读当前配置（运行期生效值）。 */
  readonly read: () => ModelVisibilityDoc
  /** 应用一次变更并落盘；成功返回「上一份 + 新文档 + 可读变更说明」。 */
  readonly write: (patch: VisibilityPatch) =>
    | { readonly ok: true; readonly doc: ModelVisibilityDoc; readonly previous: ModelVisibilityDoc; readonly note: string }
    | { readonly ok: false; readonly reason: string }
  /**
   * 每条 harness 分组的**当前合并清单**（与 `listModels` 同一份 `mergeHarnessModels` 实现，
   * 只是**不过滤** —— UI 要展示全量才好勾选）。只读同步缓存；未预热的目标就是空/短，如实。
   */
  readonly providers: () => readonly {
    readonly providerId: string
    readonly label: string
    readonly groupId: string
    readonly models: readonly string[]
  }[]
}

/** GET 出口的**单 provider 摘要**：UI 首屏与断言共用一份（不另写第二份合并逻辑）。 */
export interface PickerProviderSummary {
  readonly providerId: string
  readonly groupHidden: boolean
  readonly limit: number
  /** 当前该组合并后的全部模型数（不含 cli-default）。 */
  readonly total: number
  /** 应用可见性后会出现在选择器里的模型数（不含 cli-default；整组隐藏时为 0）。 */
  readonly visible: number
  readonly hiddenCount: number
  /** 合并清单 ∪ 已配置隐藏项：UI 勾选清单就画这一份（`known:false` = 该 CLI 当前已不再报它）。 */
  readonly models: readonly { id: string, visible: boolean, known: boolean }[]
}

export function pickerProviderSummary(
  doc: ModelVisibilityDoc,
  providerId: string,
  modelIds: readonly string[],
): PickerProviderSummary {
  const spec = pickerVisibilityFor(doc, providerId)
  const live = new Set(modelIds)
  const hidden = new Set(spec.hidden)
  const union: { id: string, visible: boolean, known: boolean }[] = []
  const seen = new Set<string>()
  for (const id of modelIds) {
    seen.add(id)
    // Per-model preference is independent from the group switch; toggling a group must not erase it.
    union.push({ id, visible: !hidden.has(id), known: true })
  }
  for (const id of spec.hidden) {
    if (!seen.has(id)) union.push({ id, visible: false, known: false })
  }
  const visibleList = spec.groupHidden
    ? []
    : filterPickerModels(modelIds.map((id) => ({ id })), hidden, spec.limit).map((row) => row.id)
  return {
    providerId,
    groupHidden: spec.groupHidden,
    limit: spec.limit,
    total: modelIds.length,
    visible: visibleList.length,
    hiddenCount: spec.hidden.filter((id) => live.has(id)).length,
    models: union,
  }
}
