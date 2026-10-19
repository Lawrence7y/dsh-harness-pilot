import type { Availability } from './federation/types.js';
/** 一份目录**属于谁**。跨 owner 使用一律拒绝：这是「不冒充」的结构性保证。 */
export type CatalogOwner = 'dsh-native' | 'harness-native';
/** 可编辑面的种类。每一个都必须由**真探测**决定支持与否。 */
export type CatalogSurfaceId = 'dsh-llm-service' | 'harness-admin-command' | 'plugin-declared-allowlist';
export type CatalogOp = 'list' | 'select' | 'add-provider' | 'remove-provider' | 'edit-provider' | 'add-model' | 'remove-model' | 'edit-model' | 'declare-models';
/**
 * `supported`        —— 有真实路径，且探测到了依据
 * `read-only`        —— 只能读（列出来），写没有落点
 * `refused-by-policy`—— 技术上也许做得到，但**本插件明确拒绝**（例如会改写用户部署默认值、
 *                       或属于凭据面）；拒绝理由必须能直接展示给用户
 * `unsupported`      —— 宿主/该 CLI 根本没有这条路径
 */
export type CapabilityVerdict = 'supported' | 'read-only' | 'refused-by-policy' | 'unsupported';
/** 执行该操作的**副作用形状** —— 结构化标注，供执行侧做门禁（不用去正则匹配证据文本）。 */
export type CatalogSideEffect = 'writes-user-cli-config';
export interface CatalogCapability {
    readonly surface: CatalogSurfaceId;
    readonly owner: CatalogOwner;
    readonly op: CatalogOp;
    readonly verdict: CapabilityVerdict;
    /** 探针**做了什么**（可复现的动作描述）。 */
    readonly probe: string;
    /** 逐字观测到的依据（帮助文本原文、方法名、落盘字段名…）。 */
    readonly evidence: readonly string[];
    /** `verdict !== 'supported'` 时**必须**有：给用户的显式拒绝理由。 */
    readonly refusal?: string;
    /** 有副作用时如实标注；执行侧据此要求显式确认。 */
    readonly sideEffect?: CatalogSideEffect;
    /** 该面执行一个动作时命令的前缀（实测例：`['provider']`）。计划阶段据它拼 argv。 */
    readonly argvPrefix?: readonly string[];
}
/** 能力报告：把「探到了什么」与「据此允许什么」放在一起，调用方直接展示即可。 */
export interface CapabilityReport {
    readonly at: string;
    readonly capabilities: readonly CatalogCapability[];
    readonly editable: readonly string[];
    readonly refused: readonly string[];
}
/** 汇总成可直接进接口/界面的报告。**不省略任何一条拒绝**。 */
export declare function capabilityReport(capabilities: readonly CatalogCapability[], at?: string): CapabilityReport;
/** 取某条能力的判定；找不到 = `undefined`（缺探测一律按「不许做」处理，不是「大概可以」）。 */
export declare function capabilityOf(capabilities: readonly CatalogCapability[], op: CatalogOp, surface?: CatalogSurfaceId): CatalogCapability | undefined;
/**
 * 服务对象的结构性探测结果。**这是观测，不是判断**。
 * 判断在 {@link dshCatalogCapabilities} 里，且必须写明为什么某个方法不算「目录写入」。
 */
