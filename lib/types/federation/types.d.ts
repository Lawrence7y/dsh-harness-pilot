/**
 * Harness 联邦层（federation）的共享词汇。
 *
 * 三层严格分开，任何一层都不得假装成另一层：
 *   1. HarnessRecord   —— 「这台机器上装了什么 CLI、什么版本、能不能连、能力边界」
 *   2. AccountProfile  —— 「这个 Harness 的哪个账号、凭据放在哪、哪些真隔离」
 *   3. ProviderRecord  —— 「这个账号下有哪些供应商与模型，以及四种可用性状态」
 *
 * 本文件是整个联邦层的**契约**：实现文件只允许 import 本文件的类型与 `node:*`。
 * 这样联邦层可以脱离 DSH 宿主单独运行与验收（`node probe/verify-federation.mjs`）。
 */
import type { TransportKind } from '../types.js';
export type { TransportKind };
/** 通道分级：一级=原生协议，二级=headless/PTY，三级=降级（必须显式标注）。 */
export type TransportTier = 1 | 2 | 3;
/** CLI 自身的连接形状。 */
export type ConnectionKind = 'acp' | 'app-server' | 'http' | 'agent-cli' | 'gui' | 'native';
export interface TransportCapability {
    readonly kind: TransportKind;
    readonly tier: TransportTier;
    /** 该通道当前是否真的可用（探测结果，不是配置愿望）。 */
    readonly available: boolean;
    /** 探测命令/判据与结论摘要（给界面 tooltip 用）。 */
    readonly evidence: string;
    /** 说明书里对该通道的诚实限制。 */
    readonly limits?: readonly string[];
}
export interface HarnessInstall {
    readonly status: 'found' | 'missing' | 'unknown';
    /** 实际可执行入口（.ps1 shim 会解析到底层 exe/js）。 */
    readonly command: string;
    readonly resolvedFrom: 'builtin-catalog' | 'profile-config' | 'path-scan' | 'user-specified';
    /** 真实版本字符串。**来源必须可追溯**，见 versionSource。 */
    readonly version?: string;
    /**
     * 版本是从哪来的：
     *   · `cli-version`  —— 跑 CLI 自己的 `--version`
     *   · `app-metadata` —— 读该应用自己的元数据（Electron/VSCode fork 的
     *     `resources/app/package.json`）。GUI 应用跑 `--version` 只会回 Electron 版本，
     *     所以这一类**必须**走元数据，不能拿运行时版本冒充。
     *   · `none`         —— 没测到
     */
    readonly versionSource?: 'cli-version' | 'app-metadata' | 'none';
    readonly versionProbe?: readonly string[];
    readonly versionCheckedAt?: string;
    readonly versionError?: string;
    /** 非空表示该安装是厂商共享的（例如落在 WorkBuddy 自带 Node 前缀下）。 */
    readonly sharedWithNote?: string;
}
export interface HarnessCapabilities {
    /** 怎么把「选择的模型」真正落到该 CLI 上。`none` = 只能在它自己的界面里选。 */
    readonly modelSelect: 'argv' | 'acp-config' | 'none' | 'unknown';
    /** 能读到该 CLI 自身供应商/模型配置的原生文件（相对用户目录）。 */
    readonly providerConfigFiles: readonly string[];
    /** 能列出该 CLI 可用模型的命令。 */
    readonly modelListCommand?: readonly string[];
    readonly modelListArgs?: readonly string[];
    /** 多账号隔离的真实形态。 */
    readonly multiAccount: 'isolated-config-dir' | 'vendor-shared-store' | 'unknown';
    /** 该 CLI 自己的权限模式取值（**不是** DSH 权限预设）。 */
    readonly permissionModes: readonly string[];
    /** 该 CLI 自己的推理/思考档位取值。 */
    readonly reasoningEfforts: readonly string[];
    /** 是否自带可复用的原生会话 id（用于恢复）。 */
    readonly sessionResume: 'native-id' | 'none' | 'unknown';
    /** 能否作为 MCP server 被 DSH 拉起（决定跨 Harness 调度的受支持方式）。 */
    readonly mcpServer: boolean;
    /** 能否担任主控：只有拿到行为证据才允许写 verified。 */
    readonly canLead: 'verified' | 'candidate' | 'no';
}
export interface HarnessProbe {
    readonly at: string;
    readonly connection: 'ok' | 'fail' | 'timeout' | 'skipped';
    readonly latencyMs: number;
    readonly detail: string;
    /** 探测走的是哪一档通道。 */
    readonly via?: TransportKind;
}
export interface HarnessRecord {
    readonly id: string;
    readonly displayName: string;
    readonly vendor: string;
    readonly kind: 'cli' | 'electron-gui' | 'vscode-fork' | 'native';
    readonly enabled: boolean;
    readonly install: HarnessInstall;
    readonly connection: ConnectionKind;
    readonly transports: readonly TransportCapability[];
    readonly capabilities: HarnessCapabilities;
    readonly probe?: HarnessProbe;
    /** 明确写在界面上的上游限制。 */
    readonly upstreamLimits: readonly string[];
}
/** 账号身份的四态。**必须分开显示，不得合并**。 */
export type AuthState = 'unknown' | 'login-ok' | 'identity-readable' | 'model-request-authorized' | 'auth-invalid';
export interface AccountIdentity {
    readonly state: AuthState;
    /**
     * 身份指纹：**sha256(身份主键)[0:12]**。
     * 身份主键取该 CLI 自己**只读**报出来的稳定标识（实测 qoderclicn 用 `username`：
     * `sha256("aliyun7629794577")[0:12] = 1fab6738baa4`，与上一轮实测记录逐字一致；
     * 用 userId 算则对不上）。**不存原值、更不存任何令牌**。
     */
    readonly fingerprint?: string;
    /** 只读探测到的身份显示名（如 username）；不含凭据。 */
    readonly displayIdentity?: string;
    readonly authType?: string;
    readonly checkedAt?: string;
    readonly detail?: string;
}
export interface NativeAuthRef {
    readonly kind: 'vendor-store' | 'file' | 'keychain' | 'unknown';
    readonly scope: 'isolated' | 'vendor-shared' | 'unknown';
    /** 例如 `CodeBuddyExtension/Data/Public/auth/<authentication.id>.info`。 */
    readonly locator: string;
    readonly authenticationId?: string;
}
export interface AccountLaunch {
    readonly mode: 'direct' | 'managed-bootstrap';
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    /** `managed-bootstrap` 专有：厂商内部协议依赖，必须带版本门禁与显式失败。 */
    readonly bootstrap?: {
        readonly adapterId: string;
        readonly vendorExecutable: string;
        readonly requiresVendorVersionPrefix: string;
        readonly vendorNode: string;
        readonly protocolNote: string;
    };
}
export interface AccountIsolation {
    readonly configDirIsolated: boolean;
    readonly authStoreIsolated: boolean;
    /** 与哪些档案共享厂商原生存储（空数组=没有已知共享）。 */
    readonly sharedWith: readonly string[];
    /** 给用户看的人话披露。 */
    readonly disclosure: string;
    /**
     * **隔离结论的依据**。声明 isolated 时这里必须能说清是怎么知道的：
     * 要么是本次实测（命令 + 观测到的差异），要么是结构事实（认证文件就在该配置目录内）。
     * 空数组 + 声称 isolated = 无依据声明，验收脚本会判失败。
     */
    readonly evidence: readonly string[];
}
export interface AccountSwitchSemantics {
    readonly currentSession: 'in-place' | 'requires-new-process' | 'requires-new-session' | 'unknown';
    readonly note: string;
}
export interface AccountProfile {
    readonly id: string;
    readonly harnessId: string;
    /** 脱敏显示名，例如 `workbuddy-a (8479…680a)`。 */
    readonly displayName: string;
    readonly region: 'cn' | 'intl' | 'unknown';
    readonly identity: AccountIdentity;
    readonly nativeAuthRef: NativeAuthRef;
    readonly configDir: string;
    readonly launch: AccountLaunch;
    readonly isolation: AccountIsolation;
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
    readonly switchSemantics: AccountSwitchSemantics;
    readonly limits: readonly string[];
}
/** 供应商/模型可用性四态。**顺序即含义，不得跳级宣称**。 */
export type Availability = 'configured' | 'discoverable' | 'auth-valid' | 'usable' | 'unavailable';
export interface ModelRecord {
    readonly id: string;
    readonly name?: string;
    readonly availability: Availability;
    readonly evidence?: string;
}
export interface ProviderRecord {
    readonly id: string;
    readonly displayName: string;
    /** 数据来自哪里。`dsh-native` 只允许出现在 DSH 自己的那一栏。 */
    readonly source: 'cli-native-config' | 'cli-list-command' | 'acp-session' | 'dsh-native' | 'none';
    readonly sourcePath?: string;
    readonly models: readonly ModelRecord[];
    readonly availability: Availability;
    readonly evidence: readonly string[];
}
export interface ProviderInventory {
    readonly harnessId: string;
    readonly accountId: string;
    /** 该 Harness/账号**原生**的供应商。 */
    readonly native: readonly ProviderRecord[];
    /** 该 Harness 的模型清单命令返回的原始结果（未归类）。 */
    readonly discovered: readonly ModelRecord[];
    readonly errors: readonly string[];
    readonly collectedAt: string;
}
/** 一次执行的请求值 vs 实际值。配置值与实际值不一致时必须能被看出来。 */
export interface ExecutionIdentity {
    readonly harnessId?: string;
    readonly accountId?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly permissionMode?: string;
}
export interface ExecutionRecord {
    readonly runId: string;
    /** 创建时固化；之后改默认值不影响它。 */
    readonly requested: ExecutionIdentity;
    readonly actual: ExecutionIdentity;
    /** 可读的差异说明（空数组=一致）。 */
    readonly mismatch: readonly string[];
    readonly nativeSessionId?: string;
    readonly transport?: TransportKind;
    readonly pid?: number;
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'stalled';
    readonly stopReason?: string;
    readonly artifacts?: Readonly<Record<string, string>>;
}
/** 脱敏：给用户看的账号短名，禁止泄露令牌或完整身份。 */
export declare function redactAccountLabel(id: string, fingerprint?: string): string;
/** 令牌形状的文本一律先脱敏再落盘/进日志。 */
export declare function redactSecrets(text: string): string;
