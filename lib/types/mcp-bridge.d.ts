import type { McpServerSpec } from './types.js';
/** MCP server 名。**不含连字符**：CLI 把工具名拼成 `mcp__<server>__<tool>`，段名会被清洗。 */
export declare const MCP_BRIDGE_SERVER_NAME = "dsh_bridge";
/**
 * 注入**通道**（两种通道的注入向量完全不同，因此不能共用一个门槛）：
 *
 * - `argv-mcp-config`（默认，headless）：往 argv 里塞 `--mcp-config <文件>`（＋最小授权）。
 *   **门槛**：只对「有直接证据认这个参数」的 CLI 基名开（`MCP_CONFIG_CLI_BASENAMES`）。
 * - `acp-mcp-servers`：走 ACP 协议字段 —— `session/new` 的 `mcpServers`
 *   （`@agentclientprotocol/sdk/dist/schema/zod.gen.js:2422-2427`）。**不动 argv**，
 *   因此「这个 CLI 认不认 `--mcp-config`」不是这条通道的性质，不能拿它当门槛；
 *   这条通道的真实门槛是**入口绑定活 Agent**（下面 `openForTurn` 的 ②）＋ 调用方
 *   确认这一轮走的是 ACP 传输。
 */
export type McpBridgeChannel = 'argv-mcp-config' | 'acp-mcp-servers';
/** 两条通道的取值（探针/自检断言用）。 */
export declare const MCP_BRIDGE_CHANNELS: readonly McpBridgeChannel[];
/** `bridge.skip` 限流参数（`probe/verify-bridge-skip-throttle.mjs` 据此算窗口数）。 */
export declare const MCP_BRIDGE_SKIP_DEDUPE: {
    readonly envVar: "DSH_BRIDGE_SKIP_DEDUPE_MS";
    readonly windowMs: number;
    readonly minWindowMs: 5000;
    readonly defaultWindowMs: 60000;
    readonly maxLinesPerWindow: 120;
    readonly maxKeys: 512;
};
/** MCP server 自报名（诊断用）。 */
export declare const MCP_BRIDGE_SERVER_VERSION = "0.1.0";
/**
 * **首期最小集合**（上级指定）：团队 `list`/`send`/`wait` + harness 任务 `派发`/`结果`/`取消`。
 * 名字与宿主/本插件注册的工具名**逐字一致**，不做任何改名 —— 这样「桥接的到底是什么」可逐条核对。
 */