export interface ServiceShapeProbe {
    readonly available: boolean;
    /** 观测到的方法名（自有 + 原型链，去重排序）。 */
    readonly observedMethods: readonly string[];
    /** 名字像「目录写入」的方法 —— 真探测到的话，结论就要跟着变。 */
    readonly mutationCandidates: readonly string[];
    /** 名字像写入但**只是声明/登记**的方法（必须逐条说明为什么不改目录）。 */
    readonly registrationOnly: readonly string[];
    readonly note: string;
}
/** 把服务对象（自有 + 原型链）的方法名枚举出来。深度有上限，绝不在宿主对象上乱走。 */
export declare function probeServiceShape(service: unknown): ServiceShapeProbe;
/**
 * 由结构探测结果推出 DSH 侧的**可编辑范围**。
 *
 * 结论不是硬编码：`mutationCandidates` 非空时结论直接变成 `supported`，并把方法名列进证据。
 * 在本机 rc.2 上观测到的方法面是
 * `discoverModels / fileRequestText / imageRequestPricing / listModels / listProviders /
 *  prepareCall / providerRetryPolicy / registerAdapter / registerConfigurableProviders /
 *  registerModelDiscovery / remoteDiscoverModels / resolveCallConfig / resolveModelInfo / stream`
 * —— 没有一个是目录写入。
 */
export declare function dshCatalogCapabilities(shape: ServiceShapeProbe): CatalogCapability[];
export interface AdminVerb {
    /** 动词（去掉参数与逗号后缀）。 */
    readonly verb: string;
    /** 该行的参数部分（如 `[options] <url>`）。 */
    readonly args: string;
    /** 该行的说明文字（逐字保留）。 */
    readonly description: string;
    /** 原始整行（逐字保留，作证据）。 */
    readonly line: string;
}
/**
 * 从 `<cli> <sub> --help` 的输出里解析出**子命令清单**。
 *
 * 实测两种排布都要认：
 *   · commander 风格（kimi）：`Commands:` 之后是 `  add [options] <url>  Import every provider …`
 *   · yargs 风格（opencode）：`SUBCOMMANDS` 之后是 `  auth               manage AI providers and credentials`
 *
 * 解析不出来就返回空数组 —— **宁可空也不要编**（编出来的动词会直接变成「看起来能改」）。
 */
export declare function parseAdminVerbs(helpText: string): AdminVerb[];
export interface HarnessAdminProbeInput {
    readonly harnessId: string;
    /** 该 CLI 的供应商管理子命令（例如 `provider`）；null = 该 CLI 没有这样的子命令。 */
    readonly subcommand: string | null;
    /** 帮助文本是怎么来的（argv，作证据）。 */
    readonly probeArgv: readonly string[];
    readonly helpText: string | null;
    /** 帮助命令的退出码；非 0 且没有子命令清单时要如实说「探不出来」。 */
    readonly exitCode?: number | null;
    /** 该 CLI 是否被实测确认有「配置目录隔离」开关。false ⇒ 执行会写用户真实配置，必须显式确认。 */
    readonly configDirIsolated: boolean;
}
/**
 * 由**真实帮助文本**推出该 CLI 自己的供应商/模型管理能力。
 *
 * 判定纪律：
 *   · 动词必须出现在 `Commands`/`SUBCOMMANDS` 小节里、且说明文字里点到 provider，才算「供应商级」；
 *   · 说明里出现凭据词（credential/login/token/api key）的动词一律判 `refused-by-policy`
 *     —— 那是凭据面，本插件不代管凭据；
 *   · **模型级**动词必须有独立动词（`model`/`models`/`alias`）才算；
 *     说明里顺带提到 model 不算（实测例：kimi 的 `remove` 说明是
 *     "Remove a provider and every model alias that referenced it" —— 模型别名是**随供应商**
 *     一起被移除的，不是模型级能力。不这样区分就会凭空多出一个「能单独删模型」的假能力）。
 */
export declare function harnessCatalogCapabilities(input: HarnessAdminProbeInput): CatalogCapability[];
export interface DeclaredAllowlistProbeInput {
    readonly accountId: string;
    /** 真实写入路径的可读描述（例如 `poolExtras.update → updatePoolState → savePoolState`）。 */
    readonly writePath: string;
    /** 在**纯内存副本**上跑一次 `{entry:{accountId, models:[…]}}` 之后，该条目落地了哪些字段名。 */
    readonly entryKeysAfterModelsPatch: readonly string[];
    /** 同一副本上再跑一次带 `providers` 的 patch 之后，该条目落地了哪些字段名。 */
    readonly entryKeysAfterProvidersPatch: readonly string[];
    /** 探针动作的逐字说明。 */
    readonly note: string;
}
/**
 * 由**真实写入路径的行为**（在内存副本上跑的，不落盘）推出声明层的可编辑范围。
 *
 * 为什么必须做这个探测：如果不去写一次、只看类型声明，就会做出一个「能填供应商清单」的
 * 界面 —— 而那个字段写下去**没有任何读取方**，是被静默丢弃的。那正是「看起来能改」。
 */
