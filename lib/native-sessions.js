/**
 * 持久原生会话层（最小改造执行计划 P1）。
 *
 * 职责：把「逻辑会话 ID → 厂商原生会话 ID」的映射**持久化**，让外部 CLI 进程在轮次结束
 * 后可以退出，下一轮按精确的原生会话 ID 恢复（`--resume <nativeId>` / `--conversation <id>`）。
 *
 * 设计纪律（与执行计划逐条对应）：
 *   · 「逻辑会话存在」与「交互进程在线」是两件事：本模块只管前者；进程在线状态仍在
 *     SessionRegistry 的交互会话表里，两者互不冒充。
 *   · 独立版本号 + 原子写（tmp + rename）；**老任务/老会话账本只读兼容，绝不批量重写**。
 *   · 原生恢复失败必须显式标记 `recovery_needed`，不静默新建会话。
 *   · 正常 CLI 退出后记录保留，状态回到 `idle`（= 可恢复），不显示成「会话丢失」。
 *   · 单会话写入互斥（SessionMutex）：同一逻辑会话同时只允许一轮；不同会话保持并行。
 *
 * 账号引用（accountId）在本模块内**只存内部 id**；所有对外输出必须经 tasks.ts /
 * task-tools.ts 已有的 `redactAccount` 脱敏出口，本模块不做第二套脱敏。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/** 状态文件独立版本；读取时不认识的版本按「无记录」处理（不猜、不迁移）。 */
