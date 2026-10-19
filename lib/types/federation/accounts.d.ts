import { existsSync } from 'node:fs';
import type { AccountIsolation, AccountLaunch, AccountProfile, AuthState, NativeAuthRef } from './types.js';
/** 身份指纹：只存不可逆短摘要。 */
export declare function fingerprintOf(primary: string): string;
/** 只读身份探测配方。 */
export interface IdentityProbe {
    /** 探测 argv；`{configDir}` 会被替换成该档案的配置目录。 */
    readonly args: readonly string[];
    /** 额外环境变量；`{configDir}` 同样会被替换。 */
    readonly env?: Readonly<Record<string, string>>;
    /** 是否把配置目录作为 CLI 的 `--config-dir` 参数注入（qoder 系用这个）。 */
    readonly configDirFlag?: string;
    /** 从 JSON 输出里取字段的点路径。 */
    readonly json?: {
        readonly loggedIn: string;
        /** 身份主键（用于算指纹）；**不是**令牌。 */
        readonly identity: string;
    };
    /** 该探测需要 managed bootstrap 才能跑（WorkBuddy 系）。 */
    readonly requiresManagedBootstrap?: boolean;
    /** 说明该 Harness 没有可用的只读身份探测。 */
    readonly unavailableReason?: string;
}
/** 账号种子：来自**实测**，不是推测。 */
export interface AccountSeed {
    readonly id: string;
    /** 插件目标名（账本与派发用这个名字）。 */
    readonly targetName: string;
    readonly harnessId: string;
    readonly displayName: string;
    readonly region: 'cn' | 'intl' | 'unknown';
    readonly configDir: string;
    readonly nativeAuthRef: NativeAuthRef;
    readonly isolation: AccountIsolation;
    readonly launch: AccountLaunch;
    readonly switchSemantics: {
        currentSession: AccountSwitchSemantics['currentSession'];
        note: string;
    };
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
    readonly limits: readonly string[];
    readonly identityProbe: IdentityProbe;
}
type AccountSwitchSemantics = AccountProfile['switchSemantics'];
/**
 * 四个**已实测**账号（两个 Qoder CN + 两个 WorkBuddy）。
 *
 * 这些不是「配置愿望」：两个 Qoder 账号的 `logged_in:true` 与不同 username 是本次实跑读出的；
 * 两个 WorkBuddy 的身份指纹来自上一轮受管 bootstrap 适配器的实测交付
 * （`verification.json`，适配器 SHA-256 `3032e84f…ac1`）。
 */
export declare const ACCOUNT_SEEDS: readonly AccountSeed[];
/**
 * **导入的**实测证据（不是本插件本次重测的）。
 *
 * 来源：上一轮交付 `…\outputs\workbuddy-cli\verification.json`（2026-10-13 14:28 CST），
 * 适配器 SHA-256 `118d3c26913118c588bf6e6a9343867a6d96c60c8131f3c97ffda8f09d07bc20`。
 * 那次四路并发里四个账号各自返回了唯一标记、`stopReason=end_turn`、工具请求 0。
 *
 * **必须如实标注为「上一次交付的实测、非本插件重测」**，因此它把状态推到
 * `model-request-authorized` 时，`detail` 里要写清出处；P7 重测后应替换为本插件自己的证据。
 */
export interface ImportedEvidence {
    readonly accountId: string;
    readonly fingerprint: string;
    readonly provenance: string;
    readonly at: string;
    readonly stopReason: string;
    readonly markerReturned: boolean;
}
export declare const IMPORTED_EVIDENCE: readonly ImportedEvidence[];
export interface IdentityProbeResult {
    readonly loggedIn?: boolean;
    readonly identity?: string;
    readonly error?: string;
    readonly argv: readonly string[];
    readonly at: string;
    /** managed bootstrap 未建立时无法探测。 */
    readonly skipped?: string;
}
/** 跑一次只读身份探测。**不读凭据、不打印令牌**。 */
export declare function probeIdentity(seed: AccountSeed, entry: string | null, timeoutMs?: number): Promise<IdentityProbeResult>;
/**
 * 三态判定。**必须分开**，任何一层成功都不得自动升级下一层：
 *   `login-ok`                  —— CLI 自己报告已登录
 *   `identity-readable`         —— 另外还读到了稳定身份主键
 *   `model-request-authorized`  —— 只有真实完成过一次模型请求才给
 */