export declare const MCP_BRIDGE_TOOLS: readonly ["list_agents", "send_message", "wait_agent", "harness_task_start", "harness_task_status", "harness_task_cancel"];
export type McpBridgeToolName = (typeof MCP_BRIDGE_TOOLS)[number];
/** 宿主面：本模块只声明**真正用到**的东西。 */
export interface McpBridgeHostCtx {
    get?<T>(name: string): T | undefined;
    on?(name: string, listener: (...args: never[]) => unknown, options?: unknown): unknown;
    logger?: {
        info?(message: string): void;
        warn?(message: string): void;
    };
}
/** 一次开入口的输入。 */
export interface McpBridgeOpenInput {
    /** 目标子会话 id（团队成员的子会话）。没有活 Agent 就**不开**入口。 */
    readonly sessionId?: string;
    /** 这一轮要跑的外部 CLI 命令（绝对路径或裸命令名）。用它判定能不能注入 MCP 配置。 */
    readonly command?: string;
    /**
     * 注入通道：`argv-mcp-config`（默认，headless 的 `--mcp-config`）或
     * `acp-mcp-servers`（ACP 的 `session/new.mcpServers`）。见 `McpBridgeChannel`。
     */
    readonly channel?: McpBridgeChannel;
    /** 谁在开这个入口（取证用，例如 `pilot-cli-redirect`）。 */
    readonly origin: string;
    /** TTL 覆盖值（会被 `MAX_TTL_MS` 夹住）。 */
    readonly ttlMs?: number;
    /** 是否在 argv 里预授权被桥接的工具名（CLI 侧）。默认 true。**只对 `argv-mcp-config` 通道有意义**。 */
    readonly authorizedTools?: boolean;
    /** 写入日志的附加字段（例如 target 名）。**不得**含令牌。 */
    readonly note?: Readonly<Record<string, unknown>>;
}
/** 一个已开入口的**脱敏**视图（日志 / 取证用；不含令牌）。 */
export interface McpBridgeView {
    readonly id: string;
    readonly sessionId: string;
    readonly agentId: string;
    readonly origin: string;
    readonly port: number;
    readonly url: string;
    readonly tokenFingerprint: string;
    readonly configPath: string;
    readonly ttlMs: number;
    readonly openedAt: string;
    readonly expiresAt: string;
    readonly closedAt?: string;
    readonly closeReason?: string;
    readonly calls: number;
    readonly rejections: number;
    readonly injected: boolean;
    /** 这条入口用的是哪条注入通道（`argv-mcp-config` / `acp-mcp-servers`）。 */
    readonly channel: McpBridgeChannel;
    readonly extraArgs: readonly string[];
    /**
     * **落盘的那份注入文件里有没有凭据**。恒为 `false`（headless 通道写的是不含令牌的
     * stdio 代理配置；ACP 通道根本不落盘）。写进视图是为了让「凭据有没有落盘」**可核对**，
     * 而不是靠一句承诺。
     */
    readonly configHasCredential: boolean;
    /** 手递凭据用的**环境变量名**（只有名字，没有值）。ACP 通道为空。 */
    readonly handoffEnvKeys: readonly string[];
}
/** 入口句柄：调用方拿它注入 argv，并在本轮结束时关闭。 */
export interface McpBridgeHandle {
    readonly id: string;
    readonly sessionId: string;
    readonly agentId: string;
    readonly port: number;
    readonly url: string;
    readonly tokenFingerprint: string;
    readonly configPath: string;
    readonly expiresAt: string;
    /** 这条入口用的是哪条注入通道。 */
    readonly channel: McpBridgeChannel;
    /** headless 通道要追加的 argv（可能为空 = 这个 CLI 不支持注入，或这条通道不走 argv）。 */
    readonly extraArgs: readonly string[];
    /**
     * **ACP 通道**要放进 `DispatchSpec.mcpServers` 的条目（形状见 `mcpServerDescriptors`）。
     *
     * 令牌**只**由本模块在这里拼进 `Authorization` header —— 句柄**不提供**任何
     * 「把令牌取出来」的方法（避免「令牌可被任意调用方取出」变成常规路径）。
     * 每次读都是一份**新对象**；调用方不得把它记进日志（`view()` 里没有它）。
     */
    readonly mcpServers: readonly McpServerSpec[];
    /**
     * **headless 通道的手递凭据**（每次读新建一份）：调用方把它并进**这一轮 CLI 子进程**的环境。
     *
     * - 令牌**只**经由这条路交出去：不进配置文件、不进 argv、不进日志、不经 API 返回；
     * - ACP 通道返回 `{}`（那条通道的注入向量是协议字段，不走 env）；
     * - 调用方**不得**把它记进任何诊断/日志/响应体 —— 只许原样交给 `spawn` 的 `env`。
     *   变量名本身（不是值）在 `view().handoffEnvKeys` 里可见，便于取证。
     */
    readonly handoffEnv: Readonly<Record<string, string>>;
    close(reason: string): void;
    view(): McpBridgeView;
}
/** 一条桥接事件（写 JSONL，也留在内存环形缓冲里）。 */
export interface McpBridgeEvent {
    readonly time: string;
    readonly seq: number;
    readonly event: string;
    readonly [key: string]: unknown;
}
export interface McpBridgeOptions {
    readonly ctx: McpBridgeHostCtx;
    /** 事件 JSONL 路径。 */
    readonly logPath: string;
    /** `--mcp-config` 文件目录（每个入口一个文件，关闭即删）。 */
    readonly configDir: string;
    /**
     * 可选：stdio 代理自己的事件 JSONL 路径（`DSH_BRIDGE_PROXY_LOG`）。
     *
     * 代理**不解析** MCP 语义，但它会记「收到哪些方法 / 转发得到什么状态码」——
     * 这是「令牌没进日志」这条断言在**代理这一侧**也能被扫到的前提
     * （不传就完全不写代理日志）。
     */
    readonly proxyLogPath?: string;
    readonly defaultTtlMs?: number;
    readonly maxTtlMs?: number;
    /** 覆盖桥接工具白名单（默认 `MCP_BRIDGE_TOOLS`）。 */
    readonly tools?: readonly string[];
    /** 是否安装 `tools/execute` 原生管线观察器（默认安装）。 */
    readonly observePipeline?: boolean;
}
/**
 * `bridge.skip` 限流的**可核对计数**（`paths.skipLog`，随 `GET /mcp-bridge` 一起读出）。
 *
 * 这是「写盘速率有界」这件事的**读数面**：即使刷屏在窗口中途停止、没有触发下一条汇总行，
 * `suppressedByDedupe` / `suppressedByCap` 也仍然告诉取证者「有多少条被压掉了」——
 * 被压掉的是**重复**，不是**信息**：唯一的 reason/session 组合**第一条**永远落盘。
 */
