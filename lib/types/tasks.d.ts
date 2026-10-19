import type { DispatchOutcome, DispatchSpec, TargetConfig, TransportKind } from './types.js';
import { SessionMutex, NativeSessionStore } from './native-sessions.js';
import { ReceiptOutbox } from './receipt-outbox.js';
export type TaskStatus = 'running' | 'completed' | 'error' | 'timeout' | 'aborted' | 'interrupted' | 'stalled';
/**
 * 这本账里记着两种东西：
 *   - `task`     ：`harness_task_start` 派发的后台任务（有回执、有并发上限）；
 *   - `subagent` ：`harness_agent` / 宿主 subagent 工具经 provider 派发的**内部子代理 run**。
 *
 * 后者以前是纯内存的：runId 只出现在当次工具返回的文本里，既不落盘也不进注册表，
 * 于是静默失败只能靠"预期产物缺席"反推（P7）。
 */
export type TaskKind = 'task' | 'subagent';
/** 完成回执的投递状态机。 */
export type CallbackStatus = 'pending' | 'sending' | 'delivered' | 'failed' | 'skipped' | 'uncertain';
export interface TaskCallback {
    /** 完成后是否要唤醒发起会话。 */
    notify: boolean;
    /** 发起会话（DSH session id）；为空则无法唤醒。 */
    sessionId: string;
    /** 派发时记录的续办提示（仅供上下文参考）。 */
    instruction: string;
    status: CallbackStatus;
    receipt?: string;
    error?: string;
    deliveredAt?: number;
    /**
     * **稳定回执 ID**（outbox 持久化后生成；收件端按它去重）。
     * 旧账本没有本字段 —— 只读兼容，不补投。
     */
    receiptId?: string;
}
/**
 * 迟到结算证据的**只读视图**（R9）：宽限期后执行器迟到返回的实际结果。
 * 保存在 `<tasksDir>/<taskId>.late-settlement.json`；status()/result() 发现即附加。
 * 内容保存时已经 `redactResult` 脱敏；`original_uncertain` 关联不确定快照。
 * 命名对齐 TaskView 顶层惯例（snake_case；native 子对象与 actual 一致用 camel）。
 */