export declare function deriveAuthState(input: {
    loggedIn?: boolean;
    identityReadable: boolean;
    modelRequestProven: boolean;
    invalid?: boolean;
}): AuthState;
export interface CollectAccountsOptions {
    /** 目标名 → 已解析入口。缺省的账号跳过命令探测并说明原因。 */
    readonly entryForTarget: (targetName: string) => string | null;
    readonly measure?: boolean;
    readonly timeoutMs?: number;
    /** 本插件**自己**的账号级模型请求证据（P7 会写）。 */
    readonly ownEvidence?: readonly ImportedEvidence[];
    readonly importPriorEvidence?: boolean;
    readonly now?: () => Date;
    /**
     * 要收集的账号种子。缺省=内置四个。
     * 传 `effectiveSeeds(registry)` 时，用户新增/删除/改名的档案会一并出现在结果里 ——
     * 否则「动态管理」在界面上看不出来。
     */
    readonly seeds?: readonly AccountSeed[];
}
/** 收集全部账号档案（含三态）。 */
export declare function collectAccounts(options: CollectAccountsOptions): Promise<AccountProfile[]>;
export interface AccountStateFile {
    readonly version: 1;
    /** 每个账号的**默认**设定；切换只影响**新建**的执行。 */
    readonly defaults: Readonly<Record<string, {
        provider?: string;
        model?: string;
    }>>;
    readonly updatedAt: string;
}
export declare function loadAccountState(file: string): AccountStateFile;
export declare function saveAccountState(file: string, state: AccountStateFile): void;
/** 写入前把形状像令牌的串替换掉 —— 双保险，本模块本来也不该出现凭据。 */
export declare function assertNoSecrets(text: string): string[];
export interface BootstrapGateResult {
    readonly ok: boolean;
    /** 不通过时的**显式**原因（绝不允许静默退化）。 */
    readonly reason?: string;
    readonly requiredPrefix: string;
    readonly observed?: string;
}
/**
 * 受管 bootstrap 的版本门禁。
 *
 * 为什么必须有：该适配器依赖**厂商内部发布模块与启动协议**
 * （`resources/app.asar/main/process-cpu-sampler.js` 的内部 API、
 * `process._linkedBinding('electron_browser_workbuddy_storage')`、以及一次性命名管道 bootstrap）。
 * 厂商升级后这些内部面随时可能变。**版本不匹配时必须显式失败**，
 * 不能退化成「不带保护地启动」「关闭加密」「导出令牌」之类的做法。
 *
 * @param vendorVersion 厂商 CLI 的实测版本（例如 `2.156.0`）
 */
export declare function checkManagedBootstrapGate(seed: AccountSeed, vendorVersion: string | undefined): BootstrapGateResult;
/** 已验收的 WorkBuddy 受管适配器指纹（与上一轮交付逐字节一致才算数）。 */
export declare const WORKBUDDY_ADAPTER_SHA256 = "cfe9148cccb57d654534ad2471a17e47dd3970da86896d040920dc7c07b8ddf7";
/**
 * 校验随包适配器是否仍是**已验收过的那一份**。
 * 适配器被改动（或被厂商升级挤掉）必须能被发现，而不是悄悄跑一个没验过的版本。
 */
