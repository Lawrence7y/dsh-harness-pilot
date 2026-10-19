/**
 * 异步任务管理：把一次 harness 派发放到后台跑，落盘进度/结果，
 * 并在**终态时主动回执**——把交付内容送回发起的 DSH 会话并唤醒它继续任务。
 *
 * 形状与 Codex 版 harness-pilot 的 TaskManager 对齐（`.json` / `.log` / `.result.json`
 * 三件套、`callback.status` 状态机），方便两侧工具互通；差别是回执不是走
 * Codex desktop 的 `send_message_to_thread`，而是走 DSH 侧的会话唤醒（见 wake.ts）。
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { redactAccount } from './federation/poolconfig.js'
import { redactAccountIdsInText } from './task-tools.js'
import type { DispatchOutcome, DispatchSpec, NativeRunState, NativeSessionRef, TargetConfig, TransportKind } from './types.js'
// 持久原生会话层（P1）与回执 outbox（P4）：直接复用同一实现，不建第二套账本。
import { SessionMutex, NativeSessionStore, type NativeSessionRecord } from './native-sessions.js'
import { ReceiptOutbox, receiptIdFor } from './receipt-outbox.js'
// R2：目标配方烘焙账号的识别（与 sessions.ts 门禁同一实现）。
import { bakedAccountRefKey, bakedAccountRefOf } from './account-target.js'

const TERMINAL = new Set<TaskStatus>(['completed', 'error', 'timeout', 'aborted', 'interrupted'])

export type TaskStatus = 'running' | 'completed' | 'error' | 'timeout' | 'aborted' | 'interrupted' | 'stalled'

/**
 * 这本账里记着两种东西：
 *   - `task`     ：`harness_task_start` 派发的后台任务（有回执、有并发上限）；
 *   - `subagent` ：`harness_agent` / 宿主 subagent 工具经 provider 派发的**内部子代理 run**。
 *
 * 后者以前是纯内存的：runId 只出现在当次工具返回的文本里，既不落盘也不进注册表，
 * 于是静默失败只能靠"预期产物缺席"反推（P7）。
 */
export type TaskKind = 'task' | 'subagent'

/** 完成回执的投递状态机。 */
export type CallbackStatus = 'pending' | 'sending' | 'delivered' | 'failed' | 'skipped' | 'uncertain'

export interface TaskCallback {
  /** 完成后是否要唤醒发起会话。 */
  notify: boolean
  /** 发起会话（DSH session id）；为空则无法唤醒。 */
  sessionId: string
  /** 派发时记录的续办提示（仅供上下文参考）。 */
  instruction: string
  status: CallbackStatus
  receipt?: string
  error?: string
  deliveredAt?: number
  /**
   * **稳定回执 ID**（outbox 持久化后生成；收件端按它去重）。
   * 旧账本没有本字段 —— 只读兼容，不补投。
   */
  receiptId?: string
}

/**
 * 迟到结算证据的**只读视图**（R9）：宽限期后执行器迟到返回的实际结果。
 * 保存在 `<tasksDir>/<taskId>.late-settlement.json`；status()/result() 发现即附加。
 * 内容保存时已经 `redactResult` 脱敏；`original_uncertain` 关联不确定快照。
 * 命名对齐 TaskView 顶层惯例（snake_case；native 子对象与 actual 一致用 camel）。
 */
export interface LateSettlementView {
  readonly version: 1
  readonly task_id: string
  readonly run_id: string
  readonly logical_id: string
  /** 迟到结算收取时间。 */
  readonly received_at: number
  readonly stop_reason: string
  readonly text: string
  readonly transport?: string
  readonly diagnostic?: string
  readonly native?: { readonly sessionId?: string, readonly requestId?: string, readonly runState?: string, readonly protocol?: string, readonly sessionMode?: string }
  readonly facts?: Record<string, string | number | boolean | undefined>
  /** 原不确定快照（保留历史，不自动改成功）。 */
  readonly original_uncertain: { readonly status: string, readonly diagnostic: string, readonly at: number }
}

/** 对外（工具 / HTTP / 回执）的任务视图。 */
export interface TaskView {
  task_id: string
  /** 这本账里的两类东西（见 TaskKind）。 */
  kind: TaskKind
  target: string
  model: string | null
  cwd: string
  transport?: string
  status: TaskStatus
  created_at: number
  updated_at: number
  elapsed_ms: number
  log_path: string
  result_path: string
  output_chars: number
  progress_available: boolean
  diagnostic: string | null
  callback: TaskCallback | null
  /** 本次任务**实际**使用的账号 / 供应商 / 模型（身份来自通道回报，不是配置值）。 */
  actual?: { readonly accountId?: string, readonly provider?: string, readonly model?: string, readonly harnessId?: string, readonly nativeSessionId?: string, readonly transport?: string }
  /** Frozen request, independent of execution receipts. */
  requested?: Readonly<NonNullable<DispatchSpec['identity']>>
  /** Old ledgers without this marker cannot establish provider/model provenance. */
  actualSource?: 'transport-outcome' | 'legacy-unverified'
  /** 请求值与实际值的偏差；非空必须显示。 */
  mismatch?: readonly string[]
  /**
   * **迟到结算证据**（R9；可选，只读）。
   *
   * 宽限期后执行器迟到返回时，任务结果视图保留不确定快照原样（不自动改成功）；
   * 实际正文/原生与请求 ID/终态/退出事实经此字段可查询，并与 `original_uncertain`
   * 快照关联。内容在**保存时**已过 `redactResult` 脱敏出口；重开 TaskManager 仍可读。
   */
  late_settlement?: LateSettlementView
  /**
   * **持久逻辑会话**绑定（可选；只有带 session 派发的任务才有）。
   * `nativeSessionId` 是厂商原生 ID；`idle` 状态 = 进程可释放、会话可恢复（**不是丢失**）。
   * accountId 已在 store 出口脱敏（本视图只带脱敏标签）。
   */
  session?: {
    readonly logicalId: string
    readonly nativeSessionId?: string
    readonly resumeKind?: string
    readonly status?: string
    readonly account?: string
  }
}

export interface TaskResult {
  stopReason: string
  text: string
  transport?: TransportKind
  diagnostic?: string
  facts?: Record<string, string | number | boolean | undefined>
}

export interface StartTaskInput {
  target: TargetConfig
  prompt: string
  cwd: string
  timeoutMs: number
  model?: string
  extraArgs?: readonly string[]
  transport?: TransportKind
  /**
   * 本次任务**请求**的执行身份（账号 / 供应商 / 模型）。
   * 单独冻结在 requested 并透传给 DispatchSpec；不能用请求供应商/模型充当实际回报。
   */
  identity?: { readonly accountId?: string, readonly provider?: string, readonly model?: string, readonly harnessId?: string }
  /**
   * **持久逻辑会话**（可选；P1/P3；R2 收紧绑定）。
   *   · `{ logicalId }` —— 继续该逻辑会话：**cwd/账号继承创建时冻结的绑定**
     *   （`session.cwd` 可显式携带，但必须与冻结值一致，否则在任何执行前拒绝）；
   *   · `{}`（logicalId 缺省）—— 新建逻辑会话（要求目标声明 nativeCli 能力）。
   * 省略整个字段 = 一次性短任务（与旧行为完全一致）。
   */
  session?: { readonly logicalId?: string, readonly cwd?: string }
  callback: Omit<TaskCallback, 'status'>
}

/** 登记一个**外部驱动**的 run（内部子代理 provider 用）。 */
export interface TrackInput {
  kind: TaskKind
  target: TargetConfig
  prompt: string
  cwd: string
  model?: string
  identity?: Readonly<NonNullable<DispatchSpec['identity']>>
  /**
   * 发起会话（用于停滞回执）。留空 = 只记账、不投递 ——
   * 内部子代理的调用方本来就在 await 结果，再回执一次就是重复唤醒。
   */
  callback?: Omit<TaskCallback, 'status'>
  /** 超过这么久既无进度也无终态就标记 `stalled`；0/未给 = 不探测。 */
  stallTimeoutMs?: number
}

/** `track()` 返回的句柄：调用方把 run 的进展喂回来。 */
export interface TrackedRun {
  readonly id: string
  readonly view: TaskView
  /** 追加一段过程输出（同时刷新停滞计时，并把 stalled 收回 running）。 */
  progress(chunk: string): void
  /** run 结束（含非 completed 的 stopReason）。 */
  finish(outcome: DispatchOutcome): void
  /** run 抛错。 */
  fail(error: Error): void
}

