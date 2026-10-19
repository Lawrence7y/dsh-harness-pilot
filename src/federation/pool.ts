/**
 * 账号池与自动切换决策（**纯函数**，可离线单测）。
 *
 * ## 设计原则
 * 1. **只在「明确额度耗尽」时自动切换。** `unknown` 一律不触发 —— 否则短暂限流会把账号池搅乱。
 * 2. **只在用户启用的账号池内、且 harness / 区域 / 供应商 / 模型兼容的账号之间切换。**
 * 3. **切换前验证目标账号的认证与可用性**；认证失效的账号不是候选。
 * 4. **无法保持原模型时按用户策略停止并提示**，**绝不静默换模型**（默认策略就是 `stop`）。
 * 5. **有上限、有退避、有熔断**：切换次数上限、最小切换间隔、连续失败熔断；
 *    全部账号不可用时**暂停并说明恢复条件**，不无限循环。
 * 6. **不做自动注册 / 自动获取新账号**；凭据始终由原生认证与受保护存储管理，本模块只做决策。
 *
 * 本模块**不执行**任何 I/O，也不碰凭据：决策与执行分离，便于先把「什么时候该切」论证清楚。
 */
import type { QuotaRecord, QuotaState } from './quota.js'

export interface PoolEntry {
  readonly accountId: string
  readonly harnessId: string
  /** 服务区域。跨区域切换必须显式声明兼容，否则不做候选。 */
  readonly region: string
  /** 用户是否把该账号纳入自动切换池。 */
  readonly enabled: boolean
  /** 越小越优先。 */
  readonly priority: number
  /** 该账号可用的供应商（留空表示不限制）。 */
  readonly providers?: readonly string[]
  /** 该账号可用的模型（留空表示不限制）。 */
  readonly models?: readonly string[]
  /** 冷却截止（毫秒时间戳）。 */
  readonly cooldownUntilMs?: number
  /**
   * 切到该账号之后要设置的冷却时长（毫秒）。**执行侧**（`autoswitch.ts`）在切换成功后读它，
   * 于是「冷却」不是一句注释，而是真的会挡住下一轮。
   */
  readonly cooldownMs?: number
  /** 与当前账号区域兼容的显式声明（跨区域时才需要）。 */
  readonly regionCompatibleWith?: readonly string[]
}

export interface SwitchPolicy {
  /** 用户是否启用「额度耗尽后自动切换」。**默认关闭**。 */
  readonly autoSwitchEnabled: boolean
  readonly maxSwitchesPerTask: number
  /** 两次自动切换之间的最小间隔（退避基准）。 */
  readonly backoffBaseMs: number
  readonly backoffFactor: number
  /** 连续失败多少次后熔断。 */
  readonly maxConsecutiveFailures: number
  /**
   * 目标账号无法保持原模型时的策略。
   * `stop` = 停止并提示（**默认，也是唯一不静默的选项**）；`switch-model` = 允许换模型但必须显式标注。
   */
  readonly onModelUnavailable: 'stop' | 'switch-model'
}

export const DEFAULT_POLICY: SwitchPolicy = {
  autoSwitchEnabled: false,
  maxSwitchesPerTask: 2,
  backoffBaseMs: 60_000,
  backoffFactor: 2,
  maxConsecutiveFailures: 3,
  onModelUnavailable: 'stop',
}

export type AuthStateLike = 'model-request-authorized' | 'identity-readable' | 'login-ok' | 'auth-invalid' | 'unknown'

export interface AutoSwitchInput {
  readonly now: number
  readonly harnessId: string
  readonly currentAccountId: string
  /** 当前任务正在用的模型（要尽量保住）。 */
  readonly currentModel?: string
  readonly currentProvider?: string
  readonly pool: readonly PoolEntry[]
  readonly quota: Readonly<Record<string, QuotaRecord>>
  readonly auth: Readonly<Record<string, AuthStateLike>>
  readonly switchesSoFar: number
  readonly consecutiveFailures: number
  readonly lastSwitchAtMs?: number
  readonly policy: SwitchPolicy
  /**
   * 该 harness 是否支持**原生跨账号恢复会话**。
   * false 时要走「脱敏交接检查点 + 新会话」，并如实告知上下文保留边界。
   */
  readonly nativeSessionResumable: boolean
}

export interface SwitchEvent {
  readonly at: string
  readonly reason: string
  readonly fromAccountId: string
  readonly toAccountId: string
  readonly recovery: 'native-resume' | 'checkpoint-new-session'
  /** 交接边界：哪些保留了、哪些丢了。**必须写清楚**。 */
  readonly boundary: string
  readonly result: 'switched' | 'failed'
}

