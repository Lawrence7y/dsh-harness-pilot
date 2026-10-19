import type { SpawnObserverHost } from '../processpool.js';
import type { DispatchOutcome, DispatchSpec, NativeCliConfig, NativeCliProtocol, NativeCliConfig as NativeCliProfile, NativeRunState, NativeSessionRef } from '../types.js';
export type { NativeCliConfig, NativeCliProtocol, NativeSessionRef };
/** 归一化后的一条事件。 */
export interface NativeEvent {
    /** 厂商会话 ID（init / result 事件带出）。 */
    session?: string;
    /** 厂商请求 ID（有则记录；未知留空，绝不编造）。 */
    requestId?: string;
    /** 最终回答片段（result 事件的 response/result 字段）。 */
    answer?: string;
    /** 进度文本增量（assistant delta / step_update text_delta）。 */
    progress?: string;
    /** 结构化状态信号（可见即如实上报，不改变终态判定）。 */
    signal?: 'upstream_queued' | 'waiting_permission' | 'running';
    /** result 事件的错误标记。 */
    isError?: boolean;
    /** 厂商状态原文（agy 的 SUCCESS/ERROR；claude 的 success/error_max_turns 等）。 */
    status?: string;
    /** 事件类型名（诊断用）。 */
    kind: string;
}
/** 逐行解析：claude 风格 stream-json（WorkBuddy / WorkBuddyAI / Qoder CN CLI）。 */
export declare function parseClaudeStreamJsonLine(line: string): NativeEvent | undefined;
/** 逐行解析：agy 风格 JSONL（Antigravity）。 */
export declare function parseAgyJsonLine(line: string): NativeEvent | undefined;
/** 一次 native CLI 轮次解析的累积器（离线可测：feed 逐块喂 stdout）。 */
export declare class NativeCliStreamParser {
    private buffer;
    private readonly parseLine;
    answer: string;
    sessionId: string | undefined;
    requestId: string | undefined;
    events: number;
    signals: NativeRunState[];
    resultSeen: boolean;
    resultIsError: boolean | undefined;
    resultStatus: string | undefined;
    constructor(protocol: NativeCliProtocol);
    /** 喂一段 stdout；返回本段产生的进度文本增量。 */
    feed(chunk: string): string;
    /** 终态判据（退出码只是辅助；result 事件才是权威）。 */
    terminal(): {
        runState: NativeRunState;
        answer: string;
        diagnostic?: string;
    };
}
/** 按会话引用拼 argv 的会话段（new / resume）。 */
export declare function sessionArgsFor(profile: NativeCliProfile, ref: NativeSessionRef, requestedSessionId: string): {
    argv: readonly string[];
    mode: 'new' | 'resume';
};
/**
 * 跑一次结构化 native CLI 轮次（headless 通道的 JSONL 分支）。
 *
 * 生命周期事实（pid 登记 / 结束回报 / 整树终止）与 `dispatchHeadless` 同一套语义；
 * 差异只在输出侧：stdout 逐行喂给解析器，进度增量走 `onProgress`，最终回答只取
 * result 事件；stderr 单独累积，只进诊断。本函数永不 reject。
 */
export declare function dispatchNativeCli(spec: DispatchSpec & SpawnObserverHost): Promise<DispatchOutcome>;