export interface McpBridgeSkipLog {
    readonly windowMs: number;
    readonly maxLinesPerWindow: number;
    /** 本实例累计 `bridge.skip` 调用次数（= 调用方实际请求次数）。 */
    readonly calls: number;
    /** 其中**真的落盘**的行数。 */
    readonly written: number;
    /** 被「同键同窗口」压掉的行数。 */
    readonly suppressedByDedupe: number;
    /** 被「全实例每窗口行数上限」压掉的行数。 */
    readonly suppressedByCap: number;
    /** 当前记住的去重键数（上界 `maxKeys`）。 */
    readonly distinctKeys: number;
    /** `written + suppressedByDedupe + suppressedByCap === calls`（自检；false 就是记账漏了）。 */
    readonly accountingHolds: boolean;
}
export interface McpBridge {
    /**
     * 为**一轮派发**开入口。
     *
     * - 目标 CLI 没有**已验证**的 `--mcp-config` 注入 ⇒ 返回 `undefined`（**不开端口**）；
     * - 该会话没有活 Agent ⇒ 返回 `undefined`（作用域绑定是硬前提，绑不上就不许有入口）。
     *
     * **异步**是刻意的：端口必须真的 `listen` 成功之后才能算出来，而调用方要用
     * `extraArgs` 拼 argv。宁可 await，也不返回一个「端口未知」的假句柄。
     */
    openForTurn(input: McpBridgeOpenInput): Promise<McpBridgeHandle | undefined>;
    list(): readonly McpBridgeView[];
    events(limit?: number): readonly McpBridgeEvent[];
    /** 关闭入口。给了 `sessionId` 就只关那个会话的入口；不给就全关。 */
    closeAll(reason: string, sessionId?: string): void;
    /** 只关一个入口（按 id）。返回是否真的关掉了一个还开着的入口。 */
    closeOne(id: string, reason: string): boolean;
    /**
     * 落盘路径 + **`bridge.skip` 限流计数**（后者是**活的**只读视图：每次读都是当前值）。
     *
     * 追加 `skipLog` 是**加法**：`index.ts` 的 `GET /mcp-bridge` 原样把 `paths` 序列化出去，
     * 所以探针不必改宿主代码就能读到「写盘上界」的读数。
     */
    readonly paths: {
        readonly logPath: string;
        readonly configDir: string;
        readonly skipLog: McpBridgeSkipLog;
    };
}
/** 取可执行文件基名（去扩展名、转小写），用于判定 CLI 是否支持 `--mcp-config`。 */
export declare function cliBasename(command: string): string;
/** 这个 CLI 支持 `--mcp-config` 注入吗？只对**有直接证据**的基名回答 true。 */
export declare function supportsMcpConfigInjection(command: string | undefined): boolean;
/**
 * **`--mcp-config` 文件的内容** —— 只写**不含任何凭据**的 stdio 代理配置。
 *
 * ## 为什么不是 http + Authorization 头（这是一次**安全修复**）
 * 之前这里写的是 `{type:'http', url, headers:{Authorization:'Bearer <令牌>'}}`：令牌于是
 * **以明文落盘**（`mode: 0o600` —— 但那在 **Windows 上不是强制 ACL**，两个令牌都没拿到的
 * 本地进程照样读得到）。ACP 通道那条路不落盘，**不代表** headless 这条持久化路径也安全。
 *
 * 现在落盘的只有「怎么把我的代理拉起来」：
 * ```
 * {"mcpServers":{"dsh_bridge":{"command":"<node>","args":["<…>/lib/mcp-bridge-proxy.js"],"env":{}}}}
 * ```
 * 凭据**不在文件里**：它在**每次 spawn 独立**的子进程环境里交给代理
 * （`MCP_BRIDGE_HANDOFF_*`，见 `MCP_BRIDGE_HANDOFF_ENV`），代理再转发到本机 loopback 入口。
 * 于是 配置 / argv / 日志 / API 四处都不含令牌；入口关闭即代理随 stdin 结束退出、凭据一起消失。
 *
 * ## 实测过的形状依据（不许猜）
 * | 事实 | 证据 |
 * |---|---|
 * | 条目形状 `{command, args, env}`，`type` **可省**、`env` **可省** | `probe/_mcp-stdio-contract-probe.mjs`（真机 prompt：C1b/C1c/C2b） |
 * | CLI **真的 spawn** 这个 command，并完成 `initialize` + `tools/list` + `tools/call` | 同上 C1c/C1d/C2d |
 * | stdio 传输是 **NDJSON**（一行一个 JSON，`2025-11-25`），**不是** `Content-Length` 头 | 同上 C1e/C1f（原始字节 `…stdin.hex`） |
 * | CLI 把它自己进程的环境**深拷贝**给 MCP 子进程（`env` 那一项写不写都一样） | `probe/_mcp-env-semantics-matrix.mjs`（A 缺席／B 空对象／C 非空 三个变体结果逐字相同） |
 * | 但会**按名字丢掉**含 `TOKEN`/`SECRET`/`KEY`/`AUTH`/`PASSWORD`/`CREDENTIAL` 的键 | 同上（`DSH_BRIDGE_HANDOFF` 透传，`…_HANDOFF_TOKEN` / `…_HANDOFF_KEY` **整键不在**） |
 */
