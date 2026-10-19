/**
 * 子代理模型白名单（宿主 `subagent-model-selection-settings.allowedModels`）的**读写与差分**。
 *
 * ## 为什么需要它（用户要求原文）
 * 「……另外，该 harness 中的模型，**能够选择哪些在会话和子代理选择中被选择**」。
 *
 * 两条链路的可见性**不是一回事**（0.2.0-rc.2 实测）：
 *   · **会话**选择器：数据源 = `remote.session.modelCatalog()` → `buildModelCatalog()`
 *     （`dsh-api-session-controller/lib/index.js:500-548`）⇒ 只要插件注册了 provider 就有；
 *   · **子代理**：同一份目录**再叠一道精确串白名单** —— `dsh-tool-subagent/lib/index.js:91-98`
 *     （`assertAllowedModelSelection`：`policy.routes.some(route => route.provider===p && route.model===m)`），
 *     不匹配就抛 `child LLM route "P/M" is not allowed for this Session`；发现工具
 *     `list_subagent_models` 也被同一份白名单过滤（`:150-162`）。
 * ⇒ 本插件把模型目录改成「一个 harness 一条 provider」之后，**新路由必须能进这份白名单**，
 *   否则「子代理里选外部模型」这条路是断的（旧的 `pilot-cli/*` 条目在新目录下已不再列出模型）。
 *
 * ## 写入纪律（与闸门同一套）
 *   · 走**宿主自己的设置服务**（`ctx.settings.update(ns, patch, revision)`，`dsh-settings/lib/index.js:470`），
 *     它是 Plugins 页用的同一条路；带 **revision 乐观锁**（`:511` 冲突即抛 `SettingsConflictError`）；
 *   · **只增不删由调用方决定**：本模块只算差分，删哪些由用户显式勾选（绝不偷偷清理别人的条目）；
 *   · 写后**独立回读**（重新 `describe()`）并与请求目标比对，不一致就如实报错 —— 不相信「写下去了」。
 */
import type { HarnessLlmProvider } from './harness-llm.js'
import { mergeHarnessModels } from './harness-llm.js'

/** 宿主那条例目的 id（profile patch 里的 `id:`）。 */
export const SUBAGENT_MODEL_NS = 'subagent-model-selection-settings'

export interface AllowedRoute {
  readonly provider: string
  readonly model: string
}

export function routeKey(route: AllowedRoute): string {
  return `${route.provider}\u0000${route.model}`
}

/** 把任意来源的值规整成 route 数组（形状不对的条目**丢弃并计数**，不静默当合法）。 */
export function normalizeRoutes(value: unknown): { routes: AllowedRoute[], dropped: number } {
  if (!Array.isArray(value)) return { routes: [], dropped: 0 }
  const out: AllowedRoute[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const raw of value) {
    const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
    const provider = typeof record?.provider === 'string' ? record.provider.trim() : ''
    const model = typeof record?.model === 'string' ? record.model.trim() : ''
    if (provider.length === 0 || model.length === 0) { dropped += 1; continue }
    const key = routeKey({ provider, model })
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ provider, model })
  }
  return { routes: out, dropped }
}

/** 一次读取的现场（缺服务时 `available:false` + 可读原因，绝不假装读到空表）。 */
export interface PolicySnapshot {
  readonly available: boolean
  readonly reason: string
  readonly revision: number | null
  readonly enabled: boolean | null
  readonly allowed: readonly AllowedRoute[]
  readonly dropped: number
}

/** 宿主设置服务的最小面（`dsh-settings` 的 `describe/update`）。 */
export interface SettingsLike {
  describe?(options?: { redactSecrets?: boolean }): { ns?: unknown, revision?: unknown, value?: unknown }[]
  update?(ns: string, patch: unknown, expectedRevision?: number): Promise<unknown>
}

