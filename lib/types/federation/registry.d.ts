import { PROBE_SUMMARY, type HarnessSeed } from './catalog.js';
import type { HarnessInstall, HarnessRecord } from './types.js';
/** 插件目标的最小结构面（不 import `../config.js`，以保持本层可独立运行）。 */
export interface TargetLike {
    readonly name: string;
    readonly description?: string;
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly order?: readonly string[];
    readonly transport?: string;
}
/** 用户可改、且要落盘的部分。 */
export interface HarnessOverride {
    readonly enabled?: boolean;
    /** 用户指定的入口（覆盖种子里的实测入口）。 */
    readonly command?: string;
    /** 用户备注，随记录一起回显。 */
    readonly note?: string;
}
export interface RegistryState {
    readonly version: 1;
    readonly overrides: Readonly<Record<string, HarnessOverride>>;
    readonly updatedAt: string;
}
export declare function seedForTarget(targetName: string): HarnessSeed | undefined;
/** 记录一次版本探测。没测到就把原因带上，绝不拿种子值顶替。 */
export interface VersionProbeResult {
    readonly version?: string;
    readonly error?: string;
    readonly argv: readonly string[];
    readonly at: string;
    readonly durationMs: number;
}
/**
 * 把入口 + 参数解析成真正要 spawn 的 argv。
 * 处理三种真实情况：`.js` 需要 node、`.cmd/.bat` 需要 cmd /c、需要 Electron 的 Node 模式。
 */
export declare function resolveInvocation(entry: string, args: readonly string[], wrapping: string): {
    file: string;
    argv: string[];
    env: Record<string, string>;
    note: string;
};
/**
 * 从 `.asar` 归档里读它自己的 `package.json` 版本。
 *
 * asar 是 Chromium 归档格式：前 16 字节里 offset 12 是 header 长度（小端 u32），
 * 紧随其后是 JSON header，`files` 树里每个节点带 `offset`/`size`（相对文件头之后）。
 * 本机这套读法已在 DSH 自身（`app.asar`）上验证过；这里用来读打包版 Electron 应用。
 * **只读，不解包**：不为拿一个版本号把几百 MB 解出来。
 */
export declare function readAsarPackageVersion(asarPath: string): string | null;
/**
 * 读 Electron / VSCode-fork 应用**自己的**产品版本。
 *
 * 为什么需要：这类应用的 exe 跑 `--version` 回的是 Electron 版本（实测 Qoder → v24.15.0），
 * 拿它当产品版本就是虚假陈述。但它们都会在自己的元数据里声明真实版本，本机实测三种形态：
 *   · 未打包 / VSCode fork：`<AppDir>/resources/app/package.json` 直接可读（Qoder、Qoder CN IDE）
 *   · 打包 Electron：`<AppDir>/resources/app.asar` 的 header package.json（只读 header，不解包）
 *   · 两者都没有：如实返回 null，由调用方按「无法确定产品版本」处理，不猜。
 */
export declare function readElectronAppVersion(entry: string): {
    version: string;
    source: string;
} | null;
/**
 * 判定一次版本输出**是不是产品版本**。
 *
 * 为什么必须有这一步：本机实测发现，对 GUI/Electron 目标或裸 `node` 入口跑 `--version`，
 * 拿回来的是**运行时**版本而不是产品版本 —— 例如
 * `Antigravity.exe --version` → `v24.20.0`（Electron）、`node --version` → `v22.22.2`。
 * 把这种值当「真实安装版本」展示就是虚假陈述，因此这里显式拒绝，
 * 并把原始输出留在原因里（可复核），而不是编一个版本号。
 *
 * @returns 非 null = 这条输出不能当作产品版本，值为拒收原因。
 */
export declare function rejectRuntimeOnlyVersion(seed: HarnessSeed | undefined, entry: string, baseArgs: readonly string[], text: string): string | null;
/** 实测版本：真实 spawn，带超时；stdout/stderr 都看，失败如实记录。 */
export declare function probeVersion(entry: string, argv: readonly string[], wrapping: string, timeoutMs?: number): Promise<VersionProbeResult>;
export interface ResolvedEntry {
    readonly entry: string | null;
    readonly resolvedFrom: HarnessInstall['resolvedFrom'];
    readonly wrapping: string;
    readonly sharedWithNote?: string;
    readonly caveat?: string;
}
/**
 * 解析某目标的真实入口，优先级：用户指定 > 插件目标配置 > 种子实测入口。
 * 顺带做两件诚实性检查：厂商共享 Node 前缀、以及已知坏入口。
 */
export declare function resolveEntry(seed: HarnessSeed | undefined, target: TargetLike | undefined, override?: HarnessOverride): ResolvedEntry;
export interface BuildOptions {
    readonly targets: readonly TargetLike[];
    readonly overrides: Readonly<Record<string, HarnessOverride>>;
    /** 是否真的 spawn 去测版本（离线校验传 false）。 */
    readonly measure?: boolean;
    readonly probeTimeoutMs?: number;
}
/**
 * 构建注册表。`measure=false` 时**不做任何 spawn**，版本一律标为未测 —— 离线可跑。
 */
export declare function buildRegistry(options: BuildOptions): Promise<HarnessRecord[]>;
export declare function loadRegistryState(file: string): RegistryState;
export declare function saveRegistryState(file: string, state: RegistryState): void;
/** 合并一次更新（只接受已知字段，且 enabled 必须是布尔）。 */
export declare function applyOverride(state: RegistryState, target: string, patch: HarnessOverride): RegistryState;
export { PROBE_SUMMARY };
export type { HarnessRecord };