export declare function checkAdapterIntegrity(actualSha256: string | undefined): {
    ok: boolean;
    reason?: string;
};
export interface NativeAuthSpec {
    /** 对应 `catalog.ts` 的 harness id。 */
    readonly harnessId: string;
    /** 该 harness 的 CLI 入口名（用于给用户一条可自己粘贴的命令）。 */
    readonly entryName: string;
    /** 登录 argv（不含入口本身，也不含账号配置目录参数）。 */
    readonly login?: readonly string[];
    /** 退出 argv。CLI 帮助里没有 logout 时**留空**，不编一个。 */
    readonly logout?: readonly string[];
    /** 只读状态 argv。**必须**保证不会打印凭据，否则留空并写明原因。 */
    readonly status?: readonly string[];
    /** 登录是否必须由用户在自己的终端里完成。 */
    readonly interactive: boolean;
    /** `logout` 是否也可能交互（例如要先选账号）。 */
    readonly logoutInteractive: boolean;
    /** 没有原生入口时的原因 + 用户应当去哪里完成。 */
    readonly unavailableReason?: string;
    /** 实测出处（命令 + 观测到的原文）。 */
    readonly evidence: readonly string[];
    readonly limits: readonly string[];
}
export declare const NATIVE_AUTH: readonly NativeAuthSpec[];
export declare function nativeAuthFor(harnessId: string): NativeAuthSpec | undefined;
export interface IsolationProfile {
    readonly harnessId: string;
    /** 配置目录能否按档案切换（有实测证据的开关）。 */
    readonly configDirIsolated: boolean;
    /** 认证存储是否真的随配置目录走。false 时**不得**宣称认证隔离。 */
    readonly authStoreIsolated: boolean;
    /** 实测有效的隔离开关（env 名或 CLI flag）；没有就是 null。 */
    readonly mechanism: string | null;
    /** 开关怎么落到 launch 上。 */
    readonly launchKind: 'env' | 'argv' | 'none';
    readonly evidence: readonly string[];
    readonly disclosure: string;
    /** 是否允许为这个 harness **新增**账号档案。 */
    readonly mayAddAccounts: boolean;
    /** 不允许时的原因 + 差什么证据。 */
    readonly refuseReason?: string;
    readonly limits: readonly string[];
}
/**
 * 取某个 harness 的隔离画像。
 * **未知 harness 一律当作「不允许新增」** —— 默认拒绝，而不是默许。
 */
export declare function isolationProfileFor(harnessId: string): IsolationProfile;
export type NativeAuthAction = 'login' | 'logout' | 'status';
export interface NativeAuthPlan {
    readonly ok: true;
    readonly action: NativeAuthAction;
    readonly harnessId: string;
    readonly accountId: string;
    /** 实际入口（绝对路径优先）。 */
    readonly command: string;
    /** 完整 argv（含该档案的配置目录参数）。 */
    readonly argv: readonly string[];
    /** 用户可自己粘贴到终端里的命令（值已脱敏）。 */
    readonly cliLine: string;
    /** `terminal` = 必须由用户在真实终端里完成；`pipe` = 可非交互执行并回收输出。 */
    readonly mode: 'terminal' | 'pipe';
    readonly note: string;
}
export type NativeAuthPlanResult = NativeAuthPlan | {
    readonly ok: false;
    readonly harnessId: string;
    readonly accountId: string;
    readonly reason: string;
    readonly alternative?: string;
};
/**
 * 生成「调用该 CLI **自己的**认证流程」的执行计划。**纯函数**：不执行任何东西。
 *
 * 三条必须成立的纪律：
 *   1. 只调用 CLI 自己的子命令 —— 本插件**不实现**任何登录协议；
 *   2. 账号的配置目录参数必须一并带上，否则登错账号；
 *   3. 登录一律 `mode: 'terminal'` —— 交互式流程**不允许**被管道捕获后当成「已经登录」。
 */
export declare function planNativeAuth(seed: Pick<AccountSeed, 'id' | 'harnessId' | 'launch'>, entry: string | null, action: NativeAuthAction, homeDir: string): NativeAuthPlanResult;
export interface NativeAuthRunResult {
    readonly ok: boolean;
    readonly action: NativeAuthAction;
    readonly accountId: string;
    readonly argv: readonly string[];
    readonly exitCode: number | null;
    /** **已脱敏**的输出。 */
    readonly stdout: string;
    readonly stderr: string;
    readonly redacted: boolean;
    readonly note: string;
    readonly at: string;
}
/**
 * 执行一个**非交互**的原生认证动作（只允许 `pipe` 计划）。
 *
 * 交互式（`login`）一律**拒绝**在这里执行：管道捕获一个会等待用户输入的进程，
 * 只会得到「看起来跑了但什么都没发生」，比不做更糟。
 */