/** `subagentModelSelection` 服务的最小面（`current()` 返回当前生效值）。 */
export interface SelectionServiceLike {
  current?(): { enabled?: unknown, allowedModels?: unknown }
}

/**
 * 读当前白名单。
 *
 * 优先用 **服务**（`subagentModelSelection.current()`，它就是运行期生效值），
 * 同时用 **设置文档**（`settings.describe()`）取 `revision` —— 写入要用它做乐观锁。
 * 两者都不在 ⇒ `available:false`（如实说明，不返回空表冒充「没有白名单」）。
 */
export function readPolicy(settings: SettingsLike | undefined, selection: SelectionServiceLike | undefined): PolicySnapshot {
  let revision: number | null = null
  let documentValue: unknown
  let documentSeen = false
  try {
    const descriptors = settings?.describe?.({ redactSecrets: false }) ?? []
    const found = descriptors.find((row) => row.ns === SUBAGENT_MODEL_NS)
    if (found !== undefined) {
      documentSeen = true
      documentValue = found.value
      revision = typeof found.revision === 'number' && Number.isFinite(found.revision) ? found.revision : null
    }
  } catch { /* 读文档失败：下面按服务或不可用处理 */ }

  let serviceValue: unknown
  let serviceSeen = false
  try {
    const current = selection?.current?.()
    if (current !== undefined) { serviceSeen = true; serviceValue = current }
  } catch { /* 服务读失败：同上 */ }

  if (!documentSeen && !serviceSeen) {
    return {
      available: false,
      reason: settings === undefined && selection === undefined
        ? '宿主既没有 `settings` 服务也没有 `subagentModelSelection` 服务（本组合没挂载子代理模型选择）'
        : `没有读到「${SUBAGENT_MODEL_NS}」这一条目（该 profile 可能没有启用子代理模型选择）`,
      revision: null, enabled: null, allowed: [], dropped: 0,
    }
  }
  const source = serviceSeen ? serviceValue : documentValue
  const record = source !== null && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : {}
  const normalized = normalizeRoutes(record.allowedModels)
  return {
    available: true,
    reason: serviceSeen ? '值取自 subagentModelSelection.current()（运行期生效值）' : '值取自 settings.describe()（设置文档）',
    revision,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : null,
    allowed: normalized.routes,
    dropped: normalized.dropped,
  }
}

/** 白名单变更的**差分**（纯函数）：只算要加/要删/已在/不存在，绝不预设策略。 */
export interface PolicyChangePlan {
  readonly additions: readonly AllowedRoute[]
  readonly removals: readonly AllowedRoute[]
  readonly alreadyPresent: readonly AllowedRoute[]
  readonly missing: readonly AllowedRoute[]
  readonly next: readonly AllowedRoute[]
}

export function planPolicyChange(
  current: readonly AllowedRoute[],
  add: readonly AllowedRoute[],
  remove: readonly AllowedRoute[],
): PolicyChangePlan {
  const have = new Set(current.map(routeKey))
  const additions: AllowedRoute[] = []
  const alreadyPresent: AllowedRoute[] = []
  for (const route of add) {
    const key = routeKey(route)
    if (have.has(key)) { alreadyPresent.push(route); continue }
    have.add(key)
    additions.push(route)
  }
  const removalKeys = new Set(remove.map(routeKey))
  const removals: AllowedRoute[] = []
  const missing: AllowedRoute[] = []
  for (const route of remove) {
    if (removalKeys.has(routeKey(route)) && current.some((entry) => routeKey(entry) === routeKey(route))) removals.push(route)
    else missing.push(route)
  }
  const removalSet = new Set(removals.map(routeKey))
  const next = [...current.filter((route) => !removalSet.has(routeKey(route))), ...additions]
  return { additions, removals, alreadyPresent, missing, next }
}

/** 该 provider 在**当前目录**里的可选模型（给设置页的勾选清单用）。 */
export interface CandidateModel {
  readonly provider: string
  readonly model: string
  readonly name: string
  readonly enabled: boolean
}

