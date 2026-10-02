import type { TargetConfig } from './types.js';
export interface HarnessModels {
    readonly models: string[];
    /** 查询方式（给 UI/模型看的说明）。 */
    readonly note: string;
}
/** 跑一次 `modelsCommand` 并解析出模型 id 列表；失败不抛错，返回空列表 + 原因。 */
export declare function listHarnessModels(target: TargetConfig, timeoutMs?: number): Promise<HarnessModels>;
/**
 * 从命令输出里解析模型 id：一行一个，取每行的第一个字段再校验。
 *
 * 各家输出格式差别很大：opencode 是一行一个纯 id；agy 是 `id<TAB>显示名`；
 * pi 是 `provider/id` 加说明文字。所以只取首个 token，并过滤说明行。
 */
export declare function parseModels(output: string): string[];
/** DSH 侧已配置的供应商路由与模型（llm 服务缺失时返回空）。 */
export interface DshProviderModels {
    readonly id: string;
    readonly name: string;
    readonly models: string[];
}
interface LlmLike {
    listProviders(): {
        id: string;
        name: string;
    }[];
    listModels(provider: string): Promise<{
        id: string;
    }[]>;
}
export declare function listDshModels(llm: LlmLike | undefined): Promise<DshProviderModels[]>;
export {};
