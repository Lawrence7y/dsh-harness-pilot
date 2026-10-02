import { type SubagentProvider } from '@deepseek-ai/dsh-subagent';
import type { SessionRegistry } from './sessions.js';
import type { TargetConfig } from './types.js';
/** 该 harness 的子代理 provider 名（`harness-opencode`、`harness-zcode` …）。 */
export declare function providerNameFor(target: TargetConfig): string;
/** 可注入的 `ctx.subagents` 最小面。 */
export interface SubagentRegistryLike {
    registerProvider(provider: SubagentProvider): () => void;
    /** 已有的 provider 名（用于幂等跳过；缺失时不做跳过）。 */
    list?(): string[];
}
/**
 * 为每个目标注册一个 provider；默认目标额外注册 `harness-pilot` 别名。
 * 返回实际注册的 provider 名，供日志与工具描述使用。
 *
 * 幂等：同名 provider 已存在（同一个包被两条 loader 行加载）时跳过，
 * 否则重复注册会让第二条 loader 行的 fiber 失败。
 */
export declare function registerProviders(registry: SubagentRegistryLike, sessions: SessionRegistry, targets: readonly TargetConfig[], defaultTarget: string): string[];
