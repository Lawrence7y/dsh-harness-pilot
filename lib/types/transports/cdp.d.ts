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
    /**
     * `kill_first` 的记账：为了带调试端口拉起实例，终止了哪些 pid。
     * 由 `openCdp` 在终止成功后写入，上层并进会话 detail —— 破坏性操作必须可审计。
     */
    launchNote?: string;
}
/**
 * 插入校验（纯函数，2026-10-16 收紧）。
 *
 * 「值里包含尾片段」只是必要条件 —— 现场实测（P-4）：目标应用的输入框可能有自己的
 * 长度上限（450+ 字符被截到 422），截掉的恰恰是**前文**，尾片段照样在场 ⇒ 只查尾片段
 * 会把「被截断」验证成「已完整插入」，截断的 prompt 被静默提交。
 * 因此加第二条**去空白长度比对**：输入框值的非空白字符数不得比发送文本少超过 2 个
 * （容差只给无害的规范化差异；应用侧截断的量级远大于它）。
 * 两条比较都在**去空白**形态上做：应用折叠空格/归一化换行不该判失败。
 */
export declare function insertionVerified(value: string | null, text: string): boolean;
/** 便宜的探测：这个端口上是不是已经有一个 CDP 端点在监听？永不抛错。 */
export declare function probeCdp(port: number): Promise<{
    ok: boolean;
    targets?: CdpTargetInfo[];
    detail?: string;
}>;
/**
 * 单实例阻塞：目标已经在跑、但**没有**带调试端口，再启动也只会聚焦旧窗口。
 *
 * 之所以单独成类型：调用方要能**识别**这种情况，才能给出可复制的补救命令、
 * 或按 `kill_first` 自己完成整条流程 —— 而不是把它当成一条普通失败消息
 * 拼进"五档通道全试过"的聚合错误里（那样用户看不到真正的原因和端口）。
 */
export interface SingleInstanceBlockedInput {
    readonly target: string;
    readonly image: string;
    readonly pids: readonly number[];
    /** 插件真正会使用的调试端口。 */
    readonly port: number;
    /** 渲染好的补救说明（含 [A]~[E] 与脚本路径）。 */
    readonly remedy: string;
}
export declare class SingleInstanceBlocked extends Error {
    readonly target: string;
    readonly image: string;
    readonly pids: readonly number[];
    readonly port: number;
    readonly remedy: string;
    constructor(input: SingleInstanceBlockedInput);
}
export interface TerminateOptions {
    /** 优雅关闭（WM_CLOSE）的等待时间，超时才强制结束。默认 3000ms。 */
    readonly graceMs?: number;
    /**
     * 强制收尾的**总预算**：在这段时间内反复对残余 pid 发 `/F` 并轮询，直到映像真正消失。
     * 默认 15000ms。多进程 Electron 在 /F 之后仍要几百毫秒到数秒才退干净。
     */
    readonly forceTimeoutMs?: number;
    /**
     * 也终止「检查之后才出现」的同映像进程（默认 false）。
     * 默认行为是**只碰检查时见过的 pid** —— 这才是"漂移护栏"的精确实现。
     */
    readonly force?: boolean;
    /**
     * 动手前的最后一次确认；返回非空字符串表示拒绝终止。
     * 用来防「这期间出现了可用的 CDP 端点」—— 那是能用的会话，绝不能杀。
     */
    readonly recheck?: () => Promise<string | undefined>;
}
export interface TerminateResult {
    readonly killed: readonly number[];
    readonly graceful: readonly number[];
    readonly forced: readonly number[];
    /** 被跳过的 pid（已退出，或该 pid 已被复用成别的映像）。 */
    readonly skipped: readonly number[];
    readonly elapsedMs: number;
    /** 给上层记账用的一句话。 */
    readonly note: string;
}
/**
 * 终止「目标映像名」下的进程 —— **只**供 `kill_first` 使用。
 *
 * 四条安全约束都在这里实现，别处不得绕过：
 *   1. 只在调用方**已确认 CDP 端点不存在**之后才调用（`openCdp` 的 attach 分支没命中），
 *      所以绝不会重启一个正在正常提供 CDP 的应用。
 *   2. **漂移护栏**：重新枚举时若出现检查时没见过的新 pid，直接拒绝（除非 `force`）——
 *      防止"用户刚自己打开的那个窗口"被顺手杀掉。
 *   3. **优雅优先**：先发 WM_CLOSE，`graceMs` 后才强制结束，给应用落盘的机会。
 *   4. **白名单**：映像名为空或属于系统进程时直接拒绝（配置写错的兜底）。
 */
