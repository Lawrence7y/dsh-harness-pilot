/**
 * 「一个 harness = 一个 LLM provider 路由」的**规格与模型合并**（纯函数，零宿主依赖）。
 *
 * ## 为什么必须这么做（宿主契约，实测行号）
 * 用户要求（原话）：「会话列表和子代理选择中，要对 harness 进行折叠，点开折叠后才是该 harness 的
 * 全部模型」。而宿主的模型选择器**只按 LLM provider 分组**，且**分组不可折叠**：
 *   · 菜单：`dsh-client-ui-model-selection/lib/client.js:980-982` 用 `filteredGroups.map(group =>
 *     h(MenuGroup, { label: group.name, children: group.models.map(...) }))`；`MenuGroup` 只是**粘性
 *     标题**（`dsh-client-ui-primitives/lib/index.js:4283-4305`），全树没有组级折叠原语；
 *   · 子代理设置卡同理按 provider 分组（`dsh-client-ui-settings-subagent/lib/client.js:313-330`）；
 *   · 分组数据来自 `dsh-api-session-controller/lib/index.js:500-548 buildModelCatalog` →
 *     `ctx.llm.listProviders()` + `listModels(provider)`，**空组会被丢掉**（`:541`）。
 * ⇒ 「一个 harness 一个 provider」是唯一能落地折叠的宿主机制（`registerAdapter(providers, adapter)`
 *   本就接受**多路由**：`dsh-llm/lib/index.js:1826-1833`）。
 *
 * ## 执行目标（哪条目标会真的跑）——**显式、可读、不静默**
 * 一个分组里有多条目标（CLI / IDE / TUI / 账号配方）。折叠成一条之后必须回答「选了模型以后谁来跑」：
 *   1. **优先账号固化的目标**（argv 里带 `--config-dir` 的那些）——按用户要求，
 *      绝不静默回退到**全局账号**的 CLI；
 *   2. 没有账号固化目标时，取该组里第一条**可一次性派发**的目标（配置顺序，确定性）；
 *   3. 选中的目标名会写进每条模型条目的描述里（用户在原生菜单里就能看到「谁跑」），
 *      并在设置页的详情里逐条列出。
 */
import type { TargetConfig } from './types.js'
import { buildGroupIndex, providerIdFor, type HarnessGroupIndex, type HarnessRegion } from './harness-groups.js'

/** 一条 harness 对应的 LLM provider 规格。 */
export interface HarnessLlmProvider {
  /** provider 名（`harness-<key>[-<region>]`）；会进 profile 的 `allowedModels` 与日志。 */
  readonly id: string
  /** 原生选择器里显示的名字（例如 `外部 CLI · Qoder（国内）`）。 */
  readonly name: string
  /** 分组 id（`<key>` 或 `<key>::<region>`），用来和设置页/概览对上。 */
  readonly groupId: string
  readonly key: string
  readonly region: HarnessRegion
  /** 该组里**可一次性派发**的目标（配置顺序）。 */
  readonly targets: readonly string[]
  /**
   * 默认执行目标（`modelsFor` 命中时用它落派发）。
   * 规则见文件头：账号固化目标 > 第一条可派发目标；没有可派发目标时为 `''`。
   */
  readonly primaryTarget: string
  /** 该组里被判定为「账号固化」的目标（argv/env 里带账号配置目录）。 */
  readonly accountPinned: readonly string[]
}

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
export function isAccountPinned(target: Pick<TargetConfig, 'args' | 'env'>): boolean {
  if (target.args.some((arg) => arg.includes('--config-dir'))) return true
  if (Object.values(target.env).some((value) => value.includes('--config-dir'))) return true
  return target.args.some((arg) => /(?:^|[\\/])[^\\/]*-managed\.cjs$/i.test(arg))
}

/**
 * 该目标能否做**一次性派发**。
 *
 * `transport: 'auto'`（CLI/一次性打印）与 `'cdp'`（拉起桌面 App → CDP 注入输入 → 读回）都可以
 * —— 2026-10-15 真实矩阵实测：mimo / antigravity / qoder-cn 桌面端经 cdp 通道端到端回话成功，
 * 「cdp 只能 GUI 操控」的旧结论已过时。`'window'`（裸窗口键鼠）不在此列：实测会把输入打进
 * 命令面板等错误目标，只作为 cdp 失败后的兜底，不当可承诺的派发通道。
 */
function isDispatchable(target: Pick<TargetConfig, 'transport'>): boolean {
  const transport = target.transport ?? 'auto'
  return transport === 'auto' || transport === 'cdp'
}

