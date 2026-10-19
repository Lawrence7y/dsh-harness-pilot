import type { WindowHelper } from './helper.js';
import type { AccountManagers } from './account-managers.js';
import { type SpawnTerminal } from './transports/pty.js';
import type { DispatchOutcome, DispatchSpec, ReadResult, TargetConfig, TransportKind } from './types.js';
import { type ResolvedConfig } from './config.js';
import { type DshProviderModels } from './models.js';
import type { DiscoveryState, ModelEntry, ModelKind } from './model-sources.js';
import { ProcessPool, type PoolPolicy } from './processpool.js';
/** `transports/cdp.js` 的 `ensureCdpLaunched` 返回值的最小契约。 */
interface CdpEnsureLike {
    readonly target: string;
    readonly status: 'already-attachable' | 'launched' | 'blocked-running-without-port' | 'failed';
    readonly port?: number;
    readonly pid?: number;
    readonly pids?: readonly number[];
    readonly detail: string;
}
/**
 * 点击结果的**统一形态**：CDP（页面内 JS 的返回值）与 window（UIA 查找）都归一化成它。
 *
 * 存在的理由是一个真实事故：`clickByTextSnippet()` 匹配不到元素时**不抛异常**，
 * 只 `return { ok: false }`；而调用方只 `catch` 了"抛异常"这一种失败，
 * 于是点没点中都会继续把文本打进去并回车 —— 一次误投递。
 * 现在两种通道都必须经由这个形状，调用方只检查 `ok` 一处。
 */