export declare function terminateForLaunch(image: string, seenPids: readonly number[], options?: TerminateOptions): Promise<TerminateResult>;
/** Read-only readiness check using the same ownership and single-instance rules as openCdp. */
export declare function probeCdpTarget(target: TargetConfig, port: number, options?: {
    killFirst?: boolean;
}): Promise<{
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
    /** 目标在跑但没带调试端口时，先终止它再带端口拉起（默认 false —— 显式才杀）。 */
    killFirst?: boolean;
    /** 覆盖 kill_first 的漂移护栏（默认 false = 拒绝）。 */
    killForce?: boolean;
    /** 优雅关闭的等待时间（毫秒）。 */
    killGraceMs?: number;
    portBase: number;
    timeoutMs?: number;
}): Promise<CdpSession>;
export interface EnsureCdpResult {
    readonly target: string;
    /**
     * already-attachable —— 端口上已有本目标的调试端点，无需任何动作；
     * launched —— 应用原本没在跑，插件已带 `--remote-debugging-port=<port>` 拉起并等到端点；
     * blocked-running-without-port —— 应用已在跑且**没有**调试端口。单实例下此时唯一能带端口
     *   的办法就是先终止它（kill_first 的活）——本函数**绝不杀**，如实回报后由调用方决定；
     * failed —— 拉起失败（spawn 失败 / 端点没在时限内出现）。失败时已回收自己拉起的进程树。
     */
    readonly status: 'already-attachable' | 'launched' | 'blocked-running-without-port' | 'failed';
    readonly port?: number;
    readonly pid?: number;
    readonly pids?: readonly number[];
    readonly detail: string;
}
/**
 * 「首次启动即带调试端口」的非破坏保障（2026-10-16 统筹修复请求）：
 * 目标没在跑就带端口拉起，让 CDP 从第一次启动就可用 —— 这样永远走不到 kill_first。
 *
 * 与 `openCdp` 的分工：openCdp 服务「开一个能用的会话」（可以杀，但要显式 kill_first）；
 * 本函数服务「把应用带到一个**可附着**的状态」，**铁律是不碰任何在跑的进程**：
 * 已在跑（无端口）⇒ 只回报 blocked，绝不为了拿端口去终止用户正在用的应用。
 * 端点已可用 ⇒ 幂等 no-op。拉起后端点没出现 ⇒ 回收**自己拉起的**那棵进程树（同 openCdp）。
 */
export declare function ensureCdpLaunched(target: TargetConfig, options: {
    cwd?: string;
    portBase: number;
}): Promise<EnsureCdpResult>;
/**
 * 服务端读回：用 harness **自己的服务/CLI** 取当前会话最后一条 assistant 正文。
 *
 * 为什么需要：GUI 的正文常常是虚拟滚动 + 遮挡即冻结渲染，DOM 读回可能落后一轮；
 * 而这类应用往往自带本地服务（OpenCode 桌面端就是 `opencode-cli session export <id>`），
 * 给出的会话 JSON 是确定性的。配置形态见 `CdpReadbackSpec`。
 *
 * 只在目标显式配了 readback 时工作；任何失败都折叠成 note 并返回空串，绝不抛 ——
 * 读回兜底失败不该让一次已经成功的派发变成 error。
 */
export declare function readReplyFromService(session: CdpSession, target: TargetConfig, cwd: string): Promise<{
    text: string;
    note: string;
}>;
/**
 * 一次性把任务交给 CDP：读快照 → 注入文本 → 回车 → 轮询文本变化并等它稳定。
 * 永不 reject：所有失败都折叠成 stopReason + diagnostic。
 */
export declare function dispatchCdp(spec: DispatchSpec, options: {
    session?: CdpSession;
    launch?: boolean;
    portBase?: number;
}): Promise<DispatchOutcome>;