export declare function declaredAllowlistCapabilities(input: DeclaredAllowlistProbeInput): CatalogCapability[];
export interface AdminSubcommandHint {
    readonly subcommand: string | null;
    /** 为什么是它 / 为什么**不去探** —— 逐字依据，直接进证据串。 */
    readonly evidence: string;
}
/**
 * 该 Harness 的供应商管理子命令是什么。
 *
 * ⚠️ 这张表**只放已经实测过的东西**，而且**只影响「去探哪个子命令」**，不影响任何结论 ——
 * 结论永远由 `runHarnessAdminHelp` 的真实帮助文本算出来。这样即使表写错了，
 * 最坏也只是「探错地方 → 探不出动词 → 判 unsupported」，**不会**凭空多出一个能力。
 *
 * 没有依据的 Harness 一律返回 `null` 并**不去探**：本机踩过的教训是「负结果与猜错无法区分」，
 * 猜一个子命令去跑，跑出来的空结果会被误当成「该 CLI 没有这个能力」。
 */
export declare function adminSubcommandFor(harnessId: string): AdminSubcommandHint;
export interface AdminHelpResult {
    readonly argv: readonly string[];
    readonly code: number | null;
    readonly text: string;
    readonly error?: string;
}
/**
 * 跑一次该 CLI 的**只读**管理子命令帮助（`<entry> <sub> --help`）。
 *
 * 为什么这个可以放在本模块里、而**写**命令不行：`--help` 不产生任何副作用、不消耗额度、
 * 不碰凭据。真正的写命令一律通过 {@link CatalogEditExecutors.runHarnessAdminCommand}
 * 由调用方注入 —— 本模块不会自己去执行会改用户环境的命令。
 */
export declare function runHarnessAdminHelp(entry: string, subcommand: string, options?: {
    readonly timeoutMs?: number;
    readonly wrapping?: string;
}): Promise<AdminHelpResult>;
/** 一个**来自真实发现**的候选项。`owner` 必须如实标注，跨 owner 使用一律拒绝。 */
export interface CatalogCandidate {
    readonly id: string;
    readonly owner: CatalogOwner;
    readonly availability: Availability;
    readonly evidence?: string;
    /** 该候选项属于哪个 harness（`dsh-native` 侧用 `'__dsh__'`）。 */
    readonly harnessId: string;
}
export interface CatalogInventoryLike {
    readonly harnessId: string;
    readonly discovered: readonly {
        readonly id: string;
        readonly availability: Availability;
        readonly evidence?: string;
    }[];
    readonly dshNative?: readonly {
        readonly id: string;
        readonly models: readonly {
            readonly id: string;
            readonly availability: Availability;
            readonly evidence?: string;
        }[];
    }[];
}
/**
 * 把一次四态发现的结果摊成**受约束选择的候选清单**。
 *
 * 关键：`dshNative` 出来的候选项 owner 一律是 `dsh-native`，外部 harness 的一律是
 * `harness-native` —— 这是「不冒充」在数据结构上的落点。两边**永远不会**进同一个 owner。
 */