export interface LateSettlementView {
    readonly version: 1;
    readonly task_id: string;
    readonly run_id: string;
    readonly logical_id: string;
    /** 迟到结算收取时间。 */
    readonly received_at: number;
    readonly stop_reason: string;
    readonly text: string;
    readonly transport?: string;
    readonly diagnostic?: string;
    readonly native?: {
        readonly sessionId?: string;
        readonly requestId?: string;
        readonly runState?: string;
        readonly protocol?: string;
        readonly sessionMode?: string;
    };
    readonly facts?: Record<string, string | number | boolean | undefined>;
    /** 原不确定快照（保留历史，不自动改成功）。 */
    readonly original_uncertain: {
        readonly status: string;
        readonly diagnostic: string;
        readonly at: number;
    };
}
/** 对外（工具 / HTTP / 回执）的任务视图。 */
export interface TaskView {
    task_id: string;
    /** 这本账里的两类东西（见 TaskKind）。 */
    kind: TaskKind;
    target: string;
    model: string | null;
    cwd: string;
    transport?: string;
    status: TaskStatus;
    created_at: number;
    updated_at: number;
    elapsed_ms: number;
    log_path: string;
    result_path: string;
    output_chars: number;
    progress_available: boolean;
    diagnostic: string | null;
    callback: TaskCallback | null;
    /** 本次任务**实际**使用的账号 / 供应商 / 模型（身份来自通道回报，不是配置值）。 */
    actual?: {
        readonly accountId?: string;
        readonly provider?: string;
        readonly model?: string;
        readonly harnessId?: string;
        readonly nativeSessionId?: string;
        readonly transport?: string;
    };
    /** Frozen request, independent of execution receipts. */
    requested?: Readonly<NonNullable<DispatchSpec['identity']>>;
    /** Old ledgers without this marker cannot establish provider/model provenance. */
    actualSource?: 'transport-outcome' | 'legacy-unverified';
    /** 请求值与实际值的偏差；非空必须显示。 */
    mismatch?: readonly string[];
    /**
     * **迟到结算证据**（R9；可选，只读）。
     *
     * 宽限期后执行器迟到返回时，任务结果视图保留不确定快照原样（不自动改成功）；
     * 实际正文/原生与请求 ID/终态/退出事实经此字段可查询，并与 `original_uncertain`
     * 快照关联。内容在**保存时**已过 `redactResult` 脱敏出口；重开 TaskManager 仍可读。
     */
    late_settlement?: LateSettlementView;
    /**
     * **持久逻辑会话**绑定（可选；只有带 session 派发的任务才有）。
     * `nativeSessionId` 是厂商原生 ID；`idle` 状态 = 进程可释放、会话可恢复（**不是丢失**）。
     * accountId 已在 store 出口脱敏（本视图只带脱敏标签）。
     */
    session?: {
        readonly logicalId: string;
        readonly nativeSessionId?: string;
        readonly resumeKind?: string;
        readonly status?: string;
        readonly account?: string;
    };
}
export interface TaskResult {
    stopReason: string;
    text: string;
    transport?: TransportKind;
    diagnostic?: string;
    facts?: Record<string, string | number | boolean | undefined>;
}
export interface StartTaskInput {
    target: TargetConfig;
    prompt: string;
    cwd: string;
    timeoutMs: number;
    model?: string;
    extraArgs?: readonly string[];
    transport?: TransportKind;
    /**
     * 本次任务**请求**的执行身份（账号 / 供应商 / 模型）。
     * 单独冻结在 requested 并透传给 DispatchSpec；不能用请求供应商/模型充当实际回报。
     */
    identity?: {
        readonly accountId?: string;
        readonly provider?: string;
        readonly model?: string;
        readonly harnessId?: string;
    };
    /**
     * **持久逻辑会话**（可选；P1/P3；R2 收紧绑定）。
     *   · `{ logicalId }` —— 继续该逻辑会话：**cwd/账号继承创建时冻结的绑定**
       *   （`session.cwd` 可显式携带，但必须与冻结值一致，否则在任何执行前拒绝）；
     *   · `{}`（logicalId 缺省）—— 新建逻辑会话（要求目标声明 nativeCli 能力）。
     * 省略整个字段 = 一次性短任务（与旧行为完全一致）。
     */
    session?: {
        readonly logicalId?: string;
        readonly cwd?: string;
    };
    callback: Omit<TaskCallback, 'status'>;
}
/** 登记一个**外部驱动**的 run（内部子代理 provider 用）。 */
export interface TrackInput {
    kind: TaskKind;
    target: TargetConfig;
    prompt: string;
    cwd: string;
    model?: string;
    identity?: Readonly<NonNullable<DispatchSpec['identity']>>;
    /**
     * 发起会话（用于停滞回执）。留空 = 只记账、不投递 ——
     * 内部子代理的调用方本来就在 await 结果，再回执一次就是重复唤醒。
     */
    callback?: Omit<TaskCallback, 'status'>;
    /** 超过这么久既无进度也无终态就标记 `stalled`；0/未给 = 不探测。 */
    stallTimeoutMs?: number;
}
/** `track()` 返回的句柄：调用方把 run 的进展喂回来。 */
export interface TrackedRun {
    readonly id: string;
    readonly view: TaskView;
    /** 追加一段过程输出（同时刷新停滞计时，并把 stalled 收回 running）。 */
    progress(chunk: string): void;
    /** run 结束（含非 completed 的 stopReason）。 */
    finish(outcome: DispatchOutcome): void;
    /** run 抛错。 */
    fail(error: Error): void;
}
export interface TaskManagerDeps {
    /** 任务三件套的落盘目录。 */
    directory: string;
    /** 真正执行派发（接 SessionRegistry.dispatch）。 */
    dispatch: (spec: DispatchSpec, options?: {
        transport?: string;
    }) => Promise<DispatchOutcome>;
    maxConcurrent: number;
    /**
     * 终态回执：把交付内容送回发起会话并唤醒它。
     * 返回送达回执说明；抛错时按 deliveryUncertain / explicitRejection 决定 `failed` 还是 `uncertain`。
     */
    onComplete?: (view: TaskView, callback: TaskCallback, result: TaskResult | null) => Promise<string>;
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
    notifyEnabled?: () => boolean;
    /**
     * **持久原生会话层**（可选；P1/P3 接线）。缺省 = 带 session 的派发显式拒绝
     * （不假装支持），一次性短任务完全不受影响。
     */
    nativeSessions?: {
        readonly store: NativeSessionStore;
        readonly mutex: SessionMutex;
    };
    /**
     * **回执 outbox**（可选；P4 接线）。挂载后终态回执先落盘（queued）再投递；
     * 缺省 = 沿用旧行为（直接投递、不落 outbox），旧组合不受影响。
     */
    outbox?: ReceiptOutbox;
    /**
     * R7：执行阶段取消/超时后，等待执行器确认终态的宽限期（毫秒）。
     * 逾期仍未确认 ⇒ 任务按「取消待确认/状态不确定」记账（不报 never executed）。
     * 缺省 15000；夹紧 [50, 60000]。
     */
    sessionSettleGraceMs?: number;
    log?: (message: string) => void;
}
/**
 * TaskView 的**唯一**脱敏出口（纯函数：不改入参、不做 I/O）。
 * 任何返回 TaskView 的路径都必须经过它 —— 含**落盘 .json 的读取路径**：
 * 本改动之前写下的历史记录里可能还是原始 id，出口不能因为「盘上是旧的」就把它放出去。
 */
