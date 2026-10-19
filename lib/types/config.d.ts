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
 * 解析「安装目录名易变」的 GUI 目标的可执行文件路径。
 *
 * 背景：Qoder CN IDE 升级/重装会把安装目录在 `D:\Qoder CNide` 与 `D:\Qoder CN IDE`
 * 之间改名（本机 2026-10-09 实测就是这种情况：旧的 `D:\Qoder CN IDE` 只剩
 * `resources/` + `debug.log`，exe 已在 `D:\Qoder CNide`）。`command` 一旦对不上，
 * cdp 通道会因「命令无法解析」直接 skip、window 通道也匹配不到进程，**整个目标静默失效**
 * —— 而且因为目录还在，光看路径存在性还发现不了。
 *
 * 所以这里按「已知候选（新的在前）→ 扫描常见根目录下带同名 exe 的目录」两段解析，
 * 让目录改名不再需要改配置。
 */
/**
 * 内置目标目录。
 *
 * 顺序即真相：能走 ACP 就先 ACP（流式、结构化），其次一次性打印，再退到 PTY，
 * 最后才是 GUI 的 CDP / 窗口。
 */
export declare function installedCodexEntry(root?: string): string;
export declare const KNOWN_TARGETS: readonly TargetConfig[];
export interface ResolvedConfig extends Config {
    resolvedTargets: TargetConfig[];
}
/** 合并内置目录与用户配置；`apply()` 直接调用（无 loader 默认值）时也能得到完整配置。 */
export declare function resolveConfig(raw: unknown): ResolvedConfig;
/** 按名字或别名找一个目标（大小写不敏感）。 */
export declare function findTarget(config: ResolvedConfig, name: string): TargetConfig | undefined;
