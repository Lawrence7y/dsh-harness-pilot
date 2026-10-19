/**
 * 异步任务工具面：把长任务丢给外部 harness 后台跑，完成后由回执唤醒本会话。
 *
 *   harness_task_start   派发后台任务，立即拿到 task_id（不阻塞）
 *   harness_task_status  查状态 / 进度 / 终态结果（含交付内容）
 *   harness_task_list    列出最近任务
 *   harness_task_cancel  取消一个在跑的任务
 *
 * 与一次性 harness_dispatch 的分工：短任务用 dispatch（同步等结果）；
 * 长任务用 task_start（跑着的时候 DSH 可以继续别的事，完成时回执唤醒）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ACCOUNT_SEEDS } from './federation/accounts.js'
import { redactAccount } from './federation/poolconfig.js'
import type { ResolvedConfig } from './config.js'
import type { TaskManager, TaskView } from './tasks.js'
import type { RuntimeSettings } from './settings.js'
import type { SessionRegistry } from './sessions.js'
import type { TargetConfig } from './types.js'
import type { TransportKind } from './types.js'
// 模型引用的统一解析与校验（唯一实现：`src/model-request.ts`）。
import { resolveModelRequest } from './model-request.js'
import { classifyTarget, providerIdFor } from './harness-groups.js'
import { selectableIds } from './model-sources.js'
import { modelEntriesFor } from './models.js'

export interface TaskToolDeps {
  readonly config: ResolvedConfig
  readonly registry: SessionRegistry
  readonly tasks: TaskManager
  readonly settings: () => RuntimeSettings
  /**
   * 把账号档案合并进目标（由 index.ts 注入，**与 `/dispatch`、`/task/start` 共用同一实现**）。
   * 三个入口共用一处实现，避免「同一能力在不同入口行为不一致」——那个坑本项目踩过两次。
   */
  readonly withAccount?: (target: TargetConfig, accountId: string) => { readonly ok: true, readonly target: TargetConfig, readonly note: string } | { readonly ok: false, readonly reason: string }
  /** 账号池的默认账号（未显式指定时用）。 */
  readonly poolDefaultAccountId?: () => string
  /**
   * **按目标分域**的池默认账号（首选）。返回 `accountId: ''` + `ignoredReason` 表示
   * 「池里的默认账号不属于这条目标的 harness」⇒ 不套用它，但要说明原因。
   */
  readonly poolDefaultAccountFor?: (targetName: string) => { readonly accountId: string, readonly ignoredReason: string | null }
  /**
   * 子代理模型白名单的**只读快照**（2026-10-16 新增，供 harness_route_check 用）。
   * 未挂载 ⇒ 该工具显式说明不可用（不假装读到了空表）。
   */
  readonly routeCheck?: () => {
    readonly available: boolean
    readonly reason: string
    readonly enabled: boolean | null
    readonly revision: number | null
    readonly routes: readonly { readonly provider: string, readonly model: string }[]
    readonly candidates: readonly { readonly provider: string, readonly model: string, readonly name: string, readonly enabled: boolean }[]
  }
}

function textOutput(text: string): { text: string } {
  return { text }
}

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
} as const

/** 调用方 Agent 的 workspace 与会话 id（回执要唤醒的就是这个会话；Agent.id 即 SessionId）。 */
function agentContext(agent: unknown): {
  cwd?: string
  sessionId?: string
  /**
   * 发起会话是否**由子代理路由拥有**（`session.header.origin === 'subagent'`，rc.2 契约见
   * `dsh-session` 的 `validateSessionHeader`：`origin` 只允许等于 `'subagent'`）。
   *
   * 为什么要读它：宿主的 `sessionController.resolveAgent` 会明确拒绝这类会话
   * （实测原话 `session "<id>" is owned by subagent routing`），于是**在子代理会话里发起的任务，
   * 回执注定送不回来**。这是宿主边界、不是插件故障 —— 既然注定失败，就必须在**派发时**说清楚，
   * 而不是等任务跑完只留一行 `status=failed`。
   */
  subagentOwned: boolean
  parentSession?: string
} {
  const source = (agent as { id?: unknown, session?: { id?: unknown, header?: { cwd?: string, origin?: unknown, parentSession?: unknown } } } | undefined)
  const cwd = source?.session?.header?.cwd
  const header = source?.session?.header
  const parent = header?.parentSession
  const sessionId = typeof source?.id === 'string'
    ? source.id
    : (typeof source?.session?.id === 'string' ? source.session.id : undefined)
  return {
    ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    subagentOwned: header?.origin === 'subagent',
    ...(typeof parent === 'string' && parent.length > 0 ? { parentSession: parent } : {}),
  }
}

// ── 输出侧的脱敏与「实际身份」渲染 ────────────────────────────────────
// 用户的要求是**如实可辨**：子代理 / 团队 / 任务详情要看到真实 Harness、脱敏账号、
// 供应商、模型、原生会话 id、执行状态；配置值 ≠ 实际值时必须显式，不得静默算成功。
// 两条硬纪律写在这里：
//   ① 本文件**绝不打印原始 accountId**（一律过 redactAccount）—— 账号 id 能直指
//      某个真实登录身份，属于要脱敏的东西；脱敏在**渲染前**做，而不是指望调用方记得。
//   ② 字段**缺失**一律如实写成「未回报」，绝不折叠成「一致」或空白。