export function candidatesFor(
  providers: readonly HarnessLlmProvider[],
  modelsOf: (targetName: string) => readonly string[] | undefined,
  allowed: readonly AllowedRoute[],
): CandidateModel[] {
  const enabled = new Set(allowed.map(routeKey))
  const out: CandidateModel[] = []
  for (const spec of providers) {
    for (const model of mergeHarnessModels(spec, modelsOf)) {
      const route = { provider: spec.id, model: model.id }
      out.push({
        provider: spec.id,
        model: model.id,
        name: `${spec.name} · ${model.id}`,
        enabled: enabled.has(routeKey(route)),
      })
    }
  }
  return out
}

/** 写入结果（含**独立回读**的比对结论）。 */
export interface ApplyOutcome {
  readonly ok: boolean
  readonly reason: string
  readonly requested: { additions: number, removals: number }
  readonly readback: PolicySnapshot | null
  readonly verified: boolean
  readonly conflict: boolean
}

/**
 * 给 HTTP 层用的门面（宿主服务只在 `apply()` 的 scope 里拿得到，路由处理器拿不到 `ctx`）。
 * 由 `index.ts` 在装配期构造一次。
 */
export interface SubagentModelsFacade {
  readonly ns: string
  readonly settingsAvailable: boolean
  readonly selectionAvailable: boolean
  /** 读当前白名单（运行期生效值 + revision）。 */
  readonly read: () => PolicySnapshot
  /** 当前目录里可勾选的候选（**不截断**）。 */
  readonly candidates: () => CandidateModel[]
  /** 应用差分（写 + 独立回读）。 */
  readonly apply: (plan: PolicyChangePlan, expectedRevision: number | null) => Promise<ApplyOutcome>
}

/**
 * 应用差分：`settings.update(ns, {allowedModels: next}, revision)` + **独立回读**。
 *
 * ⚠️ 只改 `allowedModels` 这一个数组；`enabled` 与其他 profile 内容一律不动
 * （`update` 只合并传入字段，`dsh-settings/lib/index.js:470-472`）。
 */
export async function applyPolicyChange(
  settings: SettingsLike | undefined,
  selection: SelectionServiceLike | undefined,
  plan: PolicyChangePlan,
  expectedRevision: number | null,
): Promise<ApplyOutcome> {
  const requested = { additions: plan.additions.length, removals: plan.removals.length }
  if (settings?.update === undefined) {
    return { ok: false, reason: '宿主 `settings.update` 不可用 ⇒ 不写（不会退化成直接改 profile 文件）', requested, readback: null, verified: false, conflict: false }
  }
  if (plan.additions.length === 0 && plan.removals.length === 0) {
    return { ok: true, reason: '差分是空的：没有任何需要写入的变更', requested, readback: readPolicy(settings, selection), verified: true, conflict: false }
  }
  try {
    await settings.update(SUBAGENT_MODEL_NS, { allowedModels: plan.next }, expectedRevision ?? undefined)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const conflict = /changed since it was read|Conflict/i.test(message)
    return { ok: false, reason: conflict ? `白名单在读取之后被别人改过（乐观锁拒绝写入）：${message}` : `写入失败：${message}`, requested, readback: null, verified: false, conflict }
  }
  const readback = readPolicy(settings, selection)
  const want = new Set(plan.next.map(routeKey))
  const got = new Set(readback.allowed.map(routeKey))
  const verified = want.size === got.size && [...want].every((key) => got.has(key))
  return {
    ok: verified,
    reason: verified
      ? `已写入并独立回读一致（${plan.next.length} 条；本次 +${requested.additions} / -${requested.removals}）`
      : `写入返回成功，但**独立回读与目标不一致**（目标 ${want.size} 条 vs 实际 ${got.size} 条）—— 以回读为准，不认为已生效`,
    requested, readback, verified, conflict: false,
  }
}
