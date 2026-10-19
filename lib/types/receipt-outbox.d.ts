import { join } from 'node:path';
export type ReceiptState = 'queued' | 'sending' | 'delivered' | 'uncertain' | 'failed' | 'skipped';
export interface ReceiptRecord {
    /** 稳定回执 ID：`rcpt-<taskId前8>-<序号>`；同一回执重投不改 ID（收件端据此去重）。 */
    receiptId: string;
    /** 所属任务（task ID）。 */
    taskId: string;
    /** 目标唤醒会话（DSH session id）。 */
    sessionId: string;
    state: ReceiptState;
    createdAt: number;
    updatedAt: number;
    attempts: number;
    deliveredAt?: number;
    lastError?: string;
    /** 交付摘要（脱敏后的首 200 字符；完整正文永远在任务结果文件里）。 */
    preview?: string;
}
export declare class ReceiptOutbox {
    private readonly file;
    private cache;
    /** R5：状态文件不可写的原因（损坏/未知版本）。降级后读为空、**写显式拒绝**，原字节保留。 */
    private degradedReason;
    constructor(file: string);
    /** 降级原因（undefined = 可写）。 */
    get degraded(): string | undefined;
    private load;
    private persist;
    private mutate;
    /**
     * 入队（**先于任何发送**调用）：回执先落盘，再交给投递出口。
     * 同一 receiptId 重复入队是幂等的（重投场景），不产生第二条记录。
     */
    enqueue(input: {
        readonly receiptId: string;
        readonly taskId: string;
        readonly sessionId: string;
        readonly preview?: string;
    }): ReceiptRecord;
    /**
     * **claim（R3 核心）**：调用外部 send **之前**，把状态原子落盘为 `sending`（attempts+1）。
     * 落盘成功后进程才允许去碰外部世界 —— 这样「宿主已接受但本地没来得及 settle」的崩溃
     * 在磁盘上留下 `sending` 证据，重启后归 `uncertain`，**绝不**再进补投队列。
     */
    claim(receiptId: string): ReceiptRecord | undefined;
    /** 投递前被判为不应发送（notify=false / 目的会话不一致等）：终态记账，留审计。 */
    markSkipped(receiptId: string, reason: string): void;
    markDelivered(receiptId: string): void;
    markFailed(receiptId: string, error: string): void;
    markUncertain(receiptId: string, error?: string): void;
    get(receiptId: string): ReceiptRecord | undefined;
    list(): ReceiptRecord[];
    /** 入队但从未尝试发送的回执（重启补投的**唯一**对象：queued 且 attempts===0）。 */
    pendingNeverAttempted(): ReceiptRecord[];
    /**
     * 重启恢复：磁盘上的 `sending`（进程死在 claim 与 settle 之间）归 `uncertain`。
     * 只在文件**可写**时执行；没有 sending 记录时不写盘。返回改判条数。
     */
    recoverInterrupted(): number;
    /**
     * **统一投递出口（R3）**：claim（原子落盘 sending）→ send → settle。
     * 普通投递（TaskManager.deliver）与重启补投（drain）都走这一个方法，
     * 保证「磁盘状态先于外部副作用」这一顺序只有一处实现。
     *
     * `options.skipIf`：发送前的任务账本协调检查（notify 开关/目的会话一致性）——
     * 命中则不 claim、不发送，记账 `skipped`。
     */
    deliverOutbox(record: ReceiptRecord, send: () => Promise<string | void>, options?: {
        skipIf?: () => string | null;
    }): Promise<{
        result: 'delivered' | 'uncertain' | 'failed' | 'skipped';
        error?: string;
        receipt?: string;
    }>;
    /**
     * 重启补投：只投 `queued && attempts === 0`（从未尝试；「发送前崩溃」边界）。
     * sending/uncertain/failed/delivered/skipped 一律不动 —— 旧 sending/uncertain 不盲目补投。
     * 与普通投递共用 `deliverOutbox`（同一 claim→send→settle 顺序）。
     */
    drain(send: (record: ReceiptRecord) => Promise<string | void>, options?: {
        skipIf?: (record: ReceiptRecord) => string | null;
    }): Promise<{
        sent: number;
        skipped: number;
        failed: number;
    }>;
}
/** 回执 ID 规则的唯一落点（tasks.ts 与重启补投共用同一形状）。 */
export declare function receiptIdFor(taskId: string, seq: number): string;
export { join as outboxPathJoin };
