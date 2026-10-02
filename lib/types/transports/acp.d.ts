import type { DispatchOutcome, DispatchSpec, TargetConfig } from '../types.js';
/** ACP 通道的可用性探测结果。 */
export interface AcpProbeResult {
    available: boolean;
    detail?: string;
}
/**
 * 廉价可用性探测：只解析命令（`where.exe` + 文件系统检查），绝不 spawn 进程。
 * 语义跟 headless 的 `probeCommand` 一致：探不出来也不抛错，只回 available=false。
 */
export declare function probeAcp(target: TargetConfig): AcpProbeResult;
/**
 * 跑一次 ACP 派发；永不 reject（异常全部折叠成 stopReason）。
 *
 * 用的是 1.4.0 的新 API `client({name}).connectWith(stream, op)`
 * （`ClientSideConnection` 在 1.4.0 里已标 @deprecated，不再使用）。
 */
export declare function dispatchAcp(spec: DispatchSpec): Promise<DispatchOutcome>;
