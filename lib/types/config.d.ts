/**
 * Plugin registry: harness targets, defaults, and the Schemastery Config schema.
 *
 * 内置一份「本机实探过的 harness 目录」：CLI 类走 acp/headless/pty，GUI 类走 cdp/window。
 * 用户在 profile 里只写差异项（换路径、固定模型、加参数）。
 */
import z from '@deepseek-ai/schemastery';
import type { CdpSpec, TargetConfig, WindowSpec } from './types.js';
export interface Config {
    /** 追加/覆盖内置目标，按 name 合并。 */
    targets: TargetConfig[];
    /** `harness_dispatch` 省略 target 时用的默认目标。 */
    defaultTarget: string;
    /** 窗口助手使用的 python 解释器；留空自动探测。 */
    pythonPath: string;
    /** 回给模型的正文上限（字符）。 */
    maxReplyChars: number;
    /** 单次窗口文本读取上限（字符）。 */
    maxScreenChars: number;
    /** 允许的 CDP 调试端口起点。 */
    cdpPortBase: number;
    /**
     * HTTP 写接口（/harness-pilot/api/dispatch|models|send）的共享令牌。
     * 留空 = 不校验（webServer 只监听 loopback）；非空时必须带 `x-harness-pilot-token`。
     */
    apiToken: string;
}
export declare const Config: z<Config>;
/** 目标补丁：window/cdp 允许只写差异字段。 */
export type TargetPatch = Partial<Omit<TargetConfig, 'window' | 'cdp'>> & {
    name: string;
    window?: Partial<WindowSpec>;
    cdp?: Partial<CdpSpec>;
};
/**
 * 内置目标目录。
 *
 * 顺序即真相：能走 ACP 就先 ACP（流式、结构化），其次一次性打印，再退到 PTY，
 * 最后才是 GUI 的 CDP / 窗口。
 */
export declare const KNOWN_TARGETS: readonly TargetConfig[];
export interface ResolvedConfig extends Config {
    resolvedTargets: TargetConfig[];
}
/** 合并内置目录与用户配置；`apply()` 直接调用（无 loader 默认值）时也能得到完整配置。 */
export declare function resolveConfig(raw: unknown): ResolvedConfig;
/** 按名字或别名找一个目标（大小写不敏感）。 */
export declare function findTarget(config: ResolvedConfig, name: string): TargetConfig | undefined;