export const NATIVE_SESSIONS_VERSION = 1;
const EMPTY_FILE = { version: NATIVE_SESSIONS_VERSION, sessions: {} };
export class NativeSessionStore {
    file;
    cache;
    /**
     * R5：状态文件**不可写**的原因（损坏/未知版本）。降级后读取按空处理（旧行为），
     * 但任何写入（create/mutate/persist）都**显式拒绝** —— 绝不用空缓存覆盖原文件。
     * 原字节保留在磁盘上，等人工恢复；错误消息里写明路径。
     */
    degradedReason;
    constructor(file) {
        this.file = file;
    }
    /** 降级原因（可写性诊断用；undefined = 可写）。 */
    get degraded() {
        this.load();
        return this.degradedReason;
    }
    load() {
        if (this.cache !== undefined)
            return this.cache;
        try {
            if (!existsSync(this.file)) {
                this.cache = { version: NATIVE_SESSIONS_VERSION, sessions: {} };
                return this.cache;
            }
            const rawText = readFileSync(this.file, 'utf8');
            let raw;
            try {
                raw = JSON.parse(rawText);
            }
            catch {
                // R5：损坏 ⇒ 降级不可写（读为空、写拒绝），原字节保留待人工恢复。
                this.degradedReason = `状态文件不是合法 JSON（${this.file}）；原字节已保留，写入被显式拒绝，请人工隔离/恢复该文件`;
                this.cache = { ...EMPTY_FILE };
                return this.cache;
            }
            // 版本不符按「无记录」处理：不猜旧格式，不批量迁移（老账本只读兼容的边界）。
            // R5：未知版本同样降级不可写 —— 不能因为读不懂就把（可能是更新版本写的）文件覆盖掉。
            if (raw.version !== NATIVE_SESSIONS_VERSION || raw.sessions === null || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions)) {
                this.degradedReason = `状态文件版本不受支持（version=${String(raw.version)}，期望 ${NATIVE_SESSIONS_VERSION}；${this.file}）；原字节已保留，写入被显式拒绝`;
                this.cache = { ...EMPTY_FILE };
                return this.cache;
            }
            const sessions = {};
            for (const [key, value] of Object.entries(raw.sessions)) {
                const rec = value;
                if (rec === null || typeof rec !== 'object')
                    continue;
                if (typeof rec.logicalId !== 'string' || rec.logicalId.length === 0)
                    continue;
                // 老记录缺字段补默认（只读兼容；不回写历史，只在下次该会话更新时带出新形状）。
                sessions[key] = {
                    version: 1,
                    logicalId: rec.logicalId,
                    target: typeof rec.target === 'string' ? rec.target : '',
                    ...(typeof rec.accountId === 'string' && rec.accountId.length > 0 ? { accountId: rec.accountId } : {}),
                    cwd: typeof rec.cwd === 'string' ? rec.cwd : '',
                    ...(typeof rec.nativeSessionId === 'string' && rec.nativeSessionId.length > 0 ? { nativeSessionId: rec.nativeSessionId } : {}),
                    resumeKind: rec.resumeKind === 'native-id' || rec.resumeKind === 'mint-on-first-turn' ? rec.resumeKind : 'unavailable',
                    ...(typeof rec.protocol === 'string' && rec.protocol.length > 0 ? { protocol: rec.protocol } : {}),
                    ...(typeof rec.cliVersion === 'string' && rec.cliVersion.length > 0 ? { cliVersion: rec.cliVersion } : {}),
                    status: rec.status === 'running' || rec.status === 'waiting_permission' || rec.status === 'recovery_needed' || rec.status === 'closed'
                        ? rec.status
                        : 'idle',
                    createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : Date.now(),
                    updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now(),
                    ...(typeof rec.lastRunId === 'string' && rec.lastRunId.length > 0 ? { lastRunId: rec.lastRunId } : {}),
                    ...(typeof rec.lastRequestId === 'string' && rec.lastRequestId.length > 0 ? { lastRequestId: rec.lastRequestId } : {}),
                    runCount: typeof rec.runCount === 'number' && Number.isFinite(rec.runCount) ? rec.runCount : 0,
                    ...(typeof rec.lastRecoveryError === 'string' && rec.lastRecoveryError.length > 0 ? { lastRecoveryError: rec.lastRecoveryError } : {}),
                    ...(typeof rec.accountRef === 'string' ? { accountRef: rec.accountRef } : {}),
                };
            }
            this.cache = { version: NATIVE_SESSIONS_VERSION, sessions };
            return this.cache;
        }
        catch (error) {
            // 读不到（权限/IO）同样降级：能写不能读的账本更危险 —— 绝不覆盖我们读不出来的文件。
            this.degradedReason = `状态文件读取失败（${this.file}）：${error instanceof Error ? error.message : String(error)}；原字节已保留，写入被显式拒绝`;
            this.cache = { ...EMPTY_FILE };
            return this.cache;
        }
    }
    /** 原子写（tmp + rename，与 settings.ts 同一手法）。**降级时显式拒绝**（R5：不覆盖原文件）。写失败抛给调用方。 */
    persist() {
        if (this.degradedReason !== undefined) {
            throw new Error(`native session state file is not writable: ${this.degradedReason}`);
        }
        const data = this.load();
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8' });
        renameSync(tmp, this.file);
    }
    mutate(logicalId, fn) {
        const data = this.load();
        const record = data.sessions[logicalId];
        if (record === undefined)
            return undefined;
        fn(record);
        record.updatedAt = Date.now();
        this.persist();
        return record;
    }
    /** 新建逻辑会话（不派发、不落原生 ID——那要等首轮 CLI 回报）。 */
    create(input) {
        const logicalId = `ns-${randomUUID()}`;
        const now = Date.now();
        const record = {
            version: 1,
            logicalId,
            target: input.target,
            ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
            cwd: input.cwd,
            resumeKind: input.resumeKind ?? 'unavailable',
            ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
            ...(input.accountRef === undefined ? {} : { accountRef: input.accountRef }),
            status: 'idle',
            createdAt: now,
            updatedAt: now,
            runCount: 0,
        };
        const data = this.load();
        data.sessions[logicalId] = record;
        this.persist();
        return record;
    }
    /**
     * 旧记录（无 accountRef）首次续接时采纳当前目标配方（R2 的一次性回填）。
     * 已有值时**不覆盖**（那要经显式冲突处理）。
     */
    adoptAccountRef(logicalId, accountRef) {
        this.mutate(logicalId, record => {
            if (record.accountRef === undefined)
                record.accountRef = accountRef;
        });
    }
    get(logicalId) {
        return this.load().sessions[logicalId];
    }
    list(options = {}) {
        const rows = Object.values(this.load().sessions);
        const kept = options.includeClosed === true ? rows : rows.filter(row => row.status !== 'closed');
        return kept.sort((left, right) => right.updatedAt - left.updatedAt);
    }
    /** 一轮开始（进程将要 spawn）。 */
    beginRun(logicalId, runId) {
        return this.mutate(logicalId, record => {
            record.status = 'running';
            record.lastRunId = runId;
            record.runCount += 1;
        });
    }
    /** 回填原生会话 ID / 请求 ID（有则记录；未知字段如实留空）。 */
    recordNative(logicalId, info) {
        return this.mutate(logicalId, record => {
            if (info.nativeSessionId !== undefined && info.nativeSessionId.length > 0) {
                record.nativeSessionId = info.nativeSessionId;
                if (record.resumeKind === 'unavailable')
                    record.resumeKind = info.resumeKind ?? 'native-id';
                else if (info.resumeKind !== undefined)
                    record.resumeKind = info.resumeKind;
            }
            else if (info.resumeKind !== undefined) {
                record.resumeKind = info.resumeKind;
            }
            if (info.requestId !== undefined && info.requestId.length > 0)
                record.lastRequestId = info.requestId;
            if (info.protocol !== undefined && info.protocol.length > 0)
                record.protocol = info.protocol;
            if (info.cliVersion !== undefined && info.cliVersion.length > 0)
                record.cliVersion = info.cliVersion;
        });
    }
    /**
     * 轮次终态后的状态落点。`completed/aborted/timeout` ⇒ idle（可恢复）；恢复失败 ⇒ recovery_needed。
     *
     * R6（Codex 复审）双重防误结算：
     *   · **owner 校验**：`ownerRunId` 给出时，只有 `record.lastRunId === ownerRunId`
     *     （= 本轮真的 beginRun 过且仍是最近一轮）才结算；排队被拒/陈旧轮传不进正确的
     *     owner，调用侧也不该传 —— 双保险。
     *   · **closed 终态保护**：`closed` 是显式关闭，任何轮次结算都不得把它改回其他状态。
     */
    finishRun(logicalId, outcome, ownerRunId) {
        return this.mutate(logicalId, record => {
            if (record.status === 'closed')
                return;
            if (ownerRunId !== undefined && record.lastRunId !== ownerRunId)
                return;
            switch (outcome.runState) {
                case 'completed':
                case 'cancelled':
                    record.status = 'idle';
                    record.lastRecoveryError = undefined;
                    break;
                case 'recovery_needed':
                    record.status = 'recovery_needed';
                    record.lastRecoveryError = outcome.recoveryError;
                    break;
                case 'waiting_permission':
                case 'upstream_queued':
                    // 非终态：进程已退出但明确停在这两态时如实标注（恢复入口保留）。
                    record.status = 'idle';
                    record.lastRecoveryError = undefined;
                    break;
                case 'failed':
                case 'unknown':
                default:
                    // 失败不否定原生会话的存在：保持 idle（可恢复），失败详情在任务账本里。
                    record.status = record.nativeSessionId === undefined ? 'idle' : 'idle';
                    break;
            }
        });
    }
    /** 显式关闭（记录保留，供审计；closed 不出现在默认列表）。 */
    close(logicalId) {
        return this.mutate(logicalId, record => { record.status = 'closed'; }) !== undefined;
    }
}
/**
 * 单会话写入互斥：同一 key（逻辑会话 ID）串行，不同 key 并行。
 *
 * 放在本层而不是进程池：进程池管的是「全局限额」，这里管的是「同一厂商会话的轮次顺序」
 * （厂商 CLI 对同一会话的并发写入没有契约，串行是唯一安全语义）。
 * 前一轮抛错不阻塞下一轮（链路用 catch 吸收），避免一次失败把会话永久卡死。
 */
export class SessionMutex {
    chains = new Map();
    isBusy(key) {
        return this.chains.has(key);
    }
    busyKeys() {
        return [...this.chains.keys()];
    }
    runExclusive(key, fn) {
        const prev = this.chains.get(key) ?? Promise.resolve();
        const run = prev.then(fn, fn);
        const tail = run.then(() => undefined, () => undefined);
        this.chains.set(key, tail);
        // 清理挂在 finally 派生的 promise 上：调用方观测到结算**之前**，busy 标记已摘除
        // （否则 `await runExclusive(...)` 之后立刻查 isBusy 会得到过期的 true）。
        return run.finally(() => {
            if (this.chains.get(key) === tail)
                this.chains.delete(key);
        });
    }
}
//# sourceMappingURL=native-sessions.js.map