export declare function mcpConfigDocument(nodeExecutable: string, proxyScriptPath: string): Record<string, unknown>;
/** CLI 侧对被桥接工具名的预授权参数（工具名格式由 CLI 自己拼：`mcp__<server>__<tool>`）。 */
export declare function allowedToolArgs(serverName: string, toolName: string): readonly string[];
/**
 * **只让本轮 `--mcp-config` 生效**，不要顺带把 CLI 自己 settings 文件里的 MCP server 也拉进来。
 *
 * 理由有两层，都要说清楚：
 *   1. 桥接入口的作用域是**这一个成员的活 Agent**；本轮里混进别的 MCP server
 *      只会让「这次工具调用是谁发的」变得含糊；
 *   2. 更重要的是**安全边界**：那些 server 的凭据由 CLI 自己的配置保管，**不由本插件负责、
 *      也不该被本插件这一轮的写法牵扯进来**。加上这个开关，「本轮只加载我给的那一个 server」
 *      是一个**可核对的**事实，而不是「大概只有我那一个」。
 *
 * 实测：`qoderclicn --help` 有 `--strict-mcp-config  Only use MCP servers from --mcp-config (default: false)`。
 */
export declare function strictMcpConfigArgs(): readonly string[];
/**
 * **手递凭据的环境变量名**（headless stdio 代理通道专用）。
 *
 * ```text
 * DSH_BRIDGE_HANDOFF       = 本次入口的 loopback URL（含一次性随机路径段）
 * DSH_BRIDGE_HANDOFF_PAT   = 本次入口的一次性 Bearer 令牌
 * DSH_BRIDGE_PROXY_LOG     = 代理事件 JSONL 路径（可选；里面只有方法与状态码）
 * ```
 *
 * ### ⚠️ 为什么**不是** `…_TOKEN` / `…_KEY` 这种名字（实测出来的硬约束，不是取名偏好）
 * `qoderclicn 1.1.13` 在 spawn stdio MCP 子进程时，把它自己进程的环境**深拷贝**过去，
 * 但**按名字丢掉**含 `TOKEN` / `SECRET` / `KEY` / `AUTH` / `PASSWORD` / `CREDENTIAL`
 * 的键（大小写不敏感的子串匹配）。实测（`probe/_mcp-env-semantics-matrix.mjs`、
 * `probe/_mcp-key-decisive.mjs`，值长度 18/20 与 43/47 两档都测过）：
 *
 * | 键名 | 结果 |
 * |---|---|
 * | `DSH_BRIDGE_HANDOFF` / `…_PAT` / `…_BEARER` / `CANARY_SENTINEL` / `API_FOO` | **透传**（值逐字一致） |
 * | `…_TOKEN` / `…_KEY` / `…_SECRET` / `…_AUTH` / `…_PASSWORD` / `…_CREDENTIAL` / `API_KEY` / `TOKEN` | **整键不在** |
 *
 * 用被过滤的名字，后果是**凭据被静默丢掉、代理 exit 2、桥接一个工具都不可见** ——
 * 那是比明文落盘更隐蔽的坏状态（看起来在工作，其实没有）。
 * 所以这里取 `…_PAT`：它**就是**这类凭据在业界最常用的名字（personal access token），
 * 而不是为了绕过过滤器拼出来的怪名字；并且它被**实测**证明会透传。
 *
 * ⚠️ **fail closed**：`handoffEnv()` 会**逐个核对**下面这些键名是否落在
 * `MCP_BRIDGE_HANDOFF_FORBIDDEN_NAME_PARTS` 之外；一旦有人改了名字而没改这里，
 * **开入口时就抛错**（而不是等到代理静默 exit 2）。
 */
