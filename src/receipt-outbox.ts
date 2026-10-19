/**
 * 回执持久化小模块（最小改造执行计划 P4；v2 按 Codex 审查 R3/R5 重做投递状态机）。
 *
 * 职责：终态回执**先落盘、再投递**；投递状态可查询；重启后只补投「入队但从未尝试发送」
 * 的回执（至少一次投递），`sending`/`uncertain` 等已有发送证据的状态**不盲目补投**。
 * 收件端按 receipt ID 去重 —— 文本里的去重 ID 只是给 Leader 的提示，**程序级保证**来自
 * 这里的状态机：`claim（原子落盘 sending）→ send → settle`，普通投递与重启补投
 * 走**同一个** `deliverOutbox()` 出口。
 *
 * 状态区分（与计划逐条对应，callback=delivered ≠ 消费确认）：
 *   queued     已落盘待投递（结果已保存；从未尝试发送 ⇒ 重启后可补投）
 *   sending    已 claim、发送进行中（**发送前原子落盘**；重启后由 recoverInterrupted 归 uncertain）
 *   delivered  宿主接受了投递（followup 入队 / 唤醒链成功）—— **不代表 Leader 已读过或处理**
 *   uncertain  发送中断（进程死亡/返回不确定），无法确认是否送达（不自动重发，不换 ID）
 *   failed     宿主明确拒绝（结果不受影响，可用任务账本读回）
 *   skipped    投递前被任务账本/开关判为不应发送（notify=false、目的会话不一致等；终态，留审计）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ReceiptState = 'queued' | 'sending' | 'delivered' | 'uncertain' | 'failed' | 'skipped'

export interface ReceiptRecord {
  /** 稳定回执 ID：`rcpt-<taskId前8>-<序号>`；同一回执重投不改 ID（收件端据此去重）。 */
  receiptId: string
  /** 所属任务（task ID）。 */
  taskId: string
  /** 目标唤醒会话（DSH session id）。 */
  sessionId: string
  state: ReceiptState
  createdAt: number
  updatedAt: number
  attempts: number
  deliveredAt?: number
  lastError?: string
  /** 交付摘要（脱敏后的首 200 字符；完整正文永远在任务结果文件里）。 */
  preview?: string
}

interface ReceiptOutboxFile {
  version: 1
  receipts: Record<string, ReceiptRecord>
}

const EMPTY: ReceiptOutboxFile = { version: 1, receipts: {} }

export class ReceiptOutbox {
  private readonly file: string
  private cache: ReceiptOutboxFile | undefined
  /** R5：状态文件不可写的原因（损坏/未知版本）。降级后读为空、**写显式拒绝**，原字节保留。 */
  private degradedReason: string | undefined

  constructor(file: string) {
    this.file = file
  }

  /** 降级原因（undefined = 可写）。 */
  get degraded(): string | undefined {
    this.load()
    return this.degradedReason
  }

