import type { SpawnObserverHost } from '../processpool.js';
import type { DispatchOutcome, DispatchSpec, TargetConfig } from '../types.js';
/** ACP 通道的可用性探测结果。 */
/**
 * ACP 通道的**偏差清单**（请求值 ≠ 实际值）。抽成导出函数是为了能**单测**：
 * 这里出过一次真实缺陷 —— 两个 `...{ mismatch: [...] }` 展开后，后者把前者整个覆盖掉，
 * 于是「模型没生效」的偏差被「extra_args 没生效」吃掉，只剩一条（甚至反过来）。
 *
 * @param applied `false` = 请求的模型没在本会话生效（ACP 没有 `--model`，只能 `session/set_config_option`）
 * @param extraArgs 本次调用方要求追加的参数（ACP 通道**不会**追加它们，必须报出来）
 */
export declare function acpMismatchOf(input: {
    readonly modelApplied: boolean | undefined;
    readonly model: string;
    readonly modelNote: string;
    readonly extraArgs: readonly string[] | undefined;
}): string[];
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
 *
 * `spec.onSpawn` 是**可选**挂钩：ACP server 是一个常驻子进程，给了挂钩就在 `spawn()`
 * 成功那一刻把「真实拉起的 pid + 启动时刻」回报出去（进程池据此登记"我拥有的进程"），
 * 拿回的回调在出口回报"何时结束 / 退出码 / 信号 / 是否被取消"。没给也能照常跑。
 */
export declare function dispatchAcp(spec: DispatchSpec & SpawnObserverHost): Promise<DispatchOutcome>;