/**
 * 把一个账号 id 换成脱敏形式（复用账号池/切换账本同一套 `redactAccount`）。
 * `acct:…<尾 2 位><长度 36 进制>` 不可反推，但同一账号的多次输出**稳定相同**，便于对照。
 */
export function redactAccountId(accountId: string | undefined): string | undefined {
  if (accountId === undefined) return undefined
  const trimmed = accountId.trim()
  if (trimmed.length === 0) return undefined
  // **幂等短路**：视图层（src/tasks.ts 的 redactTaskView）现在返回的**已经是标签**，
  // 这里再脱一次会把它变成另一个形状（`acct:…-aa` → `acct:…aa9`），
  // 于是同一个账号在任务详情与账号池/设置页显示成**两个不同标签**，跨页对照失效。
  // 上面文档里承诺的「同一账号输出稳定相同、便于对照」就靠这一行成立。
  if (trimmed.startsWith('acct:')) return trimmed
  return redactAccount(trimmed)
}

/**
 * 文本级兜底脱敏：把**任何已知账号档案 id** 在原样出现的位置替换成脱敏形式。
 *
 * 为什么需要它（而不是只管我们自己拼的字段）：`withAccount` 的 note 由 index.ts 生成，
 * 形状是 `account=<原始 id> configDir=…`。本文件把它原样打印就是泄漏 —— 实测过。
 * 与其依赖上游改文案（那要动 index.ts，且下次又可能漂移），不如在**唯一出口**上兜住。
 *
 * ⚠️ **必须按「整词」替换，不能做子串替换**：本机实测存在真实的名字冲突 ——
 * 目标名 `qoder-cn-acct-a` / `qoder-cn-acct-b` / `qoder-cn-app` **以某个账号档案 id 为前缀**。
 * 子串替换会把目标名改成 `acct:…cct-a` 这种四不像，等于**篡改执行身份**，
 * 比不脱敏更糟。所以这里要求 id 两侧都不是「id 允许的字符」（字母/数字/`_`/`.`/`-`）：
 *   `account=<id> configDir=…` ✅ 命中；`…\harness-accounts\<id>\` ✅ 命中；
 *   `qoder-cn-acct-a` ❌ 不命中（后面还跟着 `cct-a`）。
 * 一次性用合并正则替换，避免后一轮又去扫前一轮插进去的脱敏串。
 */
export function redactAccountIdsInText(text: string): string {
  const known = ACCOUNT_SEEDS.filter(seed => seed.id.length > 0)
  if (known.length === 0) return text
  const byId = new Map(known.map(seed => [seed.id, redactAccount(seed.id)]))
  // 长的优先，避免短 id 先吃掉长 id 的前缀（同一次替换里由交替顺序决定）。
  const alternation = [...byId.keys()]
    .sort((a, b) => b.length - a.length)
    .map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const re = new RegExp(`(?<![A-Za-z0-9_.-])(?:${alternation})(?![A-Za-z0-9_.-])`, 'g')
  return text.replace(re, matched => byId.get(matched) ?? matched)
}

/** 「没查到」与「查到了是空」是两件事：这个标记专门表示前者，避免被读成后者。 */
function notReported(why?: string): string {
  return why === undefined || why.length === 0 ? '(未回报)' : `(未回报：${why})`
}

/**
 * 请求值 vs 实际回报的**结构化对照**（纯函数；UI、回执、工具面共用**这一份**实现）。
 *
 * 三种结局必须分得开，且**不许**把「没回报」当成「一致」：
 *   · `differences` 非空 ⇒ 请求值 ≠ 实际值（不得当作成功）；
 *   · `missing` 非空 ⇒ 那些字段实际未回报 ⇒ 无法比较；
 *   · 两者都空且 `compared` 非空 ⇒ 只有这些字段两侧都有证据且一致（**不代表整体身份已确认**）。
 */
export interface IdentityComparison {
  readonly evaluated: boolean
  readonly compared: readonly string[]
  readonly differences: readonly string[]
  readonly missing: readonly string[]
  /** 已有的不一致记录（来自通道/别名派发，原样带出）。 */
  readonly recorded: readonly string[]
}

export function compareIdentity(view: TaskView): IdentityComparison {
  const recorded = view.mismatch ?? []
  const requested = view.requested
  if (requested === undefined || view.actual === undefined) {
    return { evaluated: false, compared: [], differences: [], missing: [], recorded }
  }
  const missing: string[] = []
  const compared: string[] = []
  const differences: string[] = []
  for (const field of ['harnessId', 'accountId', 'provider', 'model'] as const) {
    const requestedValue = requested[field]
    if (requestedValue === undefined || requestedValue.length === 0) continue
    const actualValue = (field === 'provider' || field === 'model') && view.actualSource !== 'transport-outcome'
      ? undefined : view.actual[field]
    if (actualValue === undefined || actualValue.length === 0) { missing.push(field); continue }
    const requestedComparable = field === 'accountId' ? redactAccountId(requestedValue) : requestedValue
    const actualComparable = field === 'accountId' ? redactAccountId(actualValue) : actualValue
    compared.push(field)
    if (requestedComparable !== actualComparable) differences.push(field)
  }
  return { evaluated: true, compared, differences, missing, recorded }
}