  private load(): ReceiptOutboxFile {
    if (this.cache !== undefined) return this.cache
    try {
      if (!existsSync(this.file)) {
        this.cache = { ...EMPTY }
        return this.cache
      }
      const rawText = readFileSync(this.file, 'utf8')
      let raw: { version?: unknown, receipts?: unknown }
      try {
        raw = JSON.parse(rawText) as { version?: unknown, receipts?: unknown }
      } catch {
        this.degradedReason = `outbox 文件不是合法 JSON（${this.file}）；原字节已保留，写入被显式拒绝，请人工隔离/恢复`
        this.cache = { ...EMPTY }
        return this.cache
      }
      if (raw.version !== 1 || raw.receipts === null || typeof raw.receipts !== 'object' || Array.isArray(raw.receipts)) {
        this.degradedReason = `outbox 文件版本不受支持（version=${String(raw.version)}，期望 1；${this.file}）；原字节已保留，写入被显式拒绝`
        this.cache = { ...EMPTY }
        return this.cache
      }
      const receipts: Record<string, ReceiptRecord> = {}
      for (const [key, value] of Object.entries(raw.receipts as Record<string, unknown>)) {
        const rec = value as Partial<ReceiptRecord> | null
        if (rec === null || typeof rec !== 'object') continue
        if (typeof rec.receiptId !== 'string' || rec.receiptId.length === 0) continue
        receipts[key] = {
          receiptId: rec.receiptId,
          taskId: typeof rec.taskId === 'string' ? rec.taskId : '',
          sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
          // sending 保留原样落盘形态：磁盘上的 sending 是「进程死在 claim 与 settle 之间」的
          // 证据，由 recoverInterrupted()（显式恢复动作）改判 uncertain，而不是读取时偷改。
          state: rec.state === 'delivered' || rec.state === 'uncertain' || rec.state === 'failed' || rec.state === 'sending' || rec.state === 'skipped'
            ? rec.state
            : 'queued',
          createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : Date.now(),
          updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now(),
          attempts: typeof rec.attempts === 'number' && Number.isFinite(rec.attempts) ? rec.attempts : 0,
          ...(typeof rec.deliveredAt === 'number' ? { deliveredAt: rec.deliveredAt } : {}),
          ...(typeof rec.lastError === 'string' && rec.lastError.length > 0 ? { lastError: rec.lastError } : {}),
          ...(typeof rec.preview === 'string' && rec.preview.length > 0 ? { preview: rec.preview } : {}),
        }
      }
      this.cache = { version: 1, receipts }
      return this.cache
    } catch (error: unknown) {
      this.degradedReason = `outbox 文件读取失败（${this.file}）：${error instanceof Error ? error.message : String(error)}；原字节已保留，写入被显式拒绝`
      this.cache = { ...EMPTY }
      return this.cache
    }
  }

  private persist(): void {
    if (this.degradedReason !== undefined) {
      throw new Error(`receipt outbox file is not writable: ${this.degradedReason}`)
    }
    const data = this.load()
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8' })
    renameSync(tmp, this.file)
  }

  private mutate(receiptId: string, fn: (record: ReceiptRecord) => void): ReceiptRecord | undefined {
    const data = this.load()
    const record = data.receipts[receiptId]
    if (record === undefined) return undefined
    fn(record)
    record.updatedAt = Date.now()
    this.persist()
    return record
  }

  /**
   * 入队（**先于任何发送**调用）：回执先落盘，再交给投递出口。
   * 同一 receiptId 重复入队是幂等的（重投场景），不产生第二条记录。
   */
  enqueue(input: {
    readonly receiptId: string
    readonly taskId: string
    readonly sessionId: string
    readonly preview?: string
  }): ReceiptRecord {
    const data = this.load()
    const existing = data.receipts[input.receiptId]
    if (existing !== undefined) return existing
    const now = Date.now()
    const record: ReceiptRecord = {
      receiptId: input.receiptId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      ...(input.preview === undefined ? {} : { preview: input.preview.slice(0, 200) }),
    }
    data.receipts[input.receiptId] = record
    this.persist()
    return record
  }

  /**
   * **claim（R3 核心）**：调用外部 send **之前**，把状态原子落盘为 `sending`（attempts+1）。
   * 落盘成功后进程才允许去碰外部世界 —— 这样「宿主已接受但本地没来得及 settle」的崩溃
   * 在磁盘上留下 `sending` 证据，重启后归 `uncertain`，**绝不**再进补投队列。
   */
  claim(receiptId: string): ReceiptRecord | undefined {
    return this.mutate(receiptId, record => {
      record.state = 'sending'
      record.attempts += 1
    })
  }

  /** 投递前被判为不应发送（notify=false / 目的会话不一致等）：终态记账，留审计。 */
  markSkipped(receiptId: string, reason: string): void {
    this.mutate(receiptId, record => {
      record.state = 'skipped'
      record.lastError = reason.slice(0, 400)
    })
  }

  markDelivered(receiptId: string): void {
    this.mutate(receiptId, record => {
      record.state = 'delivered'
      record.deliveredAt = Date.now()
      record.lastError = undefined
    })
  }

  markFailed(receiptId: string, error: string): void {
    this.mutate(receiptId, record => {
      record.state = 'failed'
      record.lastError = error.slice(0, 400)
    })
  }