export declare function candidatesFromInventory(inventory: CatalogInventoryLike): CatalogCandidate[];
export interface SelectionRequest {
    /** 本次选择要落在哪个面上。它决定**只允许**哪个 owner 的候选项。 */
    readonly surface: CatalogOwner;
    /** 该面上的 harness（用于提示与证据；`dsh-native` 面传 `'__dsh__'`）。 */
    readonly harnessId: string;
    readonly requested: string;
    readonly candidates: readonly CatalogCandidate[];
    /** 是否允许「目录里没有」的手填值。**默认 false**。打开时结果一定被标成未验证。 */
    readonly allowUnlisted?: boolean;
    /** 最低可用性门槛，默认 `discoverable`（「列得出来」）。 */
    readonly minAvailability?: Availability;
}
export type SelectionOutcome = {
    readonly ok: true;
    readonly value: string;
    readonly owner: CatalogOwner;
    /** `catalog` = 来自真实发现；`unlisted-manual` = 调用方显式允许的手填值（未验证）。 */
    readonly origin: 'catalog' | 'unlisted-manual';
    readonly availability: Availability;
    readonly evidence: string;
    readonly warnings: readonly string[];
} | {
    readonly ok: false;
    readonly owner: CatalogOwner;
    readonly reason: string;
    /** 目录里最接近的几个 id（给用户选，而不是让他继续瞎填）。 */
    readonly suggestions: readonly string[];
};
/**
 * 受约束选择。**这是全部入口唯一允许的选择判定实现**（多入口一致性靠这一点）。
 *
 * 判定顺序（每一步拒绝都给出理由与候选项）：
 *   ① 空值 → 拒绝；
 *   ② **owner 不匹配** → 拒绝（这是「不得冒充」的执行点）；
 *   ③ 在目录里 → 检查四态门槛，够就通过（证据来自发现结果）；
 *   ④ 不在目录里 → `allowUnlisted` 未打开就拒绝 + 给建议；打开了才通过，并**标注未验证**。
 */
export declare function resolveCatalogSelection(request: SelectionRequest): SelectionOutcome;
export type ActualEvidenceSource = 
/** 设置调用回执（ACP `session/set_config_option` 成功之类）。**永远不算证明**。 */
'setter-ack'
/** 独立回读该 harness 自己的目录（`--list-models` / `models`）。能证伪，不能证明「被采用」。 */
 | 'catalog-read'
/** 派发身份回报。只有 `substitutedFromRequest !== true` 时才算独立观测。 */
 | 'dispatch-identity'
/** 该 harness 自己的原生会话记录（落盘日志等）。最强的独立来源。 */
 | 'native-session-log';
export interface ActualEvidence {
    readonly source: ActualEvidenceSource;
    /** 观测到的值；没观测到就留空。 */
    readonly observed?: string;
    /** `catalog-read` 专有：该 harness 自己的目录里到底有没有请求的这个 id。 */
    readonly listed?: boolean;
    readonly detail?: string;
    /**
     * **关键标志**：该证据是不是「把请求值抄过来的」。
     *
     * 实测依据：`sessions.ts` 的 `foldOutcomeIdentity()` 在通道没有明确报「换模型失败」时
     * 直接写 `actualModel = requestedModel` —— 也就是说项目里的 `actual.model` 在多数路径上
     * 就是请求值的副本。凡是从那条路径来的证据，调用方**必须**标 true，否则本模块会把它
     * 当成独立观测，那就等于用请求值给自己背书。
     */
    readonly substitutedFromRequest?: boolean;
}
export type ActualVerdictKind = 'proven' | 'mismatch' | 'unproven' | 'not-observed';
export interface ActualVerdict {
    readonly verdict: ActualVerdictKind;
    /** 只有 `proven` 才为 true。 */
    readonly proven: boolean;
    readonly requested: string;
    /** 独立观测到的值（可能 ≠ 请求值）；没有独立观测则 undefined。 */
    readonly observed?: string;
    /** 判定所依据的那一条来源；没有则 undefined。 */
    readonly reliedOn?: ActualEvidenceSource;
    /** 被**刻意排除**的证据及理由（含 `setter-ack` 与「抄请求值」的证据）。 */
    readonly excluded: readonly {
        readonly source: ActualEvidenceSource;
        readonly reason: string;
    }[];
    /** 人话结论。**必须**能直接展示。 */
    readonly reason: string;
}
/**
 * `actual` 真实核验。**纯函数**、可离线单测。
 *
 * 判定（独立观测优先）：
 *   ① 有 `native-session-log` / 未做替换的 `dispatch-identity`：
 *      与请求值一致 → `proven`；不一致 → `mismatch`（并回报观测到的值）；
 *   ② 只有 `catalog-read`：`listed === false` → `mismatch`（目录里根本没有这个 id，不可能被采用）；
 *      `listed === true` → `unproven`（「列得出来」只说明它存在，不说明本轮用了它）；
 *   ③ 只有被排除的证据 → `unproven`；一条都没有 → `not-observed`。
 */