export interface ClickOutcome {
    /** 是否真的点到了元素。**false 时调用方必须停止后续输入**。 */
    readonly ok: boolean;
    /** 给人看的说明（成功=点到了什么；失败=为什么没点到）。 */
    readonly detail: string;
    /** 近失配候选，让模型换个说法重试（UIA 的 alternatives / DOM 的候选文字）。 */
    readonly candidates?: readonly string[];
}
/** 长期存活的交互式会话（窗口 / CDP / pty）。 */
export interface InteractiveSession {
    readonly id: string;
    readonly target: TargetConfig;
    readonly transport: TransportKind;
    readonly detail: string;
    /**
     * 通道降级告警：请求的通道没选上、实际用了别的通道时才有。
     * 以前这里是**静默** `continue`，用户以为在用 cdp，其实跑的是 window —— 那本身就是误导。
     */
    readonly warning?: string;
    read(options: {
        limit: number;
        mode?: 'auto' | 'uia' | 'console';
    }): Promise<ReadResult>;
    send(input: {
        text?: string;
        submit?: boolean;
    }): Promise<{
        note: string;
    }>;
    /** 只有 CDP 会话能求值页面 JS（用于按文字点按钮、打开面板）。 */
    evaluate?(expression: string): Promise<unknown>;
    /** 只有 CDP 会话能派发真实鼠标事件（某些 GUI 的菜单只认真实 pointerdown）。 */
    mouse?(action: 'click' | 'move', x: number, y: number): Promise<void>;
    /** 窗口会话：按可见名字点 UIA 元素（GUI harness 打开面板/新建任务）。 */
    clickElement?(name: string): Promise<ClickOutcome>;
    close(): Promise<void>;
    readonly summary: LiveSessionSummary;
}
export interface LiveSessionSummary {
    readonly id: string;
    readonly target: string;
    readonly transport: TransportKind;
    readonly detail: string;
    readonly openedAt: number;
    readonly closed: boolean;
    /**
     * 最后一次被真正使用的时刻（`read` / `send` / `evaluate` / `mouse` / `clickElement`）。
     * 空闲回收按它判定，而不是按 `openedAt` —— 一个一直在被读的会话不该被当成空闲。
     */
    readonly lastUsedAt?: number;
}
export interface PoolEventRecord {
    readonly level: 'info' | 'warn';
    readonly at: number;
    readonly message: string;
}
export interface SessionDeps {
    readonly config: ResolvedConfig;
    readonly helper: WindowHelper;
    /** 宿主 `ctx.subprocess.spawnTerminal`；缺失时 pty 档自动跳过。 */
    readonly spawnTerminal?: SpawnTerminal;
    /** 宿主 `ctx.llm`：用于读出「本 profile 已配置的供应商模型」。 */
    readonly llm?: {
        listProviders(): {
            id: string;
            name: string;
        }[];
        listModels(provider: string): Promise<{
            id: string;
        }[]>;
    };
    readonly log?: (level: 'info' | 'warn', message: string) => void;
    /**
     * **受管账号的执行前门禁**（真实测量：随包适配器 sha256 + 厂商 CLI `--version` 实测）。
     *
     * 为什么在这里也要有：`registry.dispatch()` 是 HTTP `/dispatch`、`/task/start` 与
     * `harness_task_start` 的**唯一收口**，这三条路都**不**经过子代理 provider
     * （`provider.ts` 的别名路径），所以只在 provider 里接线等于「门禁只对一半入口成立」。
     * 返回字符串 = 可读拒绝原因；`undefined` = 放行（也用于「非受管账号」与「不是账号派发」）。
     *
     * ⚠️ 幂等性由调用方声明的 `spec.accountGateChecked` 保证：已经真测过的路径不得重测
     * （详见 `DispatchSpec.accountGateChecked` 的注释）。
     */
    readonly accountRuntimeGate?: (accountId: string, targetName: string) => Promise<string | undefined>;
    readonly accountManagers?: Pick<AccountManagers, 'beginExecution'>;
    readonly prepareAccountTarget?: (target: TargetConfig, accountId?: string) => TargetConfig;
    /**
     * 该目标是否被用户在「Harness 管理」里**停用**。
     * 停用必须**显式拒绝**派发，而不是静默换一个 harness 或通道执行。
     */
    readonly isTargetDisabled?: (targetName: string) => boolean;
    /**
     * 并发上限 / 空闲窗口的初值（可配置）。缺省 = `DEFAULT_POOL_POLICY`（上限 4、拒绝式）。
     * 之后由设置页经 `SessionRegistry.setPoolPolicy()` 实时改。
     */
    readonly pool?: Partial<PoolPolicy>;
    /**
     * 池状态落盘路径。给了之后探针/运维能在**不重启**的前提下读到池的真实状态
     * （否则只能靠进程内自测）。
     */
    readonly poolStateFile?: string;
}
/** 单个 harness 在设置页/概览里的画像。 */
export interface TargetOverview {
    readonly name: string;
    readonly description: string;
    readonly transport: string;
    readonly order: string[];
    readonly command: string;
    readonly commandPath?: string;
    readonly available: boolean;
    readonly reason?: string;
    /** 目标默认模型（ACP 会话内切换的那个）或空。 */
    readonly model: string;
    /** 是否支持「派发时指定模型」。 */
    readonly canSelectModel: boolean;
    /** harness 自己列出的模型（仅在请求 models 时填充）。 */
    readonly models: string[];
    readonly modelsNote: string;
    /**
     * **缓存里的**四态与四类计数（`/api/models` 的完整结果只在按需测量时给）。
     *
     * 为什么概览只给缓存：四态要嘛读原生配置（便宜），要嘛问 CLI（起进程）。
     * 概览是高频接口，不能每次刷新都把 35 个 CLI 都拉起来 —— 所以这里如实分两层：
     *   · 概览 = 缓存/静态可得的部分（`measured:false` 时不假装测过）；
     *   · 设置页上的「测量」按钮 = 显式去问一次（走 `/api/models`，有 refresh 语义）。
     */
    readonly modelState?: DiscoveryState;
    readonly modelCounts?: Readonly<Record<ModelKind, number>>;
    /** 缓存是否命中的直白标记（false = 上面两个字段来自静态配置，不是刚问出来的）。 */
    readonly modelMeasured?: boolean;
}
export interface Overview {
    readonly plugin: {
        name: string;
        version: string;
    };
    readonly defaultTarget: string;
    readonly targets: TargetOverview[];
    readonly sessions: LiveSessionSummary[];
    readonly dsh: {
        providers: DshProviderModels[];
    };
    readonly generatedAt: number;
}
/**
 * 落盘缓存（seeded）的展示 TTL：6 小时。
 *
 * 只影响「重载后先展示上次发现」，不影响新鲜度纪律：后台预热会 orce 刷新每条目标，
 * 刷新结果覆盖它并重新落盘；超过这个年龄的落盘条目在加载时就被丢掉。
 */