  markUncertain(receiptId: string, error?: string): void {
    this.mutate(receiptId, record => {
      record.state = 'uncertain'
      if (error !== undefined) record.lastError = error.slice(0, 400)
    })
  }

  get(receiptId: string): ReceiptRecord | undefined {
    return this.load().receipts[receiptId]
  }

  list(): ReceiptRecord[] {
    return Object.values(this.load().receipts).sort((left, right) => right.createdAt - left.createdAt)
  }

  /** 入队但从未尝试发送的回执（重启补投的**唯一**对象：queued 且 attempts===0）。 */
  pendingNeverAttempted(): ReceiptRecord[] {
    return this.list().filter(record => record.state === 'queued' && record.attempts === 0)
  }

  /**
   * 重启恢复：磁盘上的 `sending`（进程死在 claim 与 settle 之间）归 `uncertain`。
   * 只在文件**可写**时执行；没有 sending 记录时不写盘。返回改判条数。
   */
  recoverInterrupted(): number {
    const records = this.list().filter(record => record.state === 'sending')
    if (records.length === 0) return 0
    for (const record of records) {
      this.mutate(record.receiptId, target => {
        target.state = 'uncertain'
        target.lastError = 'process ended between claim and settle; delivery outcome unknown (not resent)'
      })
    }
    return records.length
  }

  /**
   * **统一投递出口（R3）**：claim（原子落盘 sending）→ send → settle。
   * 普通投递（TaskManager.deliver）与重启补投（drain）都走这一个方法，
   * 保证「磁盘状态先于外部副作用」这一顺序只有一处实现。
   *
   * `options.skipIf`：发送前的任务账本协调检查（notify 开关/目的会话一致性）——
   * 命中则不 claim、不发送，记账 `skipped`。
   */
  async deliverOutbox(record: ReceiptRecord, send: () => Promise<string | void>, options: { skipIf?: () => string | null } = {}): Promise<{ result: 'delivered' | 'uncertain' | 'failed' | 'skipped', error?: string, receipt?: string }> {
    const skipReason = options.skipIf !== undefined ? options.skipIf() : null
    if (skipReason !== null && skipReason.length > 0) {
      this.markSkipped(record.receiptId, skipReason)
      return { result: 'skipped', error: skipReason }
    }
    this.claim(record.receiptId)
    try {
      const receipt = await send()
      this.markDelivered(record.receiptId)
      return { result: 'delivered', ...(typeof receipt === 'string' ? { receipt } : {}) }
    } catch (error: unknown) {
      const err = error as Error & { explicitRejection?: boolean }
      const message = err instanceof Error ? err.message : String(error)
      if (err.explicitRejection === true) {
        this.markFailed(record.receiptId, message)
        return { result: 'failed', error: message }
      }
      this.markUncertain(record.receiptId, message)
      return { result: 'uncertain', error: message }
    }
  }

  /**
   * 重启补投：只投 `queued && attempts === 0`（从未尝试；「发送前崩溃」边界）。
   * sending/uncertain/failed/delivered/skipped 一律不动 —— 旧 sending/uncertain 不盲目补投。
   * 与普通投递共用 `deliverOutbox`（同一 claim→send→settle 顺序）。
   */
  async drain(send: (record: ReceiptRecord) => Promise<string | void>, options: { skipIf?: (record: ReceiptRecord) => string | null } = {}): Promise<{ sent: number, skipped: number, failed: number }> {
    let sent = 0
    let skipped = 0
    let failed = 0
    for (const record of this.pendingNeverAttempted()) {
      const skipIf = options.skipIf === undefined ? undefined : () => options.skipIf!(record)
      const outcome = await this.deliverOutbox(record, () => send(record), skipIf === undefined ? {} : { skipIf })
      if (outcome.result === 'delivered') sent += 1
      else if (outcome.result === 'skipped') skipped += 1
      else failed += 1
    }
    return { sent, skipped, failed }
  }
}

/** 回执 ID 规则的唯一落点（tasks.ts 与重启补投共用同一形状）。 */
export function receiptIdFor(taskId: string, seq: number): string {
  return `rcpt-${taskId.slice(0, 8)}-${String(seq)}`
}

export { join as outboxPathJoin }
