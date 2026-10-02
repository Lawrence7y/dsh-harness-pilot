import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ResolvedConfig } from './config.js';
import type { SessionRegistry } from './sessions.js';
/** `ctx.subagents` 的最小面（缺失时 harness_agent 会明确报错）。 */
export interface SubagentStartLike {
    start(name: string, request: {
        label: string;
        prompt: ContentBlock[];
        parent: unknown;
        signal: AbortSignal;
    }): Promise<{
        id: string;
        result: Promise<{
            output: readonly ContentBlock[];
            stopReason: string;
            diagnostic?: string;
        }>;
        dispose(): Promise<void>;
    }>;
}
export interface ToolDeps {
    readonly config: ResolvedConfig;
    readonly registry: SessionRegistry;
    readonly subagents?: SubagentStartLike;
}
/** 这个目标的模型是怎么被设定的（给人看的说明）。HTTP `/models` 也用它。 */
export declare function mechanismOf(target: {
    modelArgs: string[];
    acpArgs: string[];
    acpModel: string;
}): string;
/** 换模型只用到会话的这两件事：页面求值 + 真实鼠标（`mouse` 只有 CDP 会话有）。 */
export interface ModelSwitchSession {
    evaluate(expression: string): Promise<unknown>;
    mouse?(action: 'click' | 'move', x: number, y: number): Promise<void>;
}
export interface ModelSwitchReport {
    readonly ok: boolean;
    readonly before: string;
    readonly picked: string;
    readonly after: string;
    readonly via: string;
    readonly detail?: string;
}
/**
 * 只读地读出会话当前选中的模型（CDP 会话走 DOM 触发器）。
 * 非 CDP 会话没有页面求值，调用方应先判断 `session.evaluate`。
 */
export declare function currentModelOf(session: {
    evaluate(expression: string): Promise<unknown>;
}): Promise<string>;
/**
 * 换模型：真实鼠标点开选择器 → 直接找目标项 → 找不到就逐个父行 hover 出子菜单再找 → 点中 → 读回。
 * 全过程不往页面里派发任何合成事件（那会把 ZCode 的求值卡死）。
 */
export declare function switchModel(session: ModelSwitchSession, wanted: string): Promise<ModelSwitchReport>;
/** 没有真实鼠标的会话（理论上只剩非 CDP 通道）：保留原来的页面内合成事件路径。 */
export declare function switchModelInPage(session: {
    evaluate(expression: string): Promise<unknown>;
}, wanted: string): Promise<string>;
export declare function registerTools(ctx: any, deps: ToolDeps): void;