export type PoolDecision =
  | { readonly action: 'stay'; readonly reason: string }
  | {
      readonly action: 'switch'
      readonly targetAccountId: string
      readonly reason: string
      /** 是否保住了原模型。false 时必须配合 policy=switch-model 且界面上要显式标注。 */
      readonly modelPreserved: boolean
      readonly recovery: SwitchEvent['recovery']
      readonly boundary: string
      readonly note: string
    }
  | { readonly action: 'pause'; readonly reason: string; readonly recovery: string }

const COOLDOWN = (ms: number): string => `${Math.round(ms / 1000)}s`

/**
 * 决定：继续用当前账号 / 切到某个账号 / 暂停等人工处理。
 *
 * 顺序即优先级，任何一步不满足都**不会**发生切换。
 */
export function decideAutoSwitch(input: AutoSwitchInput): PoolDecision {
  const { policy, now } = input

  // ① 用户没启用自动切换 → 绝不自动动
  if (!policy.autoSwitchEnabled) {
    return { action: 'stay', reason: '用户未启用「额度耗尽后自动切换」，保持当前账号（手动切换仍可用）' }
  }

  // ② 只有**明确**额度耗尽才自动切；unknown / available 一律不动
  const quota = input.quota[input.currentAccountId]
  const state: QuotaState = quota?.state ?? 'unknown'
  if (state !== 'exhausted') {
    return {
      action: 'stay',
      reason: state === 'available'
        ? '当前账号额度可用，无需切换'
        : `当前账号额度状态为「未知」（${quota?.reason ?? '尚未查询'}）—— 未知**不**触发自动切换，避免把限流/故障误当成额度耗尽`,
    }
  }

  // ③ 熔断：连续失败过多
  if (input.consecutiveFailures >= policy.maxConsecutiveFailures) {
    return {
      action: 'pause',
      reason: `连续失败 ${input.consecutiveFailures} 次，已达熔断阈值 ${policy.maxConsecutiveFailures}，停止自动切换以免反复消耗账号`,
      recovery: '请检查该 Harness 的服务状态与账号认证；确认恢复后再手动切换或重新启用自动切换',
    }
  }

  // ④ 切换次数上限
  if (input.switchesSoFar >= policy.maxSwitchesPerTask) {
    return {
      action: 'pause',
      reason: `本任务已自动切换 ${input.switchesSoFar} 次，达到上限 ${policy.maxSwitchesPerTask}，不再继续切换`,
      recovery: '需要继续请手动切换，或提高本任务的切换上限后重试',
    }
  }

  // ⑤ 退避：距上次切换太近就不切（指数退避）
  if (input.lastSwitchAtMs !== undefined) {
    const wait = policy.backoffBaseMs * Math.pow(policy.backoffFactor, Math.max(0, input.switchesSoFar - 1))
    const elapsed = now - input.lastSwitchAtMs
    if (elapsed < wait) {
      return {
        action: 'pause',
        reason: `距上次切换仅 ${COOLDOWN(elapsed)}，未达退避间隔 ${COOLDOWN(wait)}，本次不切换（避免账号间来回横跳）`,
        recovery: `等待约 ${COOLDOWN(wait - elapsed)} 后重试，或手动切换`,
      }
    }
  }

  // ⑥ 找候选：启用 + 同 harness + 区域/供应商兼容 + 未被判定耗尽 + 不在冷却 + 认证未失效
  const skipped: string[] = []
  const candidates: PoolEntry[] = []
  for (const entry of input.pool) {
    if (entry.accountId === input.currentAccountId) continue
    if (!entry.enabled) { skipped.push(`${entry.accountId}: 不在启用的账号池内`); continue }
    if (entry.harnessId !== input.harnessId) { skipped.push(`${entry.accountId}: 属于别的 Harness(${entry.harnessId})`); continue }
    const regionOk = entry.region === input.pool.find(p => p.accountId === input.currentAccountId)?.region
      || (entry.regionCompatibleWith ?? []).includes(regionOf(input, input.currentAccountId))
    if (!regionOk) { skipped.push(`${entry.accountId}: 区域不兼容(${entry.region})`); continue }
    if (input.currentProvider !== undefined && entry.providers !== undefined && entry.providers.length > 0
      && !entry.providers.includes(input.currentProvider)) {
      skipped.push(`${entry.accountId}: 不支持当前供应商(${input.currentProvider})`); continue
    }
    const candState = input.quota[entry.accountId]?.state ?? 'unknown'
    if (candState === 'exhausted') { skipped.push(`${entry.accountId}: 额度也已耗尽`); continue }
    if (entry.cooldownUntilMs !== undefined && entry.cooldownUntilMs > now) {
      skipped.push(`${entry.accountId}: 冷却中(剩 ${COOLDOWN(entry.cooldownUntilMs - now)})`); continue
    }
    const auth = input.auth[entry.accountId] ?? 'unknown'
    if (auth === 'auth-invalid') { skipped.push(`${entry.accountId}: 认证已失效`); continue }
    candidates.push(entry)
  }

  if (candidates.length === 0) {
    return {
      action: 'pause',
      reason: `当前账号额度已耗尽，且账号池内没有可用的目标账号：${skipped.join('；') || '池内没有其它账号'}`,
      recovery: '请在「Harness 管理 → 账号池」中启用或登录其它账号；本插件**不会**自动注册账号或获取新账号',
    }
  }

  // ⑦ 按优先级挑；同优先级时选冷却更早结束的
  candidates.sort((a, b) => (a.priority - b.priority) || ((a.cooldownUntilMs ?? 0) - (b.cooldownUntilMs ?? 0)))
  const target = candidates[0]
  if (target === undefined) {
    return { action: 'pause', reason: '候选账号排序异常，保守起见不切换', recovery: '请重试或手动切换' }
  }

  // ⑧ 模型必须尽量保住；保不住要按用户策略处理，**绝不静默换模型**
  const models = target.models
  const modelPreserved = input.currentModel === undefined
    || models === undefined || models.length === 0
    || models.includes(input.currentModel)
  if (!modelPreserved && policy.onModelUnavailable === 'stop') {
    return {
      action: 'pause',
      reason: `目标账号 ${target.accountId} 不支持当前模型「${input.currentModel}」，按策略 stop 停止切换，**不会静默换模型**`,
      recovery: `请为该账号启用该模型，或把策略改为 switch-model（会显式标注换成了哪个模型），或手动处理后重试`,
    }
  }

  const authConfidence = input.auth[target.accountId] === 'model-request-authorized'
    ? '认证与模型请求均已验证可用'
    : '认证未失效（但未取得「模型请求已验证」级别的证据）'
  const recovery: SwitchEvent['recovery'] = input.nativeSessionResumable ? 'native-resume' : 'checkpoint-new-session'
  const boundary = input.nativeSessionResumable
    ? '该 Harness 支持原生跨账号恢复：优先用原生机制保留并恢复会话'
    : '该 Harness **不支持**跨账号恢复会话：将用可追溯、脱敏的交接检查点新建会话；'
      + '**原生历史（工具调用记录、文件状态、模型侧上下文）不会随账号一起迁移**，新会话只带检查点里明确写下的内容'

  return {
    action: 'switch',
    targetAccountId: target.accountId,
    reason: `当前账号 ${input.currentAccountId} 额度已明确耗尽（${quota?.reason ?? '结构化错误判定'}），切换到池内更优的 ${target.accountId}`,
    modelPreserved,
    recovery,
    boundary,
    note: modelPreserved
      ? `目标账号可用性：${authConfidence}；模型保持为「${input.currentModel ?? '(未指定)'}」`
      : `⚠️ 目标账号不支持原模型，按 policy=switch-model 切换；**模型已改变**，必须显式提示`,
  }
}

