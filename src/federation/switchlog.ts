/**
 * 账号切换事件账本。
 *
 * 用户的硬性要求：切换事件必须包含
 *   **切换原因、前后脱敏账号、时间、恢复方式、结果**，
 * 并且要能在**会话、子代理页面、团队成员详情**里看得到。
 *
 * 两条纪律：
 *   1. **只存脱敏账号**。原始 accountId 一律不落盘 —— 落盘的东西会被导出、被截图、
 *      被贴进 issue，所以脱敏必须发生在**写入之前**，而不是显示的时候。
 *   2. **有上限**。切换事件会随任务量增长；这里做环形裁剪，且保留最近的完整记录。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 一次切换尝试的结果。`failed` 也要记 —— 失败同样是用户要知道的事实。 */
export type SwitchResult = 'switched' | 'failed' | 'refused'

export interface SwitchEventRecord {
  /** 事件 id（也是排序键）。 */
  readonly id: string
  /** 发生时间（ISO）。 */
  readonly at: string
  /** 属于哪个会话 / 任务 / 团队成员。 */
  readonly scope: { readonly kind: 'session' | 'task' | 'member', readonly id: string }
  readonly harnessId: string
  /** **已脱敏**的账号标签。 */
  readonly fromAccount: string
  readonly toAccount: string
  /** 为什么切（或为什么不切）。 */
  readonly reason: string
  readonly recovery: 'native-resume' | 'checkpoint-new-session' | 'none'
  /** 交接边界：哪些保留、哪些不保留。**必须写清**。 */
  readonly boundary: string
  readonly result: SwitchResult
  /** 触发方式：用户手动 / 自动（额度耗尽）/ 被拒绝。 */
  readonly trigger: 'manual' | 'auto-quota' | 'policy-refused'
  /** 模型是否保住；false 时界面必须显式提示。 */
  readonly modelPreserved: boolean
  readonly model?: string
  readonly provider?: string
  /** 失败/拒绝的原因细节。 */
  readonly detail?: string
}

export interface SwitchLogFile {
  readonly version: 1
  readonly events: readonly SwitchEventRecord[]
  readonly updatedAt: string
}

const EMPTY: SwitchLogFile = { version: 1, events: [], updatedAt: new Date(0).toISOString() }

export function loadSwitchLog(file: string): SwitchLogFile {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SwitchLogFile>
    const events = Array.isArray(raw.events) ? raw.events.filter(isRecord) : []
    return { version: 1, events, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : EMPTY.updatedAt }
  } catch {
    return EMPTY
  }
}

function isRecord(value: unknown): value is SwitchEventRecord {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<SwitchEventRecord>
  return typeof v.id === 'string' && typeof v.at === 'string' && typeof v.result === 'string'
}

/**
 * 追加一条切换事件。
 *
 * @param maxEvents 超过就丢最旧的（**保留最新的**，因为排查看的是最近发生了什么）。
 */
export function appendSwitchEvent(
  state: SwitchLogFile,
  event: Omit<SwitchEventRecord, 'id' | 'at'> & { at?: string },
  maxEvents = 500,
  now = new Date(),
): SwitchLogFile {
  const at = event.at ?? now.toISOString()
  const id = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const record: SwitchEventRecord = { ...event, id, at }
  const events = [...state.events, record]
  const trimmed = events.length > maxEvents ? events.slice(events.length - maxEvents) : events
  return { version: 1, events: trimmed, updatedAt: at }
}

export function saveSwitchLog(file: string, state: SwitchLogFile): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * 按作用域取事件（会话 / 任务 / 团队成员详情页用）。
 * 返回**新的在前**，便于直接渲染。
 */
export function eventsFor(state: SwitchLogFile, scope: SwitchEventRecord['scope']): SwitchEventRecord[] {
  return state.events
    .filter(e => e.scope.kind === scope.kind && e.scope.id === scope.id)
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** 某个任务已经自动切换过几次 —— 上限与退避判定要用。 */
export function autoSwitchCount(state: SwitchLogFile, scopeId: string): number {
  return state.events.filter(e => e.scope.id === scopeId && e.trigger === 'auto-quota' && e.result === 'switched').length
}

/** 最近一次切换时间（毫秒）；没有则 undefined。 */
export function lastSwitchAtMs(state: SwitchLogFile, scopeId: string): number | undefined {
  const times = state.events
    .filter(e => e.scope.id === scopeId && e.result === 'switched')
    .map(e => Date.parse(e.at))
    .filter(t => Number.isFinite(t))
  return times.length === 0 ? undefined : Math.max(...times)
}

/**
 * 落盘前的最后一道检查：**不得**出现未脱敏的账号标识。
 * 这是「脱敏必须发生在写入之前」的强制点，而不是靠调用方自觉。
 */
export function findUnredacted(state: SwitchLogFile, rawAccountIds: readonly string[]): string[] {
  const hits: string[] = []
  for (const event of state.events) {
    for (const raw of rawAccountIds) {
      if (raw.length === 0) continue
      if (event.fromAccount.includes(raw) || event.toAccount.includes(raw)) {
        hits.push(`${event.id}: ${raw}`)
      }
    }
  }
  return hits
}

export { existsSync }