export interface TaskManagerDeps {
  /** 任务三件套的落盘目录。 */
  directory: string
  /** 真正执行派发（接 SessionRegistry.dispatch）。 */
  dispatch: (spec: DispatchSpec, options?: { transport?: string }) => Promise<DispatchOutcome>
  maxConcurrent: number
  /**
   * 终态回执：把交付内容送回发起会话并唤醒它。
   * 返回送达回执说明；抛错时按 deliveryUncertain / explicitRejection 决定 `failed` 还是 `uncertain`。
   */
  onComplete?: (view: TaskView, callback: TaskCallback, result: TaskResult | null) => Promise<string>
  /**
   * **全局**回执开关（运行时设置 `notifyOnComplete`）。
   *
   * 为什么需要它：这个设置此前被定义、被设置页渲染、被落盘、被读回，却**没有任何代码读它**
   * 做判定 —— 用户关掉「完成后唤醒会话」照样被唤醒（死设置）。判定落在 `deliver()` 这**唯一**
   * 的投递出口，所以 run()/settle()/armStallWatch() 三条完成路径一起受约束，不会出现
   * 「只改了一条路径」的老毛病。
   *
   * 语义：这是**总闸**，不是每任务 `notify` 的默认值 —— 关掉后即使某个任务显式写
   * `notify: true` 也不投递（否则调用方显式传 true 就能绕开用户的全局选择）；
   * 未挂载（离线探针 / 旧组合）时视为开启，保持向后兼容。
   *
   * 在**投递那一刻**读取（不是派发时快照）：设置页改完对在跑的任务也立即生效。
   */
  notifyEnabled?: () => boolean
  /**
   * **持久原生会话层**（可选；P1/P3 接线）。缺省 = 带 session 的派发显式拒绝
   * （不假装支持），一次性短任务完全不受影响。
   */
  nativeSessions?: { readonly store: NativeSessionStore, readonly mutex: SessionMutex }
  /**
   * **回执 outbox**（可选；P4 接线）。挂载后终态回执先落盘（queued）再投递；
   * 缺省 = 沿用旧行为（直接投递、不落 outbox），旧组合不受影响。
   */
  outbox?: ReceiptOutbox
  /**
   * R7：执行阶段取消/超时后，等待执行器确认终态的宽限期（毫秒）。
   * 逾期仍未确认 ⇒ 任务按「取消待确认/状态不确定」记账（不报 never executed）。
   * 缺省 15000；夹紧 [50, 60000]。
   */
  sessionSettleGraceMs?: number
  log?: (message: string) => void
}

interface LiveTask {
  id: string
  kind: TaskKind
  target: string
  model: string | null
  cwd: string
  transport?: string
  /**
   * 本次任务**实际**使用的身份（账号 / 供应商 / 模型 / 原生会话 id），由通道回报。
   * 与 `target` / `model`（**请求值**）分开保存 —— 配置值与实际值必须能分辨，
   * 这正是「每个任务固定记录实际使用的账号、供应商和模型」的落点。
   */
  identity?: { readonly accountId?: string, readonly provider?: string, readonly model?: string, readonly harnessId?: string, readonly nativeSessionId?: string, readonly transport?: string }
  requested?: Readonly<NonNullable<DispatchSpec['identity']>>
  actualSource?: 'transport-outcome'
  /** 请求值与实际值的偏差；非空必须显示，不得静默算成功。 */
  mismatch?: readonly string[]
  status: TaskStatus
  createdAt: number
  updatedAt: number
  outputChars: number
  diagnostic?: string
  controller: AbortController
  callback: TaskCallback | null
  promise?: Promise<void>
  result: TaskResult | null
  /** 停滞探测定时器（只有 track() 的 run 会挂）。 */
  stallTimer?: NodeJS.Timeout
  /** 持久逻辑会话绑定（start 时冻结；run 结束后回填原生 ID）。 */
  session?: {
    logicalId: string
    nativeSessionId?: string
    resumeKind?: string
    status?: string
    account?: string
  }
  /** 回执序号（同任务多次终态通知各自有稳定 ID；outbox 去重的依据）。 */
  receiptSeq: number
}

type TaskIdentity = NonNullable<TaskView['actual']>

// ── 出口脱敏：TaskView 的**唯一**收敛点（服务端视图层） ─────────────────
// 为什么放在这里，而不是各个渲染点：
//   工具面（`harness_task_*`）此前**各自**脱敏，HTTP 出口（`/api/tasks`、`/api/task?id=`、
//   `/api/overview` 内嵌的 tasks）却一个都没脱 —— 实测 `GET /api/tasks` 原样回吐
//   `actual.accountId`（10 条记录、2 个账号档案）。同一个字段在一条出口上是 `acct:…`、
//   在另一条上是原始 id，**比两条都泄漏更糟**：你会以为它已经安全了。
//   所以脱敏落在 TaskView 的构造/读取出口 —— `view()`（内存路径）与 `status()` 的落盘重建
//   路径，其余出口（list / progress / result / cancel / wait / 回执投递 / save 落盘）全部
//   从这两条路派生，不会漏。
//
// 两件不同的事，别混：
//   ① **账号字段**（`actual.accountId`）：换成账号池同一套 `redactAccount` 标签
//      （`acct:…<尾2位><长度36进制>`：不可反推，且同一账号在设定页/详情页**稳定相同**）。
//   ② **自由文本**（diagnostic / mismatch / 回执文案 / 路径 / 进程输出）：用工具面同一套
//      **整词**替换 `redactAccountIdsInText` —— 不另造第二套边界。
//      ⚠️ 必须整词：本机真实存在「目标名以档案 id 为前缀」（`qoder-cn-acct-a` / `qoder-cn-app`），
//      子串替换会把目标名改成 `acct:…cct-a` 这种四不像 = 篡改执行身份，比不脱敏更糟。

/**
 * 单个账号 id → 脱敏标签（复用账号池的 `redactAccount`，不另造一套）。
 *
 * **幂等**：已经是 `acct:…` 形式就原样返回。为什么要这一步 —— 落盘/回读会让脱敏值
 * **二次进入**这个函数（`status()` 读回 `save()` 写下的视图），而 `redactAccount` 不是
 * 幂等的（`acct:…-af` → `acct:…f9`）：同一账号会得到两个不同标签，设定页与任务详情就对不上号了。
 */
function redactAccountLabel(accountId: string | undefined): string | undefined {
  if (accountId === undefined) return undefined
  const trimmed = accountId.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.startsWith('acct:') ? trimmed : redactAccount(trimmed)
}

/** 自由文本：整词脱掉已知档案 id（与工具面同一套边界、同一个实现）。 */
const scrubText = (text: string): string => redactAccountIdsInText(text)

/** 实际身份：**原始 id 不得穿过这里**（未回报的字段保持「未回报」，绝不凭空造值）。 */
function redactIdentity(identity: TaskIdentity): TaskIdentity {
  const { accountId: raw, ...rest } = identity
  const label = redactAccountLabel(raw)
  const scrubbed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    scrubbed[key] = typeof value === 'string' ? scrubText(value) : value
  }
  if (label !== undefined) scrubbed.accountId = label
  return scrubbed as TaskIdentity
}

/**
 * TaskView 的**唯一**脱敏出口（纯函数：不改入参、不做 I/O）。
 * 任何返回 TaskView 的路径都必须经过它 —— 含**落盘 .json 的读取路径**：
 * 本改动之前写下的历史记录里可能还是原始 id，出口不能因为「盘上是旧的」就把它放出去。
 */
export function redactTaskView(view: TaskView): TaskView {
  const actual = view.actual === undefined ? undefined : redactIdentity(view.actualSource === 'transport-outcome'
    ? view.actual : { ...view.actual, provider: undefined, model: undefined })
  const requested = view.requested === undefined ? undefined : redactIdentity(view.requested)
  const source = view.callback
  const callback: TaskCallback | null = source === null
    ? null
    : {
        ...source,
        instruction: scrubText(source.instruction),
        ...(source.receipt === undefined ? {} : { receipt: scrubText(source.receipt) }),
        ...(source.error === undefined ? {} : { error: scrubText(source.error) }),
      }
  const mismatch = view.mismatch ?? []
  return {
    ...view,
    cwd: scrubText(view.cwd),
    ...(view.transport === undefined ? {} : { transport: scrubText(view.transport) }),
    log_path: scrubText(view.log_path),
    result_path: scrubText(view.result_path),
    ...(view.diagnostic === null ? {} : { diagnostic: scrubText(view.diagnostic) }),
    callback,
    ...(actual === undefined ? {} : { actual, actualSource: view.actualSource ?? 'legacy-unverified' }),
    ...(requested === undefined ? {} : { requested }),
    ...(mismatch.length === 0 ? {} : { mismatch: mismatch.map(scrubText) }),
  }
}

/** 终态结果里的自由文本（进程输出）：出口同样整词脱敏。 */
function redactResult(result: TaskResult | null): TaskResult | null {
  if (result === null) return null
  const facts = result.facts
  return {
    ...result,
    text: scrubText(result.text),
    ...(result.diagnostic === undefined ? {} : { diagnostic: scrubText(result.diagnostic) }),
    ...(facts === undefined
      ? {}
      : { facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, typeof v === 'string' ? scrubText(v) : v])) }),
  }
}

/** R2：绑定目录一致性（resolve 规范化后比较；Windows 大小写不敏感）。导出供测试复用。 */
export function sameBindingPath(left: string, right: string): boolean {
  try {
    const a = resolve(left.trim())
    const b = resolve(right.trim())
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return left.trim() === right.trim()
  }
}

/**
 * R1：排队等待会话互斥期间被取消/超时打断（区别于锁内执行错误）。
 * 语义：本轮**从未执行**（未 spawn、未使用任何恢复参数），终态按取消/超时如实记账。
 */
class SessionWaitInterruptedError extends Error {
  constructor(readonly kind: 'cancelled' | 'timeout') {
    super(kind === 'timeout'
      ? 'queued behind the session mutex and the task deadline hit before the previous turn released it — this turn never executed'
      : 'cancelled while queued behind the session mutex — this turn never executed')
  }
}