export declare const SEEDED_MODEL_TTL_MS: number;
/** 会话被关闭的原因（墓碑上必须带；`unknown session` 的可解释性靠它）。 */
export type ClosedSessionReason = 'idle-reap' | 'dispose' | 'explicit' | 'replaced';
export declare class SessionRegistry {
    private readonly deps;
    private modelCacheKey;
    private readonly sessions;
    /**
     * 已关闭会话的**墓碑**（FIFO，上限 100 条）。
     *
     * 为什么需要：会话被空闲回收/插件卸载关掉之后，调用方再拿旧 id 来用时只能看到一句
     * `unknown session "…"`（2026-10-16 现场：4 个桌面会话隔一轮全灭，调用方完全无从判断
     * 是「从未存在」还是「被回收了、该重开」）。墓碑让 get() 未命中时能给出**可执行**的
     * 解释：谁、什么时候、被什么关的、下一步怎么办。
     */
    private readonly closedSessions;
    /**
     * 模型列表缓存（按目标的**配置指纹**做键，避免每次起进程问）。
     *
     * `name` 是目标名：键是哈希，**必须**把名字也存进来，否则无法把缓存**持久化**后按名字回填
     * （2026-10-15 加的：重载后首建目录要么 14.8s 全查一遍，要么只剩「CLI 默认模型」）。
     * `seeded === true` 表示这条来自**落盘的**上次发现（`at` 可能是几十分钟前）——
     * 它仍可用于展示，但调用方会把这一事实写进 note，并且后台预热立刻刷新它。
     */
    private readonly modelCache;
    private readonly acpModule;
    private readonly cdpModule;
    private readonly windowModule;
    private counter;
    /**
     * 并发闸门 + 空闲核对账本。
     *
     * ⚠️ 惰性构造：`pluginHome()` 在**构造时**求值（读 env 与 homedir），若在 SessionRegistry
     * 构造那一刻环境还没就位，早构造会冻结一个错的目录。所以这里用 getter 兜住时序。
     */
    private poolBox;
    /** 空闲回收巡检计时器（长期交互会话的空闲释放）。 */
    private idleTick;
    /** 池的事件环形缓冲（`/diag/processpool` 之类只读出口用；不落盘时也能看到）。 */
    private readonly poolEvents;
    constructor(deps: SessionDeps);
    /**
     * 并发闸门实例（惰性、单例）。公开是**故意的**：设置页改 `maxConcurrent` 之后要能
     * 实时把新上限推给它（`setPoolPolicy`），只读出口也要能拿到快照。
     */
    pool(): ProcessPool;
    /**
     * 实时改并发上限 / 空闲窗口。**只影响之后的新准入** —— 已经跑起来的不动
     * （中途改上限会让「谁占了名额」不可解释）。
     */
    setPoolPolicy(raw: Partial<PoolPolicy>): PoolPolicy;
    /** 池事件（最近 200 条，含拒绝原因）—— 拒绝必须**留痕**，这是零静默降级的一部分。 */
    poolEventLog(): readonly PoolEventRecord[];
    private armIdleTick;
    /**
     * 关掉**空闲超窗**的长期交互会话。
     *
     * 为什么需要：`harness_open` 打开的 pty / cdp / window 会话在 `disposeAll()` 之前
     * 一直活着 —— 一个被忘掉的 GUI 会话就是几百 MB 常驻。这里按**最后一次真正使用**
     * 判定空闲（不是按打开的时长），到点就关，并把「关了谁」记进池账本。
     *
     * 窗口用的是 `idleSessionReapMs`（默认 30 分钟），**不是**进程核对用的 `idleReapMs`
     * （30s）——交互会话的使用节奏由调用方的轮次间隔决定，2026-10-16 实测 30s 会把
     * 「开完隔一轮再投」的正常节奏误判成废弃（现场 4 个桌面会话全灭）。
     *
     * `dryRun` 只做判定、不关任何会话（探针/设置页用来先看会发生什么）。
     */
    closeIdleSessions(options?: {
        dryRun?: boolean;
        windowMs?: number;
    }): Promise<{
        readonly windowMs: number;
        readonly closed: readonly string[];
        readonly candidates: readonly {
            id: string;
            target: string;
            transport: TransportKind;
            idleMs: number;
        }[];
    }>;
    private log;
    private acp;
    private cdp;
    private window;
    /**
     * 通道预检：只判断「这一档能不能用」，不派发任务（避免失败后重复执行）。
     *
     * `killFirst` 会改变 cdp 的判定：单实例阻塞时，带 kill_first 的 cdp **可用**
     * （插件会先终止再带端口拉起）。不传则维持"如实报告被挡住"的只读语义。
     */
    preflight(kind: TransportKind, target: TargetConfig, options?: {
        killFirst?: boolean;
    }): Promise<{
        available: boolean;
        detail: string;
    }>;
    /**
     * 桌面目标的**非破坏首启**（2026-10-16 统筹修复请求）：
     * 目标没在跑就带 `--remote-debugging-port=<分配端口>` 拉起，让第一次启动就带端口，
     * 之后派发直接附着 —— 全程不终止任何进程（单实例在跑且无端口时如实回报 blocked，
     * 杀不杀由调用方走 kill_first 显式决定）。
     *
     * 只对 cdp 梯子里的目标有意义：headless/pty 目标不是 GUI 应用，明确拒绝。
     */
    launchDesktop(target: TargetConfig, options?: {
        cwd?: string;
    }): Promise<CdpEnsureLike>;
    /** 按梯子选一档并跑一次任务；失败不会自动换档重跑（避免重复执行）。 */
    dispatch(spec: DispatchSpec, options?: {
        transport?: string;
    }): Promise<DispatchOutcome>;
    private dispatchUnleased;
    private asPoolTask;
    /** 把池的拒绝翻成一次**可见的**派发结果：不执行、不改道、不说"成功"。 */
    private poolDenial;
    /**
     * 并发闸门 + 空闲核对：**这是所有派发的唯一收敛点**（`/dispatch`、`/task/start`、
     * 子代理 provider、`harness_dispatch` 工具都经 `dispatch()`）。
     *
     * 四件事必须一起做，缺一个就会出现「看起来有上限、其实没有」或「看起来收干净了、
     * 其实没登记过」：
     *   1. 准入（`pool.run`）：超限 → 排队或显式拒绝，二者都可观察；
     *   2. **运行期**登记 pid：transport 在 `spawn()` 那一刻经 `onSpawn` 回报，
     *      池立刻记下"我拉起了哪个进程、什么时候"（不是等结算后补一个 pid）；
     *   3. 登记结束事实：退出码 / 信号 / 是否被取消（迟到也回填）；
     *   4. 出口核对（`finish` 内部实测）：任务结束时进程树是否真的没了。
     */
    private poolGate;
    private run;
    /** 这条会话的「首选通道」：显式 transport 优先，否则 order 里第一个有会话概念的档。 */
    private preferredSessionTransport;
    /**
     * 打开一个长期交互会话（GUI harness 优先 CDP，其次窗口，最后 pty）。
     *
     * - `transport`：强制只走某一档。补救命令 `harness_open target=… transport=window`
     *   依赖它，用来"CDP 被单实例挡住时改走窗口"。
     * - `killFirst`：透传给 cdp 通道，用于「目标在跑但没带调试端口」的单实例场景。
     */
    private readonly managerSessionLeases;
    open(target: TargetConfig, options: {
        cwd: string;
        launch?: boolean;
        killFirst?: boolean;
        killForce?: boolean;
        transport?: string;
    }): Promise<InteractiveSession>;
    private openUnleased;
    private wrapPty;
    private create;
    private mintId;
    list(): LiveSessionSummary[];
    get(id: string): InteractiveSession | undefined;
    /**
     * 「这个 id 为什么不在活会话表里」的解释（未命中且无墓碑时返回 undefined ——
     * 那就是「从未在本进程里开过」，如实说，不编造历史）。
     */
    explainMissing(id: string): string | undefined;
    private recordClosed;
    close(id: string, reason?: ClosedSessionReason): Promise<boolean>;
    disposeAll(): Promise<void>;
    /**
     * 给长期会话挂上「最后使用时刻」追踪。
     *
     * 为什么用 Proxy 而不是把每个方法都包一层：`read` / `send` / `evaluate` / `mouse` /
     * `clickElement` 五条路径都要刷新时间戳，手写五处将来一定会漏一处 ——
     * 而漏掉的那一处会让空闲回收**误杀**一个其实在用的会话。Proxy 按方法名统一拦截，
     * 新增方法自动被覆盖。`summary` 是对象引用（接口上只读），这里改的是它上面的字段。
     */
    private withIdleTracking;
    /** 供工具层使用：把目标名解析成 TargetConfig。 */
    target(name: string | undefined): TargetConfig;
    /** harness 自报的模型列表（带缓存）；modelsCommand 未配置时返回空。 */
    targetModels(target: TargetConfig, options?: {
        readonly force?: boolean;
    }): Promise<{
        models: string[];
        note: string;
        entries?: readonly ModelEntry[];
        state?: DiscoveryState;
    }>;
    /**
     * **把上次发现落盘**（`index.ts` 在预热跑完后调用）。
     *
     * 只导出**新鲜**（非 seeded）的条目：seeded 的是「上次落盘又读回来」的，再写回去只是搬来搬去。
     * 另外跳过 `entries` 为空的条目：回填时它一样会被丢（`entries.length === 0` 视为没有发现），
     * 写进去只是白占体积（实测落盘里有 `zcode-cli=0` 这类空条目）。
     */
    exportModelCache(): Array<{
        readonly name: string;
        readonly at: number;
        readonly models: readonly string[];
        readonly note: string;
        readonly entries?: readonly ModelEntry[];
        readonly state?: DiscoveryState;
    }>;
    /**
     * 用**落盘的**上次发现回填缓存（挂载时一次性）。
     *
     * 两条纪律：
     *   · 只接受**在 `maxAgeMs` 以内**的条目（更老的就当没有 —— 不能拿一天前的模型清单冒充「现在能选」）；
     *   · 回填的条目保留原始 `at`、并标 `seeded`，`note` 追加「本地缓存，N 分钟前发现」，界面上看得见它的来路。
     * @returns 回填了几条
     */
    seedModelCache(rows: readonly {
        readonly name: string;
        readonly at: number;
        readonly models: readonly string[];
        readonly note: string;
        readonly entries?: readonly ModelEntry[];
        readonly state?: DiscoveryState;
    }[], options: {
        readonly maxAgeMs: number;
        /**
         * **算缓存键用的目标变换**，必须与读取路径（`syncModelsFor` → `modelScopedTarget`）一致。
         *
         * ⚠️ 2026-10-15 实测踩到的坑：第一版按**未加账号作用域**的目标算键，而读取路径按
         * `modelScopedTarget()`（会往 `modelsArgs` 里加 `--config-dir`）算键 ——
         * 键不同 ⇒ 回填的条目**读不到**，重载后首建目录依旧 16.5s（带账号的组尤其明显）。
         */
        readonly scope?: (target: TargetConfig) => TargetConfig;
    }): number;
    /** 清掉模型缓存（UI 上「刷新模型」用）。 */
    clearModelCache(target?: TargetConfig): void;
    /**
     * **只读**模型缓存（**不**起子进程）：给 `pilot-cli` 路由的目录出口用。
     *
     * 为什么需要它：`listModels()` 是宿主高频调用且必须同步（`dsh-llm` 目录刷新会反复问），
     * 而 `targetModels()` 未命中缓存时会**起子进程**问 CLI。两者不能混用：
     * 目录出口只看缓存，缓存未命中就只宣传「默认模型」条目，同时由调用方排一轮后台预热。
     */
    cachedModels(target: TargetConfig): {
        models: string[];
        note: string;
        entries?: readonly ModelEntry[];
        state?: DiscoveryState;
    } | undefined;
    /**
     * 设置页/概览用的全量画像：目标 + 可用性 + 模型 + 活跃会话 + DSH 已配置的供应商模型。
     * `models: true` 会去问每个 harness（起进程，慢），默认只用缓存/静态信息。
     */
    overview(options?: {
        models?: boolean;
    }): Promise<Overview>;
}
/**
 * 决定「通道说明」要不要给、给什么。**没有降级就绝不说降级**。
 *
 * 修的是这样一个真实缺陷：调用方**明确强制**了某个通道时，原实现仍然拿它跟
 * 「梯子偏好的通道」比一比，于是强行指定 `acp`（梯子偏好 `cdp`）会被报成
 * 「cdp 不可用，改用 acp」—— 而**根本没有发生降级**，那是调用方自己点的。
 * 反过来看也一样糟：真正需要提醒的「梯子降级」会被这种假告警淹没，读者会开始忽略它。
 *
 * 现在的规则：
 *   · 没强制 + 用到的不是梯子首选 → **真降级**，必须报（并带上其它档被跳过的原因）；
 *   · 强制了 + 正好是梯子首选 → 不需要说明；
 *   · 强制了 + 不是梯子首选 → 说明这是**调用方的显式选择，不是降级**（避免被误读）；
 *   · 找不到梯子偏好时，只在「没强制」的情况下报一句无法判定。
 *
 * @returns undefined = 不需要任何说明
 */