/**
 * 由目标表生成 provider 规格（顺序与 `buildGroupIndex` 一致：按标签、国内在前）。
 *
 * 只产出**至少有一条可派发目标**的组：没有可派发目标的组（纯 IDE/GUI）不进模型目录
 * —— 那会造出「菜单里能选、选了什么也不跑」的假条目。
 */
export function buildHarnessLlmProviders(
  targets: readonly TargetConfig[],
  accountHarnessIds: readonly string[] = [],
  accountIds: readonly string[] = [],
): HarnessLlmProvider[] {
  const groups = buildGroupIndex(targets, accountHarnessIds, accountIds)
  const byName = new Map(targets.map((target) => [target.name, target]))
  const out: HarnessLlmProvider[] = []
  for (const group of groups) {
    const dispatchable = group.dispatchable.filter((name) => {
      const target = byName.get(name)
      return target !== undefined && isDispatchable(target)
    })
    if (dispatchable.length === 0) continue
    const pinned = dispatchable.filter((name) => {
      const target = byName.get(name)
      return target !== undefined && isAccountPinned(target)
    })
    const primaryTarget = pinned[0] ?? dispatchable[0] ?? ''
    out.push({
      id: group.providerId,
      name: `外部 CLI · ${group.label}`,
      groupId: group.id,
      key: group.key,
      region: group.region,
      targets: dispatchable,
      primaryTarget,
      accountPinned: pinned,
    })
  }
  return out
}

/** 一条可选模型（合并后）。 */
export interface HarnessLlmModel {
  /** 模型 id（**在同一个 provider 内唯一**）。 */
  readonly id: string
  /** 原生菜单里显示的名字。 */
  readonly name: string
  readonly description: string
  /** 这次选择会真的跑在哪条目标上。 */
  readonly target: string
  /** 该模型是从哪条目标发现的（去重前的原始来源，便于排查）。 */
  readonly sources: readonly string[]
  /** Account-specific discovery id may differ from the model value passed to the CLI. */
  readonly executionModel?: string
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
export function mergeHarnessModels(
  provider: HarnessLlmProvider,
  modelsOf: (targetName: string) => readonly string[] | undefined,
): HarnessLlmModel[] {
  const order: string[] = []
  const byId = new Map<string, { sources: string[], target: string }>()
  // 先问默认执行目标，再问其余目标 —— 顺序决定「同 id 用哪条目标跑」。
  const preferred = [provider.primaryTarget, ...provider.targets.filter((name) => name !== provider.primaryTarget)]
  for (const targetName of preferred) {
    if (targetName.length === 0) continue
    const models = modelsOf(targetName)
    if (models === undefined) continue
    for (const raw of models) {
      const id = raw.trim()
      if (id.length === 0) continue
      const found = byId.get(id)
      if (found === undefined) {
        byId.set(id, { sources: [targetName], target: targetName })
        order.push(id)
        continue
      }
      found.sources.push(targetName)
      // 默认执行目标报过它 ⇒ 优先用默认目标执行（`preferred` 已保证它排在最前）。
      if (targetName === provider.primaryTarget) found.target = targetName
    }
  }
  const merged: HarnessLlmModel[] = order.map((id) => {
    const entry = byId.get(id)!
    return {
      id,
      name: id,
      description: `${id}（该 harness 自报的模型；本次将由「${entry.target}」执行`
        + (entry.sources.length > 1 ? `；另有 ${entry.sources.length - 1} 条同族目标也报过它` : '')
        + '）',
      target: entry.target,
      sources: entry.sources,
    }
  })
  // Multiple pinned accounts must remain addressable after deduplicating common model ids.
  // These are routing aliases for observed models, not new vendor models.
  if (provider.accountPinned.length > 1) {
    for (const target of provider.accountPinned) {
      if (!provider.targets.includes(target)) continue
      for (const raw of modelsOf(target) ?? []) {
        const model = raw.trim(), id = `${target}::${model}`
        if (!model || merged.some(row => row.id === id)) continue
        merged.push({ id, name: `${model} · ${target}`, target, executionModel: model,
          sources: [target], description: `账号执行路由：由「${target}」运行模型「${model}」；不是新的厂商模型。` })
      }
    }
  }
  return merged
}

/** 分组规格查找（provider 名 → 规格）。 */
export function providerSpecFor(
  providers: readonly HarnessLlmProvider[],
  providerId: string,
): HarnessLlmProvider | undefined {
  return providers.find((entry) => entry.id === providerId)
}

/** 「CLI 默认档」的保留 model id（该 harness 不指定模型，用它自己的默认模型）。 */
export const CLI_DEFAULT_MODEL_ID = 'cli-default'

/** `groupIndex` 的别名导出（设置页/接口用同一个形状，避免再定义一份）。 */
export type { HarnessGroupIndex }