export declare function verifyActualSelection(input: {
    readonly requested: string;
    readonly evidences: readonly ActualEvidence[];
}): ActualVerdict;
export interface DeclaredModelsPatch {
    readonly accountId: string;
    readonly models: readonly string[];
}
export interface CatalogEditRequest {
    readonly op: CatalogOp;
    readonly harnessId: string;
    readonly accountId?: string;
    readonly providerId?: string;
    readonly models?: readonly string[];
    /** 真实发现的候选（受约束选择用）。 */
    readonly candidates: readonly CatalogCandidate[];
    /** 能力探测结果（决定这一操作到底能不能做）。 */
    readonly capabilities: readonly CatalogCapability[];
    /** 之前声明的清单（用于算出增/删/改的差）。 */
    readonly currentDeclared?: readonly string[];
    /** `add-provider` 的 registry url（实测例：`kimi provider add <url>` 需要一个 api.json）。 */
    readonly registryUrl?: string;
    /** 显式允许目录里没有的手填值。默认 false。 */
    readonly allowUnlisted?: boolean;
    /** 显式确认「已知会写用户真实的 CLI 配置」。默认 false。 */
    readonly confirmWritesUserConfig?: boolean;
}
export interface CatalogEditPlan {
    readonly ok: true;
    readonly op: CatalogOp;
    readonly surface: CatalogSurfaceId;
    /** 该操作会跑的命令（若有）。**计划阶段绝不执行**。 */
    readonly argv?: readonly string[];
    /** 该操作会写的状态补丁（若有）。 */
    readonly patch?: DeclaredModelsPatch;
    /** 逐条写清「改了之后**哪里**会跟着变」——不许含糊。 */
    readonly effects: readonly string[];
    /** 逐条写清「改完怎么核验」，必须是**独立来源**的回读。 */
    readonly verification: readonly string[];
    readonly warnings: readonly string[];
    readonly declaredOrigin: readonly {
        readonly id: string;
        readonly origin: 'catalog' | 'unlisted-manual';
    }[];
}
export interface CatalogEditRefusal {
    readonly ok: false;
    readonly op: CatalogOp;
    readonly surface: CatalogSurfaceId;
    readonly verdict: CapabilityVerdict;
    /** 显式拒绝理由（可直接展示）。 */
    readonly reason: string;
    readonly evidence: readonly string[];
    readonly suggestions: readonly string[];
}
/**
 * 计划一次目录编辑。**纯函数，不执行任何东西**（执行见 {@link executeCatalogEdit}）。
 *
 * 每一个分支都先查能力判定：没探到 `supported` 就返回 {@link CatalogEditRefusal}，
 * 绝不返回一个「计划好了但落不了地」的东西。
 */