export declare function runNativeAuth(seed: Pick<AccountSeed, 'id' | 'harnessId' | 'launch'>, entry: string | null, action: NativeAuthAction, options: {
    readonly homeDir: string;
    readonly timeoutMs?: number;
    readonly now?: () => Date;
}): Promise<NativeAuthRunResult>;
export interface CustomAccountRecord {
    readonly id: string;
    readonly harnessId: string;
    /** 派发时用的目标名（必须是本 profile 里真实存在的目标）。 */
    readonly targetName: string;
    readonly displayName: string;
    readonly region: 'cn' | 'intl' | 'unknown';
    /** 配置目录相对 `~/.dsh/harness-accounts/` 的子目录名（默认 = id）。 */
    readonly configDirSubdir: string;
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
    readonly note?: string;
    readonly createdAt: string;
}
/** 对**任何**档案（内置或新增）的可改字段。留着空白=不改。 */
export interface AccountPatch {
    readonly displayName?: string;
    readonly region?: 'cn' | 'intl' | 'unknown';
    readonly defaultProvider?: string | null;
    readonly defaultModel?: string | null;
    readonly note?: string | null;
}
export interface AccountRegistryFile {
    readonly version: 1;
    readonly custom: readonly CustomAccountRecord[];
    /** 被删除的内置档案 id（墓碑）。删内置只能「停用」，不能真删 —— 否则升级会复活它。 */
    readonly tombstones: readonly string[];
    readonly patches: Readonly<Record<string, AccountPatch>>;
    readonly updatedAt: string;
}
export declare const EMPTY_ACCOUNT_REGISTRY: AccountRegistryFile;
export declare function loadAccountRegistry(file: string): AccountRegistryFile;
export declare function saveAccountRegistry(file: string, state: AccountRegistryFile): void;
export interface CreateAccountInput {
    readonly id: string;
    readonly harnessId: string;
    readonly targetName: string;
    readonly displayName: string;
    readonly region?: 'cn' | 'intl' | 'unknown';
    readonly configDirSubdir?: string;
    readonly note?: string;
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
}
export type AccountCrudAction = {
    readonly kind: 'create';
    readonly input: CreateAccountInput;
} | {
    readonly kind: 'update';
    readonly id: string;
    readonly patch: AccountPatch;
} | {
    readonly kind: 'delete';
    readonly id: string;
} | {
    readonly kind: 'restore';
    readonly id: string;
};
export type AccountCrudResult = {
    readonly ok: true;
    readonly state: AccountRegistryFile;
    readonly id: string;
    readonly note: string;
} | {
    readonly ok: false;
    readonly reason: string;
    readonly recovery: string;
};
export interface AccountCrudContext {
    /** 本 profile 里真实存在的目标名（用于拒绝拼错的目标）。缺省时不做目标存在性校验。 */
    readonly knownTargets?: readonly string[];
    /** 目标名 → harness id。缺省时不做「账号与目标同 harness」校验。 */
    readonly harnessOfTarget?: (targetName: string) => string | undefined;
    /** 内置档案 id 集合（默认取 ACCOUNT_SEEDS）。 */
    readonly builtinIds?: readonly string[];
}
/**
 * 应用一次账号 CRUD 动作。**纯函数**（不落盘，调用方自己 save）。
 *
 * 这里承担「不伪造隔离支持」的**强制点**：
 *   · 只有 `isolationProfileFor(harnessId).mayAddAccounts === true` 才允许 **create**；
 *   · 其余 harness 一律拒绝，并把「差什么证据」原样回给调用方；
 *   · 拒绝消息里**不会**出现任何凭据 —— 本模块从头到尾没读过凭据文件。
 */
export declare function applyAccountCrud(state: AccountRegistryFile, action: AccountCrudAction, context?: AccountCrudContext, at?: string): AccountCrudResult;
/**
 * 把注册表叠加到内置种子上，得到**实际生效**的账号列表。
 *
 * 顺序：内置（减墓碑、套 patch）→ 追加新增档案。
 * 新增档案的隔离披露**逐字**来自 `isolationProfileFor`，不允许调用方覆盖 ——
 * 否则「披露」就变成了可选项。
 */
export declare function effectiveSeeds(state: AccountRegistryFile, base?: readonly AccountSeed[]): AccountSeed[];
export { existsSync };