/**
 * R7：取消/超时发生在**已取得锁的执行阶段**，但执行器在宽限期内未确认终态。
 * 语义：本轮**确实执行过**（不能报 never executed）；取消已受理但结果不确定 ——
 * 执行器若稍后返回，其锁内结算会写 store（真实事实），任务结果视图按不确定提前记账。
 */
class SessionSettleUncertainError extends Error {
  constructor(readonly kind: 'cancelled' | 'timeout', graceMs: number) {
    super(kind === 'timeout'
      ? `task deadline hit during execution; the executor did not confirm a terminal state within the ${graceMs}ms settle grace — cancellation outcome UNCERTAIN（不排除执行器仍在产出；其迟到结算会写入会话 store，但不改写本任务结果）`
      : `cancellation acknowledged during execution, but the executor did not confirm a terminal state within the ${graceMs}ms settle grace — cancellation outcome UNCERTAIN（不排除执行器仍在产出；其迟到结算会写入会话 store，但不改写本任务结果）`)
  }
}

/**
 * R1/R2/R8：会话轮次的**核验 + 回填 + 终态落 store**（锁内调用；唯一实现）。
 *
 * R2 的关键语义：恢复轮回报的原生 ID 与原记录不同（或没回报）⇒ **保留原 ID**、
 * 标 `recovery_needed`、补 mismatch —— 绝不用错误返回值覆盖原记录。
 * R8 的关键语义：收敛**返回的 outcome** 与保护状态一致 —— 任务 stopReason 失败、
 * `native.runState=recovery_needed`；错会话正文**不作为成功交付**（text 清空，
 * 原文降级为明确标注的诊断节选 + 任务 .log 全文留档），不抹掉事实。
 */
function settleSessionTurn(
  native: { readonly store: NativeSessionStore },
  logicalId: string,
  nativeRef: NativeSessionRef,
  outcome: DispatchOutcome,
  resumeKindForNewTurns?: NativeSessionRecord['resumeKind'],
  ownerRunId?: string,
  appendLog?: (chunk: string) => void,
): DispatchOutcome {
  const attemptedResume = nativeRef.nativeSessionId !== undefined && nativeRef.nativeSessionId.length > 0
  const originalId = nativeRef.nativeSessionId
  const reported = outcome.native?.sessionId ?? outcome.identity?.nativeSessionId ?? undefined
  let runState: NativeRunState = outcome.native?.runState
    ?? (outcome.stopReason === 'completed' ? 'completed' : outcome.stopReason === 'aborted' ? 'cancelled' : 'failed')
  if (runState === 'completed' && outcome.stopReason !== 'completed') runState = 'failed'
  const mismatch: string[] = [...(outcome.mismatch ?? [])]
  let recoveryNeeded = runState === 'recovery_needed'
  if (attemptedResume && reported !== originalId) {
    recoveryNeeded = true
    mismatch.push(`原生会话恢复未确认：请求恢复 ${originalId}，本轮回报 ${reported ?? '(无)'}；**保留原 ID** 并标 recovery_needed（不覆盖、不静默新建）`)
  }
  const idToStore = recoveryNeeded ? undefined : reported
  native.store.recordNative(logicalId, {
    ...(idToStore !== undefined && idToStore.length > 0 ? { nativeSessionId: idToStore } : {}),
    ...(outcome.native?.requestId === undefined ? {} : { requestId: outcome.native.requestId }),
    ...(!attemptedResume && resumeKindForNewTurns !== undefined ? { resumeKind: resumeKindForNewTurns } : {}),
    ...(outcome.native?.protocol === undefined ? {} : { protocol: outcome.native.protocol }),
  })
  native.store.finishRun(logicalId, {
    runState: recoveryNeeded ? 'recovery_needed' : runState,
    ...(outcome.diagnostic === undefined ? {} : { recoveryError: outcome.diagnostic }),
  }, ownerRunId)
  if (!recoveryNeeded) return outcome
  // ── R8：收敛返回值，与保护状态一致（任务/结果/存储三方不能互相矛盾）──
  const rawText = outcome.text
  if (rawText.trim().length > 0 && appendLog !== undefined) {
    // 事实不抹掉：错会话原文全文留在任务 .log（标注块），供取证。
    try {
      appendLog(`\n----- 恢复未确认：以下正文来自**未经确认的会话轮**（请求恢复 ${originalId}，回报 ${reported ?? '(无)'}），不作为原会话交付 -----\n${rawText}\n----- 恢复未确认正文结束 -----\n`)
    } catch { /* 日志写失败不影响收敛 */ }
  }
  const convergedDiagnostic = [
    `⚠️ 原生会话恢复未确认（请求恢复 ${originalId}，本轮回报 ${reported ?? '(无)'}）：本轮按失败处理，store 已标 recovery_needed。`,
    ...(outcome.diagnostic === undefined ? [] : [`执行诊断：${outcome.diagnostic}`]),
    ...(rawText.trim().length > 0
      ? [`错会话正文（节选 ${Math.min(rawText.length, 2000)}/${rawText.length} 字符，全文在任务日志）：${rawText.slice(0, 2000)}`]
      : []),
  ].join('；')
  return {
    ...outcome,
    // aborted 的轮保持 aborted（取消语义优先）；其余一律收敛为失败。
    stopReason: outcome.stopReason === 'aborted' ? 'aborted' : 'error',
    text: '',
    native: { ...outcome.native, runState: 'recovery_needed' },
    diagnostic: convergedDiagnostic,
    mismatch,
  }
}

export class TaskManager {
  private readonly directory: string
  private readonly dispatch: TaskManagerDeps['dispatch']
  private readonly onComplete: TaskManagerDeps['onComplete']
  private readonly notifyEnabled: TaskManagerDeps['notifyEnabled']
  private readonly nativeSessions: TaskManagerDeps['nativeSessions']
  private readonly outbox: TaskManagerDeps['outbox']
  private readonly sessionSettleGraceMs: number
  private readonly log: (message: string) => void
  private readonly tasks = new Map<string, LiveTask>()
  private readonly events = new EventEmitter()
  private maxConcurrent: number

  constructor(deps: TaskManagerDeps) {
    this.directory = deps.directory
    this.dispatch = deps.dispatch
    this.onComplete = deps.onComplete
    this.notifyEnabled = deps.notifyEnabled
    this.nativeSessions = deps.nativeSessions
    this.outbox = deps.outbox
    this.sessionSettleGraceMs = Math.min(60_000, Math.max(50, Math.round(deps.sessionSettleGraceMs ?? 15_000)))
    this.maxConcurrent = Math.max(0, Math.round(deps.maxConcurrent))
    this.log = deps.log ?? (() => {})
    this.events.setMaxListeners(64)
    mkdirSync(this.directory, { recursive: true })
  }

  setMaxConcurrent(value: number): void {
    this.maxConcurrent = Math.max(0, Math.round(value))
  }

  path(id: string, suffix: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid task_id')
    return join(this.directory, id + suffix)
  }

  private save(task: LiveTask): void {
    writeFileSync(this.path(task.id, '.json'), JSON.stringify(this.view(task), null, 2), { encoding: 'utf8' })
  }

  private view(task: LiveTask): TaskView {
    // ⚠️ 出口在此收敛：内存路径的**所有** TaskView（start / track / status / cancel /
    // 回执投递 onComplete / save 落盘）都由这一个 return 产出，脱敏只可能有一处、也只可能生效一处。
    return redactTaskView({
      task_id: task.id,
      kind: task.kind,
      target: task.target,
      model: task.model,
      cwd: task.cwd,
      ...(task.transport === undefined ? {} : { transport: task.transport }),
      status: task.status,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      elapsed_ms: (TERMINAL.has(task.status) ? task.updatedAt : Date.now()) - task.createdAt,
      log_path: this.path(task.id, '.log'),
      result_path: this.path(task.id, '.result.json'),
      output_chars: task.outputChars,
      progress_available: task.outputChars > 0,
      diagnostic: task.diagnostic ?? null,
      callback: task.callback,
      // 实际身份与偏差：任务**固定记录**，界面/工具据此显示「真的用了哪个账号和模型」。
      ...(task.identity === undefined ? {} : { actual: task.identity, actualSource: task.actualSource }),
      ...(task.requested === undefined ? {} : { requested: task.requested }),
      ...((task.mismatch ?? []).length === 0 ? {} : { mismatch: task.mismatch }),
      ...(task.session === undefined ? {} : { session: task.session }),
    })
  }