export declare function sessionTransportNote(forced: string | undefined, preferred: TransportKind | undefined, used: TransportKind, attempts: readonly string[]): string | undefined;
export declare const PLUGIN_NAME = "@dsh-external/dsh-harness-pilot";
/**
 * 插件版本**从 package.json 读**，不再硬编码。
 *
 * 之前这里写死 `0.1.0`，而 package.json 是 `0.1.1` —— `/overview` 因此长期自报错误版本。
 * 硬编码的版本号一定会漂移；改成读真实文件，读不到时给出显式占位而不是一个假的数字。
 */
export declare function pluginVersion(): string;
/**
 * 归一化出口：把**请求身份**与**实际身份**放在一起，并算出偏差。
 *
 * 这是「配置值 ≠ 实际值必须能看出来」的唯一落点：
 *   · 请求的模型与通道实际采用的模型不一致 → mismatch
 *   · 通道自己报了 mismatch（例如 ACP 换模型失败）→ 原样带出
 *   · 只有请求值与原生回报值两侧都有值才比较；空 mismatch 不证明整体一致
 *
 * 刻意做成**导出的纯函数**：ACP 的换模型失败路径在本机受 opencode 未配置供应商认证所限，
 * 无法稳定地在真实会话里复现，因此这段判据必须能离线单测 —— 否则它只会是「看起来写了」。
 */
export declare function foldOutcomeIdentity(spec: DispatchSpec, targetName: string, chosen: TransportKind, outcome: DispatchOutcome, ladder: string): DispatchOutcome;
export {};
