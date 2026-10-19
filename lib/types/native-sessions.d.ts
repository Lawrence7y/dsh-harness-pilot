/** 状态文件独立版本；读取时不认识的版本按「无记录」处理（不猜、不迁移）。 */
export declare const NATIVE_SESSIONS_VERSION = 1;
/**
 * 逻辑会话状态。
 * `idle` = 无在飞轮次、原生恢复可用（**可恢复 ≠ 丢失**）；
 * `recovery_needed` = 上一次按原生 ID 恢复失败，需要人工/上层决定，绝不静默新建；
 * `closed` = 显式关闭（记录保留，供审计）。
 */
export type NativeSessionStatus = 'idle' | 'running' | 'waiting_permission' | 'recovery_needed' | 'closed';
/** 恢复方式（来自目标声明的 nativeCli 协议能力，实测依据见 work/cli-session-audit/）。 */
export type NativeResumeKind = 'native-id' | 'mint-on-first-turn' | 'unavailable';
export interface NativeSessionRecord {
    /** 状态文件内版本（写入时固定，读取时校验）。 */
    version: 1;
    /** 稳定逻辑会话 ID（`ns-` 前缀 + UUID；与 task run ID 明确区分）。 */
    logicalId: string;
    /** 目标名（五路产品入口之一）。 */
    target: string;
    /** 账号引用（内部 id；出口必须脱敏）。 */
    accountId?: string;
    /** 会话绑定的工作目录（恢复时必须同一目录）。 */
    cwd: string;
    /** 厂商原生会话 ID（首轮结束后回填）。 */
    nativeSessionId?: string;
    resumeKind: NativeResumeKind;
    /** 结构化协议名（claude-stream-json / agy-jsonl）。 */
    protocol?: string;
    /** 首轮实测到的 CLI 版本（有则记录；未知如实留空）。 */
    cliVersion?: string;
    status: NativeSessionStatus;
    createdAt: number;
    updatedAt: number;
    /** 最近一次 run（task ID）与原生请求 ID（有则记录）。 */
    lastRunId?: string;
    lastRequestId?: string;
    /** 已完成轮数（含失败）。 */
    runCount: number;
    /** 最近一次恢复失败的可读原因（recovery_needed 时必看）。 */
    lastRecoveryError?: string;
    /**
     * 目标配方烘焙账号的绑定键（R2；`bakedAccountRefKey()` 的输出）。
     * 创建时冻结；续接时重算目标配方并与它比对 —— 配方被改动 ⇒ 显式拒绝。
     * 旧记录（v1）没有本字段 ⇒ 首次续接时**采纳**当前值（一次性回填），不拒绝。
     */
    accountRef?: string;
}
export interface NativeSessionCreateInput {
    readonly target: string;
    readonly cwd: string;
    readonly accountId?: string;
    readonly protocol?: string;
    readonly resumeKind?: NativeResumeKind;
    /** 目标配方烘焙账号的绑定键（R2；创建时冻结）。 */
    readonly accountRef?: string;
}
export declare class NativeSessionStore {
    private readonly file;
    private cache;
    /**
     * R5：状态文件**不可写**的原因（损坏/未知版本）。降级后读取按空处理（旧行为），
     * 但任何写入（create/mutate/persist）都**显式拒绝** —— 绝不用空缓存覆盖原文件。
     * 原字节保留在磁盘上，等人工恢复；错误消息里写明路径。
     */
    private degradedReason;
    constructor(file: string);
    /** 降级原因（可写性诊断用；undefined = 可写）。 */
    get degraded(): string | undefined;
    private load;
    /** 原子写（tmp + rename，与 settings.ts 同一手法）。**降级时显式拒绝**（R5：不覆盖原文件）。写失败抛给调用方。 */
    private persist;
    private mutate;
    /** 新建逻辑会话（不派发、不落原生 ID——那要等首轮 CLI 回报）。 */
    create(input: NativeSessionCreateInput): NativeSessionRecord;
    /**
     * 旧记录（无 accountRef）首次续接时采纳当前目标配方（R2 的一次性回填）。
     * 已有值时**不覆盖**（那要经显式冲突处理）。
     */
    adoptAccountRef(logicalId: string, accountRef: string): void;
    get(logicalId: string): NativeSessionRecord | undefined;
    list(options?: {
        includeClosed?: boolean;
    }): NativeSessionRecord[];
    /** 一轮开始（进程将要 spawn）。 */
    beginRun(logicalId: string, runId: string): NativeSessionRecord | undefined;
    /** 回填原生会话 ID / 请求 ID（有则记录；未知字段如实留空）。 */
    recordNative(logicalId: string, info: {
        readonly nativeSessionId?: string;
        readonly requestId?: string;
        readonly resumeKind?: NativeResumeKind;
        readonly protocol?: string;
        readonly cliVersion?: string;
    }): NativeSessionRecord | undefined;
    /**
     * 轮次终态后的状态落点。`completed/aborted/timeout` ⇒ idle（可恢复）；恢复失败 ⇒ recovery_needed。
     *
     * R6（Codex 复审）双重防误结算：
     *   · **owner 校验**：`ownerRunId` 给出时，只有 `record.lastRunId === ownerRunId`
     *     （= 本轮真的 beginRun 过且仍是最近一轮）才结算；排队被拒/陈旧轮传不进正确的
     *     owner，调用侧也不该传 —— 双保险。
     *   · **closed 终态保护**：`closed` 是显式关闭，任何轮次结算都不得把它改回其他状态。
     */
    finishRun(logicalId: string, outcome: {
        readonly runState?: 'completed' | 'failed' | 'cancelled' | 'recovery_needed' | 'waiting_permission' | 'upstream_queued' | 'unknown';
        readonly recoveryError?: string;
    }, ownerRunId?: string): NativeSessionRecord | undefined;
    /** 显式关闭（记录保留，供审计；closed 不出现在默认列表）。 */
    close(logicalId: string): boolean;
}
/**
 * 单会话写入互斥：同一 key（逻辑会话 ID）串行，不同 key 并行。
 *
 * 放在本层而不是进程池：进程池管的是「全局限额」，这里管的是「同一厂商会话的轮次顺序」
 * （厂商 CLI 对同一会话的并发写入没有契约，串行是唯一安全语义）。
 * 前一轮抛错不阻塞下一轮（链路用 catch 吸收），避免一次失败把会话永久卡死。
 */
export declare class SessionMutex {
    private readonly chains;
    isBusy(key: string): boolean;
    busyKeys(): readonly string[];
    runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