export declare function planCatalogEdit(request: CatalogEditRequest): CatalogEditPlan | CatalogEditRefusal;
/** 一次落地核验：**每个出口各回读一次**，并如实标出「表达不了这个字段」的出口。 */
export interface DeclaredModelsReadback {
    readonly entrance: string;
    /** 该出口读到的值；`undefined` = 该出口**表达不了**这个字段（盲）。 */
    readonly models?: readonly string[];
}
export interface DeclaredModelsVerification {
    readonly accountId: string;
    readonly requested: readonly string[];
    readonly verdict: 'applied' | 'not-applied' | 'unverified' | 'consistent';
    readonly readbacks: readonly {
        readonly entrance: string;
        readonly value: string;
        readonly matches: boolean | null;
    }[];
    /** 表达不了该字段的出口 —— 必须单独列出来，不能被算成「一致」。 */
    readonly blindEntrances: readonly string[];
    readonly reason: string;
}
/** 声明的**落地**核验（与「模型是否真的服务了本轮」是两件事，别混）。 */
export declare function verifyDeclaredModelsApplied(input: {
    readonly accountId: string;
    readonly requested: readonly string[];
    readonly readbacks: readonly DeclaredModelsReadback[];
}): DeclaredModelsVerification;
/** 执行器：**由调用方注入**。模块自己不 spawn 会写用户配置的命令。 */
export interface CatalogEditExecutors {
    /** 写入账号池的声明清单（index.ts 注入：updatePoolState + savePoolState 那一处）。 */
    readonly applyDeclaredModels?: (patch: DeclaredModelsPatch) => Promise<{
        readonly ok: boolean;
        readonly error?: string;
    }>;
    /** **独立**回读落盘声明（不要复用写入路径的返回值）。 */
    readonly readDeclaredModels?: (accountId: string) => Promise<readonly string[] | undefined>;
    /** 其它出口的回读（例如 `GET /pool` 的 HTTP 出口）；返回 undefined = 该出口表达不了这个字段。 */
    readonly readDeclaredModelsFromEntrance?: (entrance: string, accountId: string) => Promise<readonly string[] | undefined>;
    /** 跑该 CLI 自己的管理子命令（kimi provider add/remove 之类）。**未注入 = 该面不可执行**。 */
    readonly runHarnessAdminCommand?: (input: {
        readonly harnessId: string;
        readonly entry: string;
        readonly argv: readonly string[];
        readonly timeoutMs?: number;
    }) => Promise<{
        readonly code: number | null;
        readonly stdout: string;
        readonly stderr: string;
    }>;
}
export interface CatalogEditResult {
    readonly ok: boolean;
    readonly op: CatalogOp;
    readonly executed: boolean;
    /** 执行后**独立**核验的结果；没执行则为 undefined。 */
    readonly verification?: DeclaredModelsVerification;
    /** 该 CLI 管理命令的真实输出（若跑了）。 */
    readonly commandOutput?: {
        readonly code: number | null;
        readonly stdout: string;
        readonly stderr: string;
    };
    readonly reason: string;
    readonly warnings: readonly string[];
}
/**
 * 执行一次已经计划好的编辑，**并用独立来源核验落地**。
 *
 * 纪律：
 *   · 计划是拒绝的就绝不执行；
 *   · 没有注入对应执行器就拒绝（"组合里没接上" 不等于 "可以绕过"）；
 *   · `declare-models` 执行完必须回读（落盘 + 每个可注入的出口），并按
 *     {@link verifyDeclaredModelsApplied} 如实报「已落地 / 没落地 / 未核验 / 有出口是盲的」。
 */
export declare function executeCatalogEdit(plan: CatalogEditPlan | CatalogEditRefusal, executors: CatalogEditExecutors, options?: {
    readonly entrances?: readonly string[];
    readonly harnessEntry?: string;
    readonly timeoutMs?: number;
}): Promise<CatalogEditResult>;
/**
 * 读一个 JSON 文件（只做**独立回读**用）。
 *
 * 之所以自己读文件而不复用写入路径的内存状态：写入函数返回的东西**不是**独立证据。
 * 只读前 1 MiB，够用且不会把大文件整个拉进内存。
 */
export declare function readJsonHead(file: string, bytes?: number): unknown;
/** 从落盘状态里回读某个账号的声明模型清单（独立于写入路径）。 */
export declare function readDeclaredModelsFromFile(file: string, accountId: string): readonly string[] | undefined;