export declare const MCP_BRIDGE_HANDOFF_ENV: {
    readonly url: "DSH_BRIDGE_HANDOFF";
    readonly token: "DSH_BRIDGE_HANDOFF_PAT";
    readonly proxyLog: "DSH_BRIDGE_PROXY_LOG";
};
/**
 * CLI 会**按名字丢掉**的键名片段（实测；大小写不敏感的子串匹配）。
 * 这张表是**判据**，不是装饰：`handoffEnv()` 与探针都用它来 fail closed。
 */
export declare const MCP_BRIDGE_HANDOFF_FORBIDDEN_NAME_PARTS: readonly string[];
/** 这个键名会被 CLI 丢掉吗？（大小写不敏感的子串匹配，照实测规则） */
export declare function isHandoffNameDropped(name: string): boolean;
/**
 * 给 CLI 子进程用的**手递凭据**环境变量（每次 spawn 一份新的）。
 *
 * 这是本模块**唯一**把令牌交出去的地方：交出去的对象是「这一轮 CLI 进程的环境」，
 * CLI 再把它（深拷贝）交给它 spawn 的 MCP 子进程（= 我们的代理）。
 * 令牌**不**进配置文件、**不**进 argv、**不**进日志、**不**经 API 返回。
 *
 * **fail closed**：任何一个键名命中 `MCP_BRIDGE_HANDOFF_FORBIDDEN_NAME_PARTS` 就抛错 ——
 * 宁可开不了入口，也不交付一份「会被 CLI 悄悄丢掉」的凭据信封。
 */
export declare function handoffEnv(url: string, token: string, proxyLogPath?: string): Readonly<Record<string, string>>;
/**
 * 拉起 stdio 代理用哪个解释器。
 *
 * 用 `process.execPath`（宿主自己就是一个可用的 Node/Electron-as-Node 运行时，
 * 不必依赖 PATH 上有没有 `node`），但**要求** `ELECTRON_RUN_AS_NODE=1` 一并交给子进程：
 * 宿主若跑在 Electron 里，缺这个变量会**开出一个 GUI 窗口**而不是跑脚本（`src/launcher.ts:27-45`
 * 记的就是这个坑：实测 `"D:\Qoder CN\Qoder CN.exe" --version` 在泄漏该变量时输出 Node 版本）。
 * 该变量是**幂等**的：子进程本来就是 Node 时它没有任何副作用。
 *
 * ⚠️ 本机实测：宿主（Codex 运行时下的 DSH）的 `process.execPath` 就是
 * `…\.workbuddy\binaries\node\versions\22.22.2\node.exe`（探针 F1g 的产物可核）。
 * Electron 场景下这一格是**唯一**的保险，因此它跟手递凭据一起走 `extraEnv`。
 */
export declare function proxySpawnEnvironment(): Readonly<Record<string, string>>;
/**
 * 配置里**只允许出现**的东西：解释器、代理脚本、空 env。
 * 这个断言就是「文件里没有凭据」的可执行形式 —— 探针用它逐键核对。
 */
export declare function configDocumentKeys(document: Record<string, unknown>): readonly string[];
/** 配置条目里**允许出现**的键（多一个键就要有人解释它是什么；`url`/`headers` 是**禁止**的）。 */
export declare const MCP_BRIDGE_CONFIG_ALLOWED_KEYS: readonly string[];
/** 配置条目里**永远不许出现**的键（出现即视为修复回退，探针会 FAIL）。 */
export declare const MCP_BRIDGE_CONFIG_FORBIDDEN_KEYS: readonly string[];
/**
 * **ACP 通道**的 `session/new.mcpServers` 条目（令牌只在这里拼进 header）。
 *
 * 形状**逐字**照 ACP 的 zod / 规范 schema（`zod.gen.js:2347-2360`、`:2405-2416`；
 * `schema/schema.json` 的 `McpServerHttp` 是 `required:["name","url","headers"]`）：
 * `{type:'http', name, url, headers:[{name,value}]}`。
 * **不**加任何 schema 之外的键（例如 `--mcp-config` 那套 `timeout` / `description`
 * 是 Claude-Code 扩展，不在 ACP schema 里）—— 多出来的键会被 zod 剥掉或被严格实现拒绝。
 *
 * 返回的是**每次新建的对象**：调用方拿到的是副本，改它不会影响入口，
 * 入口的令牌也不会因为对象被共享而流到别处（日志里仍然只有指纹）。
 */