/**
 * 一行**结论**（给回执/界面用：读一行就知道该不该信）。
 *
 * 顺序即优先级：**已记录的不一致 > 比出来的不一致 > 未完整回报 > 部分一致**。
 */
export function identityVerdictLine(comparison: IdentityComparison): string {
  if (comparison.recorded.length > 0 || comparison.differences.length > 0) {
    const parts = [...comparison.recorded.map((item) => item), ...(comparison.differences.length === 0 ? [] : [`差异字段：${comparison.differences.join(', ')}`])]
    return `⚠️ 请求值 ≠ 实际值（不得当作成功）：${parts.join('；')}`
  }
  if (!comparison.evaluated) return '实际身份未回报 ⇒ 无法判定请求值与实际值是否一致（**不得**读成一致）'
  if (comparison.missing.length > 0) {
    return `实际身份**未完整回报**（缺 ${comparison.missing.join(', ')}）⇒ 无法判定一致`
  }
  if (comparison.compared.length > 0) {
    return `已有两侧证据的字段一致（${comparison.compared.join(', ')}）；**不代表整体身份已确认**`
  }
  return '没有可比较的请求字段 ⇒ 无法确认整体一致'
}

/** 实际身份一行。
 *
 * `view.actual` 是**通道/CLI 真实回报**的身份（`sessions.foldOutcomeIdentity` 的出口），
 * 与请求值（`target` / `model` / 账号参数）分开呈现 —— 否则「请求了什么」会被当成「用了什么」。
 */
export function actualIdentityLines(view: TaskView): string[] {
  const actual = view.actual === undefined ? undefined : (view.actualSource === 'transport-outcome'
    ? view.actual : { ...view.actual, provider: undefined, model: undefined })
  if (actual === undefined) {
    const terminal = ['completed', 'error', 'timeout', 'aborted', 'interrupted'].includes(view.status)
    return [
      '  actual: (无实际身份记录 —— '
      + (terminal
        ? '该 run 已到终态却没有回报身份，说明这次执行**没有留下身份证据**。'
        : '任务刚派发、身份还没回报（跑完再看这一行）。')
      + '两种情况下都**不得**把「没记录」读成「与请求一致」)',
    ]
  }
  const account = redactAccountId(actual.accountId)
  const transport = actual.transport ?? view.transport
  const nativeSession = actual.nativeSessionId === undefined
    ? notReported('本通道未提取原生会话 id —— 是「还没打通」，不是「该 Harness 没有会话」')
    : actual.nativeSessionId
  const line = '  actual: '
    + `harness=${actual.harnessId ?? notReported()}`
    + ` account=${account ?? notReported('无法确认账号档案是否被采用')}`
    + ` provider=${actual.provider ?? notReported()}`
    + ` model=${actual.model ?? notReported()}`
    + ` nativeSessionId=${nativeSession}`
    + ` transport=${transport ?? notReported()}`
  const lines = [line]
  if (view.requested !== undefined) {
    lines.push('  requested: '
      + `harness=${view.requested.harnessId ?? notReported()}`
      + ` account=${redactAccountId(view.requested.accountId) ?? notReported()}`
      + ` provider=${view.requested.provider ?? notReported()}`
      + ` model=${view.requested.model ?? notReported()}`)
  }
  if (view.actualSource !== 'transport-outcome') {
    lines.push('    （历史记录缺少身份来源标记：供应商与模型未验证，不能用旧记录确认本轮采用值）')
  }
  if (actual.provider === undefined) {
    lines.push('    （provider 未回报，无法确认实际供应商；请求值与目录列表不能替代执行回报）')
  }
  if (actual.model === undefined) {
    lines.push('    （model 未回报，无法确认实际模型；ACP 配置应答不能证明本轮采用了请求模型）')
  }

  return lines
}

/** Compare only fields for which both request and native receipt are available. */
export function mismatchLines(view: TaskView): string[] {
  const mismatch = view.mismatch ?? []
  const lines = mismatch.map((item, index) => `  mismatch${mismatch.length > 1 ? `[${index + 1}]` : ''}: ⚠️ ${item}`)
  // ⚠️ 对照本身在 `compareIdentity()`（**唯一**实现）；这里只负责排版。
  const comparison = compareIdentity(view)
  if (!comparison.evaluated) {
    lines.push('  comparison: 未评估，缺少请求快照或实际身份，无法确认一致')
    return lines
  }
  if (comparison.differences.length > 0) lines.push(`  comparison: 请求与实际回报存在偏差：${comparison.differences.join(', ')}`)
  else if (comparison.compared.length > 0) lines.push(`  comparison: 已有两侧证据的字段一致：${comparison.compared.join(', ')}；不代表整体身份已确认`)
  if (comparison.missing.length > 0) lines.push(`  comparison: ${comparison.missing.join(', ')} 实际未回报，无法比较或确认一致`)
  if (comparison.compared.length === 0 && comparison.missing.length === 0) lines.push('  comparison: 没有可比较的请求字段，无法确认整体一致')
  return lines
}

