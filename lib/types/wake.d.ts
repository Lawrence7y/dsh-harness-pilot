import type { RuntimeSettings } from './settings.js';
import type { TaskCallback, TaskResult, TaskView } from './tasks.js';
/** `Agent` 的最小面：只需要 followup（排队新 turn 并唤醒驱动）。 */
export interface AgentLike {
    session?: unknown;
    followup(message: unknown): void;
}
/** `ctx.sessionController` 的最小面：resolveAgent 自带「不在线就 resume」。 */
export interface SessionControllerLike {
    resolveAgent(sessionId: string): Promise<{
        agent?: AgentLike;
        error?: unknown;
    }>;
}
/** `ctx.agents`（AgentRegistry）的最小面（sessionController 缺失时的回落）。 */
export interface AgentRegistryLike {
    get(id: string): AgentLike | undefined;
    resume(options: {
        resumeSessionId: string;
    }): Promise<{
        agent: AgentLike;
    }>;
}
/** `ctx.sessions`（SessionStore）的最小面：落盘确认。 */
export interface SessionStoreLike {
    flush(session: unknown): Promise<boolean>;
}
/** 把一段文本注入指定 DSH 会话并触发新一轮；返回送达回执说明。 */
export interface SessionWaker {
    wake(sessionId: string, text: string): Promise<string>;
}
export interface WakerServices {
    sessionController?: SessionControllerLike;
    agents?: AgentRegistryLike;
    sessions?: SessionStoreLike;
}
export interface WakerDeps {
    /**
     * 惰性解析宿主服务：**投递回执时**才取，不能在 apply 时快照 ——
     * cordis 的服务注册顺序不保证，快照可能拿到 undefined。
     */
    resolve: () => WakerServices;
}
/** 一次回执要送出的完整文本。 */
export declare function buildReceipt(view: TaskView, callback: TaskCallback, result: TaskResult | null, settings: RuntimeSettings): string;
/**
 * 基于宿主服务的唤醒实现（对齐 dsh-schedule 的唤醒链）：
 *   resolveAgent（不在线自动 resume，即「会话重新启动」）→ followup → flush 落盘确认。
 */
export declare function createSessionWaker(deps: WakerDeps): SessionWaker;
