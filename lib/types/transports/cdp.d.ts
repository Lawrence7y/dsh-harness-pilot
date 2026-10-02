import type { DispatchOutcome, DispatchSpec, ReadResult, TargetConfig } from '../types.js';
export interface CdpTargetInfo {
    id: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
}
export interface CdpSession {
    readonly target: string;
    readonly port: number;
    readonly pageId: string;
    /** 读对话 / 可见正文。 */
    read(options: {
        limit: number;
    }): Promise<ReadResult>;
    /** 往 harness 输入框插入文本，可选提交。 */
    send(input: {
        text: string;
        submit?: boolean;
    }): Promise<{
        note: string;
    }>;
    /** 逃生舱：在页面里求值一个表达式，返回 JSON 化后的值。 */
    evaluate(expression: string): Promise<unknown>;
    /** Real CDP mouse input (synthetic DOM events hang some pages, e.g. ZCode). */
    mouse(action: 'click' | 'move', x: number, y: number): Promise<void>;
    close(): Promise<void>;
}
/** 便宜的探测：这个端口上是不是已经有一个 CDP 端点在监听？永不抛错。 */
export declare function probeCdp(port: number): Promise<{
    ok: boolean;
    targets?: CdpTargetInfo[];
    detail?: string;
}>;
/** Read-only readiness check using the same ownership and single-instance rules as openCdp. */
export declare function probeCdpTarget(target: TargetConfig, port: number): Promise<{
    available: boolean;
    detail: string;
}>;
/**
 * 附着到已经在跑的调试端点，或者带着调试端口把应用拉起来再附着。
 * 失败时抛错（错误消息就是给模型看的诊断）。
 */
export declare function openCdp(target: TargetConfig, options: {
    cwd?: string;
    launch?: boolean;
    portBase: number;
    timeoutMs?: number;
}): Promise<CdpSession>;
/**
 * 一次性把任务交给 CDP：读快照 → 注入文本 → 回车 → 轮询文本变化并等它稳定。
 * 永不 reject：所有失败都折叠成 stopReason + diagnostic。
 */
export declare function dispatchCdp(spec: DispatchSpec, options: {
    session?: CdpSession;
    launch?: boolean;
    portBase?: number;
}): Promise<DispatchOutcome>;