/**
 * 回执行：把**为什么送不到**如实写出来。
 *
 * 最重要的一条是宿主边界：发起会话由**子代理路由**拥有时，宿主的 `resolveAgent` 会明确拒绝
 * 唤醒（实测原话 `session "<id>" is owned by subagent routing`）。这类 `failed` 不是插件故障、
 * 也不是网络抖动，任务结果本身完好 —— 所以必须给出「去哪读结果」，而不是只留一句失败。
 */
export function receiptLines(view: TaskView): string[] {
  const callback = view.callback
  if (callback === null) {
    return ['  回执: 无 —— 这条 run 没有登记回执（内部子代理 run 的调用方本来就在 await 结果，'
      + '再回执一次就是重复唤醒）。结果直接用 harness_task_status 读。']
  }
  const head = '  回执: '
    + `notify=${callback.notify} session=${callback.sessionId || '(none)'} status=${callback.status}`
    + (callback.error === undefined ? '' : ` error=${callback.error}`)
  const lines = [head]
  const error = callback.error ?? ''
  if (callback.status === 'failed' && /owned by subagent routing/i.test(error)) {
    lines.push('    ⚠️ 回执无法送达 = **宿主限制，不是插件故障，也不是网络抖动**：'
      + '发起会话（session=' + (callback.sessionId || '(none)') + '）由**子代理路由**拥有，'
      + '宿主的 sessionController.resolveAgent 对这类会话明确拒绝唤醒。')
    lines.push(`    任务本身已到终态 status=${view.status}，结果不受影响：`
      + `用 harness_task_status task_id=${view.task_id} 读取，或直接读结果文件 ${view.result_path}。`)
    lines.push('    要拿到回执，请从**顶层会话**（或任何非子代理会话）发起该任务，'
      + '或由父会话主动轮询上面这个 task_id。')
  } else if (callback.status === 'failed') {
    lines.push('    ⚠️ 回执投递被宿主**明确拒绝**（不是「可能已送达」）：'
      + '结果已落盘，请用 harness_task_status 读取，不要等唤醒。')
  } else if (callback.status === 'uncertain') {
    lines.push('    ⚠️ 回执状态**不确定**（进程在投递途中结束）：既不能当作已送达，也不要重放任务；'
      + `结果以 ${view.result_path} 为准。`)
  }
  return lines
}

/** R9：迟到结算证据行的渲染（发现即可见；原文/事实已在保存时脱敏）。 */
export function lateSettlementLines(view: TaskView): string[] {
  const late = view.late_settlement
  if (late === undefined) return []
  const lines = ['  late-settlement: ⚠️ 任务结果视图是**不确定快照**（不自动改成功）；执行器迟到返回的实际结果已另行留档：'
    + `stop=${late.stop_reason}`
    + ` received=${new Date(late.received_at).toISOString()}`
    + ` native=${late.native?.sessionId ?? '(未回报)'}`
    + ` request=${late.native?.requestId ?? '(未回报)'}`
    + ` textChars=${late.text.length}`
    + ` originalUncertain=${late.original_uncertain?.status ?? '(未记录)'}@${late.original_uncertain ? new Date(late.original_uncertain.at).toISOString() : '?'}`
    + `（正文与事实见 harness_task_status include_result 的 late_settlement 字段 / 任务目录 <task_id>.late-settlement.json）`]
  if (late.text.length > 0) {
    lines.push(`    late 正文（脱敏，前 600 字符）：${late.text.slice(0, 600)}${late.text.length > 600 ? '…' : ''}`)
  }
  return lines
}

/** 持久逻辑会话行的渲染（可选字段缺失如实显示；账号只出脱敏标签）。 */
export function sessionLines(view: TaskView): string[] {
  const session = view.session
  if (session === undefined) return []
  const lines = ['  session: '
    + `logical=${session.logicalId}`
    + ` native=${session.nativeSessionId ?? '(首轮尚未回报；结束后回填)'}`
    + ` resume=${session.resumeKind ?? '(未记录)'}`
    + ` status=${session.status ?? '(未记录)'}`
    + (session.account === undefined ? '' : ` account=${session.account}`)]
  if (session.status === 'recovery_needed') {
    lines.push('    ⚠️ 该逻辑会话被标记 recovery_needed：上一次按原生 ID 恢复未确认。')
    lines.push('    处理方式：人工接管（用厂商 CLI 核对原会话）或显式新建会话；**不要**盲目重试同一 ID。')
  } else if (session.status === 'idle') {
    lines.push('    （idle = CLI 进程已释放、会话记录保留；继续派发时传 session_id=<logical> 即按原生 ID 精确恢复 —— 可恢复 ≠ 丢失。）')
  }
  return lines
}

export function describe(view: TaskView): string {
  const kind = view.kind ?? 'task'
  const model = view.model === null ? '' : ` model=${view.model}`
  const transport = view.transport === undefined ? '' : ` transport=${view.transport}`
  const diagnostic = view.diagnostic === null || view.diagnostic.length === 0 ? '' : `\n  diagnostic: ${view.diagnostic}`
  const session = sessionLines(view)
  const late = lateSettlementLines(view)
  return redactAccountIdsInText(
    `${kind} ${view.task_id}\n`
    + `  target=${view.target}${model}${transport} status=${view.status} elapsed=${Math.round(view.elapsed_ms / 1000)}s\n`
    + `  cwd=${view.cwd}\n`
    + `  output_chars=${view.output_chars} result=${view.result_path}${diagnostic}\n`
    + `${actualIdentityLines(view).join('\n')}\n`
    + (session.length === 0 ? '' : `${session.join('\n')}\n`)
    + (late.length === 0 ? '' : `${late.join('\n')}\n`)
    + `${mismatchLines(view).join('\n')}\n`
    + `${receiptLines(view).join('\n')}`,
  )
}

