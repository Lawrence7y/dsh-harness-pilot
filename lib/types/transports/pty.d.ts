import type { DispatchOutcome, DispatchSpec, TargetConfig } from '../types.js';
/** 宿主 `ctx.subprocess.spawnTerminal` 的最小结构（避免耦合具体服务类型）。 */
export interface TerminalHandleLike {
    readonly pid: number;
    readonly output: NodeJS.ReadableStream;
    readonly done: Promise<unknown>;
    write(data: string): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    signalForeground(signal: string): Promise<number>;
    terminate(): Promise<void>;
}
export interface TerminalSpawnSpecLike {
    argv: readonly string[];
    cwd: string;
    env?: Record<string, string>;
    rows: number;
    cols: number;
    terminalType: string;
    graceMs: number;
    signal?: AbortSignal;
}
export type SpawnTerminal = (spec: TerminalSpawnSpecLike) => Promise<TerminalHandleLike>;
export declare function probePty(target: TargetConfig): {
    available: boolean;
    detail?: string;
};
/** 跑一次 pty 派发；永不 reject。 */
export declare function dispatchPty(spec: DispatchSpec, spawnTerminal: SpawnTerminal): Promise<DispatchOutcome>;
/** 打开一个长期存在的交互式 pty 会话（供 harness_open/harness_send 使用）。 */
export declare class PtySession {
    readonly target: string;
    private readonly screen;
    private readonly handle;
    private delivered;
    private closed;
    private buffer;
    private constructor();
    static open(target: TargetConfig, options: {
        cwd: string;
        spawnTerminal: SpawnTerminal;
        signal?: AbortSignal;
    }): Promise<PtySession>;
    get pid(): number;
    read(): {
        text: string;
        source: string;
    };
    send(input: {
        text?: string;
        submit?: boolean;
    }): Promise<{
        note: string;
    }>;
    hasDelivered(): boolean;
    get isClosed(): boolean;
    close(): Promise<void>;
}