export declare function redactTaskView(view: TaskView): TaskView;
/** R2：绑定目录一致性（resolve 规范化后比较；Windows 大小写不敏感）。导出供测试复用。 */
export declare function sameBindingPath(left: string, right: string): boolean;
export declare class TaskManager {
    private readonly directory;
    private readonly dispatch;
    private readonly onComplete;
    private readonly notifyEnabled;
    private readonly nativeSessions;
    private readonly outbox;
    private readonly sessionSettleGraceMs;
    private readonly log;
    private readonly tasks;
    private readonly events;
    private maxConcurrent;
    constructor(deps: TaskManagerDeps);
    setMaxConcurrent(value: number): void;
    path(id: string, suffix: string): string;
    private save;
    private view;
    /** 立即返回任务视图；真正的派发在后台跑，终态触发回执。 */
    start(input: StartTaskInput): TaskView;
    /**
     * 登记一个**外部驱动**的 run 并返回句柄。
     *
     * 为什么复用 TaskManager 而不是另造一套：三件套落盘、TaskStatus 状态机、
     * `callback.status` 记账、以及重启后把未完成 run 降级成 `interrupted`（见 `status()`）
     * 这里都已经有了。再造一份只会让"该去哪查状态"变成两个答案。
     */
    track(input: TrackInput): TrackedRun;
    /**
     * 停滞探测：run 超过 timeoutMs 既无进度也无终态 → 标记 `stalled` 并按需回执。
     *
     * 以前卡住的 run 会永远显示 `running`，用户只能靠"预期产物不存在"反推。
     * `stalled` **不是**终态：真有输出回来时 `progress()` 会把它收回 `running`。
     */
    private armStallWatch;
    private run;
    /** 终态回执：通知发起会话（失败只记录，不重发——重复唤醒比漏唤醒更糟）。 */
    private deliver;
    /**
     * R9：读取迟到结算证据（不存在/损坏 ⇒ undefined，不抛）。
     * 内容在保存时已过 redactResult；这里对文本字段再做一次整词脱敏兜底（幂等）。
     */
    private lateSettlementOf;
    status(id: string): TaskView;
    /** status() 的盘读分支（内存无此任务时）；脱敏与重启降级语义不变。 */
    private statusFromDisk;
    /**
     * R9：宽限期后执行器迟到返回的**证据落盘**（唯一写入口）。
     *
     * 只保存事实，不改写任务已终态的结果视图（不确定快照保留）、不重跑模型、
     * 不触发回执/唤醒。三段降级：late 文件 → 任务 .log 标注块 → 运行日志告警；
     * 前两级都失败时**至少**有一条可见诊断（不静默丢）。
     * 内容经 `redactResult` 脱敏出口 + 整词账号脱敏，与 task/run/会话 ID 绑定。
     */
    private saveLateSettlement;
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
    private storedStatus;
    prune(keep?: number): {
        kept: number;
        removed: string[];
        skippedRunning: string[];
        freedBytes: number;
    };
    list(): TaskView[];
    /** 进度：从 .log 里取一段（增量拉取用 offset）。 */
    progress(id: string, offset?: number, limit?: number): TaskView & {
        text: string;
        offset: number;
        next_offset: number;
        has_more: boolean;
        progress_note: string;
    };
    /** 终态结果；没到终态时 ready=false。 */
    result(id: string): TaskView & {
        ready: boolean;
        result: TaskResult | null;
    };
    cancel(id: string): {
        view: TaskView;
        cancellation_requested: boolean;
    };
    /** 等到终态（最多 timeoutMs），用于工具里的「等一小段再看」。 */
    wait(id: string, timeoutMs?: number): Promise<TaskView & {
        ready: boolean;
        result: TaskResult | null;
    }>;
    shutdown(): Promise<void>;
}