function regionOf(input: AutoSwitchInput, accountId: string): string {
  return input.pool.find(p => p.accountId === accountId)?.region ?? ''
}

/**
 * 生成切换事件记录。
 * 用户的硬性要求：切换事件要包含**原因、前后脱敏账号、时间、恢复方式和结果**。
 */
export function makeSwitchEvent(
  decision: Extract<PoolDecision, { action: 'switch' }>,
  fromAccountId: string,
  redact: (accountId: string) => string,
  result: SwitchEvent['result'],
  at = new Date().toISOString(),
): SwitchEvent {
  return {
    at,
    reason: decision.reason,
    fromAccountId: redact(fromAccountId),
    toAccountId: redact(decision.targetAccountId),
    recovery: decision.recovery,
    boundary: decision.boundary,
    result,
  }
}

/**
 * 「结果不确定的写操作」重放保护。
 *
 * 用户明确要求：切换账号**不得**盲目重放整个任务或重复执行已完成的工具调用；
 * 对结果不确定的写入 / 提交 / 推送，必须先核验实际状态。
 *
 * 返回该动作**现在应该怎么做**：
 *   · 已完成 → `skip`（绝不重复执行）
 *   · 结果不确定 → `verify-first`（先核验，**不允许**直接重放）
 *   · 未开始 → `run`
 */
export type ActionState = 'not-started' | 'completed' | 'uncertain'

export function replayPolicy(state: ActionState, kind: 'read' | 'write' | 'commit' | 'push'): {
  readonly action: 'run' | 'skip' | 'verify-first'
  readonly reason: string
} {
  if (state === 'completed') {
    return { action: 'skip', reason: `${kind} 已完成 —— 换账号也**不得**重复执行` }
  }
  if (state === 'uncertain') {
    if (kind === 'read') {
      return { action: 'run', reason: '只读操作，重跑无副作用' }
    }
    return {
      action: 'verify-first',
      reason: `${kind} 的结果不确定（既没确认成功也没确认失败）：必须先核验实际状态（例如查远端/查工作区），**不得**直接重放`,
    }
  }
  return { action: 'run', reason: `${kind} 尚未开始，可以执行` }
}