export function registerTaskTools(ctx: any, deps: TaskToolDeps): void {
  const { config, registry, tasks, settings } = deps
  const register = (definition: unknown, label: string): void => {
    const toolName = (definition as { name?: string }).name ?? ''
    if (toolName.length > 0 && typeof ctx.tools?.get === 'function' && ctx.tools.get(toolName) !== undefined) return
    ctx.effect(() => ctx.tools.register(definition), `@dsh-external/dsh-harness-pilot: ${label}`)
  }

  register(defineTool({
    name: 'harness_task_start',
    description:
      'Dispatch one task to another agent harness IN THE BACKGROUND and return a task id immediately. Use this for '
      + 'long-running work: the harness runs while you continue, and on completion the plugin delivers its output '
      + 'back into THIS session as a completion receipt that re-wakes the session to continue the original goal. '
      + 'The returned record states the REQUESTED identity (harness, redacted account, model, transport) and, once the '
      + 'run settles, the ACTUAL identity reported by the harness (harness, redacted account, provider, model, native '
      + 'session id, transport) plus any requested-vs-actual mismatch — read it with harness_task_status. Account ids '
      + 'are always redacted in tool output. '
      + 'Receipt boundary: a task started from a session owned by subagent routing cannot be woken (a host limitation), '
      + 'so the receipt is recorded as failed while the task itself still completes — the result must be read with '
      + 'harness_task_status. '
      + 'Use harness_dispatch for short synchronous tasks.',
    parameters: {
      target: { type: 'string', required: true, description: 'Harness name from harness_list (e.g. opencode, agy, zcode)' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for that harness (it cannot see this conversation)' },
      model: { type: 'string', description: 'Model id for this run; see harness_models' },
      cwd: { type: 'string', description: 'Working directory; defaults to this session workspace' },
      transport: { type: 'string', enum: ['auto', 'acp', 'headless', 'pty', 'cdp', 'window'], description: 'Force one transport (default auto)' },
      timeout_ms: { type: 'integer', description: 'Hard deadline in ms (default: plugin defaultTaskTimeoutMs setting)' },
      notify: { type: 'boolean', description: 'On completion, deliver the result and re-wake this session (default true)' },
      resume_instruction: { type: 'string', description: 'Note recorded for the completion receipt: what to do when the session is re-woken' },
      accountId: { type: 'string', description: 'Account profile id (e.g. qoder-cn-a). Omit to use this session\'s binding, else the account pool default. The account is applied AND recorded in the task ledger as the actual identity.' },
      session_id: { type: 'string', description: 'Continue an existing PERSISTENT logical session (ns-…, see harness_sessions): the harness CLI is resumed by its PRECISE native session id in the same working directory and account — no --continue guessing. Cross-target reuse is refused; a session marked recovery_needed must be handled explicitly first. The CLI process may have exited; resuming it is normal and is NOT a new conversation.' },
      persistent: { type: 'boolean', description: 'Create a NEW persistent logical session on this target (only for targets whose harness_list entry declares a structured CLI protocol, e.g. workbuddy-native / qoder-cn-native / antigravity-native). The record carries session.logicalId — pass it back as session_id for follow-ups. Omit both fields for a one-shot task (legacy behavior).' },
    },
    output: OUTPUT,
    async execute(args: any, exec: any): Promise<{ text: string }> {
      const target = registry.target(String(args.target))
      const agent = agentContext(exec?.agent)
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : (agent.cwd ?? process.cwd())
      // 模型引用先**校验**（与 harness_dispatch / harness_agent 同一份实现）：三种形态 + 与当前可选清单核对。
      // 拒绝时**不建任务** —— 否则账本里会留下一条注定失败的 run，事后很难归因。
      const requestedModel = typeof args.model === 'string' && args.model.trim().length > 0 ? args.model.trim() : undefined
      const known = await registry.targetModels(target)
      const modelRef = resolveModelRequest({
        targetName: target.name,
        providerId: providerIdFor(classifyTarget({ name: target.name })),
        ...(requestedModel === undefined ? {} : { explicit: requestedModel }),
        selectable: selectableIds(known.entries ?? modelEntriesFor({})),
        measured: known.state !== undefined && known.state.code !== 'unknown',
        modelSwitchable: target.modelArgs.length > 0 || target.acpArgs.length > 0,
      })
      if (!modelRef.ok) {
        return textOutput(`✗ 模型引用被拒绝（**没有建任务**）\n原因：${modelRef.reason}\n怎么办：${modelRef.recovery}`)
      }
      const model = modelRef.model
      const transport = typeof args.transport === 'string' && args.transport !== 'auto'
        ? args.transport as TransportKind
        : undefined
      const runtime = settings()
      const prompt = String(args.prompt)
      if (prompt.trim().length === 0) throw new Error('prompt must be a non-empty string')
      // 账号：显式 > 账号池默认。与 HTTP `/task/start` 同一套优先级，
      // 并且同样把身份交给 TaskManager —— 只改 target 能让账号生效，却不会留下记录。
      //
      // ⚠️ 2026-10-14 修：池默认账号必须**按目标所属 Harness 分域**再用。
      // 历史行为：池里设了 `workbuddy-a` 之后 `harness_task_start(target:'agy')` 会走进
      // 跨 Harness 拒绝分支 ⇒ 整次任务失败（实测）。现在不属于本目标就**不套用**并写进 note。
      const scopedDefault = deps.poolDefaultAccountFor?.(target.name)
      const explicitAccountId = typeof args.accountId === 'string' && args.accountId.trim().length > 0
        ? args.accountId.trim()
        : ''
      const accountId = explicitAccountId.length > 0
        ? explicitAccountId
        // ⚠️ **不给全局兜底**：`poolDefaultAccountId()` 是「全局一个」的旧接口，
        // 用它会把别家的账号套到本目标上（实测缺陷）。分域解析没挂载时就**不套用**账号。
        : (scopedDefault?.accountId ?? '')
      let effectiveTarget = target
      let accountNote = explicitAccountId.length === 0 && scopedDefault?.ignoredReason != null
        ? scopedDefault.ignoredReason
        : ''
      if (accountId.length > 0) {
        if (deps.withAccount === undefined) {
          throw new Error('accountId was given but this composition has no account resolver mounted')
        }
        const applied = deps.withAccount(target, accountId)
        // ⚠️ 失败原因由 index.ts 的 `withAccountTarget` 生成，**里面含原始 accountId**
        // （实测：`账号 <原始 id> 属于 Harness「…」…`）。工具错误同样是**用户可见面**，
        // 所以这里必须先脱敏再抛。
        if (!applied.ok) throw new Error(redactAccountIdsInText(applied.reason))
        effectiveTarget = applied.target
        accountNote = applied.note
      }
      // ── 持久逻辑会话参数（P3；R2 收紧绑定）：显式 > 缺省；拒绝（未知 ID / 跨目标 /
      // 恢复待定 / cwd 或账号与冻结绑定冲突）由 TaskManager.start 同步抛出 —— 不建任务。──
      // cwd 语义：续接时缺省 = **继承创建时冻结的绑定目录**；显式给了就必须与绑定一致。
      const explicitCwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd.trim() : undefined
      const explicitSessionId = typeof args.session_id === 'string' && args.session_id.trim().length > 0
        ? args.session_id.trim()
        : undefined
      const wantPersistentSession = args.persistent === true || explicitSessionId !== undefined
      const view = tasks.start({
        target: effectiveTarget,
        prompt,
        cwd,
        timeoutMs: Number(args.timeout_ms ?? runtime.defaultTaskTimeoutMs),
        ...(model === undefined ? {} : { model }),
        ...(transport === undefined ? {} : { transport }),
        ...(accountId.length === 0 ? {} : { identity: { harnessId: target.name, accountId, ...(model === undefined ? {} : { model }) } }),
        ...(wantPersistentSession
          ? { session: {
            ...(explicitSessionId === undefined ? {} : { logicalId: explicitSessionId }),
            // 只在显式给了 cwd 时才携带；省略 = 继承绑定（不带工具层的 agent workspace 兜底值）。
            ...(explicitCwd === undefined || explicitSessionId === undefined ? {} : { cwd: explicitCwd }),
          } }
          : {}),
        callback: {
          notify: args.notify !== false,
          sessionId: agent.sessionId ?? '',
          instruction: typeof args.resume_instruction === 'string' ? args.resume_instruction : '',
        },
      })
      // 请求身份**显式**列出（账号已脱敏）：任务跑完后 `actual:` 行会给出实际值，
      // 两者并排才谈得上「配置值 ≠ 实际值」可辨。原始 accountId 一律不打印。
      const requested = '  requested: '
        + `harness=${target.name}`
        + ` account=${redactAccountId(accountId) ?? 'none'}`
        + ` model=${model ?? '(未指定：用该 Harness 自己的默认)'}`
        + ` transport=${transport ?? 'auto（按通道梯子决定）'}`
      // 持久会话提示：追问时用原逻辑 ID（native ID 精确恢复），不要重新派发新会话。
      const sessionNote = view.session === undefined
        ? ''
        : '\nsession: 本任务绑定持久逻辑会话。后续追问请再次调用本工具并传 session_id=' + view.session.logicalId
          + '（同会话同时只允许一轮；进程已退出的会话会按原生 ID 精确恢复 —— 这是正常恢复，不是新建。）\n'
      const receiptBoundary = agent.subagentOwned
        ? '\n⚠️ 回执边界（**宿主限制，不是插件故障**）：本会话由**子代理路由**拥有'
          + `（session.header.origin=subagent${agent.parentSession === undefined ? '' : `，parent=${agent.parentSession}`}），`
          + '宿主的 sessionController.resolveAgent **明确拒绝**唤醒这类会话，因此本任务完成后'
          + '**回执送不回来**（账本里会记成 callback.status=failed，原话 "is owned by subagent routing"）。'
          + `任务照常执行；结果请用 harness_task_status task_id=${view.task_id} 读取`
          + '（或由父会话/顶层会话按这个 id 查询）。要拿到自动回执，请从顶层会话发起该任务。\n'
        : ''
      return textOutput(
        `started ${describe(view)}\n`
        + `${requested}\n`
        + (accountNote.length > 0 ? `account: ${redactAccountIdsInText(accountNote)}\n` : '')
        + sessionNote
        + receiptBoundary
        // 结尾这句**必须**与回执边界一致：子代理会话里承诺「完成后回执唤醒本会话」是假话，
        // 而一句假的承诺会把上面那段真话抵消掉。
        + (agent.subagentOwned
          ? 'The harness runs in the background. This session cannot be woken by a receipt (host limitation, see above) — '
            + 'poll the result with harness_task_status; cancel with harness_task_cancel.'
          : 'The harness runs in the background. On completion the result is delivered back to this session as a receipt '
            + '(when notify=true). Check with harness_task_status; cancel with harness_task_cancel.'),
      )
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_task_start → ${String(args.target ?? '?')}`, kind: 'execute' as const }
    },
  }), 'harness_task_start')

  register(defineTool({
    name: 'harness_task_status',
    description:
      'Check one run recorded by this plugin: status, progress output and (once terminal) the delivered result. '
      + 'The record shows the ACTUAL execution identity reported by the harness — real harness id, REDACTED account '
      + '(never the raw account id), provider, model, native session id and transport — and any mismatch between the '
      + 'requested and actual values; a missing field is reported as "not reported", never as "matches". '
      + 'It also states why a completion receipt was not delivered, including the host limitation for sessions owned '
      + 'by subagent routing. '
      + 'Works for BOTH kinds — background tasks from harness_task_start (kind=task) and internal subagent runs '
      + 'dispatched through harness_agent or the host subagent tool with provider=harness-<name> (kind=subagent). '
      + 'A subagent run that is stuck reports status=stalled instead of staying "running" forever. '
      + 'Pass include_result=true to inline the final output text.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Run id: task id from harness_task_start, or run id from harness_agent' },
      include_result: { type: 'boolean', description: 'Include the full result text when the task is terminal (default true)' },
      log_offset: { type: 'integer', description: 'Progress log offset for incremental reads (default 0)' },
      log_limit: { type: 'integer', description: 'Max progress characters to return (default 4000)' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args: any): Promise<{ text: string }> {
      const id = String(args.task_id)
      const offset = Math.max(0, Number(args.log_offset ?? 0))
      const limit = Math.min(64000, Math.max(200, Number(args.log_limit ?? 4000)))
      const progress = tasks.progress(id, offset, limit)
      const includeResult = args.include_result !== false
      const terminal = ['completed', 'error', 'timeout', 'aborted', 'interrupted'].includes(progress.status)
      const lines = [describe(progress)]
      if (progress.text.length > 0) {
        lines.push(`\n--- progress (offset ${progress.offset}..${progress.next_offset}${progress.has_more ? ', more available' : ''}) ---\n${progress.text}`)
      }
      if (terminal && includeResult) {
        const result = tasks.result(id)
        if (result.ready && result.result !== null) {
          lines.push(`\n--- result (stop=${result.result.stopReason}) ---\n${result.result.text.trim().length > 0 ? result.result.text : '(no text returned)'}`)
        } else {
          lines.push('\n--- result ---\n(not readable yet; see diagnostic above)')
        }
      }
      // 进度与结果正文是 **harness 自己吐出来的原始文本**，可能带回显给 CLI 的参数/配置目录
      // （账号档案目录名就是账号 id）。出口再过一次脱敏：账号 id 不出现在本工具的任何输出里。
      return textOutput(redactAccountIdsInText(lines.join('\n')))
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_task_status ${String(args.task_id ?? '?')}`, kind: 'read' as const }
    },
  }), 'harness_task_status')

  register(defineTool({
    name: 'harness_task_list',
    description:
      'List recent runs (newest first) with kind (task | subagent), status, target, the ACTUAL execution identity '
      + '(real harness, redacted account, provider, model, native session id, transport), requested-vs-actual mismatch, '
      + 'and receipt state — including why a receipt could not be delivered. '
      + 'Includes internal subagent runs dispatched through harness_agent.',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(): Promise<{ text: string }> {
      const views = tasks.list()
      if (views.length === 0) return textOutput('no harness tasks recorded')
      return textOutput(views.map(describe).join('\n\n'))
    },
    presentCall() {
      return { card: 'generic' as const, title: 'harness_task_list', kind: 'read' as const }
    },
  }), 'harness_task_list')

  register(defineTool({
    name: 'harness_task_cancel',
    description: 'Cancel a running background harness task. Terminal tasks are left untouched.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id from harness_task_start' },
    },
    output: OUTPUT,
    async execute(args: any): Promise<{ text: string }> {
      const id = String(args.task_id)
      const { view, cancellation_requested } = tasks.cancel(id)
      return textOutput(
        `${cancellation_requested ? 'cancellation requested' : 'not cancelled (already terminal or unknown)'}\n${describe(view)}`,
      )
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_task_cancel ${String(args.task_id ?? '?')}`, kind: 'execute' as const }
    },
  }), 'harness_task_cancel')

  // ── harness_route_check（2026-10-16，P-2）───────────────────────────────────
  // 现场实测：子代理派发用了「provider/model 配错对」的路由（如 xiaomi 配 Qwen3.8-Flash、
  // workbuddy 配 qoder 的模型），宿主 dsh-tool-subagent 的白名单精确串校验直接拒绝
  // （原话 `child LLM route "P/M" is not allowed for this Session`），调用方只能事后挨打。
  // 宿主校验插件拦不住，但**可以在派发前自查**：本工具读当前白名单，回答
  // 「这对路由现在能不能用于子代理派发」，不能时列出该 provider 名下真正可用的模型。
  register(defineTool({
    name: 'harness_route_check',
    description:
      'Check whether a provider/model route would be ACCEPTED for subagent dispatch BEFORE spawning '
      + '(the host rejects disallowed pairs with "child LLM route ... is not allowed for this Session"). '
      + 'Pass provider+model for a verdict, provider alone to list its allowed models, or nothing for an overview. '
      + 'Use this whenever you are about to spawn a subagent with an explicit model and are not certain the pair exists.',
    parameters: {
      provider: { type: 'string', description: 'Provider id as used in subagent model routes (e.g. harness-qoder-cn, harness-workbuddy-intl, xiaomi)' },
      model: { type: 'string', description: 'Model id (e.g. Qwen3.8-Flash, mimo-v2.6-flash)' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args: any): Promise<{ text: string }> {
      const provider = typeof args.provider === 'string' ? args.provider.trim() : ''
      const model = typeof args.model === 'string' ? args.model.trim() : ''
      if (deps.routeCheck === undefined) {
        return textOutput('✗ harness_route_check 在当前装配里不可用（子代理模型白名单门面未挂载）——无法自查，派发前的路由对无法验证。')
      }
      const info = deps.routeCheck()
      if (!info.available) {
        return textOutput(`✗ 读不到子代理模型白名单，无法自查：${info.reason}\n怎么办：先在设置页确认「子代理模型选择」是否启用；不要凭记忆猜路由对。`)
      }
      const head = `子代理模型白名单：enabled=${info.enabled ?? '(未回报)'} revision=${info.revision ?? '(未回报)'} 路由 ${info.routes.length} 条`
      const providerCounts = new Map<string, number>()
      for (const route of info.routes) providerCounts.set(route.provider, (providerCounts.get(route.provider) ?? 0) + 1)
      if (provider.length === 0 && model.length === 0) {
        const lines = [head, '按 provider 分组：']
        for (const [name, count] of [...providerCounts.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  ${name}: ${count} 条`)
        if (providerCounts.size === 0) lines.push('  （白名单为空 ⇒ 任何显式 provider/model 的子代理派发都会被宿主拒绝）')
        lines.push('用法：传 provider 单查一个；传 provider+model 做派发前判定。')
        return textOutput(lines.join('\n'))
      }
      if (model.length === 0) {
        const allowed = info.routes.filter(route => route.provider === provider).map(route => route.model)
        const candidates = info.candidates.filter(entry => entry.provider === provider)
        const lines = [`provider "${provider}" 在白名单里的模型（${allowed.length} 条）：`]
        for (const entry of allowed) lines.push(`  ✅ ${entry}`)
        if (allowed.length === 0) lines.push('  （一条都没有 ⇒ 该 provider 名下任何模型都会被宿主拒绝）')
        if (candidates.length > 0) {
          lines.push(`目录候选（${candidates.length} 条；✅=已在白名单，❌=可选但未加白）：`)
          for (const entry of candidates.slice(0, 40)) lines.push(`  ${entry.enabled ? '✅' : '❌'} ${entry.model}`)
        }
        return textOutput([head, ...lines].join('\n'))
      }
      const pairAllowed = info.routes.some(route => route.provider === provider && route.model === model)
      if (pairAllowed) {
        return textOutput([head, `✅ ${provider}/${model} 在白名单里：子代理派发可用。`].join('\n'))
      }
      const servingProviders = info.routes.filter(route => route.model === model).map(route => route.provider)
      const providerModels = info.routes.filter(route => route.provider === provider).map(route => route.model)
      const lines = [
        head,
        `✗ ${provider}/${model} **不在白名单**：现在派发子代理会被宿主拒绝（child LLM route "…" is not allowed for this Session）——**先不要派**。`,
      ]
      if (servingProviders.length > 0) lines.push(`模型 "${model}" 目前挂在：${servingProviders.join(', ')}。用它请改派到这些 provider。`)
      else lines.push(`模型 "${model}" 不在任何白名单条目里（可能根本不是子代理可选模型）。`)
      if (providerModels.length > 0) lines.push(`provider "${provider}" 名下可用的模型：${providerModels.join(', ')}。`)
      else lines.push(`provider "${provider}" 名下白名单为空：先在设置页给它加模型，或改用其他 provider。`)
      lines.push('白名单可以在插件设置页增删；本工具只读，不代写。')
      return textOutput(lines.join('\n'))
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_route_check ${String(args.provider ?? '')}${args.model ? '/' + String(args.model) : ''}`.trim(), kind: 'read' as const }
    },
  }), 'harness_route_check')

  void config
}

