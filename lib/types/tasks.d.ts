import type { DispatchOutcome, DispatchSpec, TargetConfig, TransportKind } from './types.js';
export type TaskStatus = 'running' | 'completed' | 'error' | 'timeout' | 'aborted' | 'interrupted';
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
}
/** 对外（工具 / HTTP / 回执）的任务视图。 */
export interface TaskView {
    task_id: string;
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
    callback: Omit<TaskCallback, 'status'>;
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
    log?: (message: string) => void;
}
export declare class TaskManager {
    private readonly directory;
    private readonly dispatch;
    private readonly onComplete;
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
    private run;
    /** 终态回执：通知发起会话（失败只记录，不重发——重复唤醒比漏唤醒更糟）。 */
    private deliver;
    status(id: string): TaskView;
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
