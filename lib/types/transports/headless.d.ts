import type { DispatchOutcome, DispatchSpec } from '../types.js';
/** 整棵进程树终止（Windows 用 taskkill /T，POSIX 用进程组）。 */
export declare function killTree(pid: number | undefined): void;
/** 拼接一次 headless 调用的完整 argv（prompt 走末尾参数或 stdin）。 */
export declare function headlessArgv(spec: DispatchSpec): {
    argv: string[];
    stdinText?: string;
    resolved: string;
    verbatim: boolean;
};
/** 跑一次 headless 派发；永不 reject（异常折叠成 stopReason）。 */
export declare function dispatchHeadless(spec: DispatchSpec): Promise<DispatchOutcome>;