  /** 立即返回任务视图；真正的派发在后台跑，终态触发回执。 */
  start(input: StartTaskInput): TaskView {
    const running = [...this.tasks.values()].filter(task => !TERMINAL.has(task.status)).length
    if (this.maxConcurrent > 0 && running >= this.maxConcurrent) {
      throw new Error(`harness task concurrency limit reached (${this.maxConcurrent}); wait or harness_task_cancel`)
    }
    // ── 持久逻辑会话（P1/P3；R2 收紧绑定）：在任何副作用之前同步校验/创建；拒绝就不建任务 ──
    // 与模型引用校验同一纪律：注定失败的 run 不进账本。
    let sessionRecord: NativeSessionRecord | undefined
    let sessionEffectiveCwd: string | undefined
    if (input.session !== undefined) {
      if (this.nativeSessions === undefined) {
        throw new Error('persistent native sessions are not wired in this composition; omit "session" for a one-shot task')
      }
      if (input.target.nativeCli === undefined) {
        throw new Error(`target "${input.target.name}" does not declare a nativeCli protocol capability — persistent sessions are not available for it（不冒充：桌面入口/旧 text CLI 不假装支持原生恢复）`)
      }
      const wanted = input.session.logicalId
      if (wanted !== undefined && wanted.length > 0) {
        const record = this.nativeSessions.store.get(wanted)
        if (record === undefined) {
          const known = this.nativeSessions.store.list().slice(0, 8).map(row => `${row.logicalId}(${row.target},${row.status})`).join(', ')
          throw new Error(`unknown logical session "${wanted}"${known.length > 0 ? `; known: ${known}` : ''}（恢复失败不静默新建——请先用 harness_sessions 核对 ID）`)
        }
        if (record.target !== input.target.name) {
          throw new Error(`logical session "${wanted}" belongs to target "${record.target}", not "${input.target.name}"（跨产品会话复用被显式拒绝）`)
        }
        if (record.status === 'closed') throw new Error(`logical session "${wanted}" is closed`)
        if (record.status === 'recovery_needed') {
          throw new Error(`logical session "${wanted}" is marked recovery_needed（上次恢复失败：${record.lastRecoveryError ?? '未记录'}）；请先显式处理（人工接管或新建会话），不要盲目重试`)
        }
        // ── R2：绑定核验（cwd / 账号 / 目标配方的烘焙账号）──
        // 「同一个 target 名」不等于「同一个绑定」：原生转录按 cwd 归档、账号决定档案目录，
        // 二者都必须与创建时冻结的值一致（省略 = 继承；显式不一致 = 执行前拒绝）。
        if (input.session.cwd !== undefined && input.session.cwd.length > 0 && !sameBindingPath(input.session.cwd, record.cwd)) {
          throw new Error(`logical session "${wanted}" is bound to cwd "${record.cwd}"; refusing "${input.session.cwd}"（原生转录按工作目录归档——目录不同就不是同一个会话；如需新目录请新建会话）`)
        }
        // ── R2：目标配方（烘焙账号/档案目录）绑定核验 ──
        // accountRef 的三种状态：undefined = v1 时代记录（首次续接一次性采纳）；
        // '' = 创建时确认过「该目标无烘焙账号」；非空 = 创建时冻结的绑定键。
        // 「创建时没有」≠「没检查」：续接时目标突然带出烘焙账号 = 配方被改 ⇒ 拒绝。
        const bakedNow = bakedAccountRefOf(input.target)
        const bakedKeyNow = bakedNow === undefined ? '' : bakedAccountRefKey(bakedNow)
        if (record.accountRef === undefined) {
          if (bakedNow !== undefined) this.nativeSessions.store.adoptAccountRef(wanted, bakedKeyNow)
        } else if (record.accountRef !== bakedKeyNow) {
          throw new Error(`target recipe changed since session "${wanted}" was created（创建时绑定=${record.accountRef === '' ? '(无烘焙账号)' : record.accountRef}，现在=${bakedKeyNow === '' ? '(无烘焙账号)' : bakedKeyNow}）：产品/档案目录绑定被改动，本轮显式拒绝（不猜哪份配方生效）`)
        }
        const explicitAccount = input.identity?.accountId
        if (explicitAccount !== undefined && record.accountId !== undefined && explicitAccount !== record.accountId) {
          throw new Error(`logical session "${wanted}" is bound to account ${redactAccount(record.accountId)}; refusing explicit ${redactAccount(explicitAccount)}（跨账号复用会读错档案/串额度——显式拒绝，不静默改身份）`)
        }
        if (explicitAccount !== undefined && record.accountId === undefined) {
          throw new Error(`logical session "${wanted}" was created without an explicit account; passing ${redactAccount(explicitAccount)} now is a binding change — create a new session instead`)
        }
        sessionRecord = record
      } else {
        sessionRecord = this.nativeSessions.store.create({
          target: input.target.name,
          cwd: input.cwd,
          ...(input.identity?.accountId === undefined ? {} : { accountId: input.identity.accountId }),
          protocol: input.target.nativeCli.protocol,
          resumeKind: input.target.nativeCli.newSessionArgs.length === 0 ? 'mint-on-first-turn' : 'native-id',
          // R2：创建时**总是**冻结目标配方绑定键（无烘焙账号 = 空串，表示「检查过且没有」；
          // undefined 只留给 v1 历史记录，首次续接时一次性采纳）。
          accountRef: (() => {
            const baked = bakedAccountRefOf(input.target)
            return baked === undefined ? '' : bakedAccountRefKey(baked)
          })(),
        })
      }
      // 会话轮次的**有效 cwd = 冻结绑定**（继承；原生转录同目录约束）。accountRef 采纳的
      // 写盘在 adoptAccountRef 内完成；record 的内存值这里同步读一次最新。
      if (sessionRecord !== undefined) {
        const refreshed = this.nativeSessions.store.get(sessionRecord.logicalId)
        if (refreshed !== undefined) sessionRecord = refreshed
        sessionEffectiveCwd = sessionRecord.cwd
      }
    }
    // 会话任务的账本 cwd 用**有效 cwd**（冻结绑定），否则视图会把「打算用的目录」误报成绑定目录。
    const effectiveCwd = sessionEffectiveCwd ?? input.cwd
    if (!isAbsolute(effectiveCwd) || !existsSync(effectiveCwd) || !statSync(effectiveCwd).isDirectory()) {
      throw new Error('cwd must be an existing absolute directory')
    }
    const task: LiveTask = {
      id: randomUUID(),
      kind: 'task',
      target: input.target.name,
      model: input.model ?? null,
      requested: Object.freeze({ harnessId: input.target.name, ...input.identity,
        ...((input.identity?.model ?? input.model) === undefined ? {} : { model: input.identity?.model ?? input.model }) }),
      cwd: effectiveCwd,
      ...(input.transport === undefined ? {} : { transport: input.transport }),
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      outputChars: 0,
      controller: new AbortController(),
      callback: { ...input.callback, status: 'pending' },
      result: null,
      receiptSeq: 0,
      ...(sessionRecord === undefined
        ? {}
        : { session: {
          logicalId: sessionRecord.logicalId,
          ...(sessionRecord.nativeSessionId === undefined ? {} : { nativeSessionId: sessionRecord.nativeSessionId }),
          resumeKind: sessionRecord.resumeKind,
          status: sessionRecord.status,
          ...(sessionRecord.accountId === undefined ? {} : { account: redactAccount(sessionRecord.accountId) }),
        } }),
    }
    this.tasks.set(task.id, task)
    writeFileSync(this.path(task.id, '.log'), '', { encoding: 'utf8' })
    this.save(task)
    // start 的返回不等派发；这个 promise 由 TaskManager 持有，终态时自己收尾。
    task.promise = this.run(task, input, sessionRecord)
    return this.view(task)
  }

  /**
   * 登记一个**外部驱动**的 run 并返回句柄。
   *
   * 为什么复用 TaskManager 而不是另造一套：三件套落盘、TaskStatus 状态机、
   * `callback.status` 记账、以及重启后把未完成 run 降级成 `interrupted`（见 `status()`）
   * 这里都已经有了。再造一份只会让"该去哪查状态"变成两个答案。
   */
  track(input: TrackInput): TrackedRun {
    const task: LiveTask = {
      id: randomUUID(),
      kind: input.kind,
      target: input.target.name,
      model: input.model ?? null,
      requested: Object.freeze({ harnessId: input.target.name, ...input.identity,
        ...((input.identity?.model ?? input.model) === undefined ? {} : { model: input.identity?.model ?? input.model }) }),
      cwd: input.cwd,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      outputChars: 0,
      controller: new AbortController(),
      callback: input.callback === undefined ? null : { ...input.callback, status: 'pending' },
      result: null,
      receiptSeq: 0,
    }
    this.tasks.set(task.id, task)
    try { writeFileSync(this.path(task.id, '.log'), '', { encoding: 'utf8' }) } catch { /* 落盘失败不挡登记 */ }
    this.save(task)
    this.armStallWatch(task, input.stallTimeoutMs ?? 0)

    const settle = (): void => {
      if (task.stallTimer !== undefined) {
        clearInterval(task.stallTimer)
        task.stallTimer = undefined
      }
      task.updatedAt = Date.now()
      // 终态**必落盘**（失败也写）：磁盘上什么都没有，正是"只能靠产物缺席发现"的根源。
      try {
        writeFileSync(this.path(task.id, '.result.json'), JSON.stringify(task.result, null, 2), { encoding: 'utf8' })
      } catch { /* 结果文件写失败不挡查询 */ }
      this.save(task)
      this.events.emit(task.id)
      void this.deliver(task)
    }

    return {
      id: task.id,
      view: this.view(task),
      progress: (chunk: string) => {
        if (TERMINAL.has(task.status)) return
        try { appendFileSync(this.path(task.id, '.log'), chunk, { encoding: 'utf8' }) } catch { /* 落盘失败不影响派发 */ }
        task.outputChars += chunk.length
        task.updatedAt = Date.now()
        // 有进展就说明没卡死：把 stalled 收回 running。
        if (task.status === 'stalled') {
          task.status = 'running'
          task.diagnostic = undefined
        }
        this.events.emit(task.id)
      },
      finish: (outcome: DispatchOutcome) => {
        task.transport = outcome.transport
        // 任务**固定记录**实际使用的账号/供应商/模型 + 偏差 —— 配置值与实际值必须能分辨。
        if (outcome.identity !== undefined) { task.identity = Object.freeze({ ...outcome.identity }); task.actualSource = 'transport-outcome' }
        task.mismatch = Object.freeze([...(outcome.mismatch ?? [])])
        if (outcome.stopReason === 'completed' && outcome.text.trim().length === 0) {
          task.status = 'error'
          task.diagnostic = 'harness returned no result'
        } else {
          task.status = outcome.stopReason
          task.diagnostic = outcome.diagnostic
        }
        task.result = {
          stopReason: task.status,
          text: outcome.text,
          transport: outcome.transport,
          ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
          ...(outcome.facts === undefined ? {} : { facts: outcome.facts }),
        }
        settle()
      },
      fail: (error: Error) => {
        task.status = task.controller.signal.aborted ? 'aborted' : 'error'
        task.diagnostic = error.message
        task.result = { stopReason: task.status, text: '', diagnostic: task.diagnostic }
        settle()
      },
    }
  }