export declare function mcpServerDescriptors(url: string, token: string): readonly McpServerSpec[];
/**
 * 只把条目的**字段名**列出来（**绝不含 url / 令牌**）—— 日志与 facts 里只允许出现这个。
 * 传进来的 servers 用来体现「我们实际会发哪些键」；调用方应当传占位值（见 `openForTurn`）。
 */
export declare function mcpServerShapeLabels(servers: readonly McpServerSpec[]): readonly string[];
/** 令牌指纹：日志里**只**写这个，永不写令牌本体。 */
export declare function tokenFingerprint(token: string): string;
/** 该地址是 loopback 吗？ */
export declare function isLoopbackAddress(address: string | undefined): boolean;
/** 把 DSH ContentBlock 映射成 MCP content block（不可映射的**如实降级**并计数，不静默丢）。 */
export declare function toMcpContent(blocks: unknown): {
    content: unknown[];
    degraded: number;
};
/** 参数指纹：只记**结构**（字段名 + 长度），不把工具参数正文搬进日志。 */
export declare function argsFingerprint(args: unknown): Record<string, unknown>;
export declare function createMcpBridge(options: McpBridgeOptions): McpBridge;
/** 供探针/自检使用：本模块认识的契约面（不改运行期行为）。 */
export declare const MCP_BRIDGE_CONTRACT: {
    readonly serverName: "dsh_bridge";
    readonly serverVersion: "0.1.0";
    readonly tools: readonly ["list_agents", "send_message", "wait_agent", "harness_task_start", "harness_task_status", "harness_task_cancel"];
    readonly channels: readonly McpBridgeChannel[];
    /** ACP 通道注入条目的形状（字段名清单；不含 url / 令牌）。 */
    readonly acpServerShape: readonly string[];
    /** ACP 通道注入的传输类型（本桥接是 loopback 上的 HTTP MCP 服务端）。 */
    readonly acpServerType: "http";
    readonly knownProtocolVersions: readonly string[];
    readonly fallbackProtocolVersion: "2025-06-18";
    readonly mcpConfigCliBasenames: readonly string[];
    readonly defaultTtlMs: 180000;
    readonly maxTtlMs: 600000;
    readonly loopbackAddresses: readonly string[];
    /** `bridge.skip` 的写盘上界参数（tight-loop 修复的可核对面；限流不删诊断）。 */
    readonly skipDedupe: {
        readonly envVar: "DSH_BRIDGE_SKIP_DEDUPE_MS";
        readonly windowMs: number;
        readonly minWindowMs: 5000;
        readonly defaultWindowMs: 60000;
        readonly maxLinesPerWindow: 120;
        readonly maxKeys: 512;
    };
};
/**
 * **会话级 `tool/call` / `tool/result` 事件：本模块不写，而且这是刻意的。**
 *
 * 这两个事件**只**由 `dsh-agent-loop` 的 `executeToolCalls` append
 * （运行版 `dsh-agent-loop/lib/index.js:682`（`tool/call`）、`:697`（`tool/result`），
 * 结果消息由 `createToolResultMessage` 造，形状 = `{role:'tool', source:{kind:'tool',callId},
 * toolCallId, content, isError}`）。`ctx.tools.execute` 这条路径**不**append 它们。
 *
 * 为什么不在桥里补写：成员是**进程内 DSH Agent**，它的下一轮请求是**由会话日志推导**的
 * （`dsh-agent-loop` 的 `requestProposal` + 会话投影）。补写一条没有对应 assistant `tool-call`
 * 块的孤立 `tool` 消息，等于往那段历史里塞一条不该存在的消息。`SessionEvent.ignorable` 也救不了：
 * 只有**未知**类型 + `ignorable:true` 才会被表面投影丢弃（`dsh-session/lib/index.js:298`），
 * `tool/call` / `tool/result` 都是已知类型。
 *
 * 因此桥接改走**原生工具管线**取证：`tools/pre-execute` → guards → `tools/execute` →
 * `tools/post-execute`（本模块用 `tools/execute` 观察器记录 `pipeline.execute`），
 * 以及工具自身的原生持久化副作用（`send_message` → Lead 会话日志里的 `team/message/queued`）。
 */
export declare const MCP_BRIDGE_SESSION_EVENT_NOTE: string;
