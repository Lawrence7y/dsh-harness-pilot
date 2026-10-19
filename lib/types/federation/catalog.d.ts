/**
 * ⚠️ 本文件由 `scripts/gen-federation-catalog.mjs` 从 `docs/verified/harness-probe.json`
 * **自动生成**，请勿手改；要改就改生成脚本并重跑。
 *
 * 生成源是逐条实测的探针结果（11/12 harness 解析到真实入口）。
 * 这里存的是**这台机器的 CLI 长什么样**（种子知识），
 * **不包括当前版本与当前连通性** —— 那两样由 `registry.ts` 在运行期测量。
 * `seedVersion` 只作对照，**禁止当作当前版本展示**。
 */
import type { ConnectionKind, TransportKind, TransportTier } from './types.js';
export interface HarnessSeedTransport {
    readonly kind: TransportKind;
    readonly tier: TransportTier;
    readonly supported: boolean;
    readonly note: string | null;
}
export interface HarnessSeed {
    readonly id: string;
    readonly displayName: string;
    readonly vendor: string;
    readonly kind: 'cli' | 'electron-gui' | 'vscode-fork' | 'native';
    /** 实测到的真实入口（已解析 shim）；null = 没找到。 */
    readonly entryPath: string | null;
    readonly shimPath: string | null;
    /** 入口需要怎样的包裹才能跑（none / node / ELECTRON_RUN_AS_NODE…）。 */
    readonly shimWrappingRequired: string;
    readonly entryResolution: string;
    /** 版本探测 argv（附加在入口之后）；空数组 = 该目标不做版本探测。 */
    readonly versionProbe: readonly string[];
    /** 探针当时的版本，**仅作对照**。 */
    readonly seedVersion: string | null;
    readonly confidence: string;
    /** 非 null = 能力字段继承自哪个 harness（该目标未单独复测，必须按 inferred 展示）。 */
    readonly inheritedFrom: string | null;
    readonly connection: ConnectionKind;
    readonly transports: readonly HarnessSeedTransport[];
    readonly modelSelect: 'argv' | 'acp-config' | 'none' | 'unknown';
    readonly modelFlag: string | null;
    readonly modelListArgs: readonly string[];
    /** probe 里那句**人类可读的**原始说明，仅供界面展示；**不要**当 argv 用。 */
    readonly modelListCommandRaw: string | null;
    readonly modelListCount: number | null;
    readonly providerConfigFiles: readonly string[];
    readonly multiAccount: 'isolated-config-dir' | 'vendor-shared-store' | 'unknown';
    readonly multiAccountSwitch: string | null;
    /** 是否**实测**过隔离开关真的生效。false 时必须按「未验证」展示。 */
    readonly isolationTested: boolean;
    readonly permissionModes: readonly string[];
    readonly reasoningEfforts: readonly string[];
    readonly sessionResume: 'native-id' | 'none' | 'unknown';
    readonly sessionResumeNote: string | null;
    readonly mcpServer: boolean;
    readonly authNote: string | null;
    readonly upstreamLimits: readonly string[];
}
/** 逐条实测的种子目录（按 id 索引）。 */
export declare const HARNESS_SEEDS: readonly HarnessSeed[];
/** 探针整体结论，界面上要如实转述。 */
export declare const PROBE_SUMMARY: {
    readonly generatedAt: null;
    readonly entryPathResolvedCount: 11;
    readonly targetsWithoutResolvedEntry: readonly ["zcode"];
    readonly isolationMeasuredWorking: readonly ["CODEX_HOME (codex)", "CLAUDE_CONFIG_DIR (claude-code)", "PI_CODING_AGENT_DIR (pi)"];
    readonly isolationMeasuredNotWorking: readonly ["opencode (5 switches tested, none changed the credential result; shared 'opencode serve --service' process is the probable cause)", "mimo (MIMOCODE_CONFIG_DIR no effect; MIMOCODE_HOME partial)", "workbuddy CodeBuddy (CODEBUDDY_CONFIG_DIR present in bundle but behaviourally untestable - launcher bundle is broken)"];
    readonly liveModelRequestIssued: false;
};