  /**
   * 停滞探测：run 超过 timeoutMs 既无进度也无终态 → 标记 `stalled` 并按需回执。
   *
   * 以前卡住的 run 会永远显示 `running`，用户只能靠"预期产物不存在"反推。
   * `stalled` **不是**终态：真有输出回来时 `progress()` 会把它收回 `running`。
   */
  private armStallWatch(task: LiveTask, timeoutMs: number): void {
    if (!(timeoutMs > 0)) return
    const timer = setInterval(() => {
      if (TERMINAL.has(task.status) || task.status === 'stalled') return
      const idle = Date.now() - task.updatedAt
      if (idle < timeoutMs) return
      task.status = 'stalled'
      task.diagnostic = `no output for ${Math.round(idle / 1000)}s (stall timeout ${Math.round(timeoutMs / 1000)}s) — the run may be hung`
      this.save(task)
      this.events.emit(task.id)
      void this.deliver(task)
    }, Math.max(1000, Math.min(timeoutMs, 15_000)))
    timer.unref?.()
    task.stallTimer = timer
  }

  private async run(task: LiveTask, input: StartTaskInput, sessionRecord?: NativeSessionRecord): Promise<void> {
    let result: DispatchOutcome | null = null
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      task.controller.abort()
    }, Math.max(1000, input.timeoutMs))
    const native = sessionRecord === undefined ? undefined : this.nativeSessions
    // 派发规格骨架；会话轮次在**锁内**补 nativeSession（最新原生 ID）/有效 cwd/继承账号。
    const baseSpec = (cwd: string, nativeSession?: NativeSessionRef, identity?: DispatchSpec['identity']): DispatchSpec => ({
      target: input.target,
      prompt: input.prompt,
      cwd,
      signal: task.controller.signal,
      timeoutMs: input.timeoutMs,
      ...(input.model === undefined ? {} : { model: input.model }),
      // 把请求身份透传进派发 —— 否则「按账号执行」成立，但 actual 里永远不会出现 accountId。
      ...(identity === undefined ? {} : { identity }),
      ...(input.extraArgs === undefined ? {} : { extraArgs: input.extraArgs }),
      ...(nativeSession === undefined ? {} : { nativeSession }),
      onProgress: (chunk: string) => {
        try {
          appendFileSync(this.path(task.id, '.log'), chunk, { encoding: 'utf8' })
        } catch { /* 落盘失败不影响派发 */ }
        task.outputChars += chunk.length
        task.updatedAt = Date.now()
        this.events.emit(task.id)
      },
    })

    /**
     * ── R1（Codex 审查）：会话轮次的**完整事务**放进同一个互斥临界区 ──
     *
     * 修复前：nativeRef 在取锁前生成 —— 首轮未完成时排队的第二轮捕获「没有原生 ID」的
     * 过期引用，首轮回填后第二轮仍按 new 启动（反例复现：store 被第二轮的 mint 覆盖）。
     * 现在：取得锁之后**重新读 store**、复核状态/绑定/取消，再 beginRun、构建引用、
     * dispatch、核验原生 ID、回填并提交终态，**最后**才释放锁。排队轮拿到的恢复参数
     * 一定是前轮刚落盘的最新值。
     *
     * 等待期间取消/超时**不必**等前轮释放：仅覆盖 waiting 阶段的竞速，谁先到终态谁赢；
     * 取得锁后监听移除、竞速退场（R7）——执行中的取消/超时由执行器路径带回真实结果
     * 并在锁内结算；执行器逾期不响应时按宽限期记「取消待确认/不确定」。
     */
    const sessionTurn = native !== undefined && sessionRecord !== undefined
      ? async (): Promise<DispatchOutcome> => {
        const logicalId = sessionRecord.logicalId
        // ── R7：轮次生命周期显式分阶段 ──
        //   waiting（未取得锁）：取消/超时打断 ⇒ 本轮从未执行（SessionWaitInterruptedError）；
        //   acquired/executing/settling（取得锁之后）：**移除等待监听、退出竞速**——
        //   取消/超时由执行器自己的取消路径带回真实结果，在锁内结算（保留部分输出、
        //   原生 ID、退出/取消事实）；执行器不响应时进入宽限期，逾期按「取消待确认/
        //   状态不确定」提前记账（SessionSettleUncertainError），**不报 never executed、
        //   不覆盖执行器稍后的锁内结算**。
        let phase: 'waiting' | 'acquired' = 'waiting'
        const inLock = async (): Promise<DispatchOutcome> => {
          // 取得锁：等待阶段的打断路径退场。⚠️ 这里**不移除** abort 监听——fire 仍要在
          // 执行阶段的取消/超时上触发宽限期（R7）；waiting 分支由 phase 守卫禁用。
          phase = 'acquired'
          // ① 锁内重查：取得锁的瞬间已取消 ⇒ 本轮确实从未执行（执行器未进），如实记账。
          if (task.controller.signal.aborted) {
            throw new SessionWaitInterruptedError(timedOut ? 'timeout' : 'cancelled')
          }
          // ② 锁内重读最新记录并复核状态（前轮可能刚把它置成 recovery_needed/closed）。
          //    R6：这里的拒绝**不携带结算权**——本轮从未 beginRun，绝不能在外层改写 store。
          const record = native.store.get(logicalId)
          if (record === undefined) throw new Error(`logical session "${logicalId}" no longer exists（不静默新建）`)
          if (record.status === 'closed') throw new Error(`logical session "${logicalId}" is closed（排队期间被关闭；本轮不执行）`)
          if (record.status === 'recovery_needed') {
            throw new Error(`logical session "${logicalId}" became recovery_needed while this turn was queued（${record.lastRecoveryError ?? '未记录原因'}）；本轮不执行，请先显式处理`)
          }
          // ③ beginRun（= 本轮取得该会话的**结算所有权**）+ 用**最新**原生 ID 构建引用（R1 的核心）。
          native.store.beginRun(logicalId, task.id)
          const nativeRef: NativeSessionRef = {
            logicalId,
            ...(record.nativeSessionId === undefined || record.nativeSessionId.length === 0
              ? {}
              : { nativeSessionId: record.nativeSessionId }),
          }
          task.session = {
            logicalId,
            ...(record.nativeSessionId === undefined ? {} : { nativeSessionId: record.nativeSessionId }),
            resumeKind: record.resumeKind,
            status: 'running',
            ...(record.accountId === undefined ? {} : { account: redactAccount(record.accountId) }),
          }
          this.save(task)
          // ④ dispatch（cwd=冻结绑定；账号=继承绑定）。R6：结算带 owner 校验——
          // 只有 lastRunId 仍是本轮（没被更新的轮接管）才允许写 store。
          const identity: DispatchSpec['identity'] = { ...(task.requested ?? { harnessId: input.target.name }), ...(record.accountId === undefined ? {} : { accountId: record.accountId }) }
          let outcome: DispatchOutcome
          try {
            outcome = await this.dispatch(baseSpec(record.cwd, nativeRef, identity), input.transport === undefined ? {} : { transport: input.transport })
          } catch (error: unknown) {
            // dispatch 抛错也要把 store 从 running 落回（重启恢复语义依赖盘上无残留 running）。
            native.store.finishRun(logicalId, { runState: task.controller.signal.aborted ? 'cancelled' : 'failed' }, task.id)
            throw error
          }
          // ⑤ 核验 + 回填 + 终态落 store（都在锁内；R2：恢复回报不同 ID 时保留原 ID；R8：收敛返回值）。
          return settleSessionTurn(native, logicalId, nativeRef, outcome, record.resumeKind, task.id,
            (chunk) => { try { appendFileSync(this.path(task.id, '.log'), chunk, { encoding: 'utf8' }) } catch { /* 落盘失败不影响收敛 */ } })
        }
        let removeWaitAbortListener: () => void = () => { }
        let graceTimer: NodeJS.Timeout | undefined
        // R9：宽限逾期时武装迟到结算——lockPromise 稍后若带来**真实结果**（fulfilled），
        // 由迟到消费者落盘（原文/原生与请求 ID/终态/事实 + original_uncertain 关联）。
        // waiting 打断与锁内拒绝（reject）不武装：前者无结果、后者从未执行。
        let lateSettlementArmed: { readonly status: string, readonly diagnostic: string, readonly at: number } | undefined
        const waitAbort = new Promise<never>((_, reject) => {
          const fire = (): void => {
            removeWaitAbortListener()
            if (phase === 'waiting') {
              // 等待阶段被打断：本轮从未执行、未 beginRun、不碰 store。
              reject(new SessionWaitInterruptedError(timedOut ? 'timeout' : 'cancelled'))
              return
            }
            // R7：已取得锁/执行中——**不**打断执行路径；给执行器一个宽限期确认终态。
            // 逾期仍未确认 ⇒ 提前按「取消待确认/状态不确定」记账（执行器若稍后返回，
            // 其锁内结算仍会写 store，但不再改写本任务的结果视图）。
            const grace = this.sessionSettleGraceMs
            graceTimer = setTimeout(() => {
              const kind = timedOut ? 'timeout' : 'cancelled'
              lateSettlementArmed = {
                status: kind === 'timeout' ? 'timeout' : 'aborted',
                diagnostic: new SessionSettleUncertainError(kind, grace).message,
                at: Date.now(),
              }
              reject(new SessionSettleUncertainError(kind, grace))
            }, grace)
          }
          if (task.controller.signal.aborted) { fire(); return }
          task.controller.signal.addEventListener('abort', fire, { once: true })
          removeWaitAbortListener = () => { task.controller.signal.removeEventListener('abort', fire) }
        })
        try {
          const lockPromise = native.mutex.runExclusive(logicalId, inLock)
          // 竞速可能输给 waitAbort（等待阶段打断/宽限逾期）；锁内回调稍后仍会跑完
          //（拒绝轮空转、执行轮真实结算），挂 catch 防 unhandled rejection。
          lockPromise.catch(() => { })
          // R9：迟到结算消费者——只有「已武装（宽限逾期）且锁内真的结算出结果」才落盘；
          // 不重跑模型、不触发回执/唤醒，也不改写任务已终态的结果视图。
          lockPromise.then(
            (outcome) => {
              if (lateSettlementArmed !== undefined) {
                this.saveLateSettlement(task, logicalId, task.id, outcome, lateSettlementArmed)
              }
            },
            () => { /* 锁内拒绝（无结果可留档）已在 run 的 catch 记账 */ },
          )
          const raced = await Promise.race([lockPromise, waitAbort])
          clearTimeout(graceTimer)
          return raced
        } finally {
          removeWaitAbortListener()
          clearTimeout(graceTimer)
        }
      }
      : undefined
    try {
      result = sessionTurn !== undefined
        ? await sessionTurn()
        : await this.dispatch(baseSpec(task.cwd), input.transport === undefined ? {} : { transport: input.transport })
      task.transport = result.transport
      // ⚠️ 这里是 `/task/start` **真正走**的执行路径 —— 与上面那个 `finish` 回调是**两条并行路径**。
      // 我先前只改了回调，于是「任务固定记录实际账号/供应商/模型」在子代理路径成立、
      // 在 `/task/start` 路径却始终为空（实测 86 个任务 0 个有 actual）。两条路径都要记，
      // 否则同一个字段在不同入口下的行为不一致 —— 那比没有这个字段更糟。
      if (result.identity !== undefined) { task.identity = Object.freeze({ ...result.identity }); task.actualSource = 'transport-outcome' }
      task.mismatch = Object.freeze([...(result.mismatch ?? [])])
      // 会话视图同步（store 的回填已在锁内 settle 完成，这里只读回最新值进任务视图）。
      if (native !== undefined && sessionRecord !== undefined) {
        const updated = native.store.get(sessionRecord.logicalId)
        task.session = {
          logicalId: sessionRecord.logicalId,
          ...(updated?.nativeSessionId === undefined ? {} : { nativeSessionId: updated.nativeSessionId }),
          ...(updated?.resumeKind === undefined ? {} : { resumeKind: updated.resumeKind }),
          status: updated?.status,
          ...(sessionRecord.accountId === undefined ? {} : { account: redactAccount(sessionRecord.accountId) }),
        }
      }
      if (result.stopReason === 'completed' && result.text.trim().length === 0) {
        task.status = 'error'
        task.diagnostic = 'harness returned no result'
      } else {
        task.status = result.stopReason
        task.diagnostic = result.diagnostic
      }
    } catch (error: unknown) {
      if (error instanceof SessionWaitInterruptedError) {
        // 排队等待被打断：本轮从未执行（未 spawn、未用任何恢复参数、未 beginRun）。按取消/超时如实记账；
        // **不碰 store**（R6：拒绝/未执行轮没有结算权，保护状态如 recovery_needed/closed 必须原样保留）。
        task.status = error.kind === 'timeout' ? 'timeout' : 'aborted'
        task.diagnostic = error.message
        result = { stopReason: task.status, text: '', transport: 'headless', diagnostic: task.diagnostic, facts: { sessionTurnNeverExecuted: true } }
      } else if (error instanceof SessionSettleUncertainError) {
        // R7：执行中取消/超时但执行器逾期未确认 —— 本轮**确实执行过**，按「待确认/不确定」记账。
        // 不报 never executed；不碰 store（执行器迟到结算仍会由锁内 owner 校验写入真实事实）。
        task.status = error.kind === 'timeout' ? 'timeout' : 'aborted'
        task.diagnostic = error.message
        result = { stopReason: task.status, text: '', transport: 'headless', diagnostic: task.diagnostic, facts: { sessionTurnSettleUncertain: true } }
      } else {
        task.status = task.controller.signal.aborted ? 'aborted' : 'error'
        task.diagnostic = error instanceof Error ? error.message : String(error)
        result = { stopReason: task.status, text: '', transport: 'headless', diagnostic: task.diagnostic }
        // R6：**锁外一律不写共享会话状态** —— beginRun 与全部 store 结算都发生在锁内
        // （dispatch 抛错的落回在 inLock 的 catch 里带 owner 校验完成）。这里唯一还做的
        // 是把 store 的最新事实同步进任务视图（只读），供 harness_task_status 展示。
        if (native !== undefined && sessionRecord !== undefined) {
          const updated = native.store.get(sessionRecord.logicalId)
          task.session = {
            logicalId: sessionRecord.logicalId,
            ...(updated?.nativeSessionId === undefined ? {} : { nativeSessionId: updated.nativeSessionId }),
            ...(updated?.resumeKind === undefined ? {} : { resumeKind: updated.resumeKind }),
            status: updated?.status,
            ...(sessionRecord.accountId === undefined ? {} : { account: redactAccount(sessionRecord.accountId) }),
          }
        }
      }
    }
    clearTimeout(deadline)
    if (timedOut && task.status !== 'completed') {
      // R7：若任务已按「取消待确认/不确定」记账（执行器逾期未确认），保留该事实——
      // 只把状态归一为 timeout，诊断叠加 deadline 事实，**不覆盖** uncertain 说明。
      const uncertainAlready = result?.facts?.sessionTurnSettleUncertain === true
      task.status = 'timeout'
      task.diagnostic = uncertainAlready
        ? `task deadline exceeded; ${result?.diagnostic ?? 'cancellation outcome uncertain'}`
        : 'task deadline exceeded'
      if (result === null) result = { stopReason: 'timeout', text: '', transport: 'headless', diagnostic: task.diagnostic }
    }
    task.updatedAt = Date.now()
    task.result = {
      stopReason: task.status,
      text: result?.text ?? '',
      ...(result?.transport === undefined ? {} : { transport: result.transport }),
      ...(result?.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
      ...(result?.facts === undefined ? {} : { facts: result.facts }),
    }
    try {
      writeFileSync(this.path(task.id, '.result.json'), JSON.stringify(task.result, null, 2), { encoding: 'utf8' })
    } catch { /* 结果文件写失败不挡回执 */ }
    this.save(task)
    this.events.emit(task.id)
    await this.deliver(task)
  }

  /** 终态回执：通知发起会话（失败只记录，不重发——重复唤醒比漏唤醒更糟）。 */
  private async deliver(task: LiveTask): Promise<void> {
    const callback = task.callback
    if (callback === null || !callback.notify) return
    // 全局总闸（设置页的「完成后唤醒会话」⇒ `notifyOnComplete`）。
    // 放在这里而不是各完成出口：`deliver()` 是**唯一**的投递点，run() / settle() /
    // armStallWatch() 三条路径都汇到它，闸门只可能有一处、也只可能生效一处。
    // 判定为「不回执」时**如实记账**成 `skipped` 并写明是哪个开关拦下的 ——
    // 否则界面上只看到一个永远 `pending` 的回执，和「卡住」分不开。
    if (this.notifyEnabled?.() === false) {
      callback.status = 'skipped'
      callback.error = 'notifyOnComplete is false in runtime settings; the completion receipt was not sent'
      delete callback.deliveredAt
      this.save(task)
      this.events.emit(task.id)
      return
    }
    if (callback.sessionId.length === 0) {
      callback.status = 'skipped'
      callback.error = 'no originating session to wake (session id was empty)'
      this.save(task)
      return
    }
    if (this.onComplete === undefined) {
      callback.status = 'skipped'
      callback.error = 'no completion handler wired in this composition'
      this.save(task)
      return
    }
    // ── 回执 outbox（P4；R3 重做：claim→send→settle 统一出口）──
    // 结果已保存 ≠ 已投递；入队 ≠ 宿主已接收；callback=delivered ≠ Leader 已消费。
    // 发送前先 enqueue + claim（原子落盘 sending）——进程死在 send 途中时磁盘留下
    // sending 证据，重启归 uncertain，**不会**再次补投（三个崩溃边界都有测试覆盖）。
    // outbox 未挂载时沿用旧行为（无 receiptId、无落盘）。
    if (this.outbox !== undefined) {
      task.receiptSeq += 1
      const receiptId = receiptIdFor(task.id, task.receiptSeq)
      callback.receiptId = receiptId
      let record
      try {
        record = this.outbox.enqueue({
          receiptId,
          taskId: task.id,
          sessionId: callback.sessionId,
          ...(task.result?.text === undefined ? {} : { preview: task.result.text.slice(0, 200) }),
        })
      } catch (error: unknown) {
        // R5：outbox 降级不可写 —— 不产生「声称已投递」的假状态；回执如实 failed，
        // 结果仍在任务账本里可查。绝不吞成静默。
        callback.status = 'failed'
        callback.error = `receipt outbox unavailable (state file preserved, not overwritten): ${error instanceof Error ? error.message : String(error)}`
        this.save(task)
        this.events.emit(task.id)
        return
      }
      this.save(task)
      const onComplete = this.onComplete
      const send = async (): Promise<string> => await onComplete(
        this.view(task),
        { ...callback, instruction: scrubText(callback.instruction) },
        redactResult(task.result),
      )
      const outcome = await this.outbox.deliverOutbox(record, send)
      callback.status = outcome.result === 'delivered' ? 'delivered' : outcome.result
      if (outcome.receipt !== undefined) callback.receipt = outcome.receipt
      if (outcome.result === 'delivered') callback.deliveredAt = Date.now()
      else callback.error = outcome.error ?? callback.error
      if (callback.status !== 'delivered') {
        this.log(`harness-pilot: completion receipt for ${task.id} -> ${callback.status}: ${callback.error ?? ''}`)
      }
      this.save(task)
      this.events.emit(task.id)
      return
    }
    callback.status = 'sending'
    this.save(task)
    try {
      // 回执投递（wake）也走脱敏出口：交付正文与续办提示都会被拼进**会话消息**，
      // 那是另一个可见面，同样不得把原始 accountId 带进去。
      // 传出去的是一份**只读用途**的副本（唯一消费者 buildReceipt 只读它拼文案），
      // 状态机的推进仍由本方法写在真正的 callback 上，不受影响。
      const receipt = await this.onComplete(
        this.view(task),
        { ...callback, instruction: scrubText(callback.instruction) },
        redactResult(task.result),
      )
      callback.status = 'delivered'
      callback.receipt = receipt
      callback.deliveredAt = Date.now()
    } catch (error: unknown) {
      const err = error as Error & { deliveryUncertain?: boolean; explicitRejection?: boolean }
      callback.status = err.deliveryUncertain === true && err.explicitRejection !== true ? 'uncertain' : 'failed'
      callback.error = err instanceof Error ? err.message : String(error)
      this.log(`harness-pilot: completion receipt for ${task.id} -> ${callback.status}: ${callback.error}`)
    }
    this.save(task)
    this.events.emit(task.id)
  }

  /**
   * R9：读取迟到结算证据（不存在/损坏 ⇒ undefined，不抛）。
   * 内容在保存时已过 redactResult；这里对文本字段再做一次整词脱敏兜底（幂等）。
   */
  private lateSettlementOf(id: string): LateSettlementView | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.path(id, '.late-settlement.json'), 'utf8')) as Partial<LateSettlementView> | null
      if (raw === null || typeof raw !== 'object' || raw.version !== 1) return undefined
      if (typeof raw.task_id !== 'string' || raw.task_id !== id) return undefined
      const scrubbedText = (value: string | undefined): string => typeof value === 'string' ? scrubText(value) : ''
      const originalUncertain = raw.original_uncertain !== null && typeof raw.original_uncertain === 'object'
        ? {
          status: scrubbedText(raw.original_uncertain.status),
          diagnostic: scrubbedText(raw.original_uncertain.diagnostic),
          at: typeof raw.original_uncertain.at === 'number' ? raw.original_uncertain.at : 0,
        }
        : { status: 'unknown', diagnostic: 'original uncertain snapshot missing in stored late-settlement record', at: 0 }
      const view: LateSettlementView = {
        version: 1,
        task_id: raw.task_id,
        run_id: typeof raw.run_id === 'string' ? raw.run_id : '',
        logical_id: typeof raw.logical_id === 'string' ? raw.logical_id : '',
        received_at: typeof raw.received_at === 'number' ? raw.received_at : 0,
        stop_reason: typeof raw.stop_reason === 'string' ? raw.stop_reason : 'unknown',
        text: scrubbedText(raw.text),
        ...(typeof raw.transport === 'string' ? { transport: scrubbedText(raw.transport) } : {}),
        ...(raw.diagnostic === undefined ? {} : { diagnostic: scrubbedText(raw.diagnostic) }),
        ...(raw.native === undefined || typeof raw.native !== 'object' ? {} : {
          native: {
            sessionId: scrubbedText(raw.native.sessionId),
            requestId: scrubbedText(raw.native.requestId),
            runState: scrubbedText(raw.native.runState),
            protocol: scrubbedText(raw.native.protocol),
            sessionMode: scrubbedText(raw.native.sessionMode),
          },
        }),
        ...(raw.facts === undefined || typeof raw.facts !== 'object' ? {} : {
          facts: Object.fromEntries(Object.entries(raw.facts).map(([k, v]) => [k, typeof v === 'string' ? scrubText(v) : v])),
        }),
        original_uncertain: originalUncertain,
      }
      return view
    } catch {
      return undefined
    }
  }

  status(id: string): TaskView {
    const task = this.tasks.get(id)
    const view = task !== undefined
      ? this.view(task)
      : this.statusFromDisk(id)
    const late = this.lateSettlementOf(id)
    return late === undefined ? view : { ...view, late_settlement: late }
  }

  /** status() 的盘读分支（内存无此任务时）；脱敏与重启降级语义不变。 */
  private statusFromDisk(id: string): TaskView {
    let stored: TaskView
    try {
      stored = JSON.parse(readFileSync(this.path(id, '.json'), 'utf8')) as TaskView
    } catch {
      throw new Error(`unknown task_id: ${id}`)
    }
    // 兼容本改动之前落盘的 .json（那时还没有 kind 字段）。
    if (stored.kind === undefined) stored = { ...stored, kind: 'task' }
    // 重启后诚实降级：上个进程没跑完的任务不当成还在跑，也不补发回执。
    if (stored.callback?.status === 'sending') {
      stored.callback = { ...stored.callback, status: 'uncertain', error: 'process ended during callback delivery; not resent' }
    }
    // ⚠️ 落盘读取路径也必须过脱敏出口：本改动之前写下的历史 .json 里 `actual.accountId`
    // 还是原始 id（实测 10 个文件）。出口如果只在**新写入**上脱敏，那么「查历史任务」
    // 这条路径就仍然在回吐原始 id —— 那正是「只改了一条路径」的老毛病。
    // 顺带把两个 return 收敛成一个：留着分支就等于给下一个人留了漏掉脱敏的机会。
    return TERMINAL.has(stored.status)
      ? redactTaskView(stored)
      : redactTaskView({ ...stored, status: 'interrupted', diagnostic: 'harness-pilot process ended; task was not resumed' })
  }

  /**
   * R9：宽限期后执行器迟到返回的**证据落盘**（唯一写入口）。
   *
   * 只保存事实，不改写任务已终态的结果视图（不确定快照保留）、不重跑模型、
   * 不触发回执/唤醒。三段降级：late 文件 → 任务 .log 标注块 → 运行日志告警；
   * 前两级都失败时**至少**有一条可见诊断（不静默丢）。
   * 内容经 `redactResult` 脱敏出口 + 整词账号脱敏，与 task/run/会话 ID 绑定。
   */
  private saveLateSettlement(task: LiveTask, logicalId: string, ownerRunId: string, outcome: DispatchOutcome, originalUncertain: { readonly status: string, readonly diagnostic: string, readonly at: number }): void {
    const redacted = redactResult({ stopReason: outcome.stopReason, text: outcome.text, transport: outcome.transport, ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }), ...(outcome.facts === undefined ? {} : { facts: outcome.facts }) }) ?? { stopReason: outcome.stopReason, text: outcome.text }
    const record = {
      version: 1 as const,
      task_id: task.id,
      run_id: ownerRunId,
      logical_id: logicalId,
      received_at: Date.now(),
      stop_reason: redacted.stopReason,
      text: redacted.text,
      ...(redacted.transport === undefined ? {} : { transport: redacted.transport }),
      ...(redacted.diagnostic === undefined ? {} : { diagnostic: redacted.diagnostic }),
      ...(outcome.native === undefined
        ? {}
        : {
          native: {
            ...(outcome.native.sessionId === undefined ? {} : { sessionId: scrubText(outcome.native.sessionId) }),
            ...(outcome.native.requestId === undefined ? {} : { requestId: scrubText(outcome.native.requestId) }),
            ...(outcome.native.runState === undefined ? {} : { runState: outcome.native.runState }),
            ...(outcome.native.protocol === undefined ? {} : { protocol: outcome.native.protocol }),
            ...(outcome.native.sessionMode === undefined ? {} : { sessionMode: outcome.native.sessionMode }),
          },
        }),
      ...(redacted.facts === undefined ? {} : { facts: redacted.facts }),
      original_uncertain: {
        status: originalUncertain.status,
        diagnostic: scrubText(originalUncertain.diagnostic).slice(0, 600),
        at: originalUncertain.at,
      },
    }
    const serialized = JSON.stringify(record, null, 2)
    try {
      writeFileSync(this.path(task.id, '.late-settlement.json'), serialized, { encoding: 'utf8' })
      // 成功路径也在任务 .log 留一行**引用**（非正文）：读日志的人能发现 late 证据的存在与位置。
      try {
        appendFileSync(this.path(task.id, '.log'), `\n----- late-settlement：执行器迟到返回已留档 ${this.path(task.id, '.late-settlement.json')}（stop=${record.stop_reason}，received=${new Date(record.received_at).toISOString()}，正文 ${record.text.length} 字符；原不确定快照 ${record.original_uncertain.status}@${new Date(record.original_uncertain.at).toISOString()}） -----\n`, { encoding: 'utf8' })
      } catch { /* 引用行写失败不影响证据文件本身 */ }
      return
    } catch (primaryError: unknown) {
      // 一级失败 ⇒ 回退 .log 标注块（全文原文，取证不丢）。
      const note = `\n----- late-settlement 落盘失败（${primaryError instanceof Error ? primaryError.message : String(primaryError)}）；以下为迟到结算全文 -----\n${serialized}\n----- late-settlement 结束 -----\n`
      try {
        appendFileSync(this.path(task.id, '.log'), note, { encoding: 'utf8' })
      } catch (secondaryError: unknown) {
        // 二级也失败 ⇒ 运行日志告警（唯一可见面），如实写明两级都失败。
        this.log(`harness-pilot: late settlement for task ${task.id} could NOT be persisted (file: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; log fallback: ${secondaryError instanceof Error ? secondaryError.message : String(secondaryError)}) — late result NOT silently dropped but unavailable on disk`)
        return
      }
      this.log(`harness-pilot: late settlement file write failed for task ${task.id}; full late result preserved in the task .log instead (${primaryError instanceof Error ? primaryError.message : String(primaryError)})`)
    }
  }

  /**
   * 回收任务账本。
   *
   * 之前账本**只增不减**（实测 84 条记录、单条最大 5.57 MB），长期运行会无上限增长。
   * 这里做成**显式**回收而不是后台自动删：自动删有悄悄抹掉用户还要复查的证据的风险。
   *
   * 纪律：
   *   · **绝不删**非终态任务（还在跑/排队的）—— 删了会让「取消/查询」失效；
   *   · 最近 `keep` 条一律保留；
   *   · 同一任务的 `.json` / `.result.json` / `.log` 一起清，不留孤儿文件；
   *   · 返回删了哪些、跳过了哪些、释放了多少字节，便于审计。
   */
  /**
   * 读**落盘**的原始状态（不经过 `status()` 的「重启后降级」改写）。
   *
   * 为什么需要它：`status()` 会把任何非终态的落盘记录改写成 `interrupted`（因为上个进程
   * 没跑完、也无法续跑，这是诚实的降级）。但回收时必须按**原始**状态判断 ——
   * 否则「绝不删非终态任务」这条承诺对落盘记录**永远不成立**（守卫是死代码）。
   * 这条正是被 `verify-ledger-prune.mjs` 的 keep=1 用例抓出来的。
   */
  private storedStatus(id: string): TaskStatus | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.path(id, '.json'), 'utf8')) as { status?: unknown }
      return typeof raw.status === 'string' ? (raw.status as TaskStatus) : undefined
    } catch {
      return undefined
    }
  }

  prune(keep = 200): { kept: number, removed: string[], skippedRunning: string[], freedBytes: number } {
    const all = this.list()
    const removed: string[] = []
    const skippedRunning: string[] = []
    let freedBytes = 0
    for (let i = 0; i < all.length; i += 1) {
      const view = all[i]
      if (view === undefined) continue
      if (i < keep) continue
      // 保护**非终态**：既看内存里的实时状态，也看**落盘的原始状态**。
      // 前者覆盖正在跑的任务；后者覆盖「进程中途死掉、记录仍是 running」的任务 ——
      // 那正是排查时要看的证据，不能当成普通历史记录删掉。
      const live = this.tasks.get(view.task_id)
      const rawStatus = this.storedStatus(view.task_id)
      const liveStatus = live === undefined ? undefined : this.view(live).status
      const nonTerminal = (s: TaskStatus | undefined): boolean =>
        s !== undefined && (s === 'running' || s === 'stalled')
      if (nonTerminal(liveStatus) || nonTerminal(rawStatus)) {
        skippedRunning.push(view.task_id)
        continue
      }
      for (const suffix of ['.json', '.result.json', '.log', '.late-settlement.json']) {
        const file = this.path(view.task_id, suffix)
        try {
          if (existsSync(file)) {
            freedBytes += statSync(file).size
            unlinkSync(file)
          }
        } catch { /* 单个文件删不掉不阻断其它 */ }
      }
      this.tasks.delete(view.task_id)
      removed.push(view.task_id)
    }
    return { kept: all.length - removed.length, removed, skippedRunning, freedBytes }
  }

  list(): TaskView[] {
    const ids = new Set<string>(this.tasks.keys())
    try {
      for (const file of readdirSync(this.directory)) {
        if (file.endsWith('.json') && !file.endsWith('.result.json')) ids.add(file.slice(0, -'.json'.length))
      }
    } catch { /* 目录刚建或不可读时只列内存里的 */ }
    return [...ids]
      .map(id => {
        try {
          return this.status(id)
        } catch {
          return null
        }
      })
      .filter((view): view is TaskView => view !== null)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 100)
  }

  /** 进度：从 .log 里取一段（增量拉取用 offset）。 */
  progress(id: string, offset = 0, limit = 12000): TaskView & { text: string, offset: number, next_offset: number, has_more: boolean, progress_note: string } {
    const status = this.status(id)
    let log = ''
    try {
      log = readFileSync(this.path(id, '.log'), 'utf8')
    } catch { /* 新任务可能还没有日志 */ }
    const slice = log.slice(offset, offset + limit)
    // 出口把**显示用**的切片整词脱敏（进程输出里可能带着 harness 自己打印的档案目录路径）。
    // ⚠️ offset / next_offset 仍以**原始日志**为准：偏移是分页契约，脱敏只改显示宽度，
    // 不得把分页锚点也一起改掉（否则客户端会漏读或重读）。原始日志仍然原样留在 .log 里供取证。
    const text = scrubText(slice)
    return {
      ...status,
      text,
      offset,
      next_offset: offset + slice.length,
      has_more: offset + slice.length < log.length,
      progress_note: log.length > 0
        ? 'harness process output; may include snapshots or diagnostics'
        : 'no process output yet; no percentage can be inferred',
    }
  }

  /** 终态结果；没到终态时 ready=false。 */
  result(id: string): TaskView & { ready: boolean, result: TaskResult | null } {
    const status = this.status(id)
    if (!TERMINAL.has(status.status)) return { ...status, ready: false, result: null }
    const live = this.tasks.get(id)
    if (live?.result != null) return { ...status, ready: true, result: redactResult(live.result) }
    const path = this.path(id, '.result.json')
    if (!existsSync(path)) return { ...status, ready: false, result: null }
    try {
      return { ...status, ready: true, result: redactResult(JSON.parse(readFileSync(path, 'utf8')) as TaskResult) }
    } catch {
      return { ...status, ready: false, result: null }
    }
  }

  cancel(id: string): { view: TaskView, cancellation_requested: boolean } {
    const task = this.tasks.get(id)
    if (task === undefined) {
      return { view: this.status(id), cancellation_requested: false }
    }
    if (TERMINAL.has(task.status)) {
      return { view: this.view(task), cancellation_requested: false }
    }
    task.controller.abort()
    return { view: this.view(task), cancellation_requested: true }
  }

  /** 等到终态（最多 timeoutMs），用于工具里的「等一小段再看」。 */
  async wait(id: string, timeoutMs = 30000): Promise<TaskView & { ready: boolean, result: TaskResult | null }> {
    if (TERMINAL.has(this.status(id).status)) return this.result(id)
    await new Promise<void>(resolve => {
      const finish = (): void => {
        clearTimeout(timer)
        this.events.off(id, changed)
        resolve()
      }
      const changed = (): void => {
        if (TERMINAL.has(this.status(id).status)) finish()
      }
      const timer = setTimeout(finish, timeoutMs)
      this.events.on(id, changed)
      changed()
    })
    return this.result(id)
  }

  async shutdown(): Promise<void> {
    const live = [...this.tasks.values()].filter(task => !TERMINAL.has(task.status))
    for (const task of live) task.controller.abort()
    await Promise.allSettled([...this.tasks.values()].map(task => task.promise ?? Promise.resolve()))
  }
}

