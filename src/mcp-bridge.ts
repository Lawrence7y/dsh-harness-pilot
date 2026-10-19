/**
 * **最小可执行 MCP 桥接** —— 让「被改道的真实团队子会话」用**真实工具通道**调回 DSH 工具。
 *
 * ## 它解决的是哪一个缺陷
 * 在「进程内成员 + 进程外推理」这条路由上，DSH 工具的 schema 只是被**渲染进 prompt 文本**
 * （`src/llm-adapter.ts:276-278`；实测 `request/header.tools` = 45），适配器**从不产出
 * `tool-call` 块**（`llm-adapter.ts:302`、`:332-344`），而工具执行由「assistant 消息里出现
 * `tool-call` 块」触发（运行版 `_live-agent-loop.js:1153-1155`）⇒ **`executeToolCalls` 永不执行**。
 * 于是成员「说要」发消息，却一条 `team/message` 都发不出来（2.2-④ FAIL）。
 *
 * 本模块**不解析 CLI 的自由文本**（那是被明令禁止的「解析任意文本冒充 tool-call」），
 * 而是在**外部 CLI 原生支持的 MCP 客户端**那条路上开一个真实的工具入口：
 * 把桥接的工具作为 **MCP server 的 tools** 交给 CLI，由 **CLI 自己**发起 `tools/call`。
 *
 * ## 硬性约束（逐条落到代码）
 * 1. **每个子会话一个短寿命、loopback 限定、且鉴权的入口**：
 *    - 每个入口一个**独立**的 `http.Server`，`listen(0, '127.0.0.1')` —— 不监听非本机；
 *    - 入口 =「一次性随机 32 字节令牌 + 一次性随机路径段 + 绑定的子会话 + 绑定的活 Agent + TTL」；
 *    - 请求逐条校验 `socket.remoteAddress` ∈ loopback，再校验 `Authorization: Bearer <令牌>`；
 *    - 令牌**只**出现在：进程内存、以及「本来就该交给 CLI 的那一条注入向量」里 ——
 *      `acp-mcp-servers` 通道是 `session/new.mcpServers[0].headers[0].value`
 *      （**不落盘**、只在那一次 ACP 请求里）；
 *      `argv-mcp-config` 通道是**每次 spawn 独立**的 CLI 子进程环境
 *      （`MCP_BRIDGE_HANDOFF*`），由本插件的 **stdio 代理**接手后转发到本机入口。
 *      **落盘的 `--mcp-config` 文件里没有任何凭据** —— 只有「怎么拉起代理」。
 *      **日志里只写指纹**（sha256 前 8 位），任何时候都不写令牌本体；
 *      句柄**没有**「把令牌取出来」的方法（`handoffEnv` 是唯一出口，且只对 spawn 的 env 有意义）。
 *
 *      ＞ **2026-10-13 安全修复**：headless 这条通道**曾经**把令牌明文写进 `--mcp-config`
 *      文件（`mode: 0o600`）—— **但那在 Windows 上不是强制 ACL，不构成有效保护**。
 *      ACP 通道修好**不代表**这条持久化路径也安全。修复后落盘凭据面为零；
 *      若代理脚本缺失，开入口会**显式失败**，绝不回退到明文。
 * 1b. **两条注入通道，门槛不同**（`McpBridgeChannel`）：
 *    - `argv-mcp-config`（默认，headless）：`--mcp-config <文件>` + `--strict-mcp-config`
 *      + `--allowed-tools <工具名>`；只对**有直接证据**认这个参数的 CLI 基名开；
 *      文件内容 = **不含凭据的 stdio 代理配置**（实测形状见 `mcpConfigDocument`）。
 *    - `acp-mcp-servers`：ACP 协议字段 `session/new.mcpServers`
 *      （`@agentclientprotocol/sdk/dist/schema/zod.gen.js:2422-2427`），**不动 argv**，
 *      条目形状逐字照 schema（`{type:'http',name,url,headers:[{name,value}]}`；
 *      `headers` 是必填 —— 形状错的条目会被 `vecSkipError` **静默丢掉**，`:2425`）。
 *      句柄把**已经拼好**的条目交出去（`handle.mcpServers`），令牌不经过调用方的手。
 * 2. **用真实运行版契约、在该成员自己的 Agent 作用域内调用**：
 *    - `ctx.tools.get(name, agent)` 做**可见性判定**（作用域解析的权威面）；
 *    - `ctx.tools.execute({ callId, name, arguments, agent, signal })` 执行
 *      —— 走完整原生管线：`tools/pre-execute` → guards → `tools/execute` → `tools/post-execute`，
 *      因此**原生权限语义与取消语义都被继承**（`tools` 服务契约原文：
 *      "Execute through pre-policy, guards, around-dispatch, post-policy, definition-owned content
 *      finalization, and final notification."）。
 * 3. **禁止跨作用域**：桥接入口**没有任何** scope / agent / sessionId 参数，客户端**无法**指定
 *    caller；永远只用入口自己绑定的那个活 Agent。工具名不在白名单 → 响亮拒绝；工具在该成员
 *    作用域里不可见 → 响亮拒绝。**客户端连「用谁的权限」都表达不出来**，所以也就不存在伪造 caller。
 * 4. **短寿命**：默认 TTL 3 分钟（上限 10 分钟），到期自动关；调用方（一轮派发）结束即关；
 *    入口关闭会 abort 所有在飞的工具调用 —— 取消语义因此**同步**传导到桥接入口。
 * 4b. **`bridge.skip` 的写盘速率有上界**（2026-10-14 修复，参数 `MCP_BRIDGE_SKIP_DEDUPE`）：
 *    同一 `(reason, channel, sessionId)` 一个窗口内**只落一条盘**，其余只进内存计数；
 *    全实例每窗口落盘的 skip 行数 ≤ `maxLinesPerWindow`。**诊断一条都没删** ——
 *    落盘那条带 `suppressedInPreviousWindow`，`paths.skipLog` 还能对账
 *    （`calls === written + suppressedByDedupe + suppressedByCap`）。
 *    现场依据：调用方不节流地反复请求 `open` 时，旧实现「每次调用写一条」把
 *    `bridge-events.jsonl` 顶到 137 MB（657,679 条）、≈4.4 MB/分钟。详见常量区注释。
 *
 * ## 它**没有**做什么（不许外推）
 * - **不**产出宿主的会话级 `tool/call` / `tool/result` 事件。那两个事件**只有** `dsh-agent-loop`
 *   的 `executeToolCalls` 会 append（运行版 `dsh-agent-loop/lib/index.js:682`、`:697`）；
 *   `ctx.tools.execute` 这条路径**不** append 它们。桥接改走**原生工具管线**
 *   （`tools/pre-execute` / `tools/execute` / `tools/post-execute`，本模块用 `tools/execute`
 *   观察器取证）＋ 工具自身的原生持久化副作用（例如 `send_message` → Lead 日志里的
 *   `team/message/queued`）。详见 `MCP_BRIDGE_SESSION_EVENT_NOTE`。
 * - **不**替 CLI 做权限决定：CLI 侧的 `--allowed-tools` 只预授权**被桥接的那一个工具名**。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServerSpec } from './types.js'

// ────────────────────────────────────────────────────────────────────────────
// 常量与公开类型
// ────────────────────────────────────────────────────────────────────────────

/** MCP server 名。**不含连字符**：CLI 把工具名拼成 `mcp__<server>__<tool>`，段名会被清洗。 */
export const MCP_BRIDGE_SERVER_NAME = 'dsh_bridge'

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
export type McpBridgeChannel = 'argv-mcp-config' | 'acp-mcp-servers'

/** 两条通道的取值（探针/自检断言用）。 */
export const MCP_BRIDGE_CHANNELS: readonly McpBridgeChannel[] = ['argv-mcp-config', 'acp-mcp-servers']

// ── `bridge.skip` 的**写盘上界**（2026-10-14 tight-loop 修复；参数全部可核对）────────────
//
// ## 为什么上界必须落在**插件侧**（现场实测，不是推断）
// 2026-10-14 01:49–02:25，`<pluginHome>/mcp/bridge-events.jsonl` 被 **657,679 条**同族
// `bridge.skip`（`reason:"no-live-agent-for-session"`、`origin:"api-probe"`、
// `channel:"argv-mcp-config"`）顶到 **137 MB**：速率 ≈**353 条/秒 ≈ 4.4 MB/分钟**，
// 25 分钟里同一批 3 个会话**各写 176,448 条**（另有 4 个会话各 32,083 条，5 分 49 秒）。
//
// **插件侧没有重试循环**：`lib/mcp-bridge.js` 与当前 `src` 的新编译**逐字节相同**，
// 模块内没有 retry / setInterval / 自调用；`openForTurn` 是**一次调用一条 skip** 的单发函数。
// 反复调用来自**调用方** —— `probe/verify-team-final-acceptance-v2.mjs` 的负例扫描
// `for (const cand of neg.candidates)` 在循环体里往**同一个数组** `push`，`for...of` 于是永不终止；
// 而 push 分支的条件正是 `opened.status !== 200`，也就是 `POST /mcp-bridge/open` 返回
// **409 = 该会话没有活 Agent** —— 与「对没有活 Agent 的会话调 open 之后开始刷屏」完全一致。
//
// 但「每一次调用都如实写一条盘」会把**调用方的 bug 变成插件的磁盘泄漏**（还拖垮按
// `readFileSync` 全读这份日志的探针）。所以上界落在这里：**诊断照写，但速率有界**。
//
// ## 不变量（落盘 + 可对账）
// - 同一 `(reason, channel, sessionId)` 在一个窗口内**只落一条盘**，其余只进内存计数；
//   落盘那条带 `suppressedInPreviousWindow` ⇒「被压掉多少」仍然**可审计**（不是静默丢弃）；
// - **全实例**每窗口落盘的 skip 行数 ≤ `maxLinesPerWindow`（**与键的数量无关**：就算调用方
//   每次都换一个 sessionId，写盘也封顶）；
// - `calls === written + suppressedByDedupe + suppressedByCap`（`paths.skipLog` 上可对账）。
//
// ⚠️ 窗口有**硬下限**：env 也不许把它调成「等于不限流」——否则这个修复可以被一个环境变量取消。
/** 窗口硬下限（env 也压不下去）。 */
const SKIP_WINDOW_MIN_MS = 5_000
/** 默认窗口。 */
const SKIP_WINDOW_DEFAULT_MS = 60_000
/** 全实例每窗口最多落盘的 skip 行数。 */
const SKIP_MAX_LINES_PER_WINDOW = 120
/** 记住多少个键（防止「每次换 sessionId」把内存顶爆）。 */
const SKIP_MAX_KEYS = 512

/** 读窗口配置：不合法/低于下限一律落到下限之上。 */
function skipWindowMsFromEnv(): number {
  const raw = Number.parseInt(process.env.DSH_BRIDGE_SKIP_DEDUPE_MS ?? '', 10)
  if (!Number.isFinite(raw)) return SKIP_WINDOW_DEFAULT_MS
  return Math.max(SKIP_WINDOW_MIN_MS, raw)
}

/** 生效的窗口（模块级：env 只读一次，实例之间一致）。 */
const SKIP_WINDOW_MS = skipWindowMsFromEnv()

/** `bridge.skip` 限流参数（`probe/verify-bridge-skip-throttle.mjs` 据此算窗口数）。 */
export const MCP_BRIDGE_SKIP_DEDUPE = {
  envVar: 'DSH_BRIDGE_SKIP_DEDUPE_MS',
  windowMs: SKIP_WINDOW_MS,
  minWindowMs: SKIP_WINDOW_MIN_MS,
  defaultWindowMs: SKIP_WINDOW_DEFAULT_MS,
  maxLinesPerWindow: SKIP_MAX_LINES_PER_WINDOW,
  maxKeys: SKIP_MAX_KEYS,
} as const

/** MCP server 自报名（诊断用）。 */
export const MCP_BRIDGE_SERVER_VERSION = '0.1.0'

/**
 * **首期最小集合**（上级指定）：团队 `list`/`send`/`wait` + harness 任务 `派发`/`结果`/`取消`。
 * 名字与宿主/本插件注册的工具名**逐字一致**，不做任何改名 —— 这样「桥接的到底是什么」可逐条核对。
 */
export const MCP_BRIDGE_TOOLS = [
  'list_agents',
  'send_message',
  'wait_agent',
  'harness_task_start',
  'harness_task_status',
  'harness_task_cancel',
] as const

export type McpBridgeToolName = (typeof MCP_BRIDGE_TOOLS)[number]

/**
 * 已知「`--mcp-config` 注入」可用的 CLI（按可执行文件基名匹配）。
 *
 * **只放有直接证据的**：`qoderclicn 1.1.41` 自己的 `--help` 输出里有
 * `--mcp-config <config>  Load MCP servers from JSON file(s) or inline JSON`
 * （本机实测：`C:\Users\Administrator\.qodersec\bin\qoderclicn.exe --help`）。
 * **没有验证过的 CLI 不放进来** —— 猜一个参数名发出去只会得到「CLI 报错」，
 * 那会把排查引到错的地方。
 */
const MCP_CONFIG_CLI_BASENAMES: readonly string[] = ['qoderclicn', 'qodercli']

/** 入口默认 TTL（毫秒）。一轮外部调用通常几十秒；3 分钟足够，且不会长期挂着。 */
const DEFAULT_TTL_MS = 180_000
/** 入口 TTL 上限：任何调用方都不能要求一个「长期开放」的入口。 */
const MAX_TTL_MS = 600_000
/** MCP 请求体上限（工具参数可能比本插件的 API 上限大）。 */
const MAX_BODY_BYTES = 1_048_576
/** 认识的 MCP 协议版本（客户端请求哪个就回哪个；都不认识则回默认那个）。 */
const KNOWN_MCP_PROTOCOL_VERSIONS: readonly string[] = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
const FALLBACK_MCP_PROTOCOL_VERSION = '2025-06-18'
/** loopback 判定集合（`::ffff:` 前缀是 IPv4-mapped IPv6）。 */
const LOOPBACK_ADDRESSES: readonly string[] = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

/** 宿主面：本模块只声明**真正用到**的东西。 */
export interface McpBridgeHostCtx {
  get?<T>(name: string): T | undefined
  on?(name: string, listener: (...args: never[]) => unknown, options?: unknown): unknown
  logger?: { info?(message: string): void; warn?(message: string): void }
}

/** `ctx.tools` 的最小面（签名取自运行版 `listService{service:"tools"}`）。 */
interface ToolsRuntimeLike {
  get?(name: string, scope?: unknown): { name?: unknown; description?: unknown; parameters?: unknown } | undefined
  schemas?(scope?: unknown): readonly { name?: unknown; description?: unknown; parameters?: unknown }[]
  execute?(exec: {
    callId: string
    name: string
    arguments: unknown
    agent?: unknown
    signal: AbortSignal
  }): Promise<{
    isError?: unknown
    value?: unknown
    content?: unknown
    error?: { message?: unknown; info?: { name?: unknown; code?: unknown } }
  }>
}

/** `ctx.agents` 的最小面（签名取自运行版 `listService{service:"agents"}`）。 */
interface AgentsRuntimeLike {
  get?(id: string): unknown
}

/** 一次开入口的输入。 */
export interface McpBridgeOpenInput {
  /** 目标子会话 id（团队成员的子会话）。没有活 Agent 就**不开**入口。 */
  readonly sessionId?: string
  /** 这一轮要跑的外部 CLI 命令（绝对路径或裸命令名）。用它判定能不能注入 MCP 配置。 */
  readonly command?: string
  /**
   * 注入通道：`argv-mcp-config`（默认，headless 的 `--mcp-config`）或
   * `acp-mcp-servers`（ACP 的 `session/new.mcpServers`）。见 `McpBridgeChannel`。
   */
  readonly channel?: McpBridgeChannel
  /** 谁在开这个入口（取证用，例如 `pilot-cli-redirect`）。 */
  readonly origin: string
  /** TTL 覆盖值（会被 `MAX_TTL_MS` 夹住）。 */
  readonly ttlMs?: number
  /** 是否在 argv 里预授权被桥接的工具名（CLI 侧）。默认 true。**只对 `argv-mcp-config` 通道有意义**。 */
  readonly authorizedTools?: boolean
  /** 写入日志的附加字段（例如 target 名）。**不得**含令牌。 */
  readonly note?: Readonly<Record<string, unknown>>
}

/** 一个已开入口的**脱敏**视图（日志 / 取证用；不含令牌）。 */
export interface McpBridgeView {
  readonly id: string
  readonly sessionId: string
  readonly agentId: string
  readonly origin: string
  readonly port: number
  readonly url: string
  readonly tokenFingerprint: string
  readonly configPath: string
  readonly ttlMs: number
  readonly openedAt: string
  readonly expiresAt: string
  readonly closedAt?: string
  readonly closeReason?: string
  readonly calls: number
  readonly rejections: number
  readonly injected: boolean
  /** 这条入口用的是哪条注入通道（`argv-mcp-config` / `acp-mcp-servers`）。 */
  readonly channel: McpBridgeChannel
  readonly extraArgs: readonly string[]
  /**
   * **落盘的那份注入文件里有没有凭据**。恒为 `false`（headless 通道写的是不含令牌的
   * stdio 代理配置；ACP 通道根本不落盘）。写进视图是为了让「凭据有没有落盘」**可核对**，
   * 而不是靠一句承诺。
   */
  readonly configHasCredential: boolean
  /** 手递凭据用的**环境变量名**（只有名字，没有值）。ACP 通道为空。 */
  readonly handoffEnvKeys: readonly string[]
}

/** 入口句柄：调用方拿它注入 argv，并在本轮结束时关闭。 */
export interface McpBridgeHandle {
  readonly id: string
  readonly sessionId: string
  readonly agentId: string
  readonly port: number
  readonly url: string
  readonly tokenFingerprint: string
  readonly configPath: string
  readonly expiresAt: string
  /** 这条入口用的是哪条注入通道。 */
  readonly channel: McpBridgeChannel
  /** headless 通道要追加的 argv（可能为空 = 这个 CLI 不支持注入，或这条通道不走 argv）。 */
  readonly extraArgs: readonly string[]
  /**
   * **ACP 通道**要放进 `DispatchSpec.mcpServers` 的条目（形状见 `mcpServerDescriptors`）。
   *
   * 令牌**只**由本模块在这里拼进 `Authorization` header —— 句柄**不提供**任何
   * 「把令牌取出来」的方法（避免「令牌可被任意调用方取出」变成常规路径）。
   * 每次读都是一份**新对象**；调用方不得把它记进日志（`view()` 里没有它）。
   */
  readonly mcpServers: readonly McpServerSpec[]
  /**
   * **headless 通道的手递凭据**（每次读新建一份）：调用方把它并进**这一轮 CLI 子进程**的环境。
   *
   * - 令牌**只**经由这条路交出去：不进配置文件、不进 argv、不进日志、不经 API 返回；
   * - ACP 通道返回 `{}`（那条通道的注入向量是协议字段，不走 env）；
   * - 调用方**不得**把它记进任何诊断/日志/响应体 —— 只许原样交给 `spawn` 的 `env`。
   *   变量名本身（不是值）在 `view().handoffEnvKeys` 里可见，便于取证。
   */
  readonly handoffEnv: Readonly<Record<string, string>>
  close(reason: string): void
  view(): McpBridgeView
}

/** 一条桥接事件（写 JSONL，也留在内存环形缓冲里）。 */
export interface McpBridgeEvent {
  readonly time: string
  readonly seq: number
  readonly event: string
  readonly [key: string]: unknown
}

export interface McpBridgeOptions {
  readonly ctx: McpBridgeHostCtx
  /** 事件 JSONL 路径。 */
  readonly logPath: string
  /** `--mcp-config` 文件目录（每个入口一个文件，关闭即删）。 */
  readonly configDir: string
  /**
   * 可选：stdio 代理自己的事件 JSONL 路径（`DSH_BRIDGE_PROXY_LOG`）。
   *
   * 代理**不解析** MCP 语义，但它会记「收到哪些方法 / 转发得到什么状态码」——
   * 这是「令牌没进日志」这条断言在**代理这一侧**也能被扫到的前提
   * （不传就完全不写代理日志）。
   */
  readonly proxyLogPath?: string
  readonly defaultTtlMs?: number
  readonly maxTtlMs?: number
  /** 覆盖桥接工具白名单（默认 `MCP_BRIDGE_TOOLS`）。 */
  readonly tools?: readonly string[]
  /** 是否安装 `tools/execute` 原生管线观察器（默认安装）。 */
  readonly observePipeline?: boolean
}

/**
 * `bridge.skip` 限流的**可核对计数**（`paths.skipLog`，随 `GET /mcp-bridge` 一起读出）。
 *
 * 这是「写盘速率有界」这件事的**读数面**：即使刷屏在窗口中途停止、没有触发下一条汇总行，
 * `suppressedByDedupe` / `suppressedByCap` 也仍然告诉取证者「有多少条被压掉了」——
 * 被压掉的是**重复**，不是**信息**：唯一的 reason/session 组合**第一条**永远落盘。
 */
export interface McpBridgeSkipLog {
  readonly windowMs: number
  readonly maxLinesPerWindow: number
  /** 本实例累计 `bridge.skip` 调用次数（= 调用方实际请求次数）。 */
  readonly calls: number
  /** 其中**真的落盘**的行数。 */
  readonly written: number
  /** 被「同键同窗口」压掉的行数。 */
  readonly suppressedByDedupe: number
  /** 被「全实例每窗口行数上限」压掉的行数。 */
  readonly suppressedByCap: number
  /** 当前记住的去重键数（上界 `maxKeys`）。 */
  readonly distinctKeys: number
  /** `written + suppressedByDedupe + suppressedByCap === calls`（自检；false 就是记账漏了）。 */
  readonly accountingHolds: boolean
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
  openForTurn(input: McpBridgeOpenInput): Promise<McpBridgeHandle | undefined>
  list(): readonly McpBridgeView[]
  events(limit?: number): readonly McpBridgeEvent[]
  /** 关闭入口。给了 `sessionId` 就只关那个会话的入口；不给就全关。 */
  closeAll(reason: string, sessionId?: string): void
  /** 只关一个入口（按 id）。返回是否真的关掉了一个还开着的入口。 */
  closeOne(id: string, reason: string): boolean
  /**
   * 落盘路径 + **`bridge.skip` 限流计数**（后者是**活的**只读视图：每次读都是当前值）。
   *
   * 追加 `skipLog` 是**加法**：`index.ts` 的 `GET /mcp-bridge` 原样把 `paths` 序列化出去，
   * 所以探针不必改宿主代码就能读到「写盘上界」的读数。
   */
  readonly paths: {
    readonly logPath: string
    readonly configDir: string
    readonly skipLog: McpBridgeSkipLog
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 纯函数区（离线探针直接测这些；运行期是同一份实现）
// ────────────────────────────────────────────────────────────────────────────

/** 取可执行文件基名（去扩展名、转小写），用于判定 CLI 是否支持 `--mcp-config`。 */
export function cliBasename(command: string): string {
  const base = basename(command.trim()).toLowerCase()
  return base.replace(/\.(exe|cmd|bat|ps1)$/u, '')
}

/** 这个 CLI 支持 `--mcp-config` 注入吗？只对**有直接证据**的基名回答 true。 */
export function supportsMcpConfigInjection(command: string | undefined): boolean {
  if (command === undefined) return false
  const base = cliBasename(command)
  return base.length > 0 && MCP_CONFIG_CLI_BASENAMES.includes(base)
}

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
export function mcpConfigDocument(nodeExecutable: string, proxyScriptPath: string): Record<string, unknown> {
  return {
    mcpServers: {
      [MCP_BRIDGE_SERVER_NAME]: {
        // 只有「怎么拉起代理」；**没有** url、**没有** headers、**没有**任何凭据。
        command: nodeExecutable,
        args: [proxyScriptPath],
        // `env` 必须是对象（CLI 的 zod 是 `record(string,string)`）；这里刻意留空 ——
        // 凭据走**每次 spawn 独立**的子进程环境，不经过这份落盘文件。
        env: {},
        // 客户端侧超时：`wait_agent` 这类工具可以等很久，别让 CLI 自己先掐断。
        timeout: 120_000,
        description: 'DSH tool bridge (token-free stdio proxy; credential handed off via child env)',
      },
    },
  }
}

/** CLI 侧对被桥接工具名的预授权参数（工具名格式由 CLI 自己拼：`mcp__<server>__<tool>`）。 */
export function allowedToolArgs(serverName: string, toolName: string): readonly string[] {
  return ['--allowed-tools', `mcp__${serverName}__${toolName}`]
}

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
export function strictMcpConfigArgs(): readonly string[] {
  return ['--strict-mcp-config']
}

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
export const MCP_BRIDGE_HANDOFF_ENV = {
  url: 'DSH_BRIDGE_HANDOFF',
  token: 'DSH_BRIDGE_HANDOFF_PAT',
  proxyLog: 'DSH_BRIDGE_PROXY_LOG',
} as const

/**
 * CLI 会**按名字丢掉**的键名片段（实测；大小写不敏感的子串匹配）。
 * 这张表是**判据**，不是装饰：`handoffEnv()` 与探针都用它来 fail closed。
 */
export const MCP_BRIDGE_HANDOFF_FORBIDDEN_NAME_PARTS: readonly string[] =
  ['TOKEN', 'SECRET', 'KEY', 'AUTH', 'PASSWORD', 'CREDENTIAL']

/** 这个键名会被 CLI 丢掉吗？（大小写不敏感的子串匹配，照实测规则） */
export function isHandoffNameDropped(name: string): boolean {
  const upper = name.toUpperCase()
  return MCP_BRIDGE_HANDOFF_FORBIDDEN_NAME_PARTS.some((part) => upper.includes(part))
}

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
export function handoffEnv(url: string, token: string, proxyLogPath?: string): Readonly<Record<string, string>> {
  const payload: Record<string, string> = {
    [MCP_BRIDGE_HANDOFF_ENV.url]: url,
    [MCP_BRIDGE_HANDOFF_ENV.token]: token,
    ...(proxyLogPath === undefined ? {} : { [MCP_BRIDGE_HANDOFF_ENV.proxyLog]: proxyLogPath }),
  }
  const dropped = Object.keys(payload).filter((name) => isHandoffNameDropped(name))
  if (dropped.length > 0) {
    throw new Error(
      `handoff env name(s) would be dropped by the target CLI (实测 deny-list: TOKEN/SECRET/KEY/AUTH/PASSWORD/CREDENTIAL): ${dropped.join(', ')}`,
    )
  }
  return payload
}

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
export function proxySpawnEnvironment(): Readonly<Record<string, string>> {
  return { ELECTRON_RUN_AS_NODE: '1' }
}

/**
 * 配置里**只允许出现**的东西：解释器、代理脚本、空 env。
 * 这个断言就是「文件里没有凭据」的可执行形式 —— 探针用它逐键核对。
 */
export function configDocumentKeys(document: Record<string, unknown>): readonly string[] {
  const servers = document.mcpServers as Record<string, Record<string, unknown>> | undefined
  const entry = servers?.[MCP_BRIDGE_SERVER_NAME]
  return entry === undefined ? [] : Object.keys(entry).sort()
}

/** 配置条目里**允许出现**的键（多一个键就要有人解释它是什么；`url`/`headers` 是**禁止**的）。 */
export const MCP_BRIDGE_CONFIG_ALLOWED_KEYS: readonly string[] = ['args', 'command', 'description', 'env', 'timeout']
/** 配置条目里**永远不许出现**的键（出现即视为修复回退，探针会 FAIL）。 */
export const MCP_BRIDGE_CONFIG_FORBIDDEN_KEYS: readonly string[] = ['url', 'headers', 'Authorization', 'token']

/** 解释器：宿主自己的 `process.execPath`（见 `proxySpawnEnvironment` 关于 Electron 的说明）。 */
function nodeExecutable(): string {
  return process.execPath
}

/** stdio 代理脚本的落盘位置：与本模块**同目录**（构建产物 `lib/mcp-bridge-proxy.js`）。 */
function proxyScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'mcp-bridge-proxy.js')
}

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
export function mcpServerDescriptors(url: string, token: string): readonly McpServerSpec[] {
  return [{
    type: 'http',
    name: MCP_BRIDGE_SERVER_NAME,
    url,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
  }]
}

/**
 * 只把条目的**字段名**列出来（**绝不含 url / 令牌**）—— 日志与 facts 里只允许出现这个。
 * 传进来的 servers 用来体现「我们实际会发哪些键」；调用方应当传占位值（见 `openForTurn`）。
 */
export function mcpServerShapeLabels(servers: readonly McpServerSpec[]): readonly string[] {
  return servers.map((server) => (server.type === 'stdio'
    ? `${server.type}:${server.name}(name,command,args,env)`
    : `${server.type}:${server.name}(type,name,url,headers[name,value])`))
}

/** 令牌指纹：日志里**只**写这个，永不写令牌本体。 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8)
}

/** 该地址是 loopback 吗？ */
export function isLoopbackAddress(address: string | undefined): boolean {
  return typeof address === 'string' && LOOPBACK_ADDRESSES.includes(address)
}

/** 把 DSH ContentBlock 映射成 MCP content block（不可映射的**如实降级**并计数，不静默丢）。 */
export function toMcpContent(blocks: unknown): { content: unknown[]; degraded: number } {
  const list = Array.isArray(blocks) ? blocks : []
  const content: unknown[] = []
  let degraded = 0
  for (const raw of list) {
    if (raw !== null && typeof raw === 'object' && (raw as { type?: unknown }).type === 'text') {
      const text = (raw as { text?: unknown }).text
      content.push({ type: 'text', text: typeof text === 'string' ? text : '' })
      continue
    }
    degraded += 1
    const kind = raw !== null && typeof raw === 'object' ? String((raw as { type?: unknown }).type ?? 'unknown') : typeof raw
    const attachment = raw !== null && typeof raw === 'object'
      ? (raw as { attachment?: { name?: unknown; mediaType?: unknown } }).attachment
      : undefined
    const label = typeof attachment?.name === 'string' && attachment.name.length > 0
      ? attachment.name
      : (typeof attachment?.mediaType === 'string' ? attachment.mediaType : '')
    content.push({ type: 'text', text: `[mcp-bridge: unmappable DSH content block type="${kind}"${label.length > 0 ? ` name="${label}"` : ''}]` })
  }
  return { content, degraded }
}

/** 深限结构摘要：日志序列化失败时的兜底（**一条都不许静默丢**，与团队探针同一纪律）。 */
function shapeOf(value: unknown, depth: number): unknown {
  if (depth >= 3) return typeof value
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return { array: value.length, first: value.length > 0 ? shapeOf(value[0], depth + 1) : null }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).slice(0, 24)) {
    out[key] = shapeOf((value as Record<string, unknown>)[key], depth + 1)
  }
  return out
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ unserializable: true, shape: shapeOf(value, 0) })
  }
}

/** 参数指纹：只记**结构**（字段名 + 长度），不把工具参数正文搬进日志。 */
export function argsFingerprint(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object') return { kind: typeof args }
  if (Array.isArray(args)) return { kind: 'array', length: args.length }
  const record = args as Record<string, unknown>
  const fields: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    const value = record[key]
    fields[key] = typeof value === 'string'
      ? `string(${value.length})`
      : (Array.isArray(value) ? `array(${value.length})` : typeof value)
  }
  return { kind: 'object', fields }
}

// ────────────────────────────────────────────────────────────────────────────
// 主体
// ────────────────────────────────────────────────────────────────────────────

interface BridgeEntry {
  readonly id: string
  readonly sessionId: string
  readonly agentId: string
  readonly agent: unknown
  readonly origin: string
  readonly channel: McpBridgeChannel
  readonly token: string
  readonly tokenFingerprint: string
  readonly configPath: string
  readonly expectedPath: string
  readonly ttlMs: number
  readonly openedAt: Date
  readonly expiresAt: Date
  readonly controller: AbortController
  server: Server
  timer: NodeJS.Timeout
  port: number
  url: string
  injected: boolean
  extraArgs: readonly string[]
  calls: number
  rejections: number
  closed: boolean
  closedAt?: string
  closeReason?: string
}

async function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const done = (value: { ok: true; text: string } | { ok: false; status: number; error: string }): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        done({ ok: false, status: 413, error: `request body exceeds ${limit} bytes` })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { done({ ok: true, text: Buffer.concat(chunks).toString('utf8') }) })
    req.on('error', (error: Error) => { done({ ok: false, status: 400, error: `cannot read request body: ${error.message}` }) })
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.writableEnded) return
  const text = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text, 'utf8'),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'cache-control': 'no-store', ...headers })
  res.end()
}

/** 组一个 AbortSignal：入口关闭 / 客户端断开 / 调用方取消，任一路都算取消。 */
function composeSignal(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const live = signals.filter((value): value is AbortSignal => value !== undefined)
  if (live.length === 0) return { signal: new AbortController().signal, dispose: (): void => undefined }
  if (live.length === 1) return { signal: live[0]!, dispose: (): void => undefined }
  const controller = new AbortController()
  const listeners: (() => void)[] = []
  for (const one of live) {
    if (one.aborted) { controller.abort(one.reason); break }
    const onAbort = (): void => { controller.abort(one.reason) }
    one.addEventListener('abort', onAbort, { once: true })
    listeners.push(() => { one.removeEventListener('abort', onAbort) })
  }
  return {
    signal: controller.signal,
    dispose: (): void => { for (const off of listeners) off() },
  }
}

export function createMcpBridge(options: McpBridgeOptions): McpBridge {
  const { ctx } = options
  const maxTtlMs = options.maxTtlMs ?? MAX_TTL_MS
  const defaultTtlMs = Math.min(options.defaultTtlMs ?? DEFAULT_TTL_MS, maxTtlMs)
  const allowlist: readonly string[] = options.tools ?? MCP_BRIDGE_TOOLS

  const entries = new Map<string, BridgeEntry>()
  /** agentId → 已开入口 id 集合（`tools/execute` 观察器据此判定「这是桥接发起的那一次」）。 */
  const byAgent = new Map<string, Set<string>>()
  let seq = 0
  const ring: McpBridgeEvent[] = []
  const RING_LIMIT = 4000

  const log = (event: string, fields: Record<string, unknown>): McpBridgeEvent => {
    const entry: McpBridgeEvent = { time: new Date().toISOString(), seq: ++seq, event, ...fields }
    if (ring.length >= RING_LIMIT) ring.shift()
    ring.push(entry)
    try {
      mkdirSync(dirname(options.logPath), { recursive: true })
      appendFileSync(options.logPath, `${safeStringify(entry)}\n`, 'utf8')
    } catch {
      // 取证日志写不进去不能反过来打断宿主生命周期
    }
    return entry
  }

  // ── `bridge.skip` 的**写盘限流**（不变量见 `MCP_BRIDGE_SKIP_DEDUPE` 上方的注释）──────
  // 只做**加法**：三个 `bridge.skip` 调用点改成 `logSkip(...)`，其它事件一律仍走 `log(...)`
  // 逐条落盘（`bridge.open` / `bridge.close` / `mcp.*` / `pipeline.execute` 一条都不省）。
  /** 键 = `reason|channel|sessionId` → 本窗口内已压掉多少条。 */
  const skipKeys = new Map<string, { windowStart: number; suppressed: number }>()
  const skipCounters = { calls: 0, written: 0, suppressedByDedupe: 0, suppressedByCap: 0 }
  let skipWindowStart = Date.now()
  let skipWrittenInWindow = 0
  /** 上次落盘之后被「全实例上限」压掉的行数（写在下一条落盘的 skip 行上，避免静默丢弃）。 */
  let skipCapSuppressedSinceWrite = 0

  const logSkip = (fields: { reason: string } & Record<string, unknown>): void => {
    try {
      const reason = fields.reason
      const channel = typeof fields.channel === 'string' ? fields.channel : ''
      const sessionId = typeof fields.sessionId === 'string' ? fields.sessionId : ''
      const key = `${reason}|${channel}|${sessionId}`
      const now = Date.now()
      skipCounters.calls += 1

      // 键表有上界：调用方「每次换一个 sessionId」不许把内存顶爆。
      if (skipKeys.size > SKIP_MAX_KEYS) {
        const oldest = skipKeys.keys().next()
        if (oldest.done !== true) skipKeys.delete(oldest.value)
      }
      // 全实例窗口（与键的数量无关的硬上界）。
      if (now - skipWindowStart >= SKIP_WINDOW_MS) {
        skipWindowStart = now
        skipWrittenInWindow = 0
      }
      const state = skipKeys.get(key)
      // ① 同键同窗口 ⇒ 只计数，不写盘。
      if (state !== undefined && now - state.windowStart < SKIP_WINDOW_MS) {
        state.suppressed += 1
        skipCounters.suppressedByDedupe += 1
        return
      }
      // ② 全实例本窗口额度用完 ⇒ 只计数（键窗口仍然滚动，避免额度一放开就补写一串）。
      if (skipWrittenInWindow >= SKIP_MAX_LINES_PER_WINDOW) {
        if (state === undefined) skipKeys.set(key, { windowStart: now, suppressed: 1 })
        else { state.windowStart = now; state.suppressed = 1 }
        skipCounters.suppressedByCap += 1
        skipCapSuppressedSinceWrite += 1
        return
      }
      // ③ 该写：窗口内**第一条**（或新窗口的第一条）永远落盘。
      const carried = state === undefined ? 0 : state.suppressed
      const capCarried = skipCapSuppressedSinceWrite
      skipKeys.set(key, { windowStart: now, suppressed: 0 })
      skipWrittenInWindow += 1
      skipCounters.written += 1
      skipCapSuppressedSinceWrite = 0
      log('bridge.skip', {
        ...fields,
        dedupeWindowMs: SKIP_WINDOW_MS,
        // **保留可审计性**：被压掉的条数写在落盘的那一条上（不是静默丢弃）。
        suppressedInPreviousWindow: carried,
        ...(capCarried === 0 ? {} : { suppressedByGlobalCap: capCarried }),
      })
    } catch {
      // 限流本身出错也不许打断宿主生命周期：退化成「不写这条 skip」，绝不抛。
    }
  }

  const skipLogView = (): McpBridgeSkipLog => ({
    windowMs: SKIP_WINDOW_MS,
    maxLinesPerWindow: SKIP_MAX_LINES_PER_WINDOW,
    calls: skipCounters.calls,
    written: skipCounters.written,
    suppressedByDedupe: skipCounters.suppressedByDedupe,
    suppressedByCap: skipCounters.suppressedByCap,
    distinctKeys: skipKeys.size,
    accountingHolds: skipCounters.written + skipCounters.suppressedByDedupe + skipCounters.suppressedByCap === skipCounters.calls,
  })

  const viewOf = (entry: BridgeEntry): McpBridgeView => ({
    id: entry.id,
    sessionId: entry.sessionId,
    agentId: entry.agentId,
    origin: entry.origin,
    port: entry.port,
    url: entry.url,
    tokenFingerprint: entry.tokenFingerprint,
    configPath: entry.configPath,
    ttlMs: entry.ttlMs,
    openedAt: entry.openedAt.toISOString(),
    expiresAt: entry.expiresAt.toISOString(),
    ...(entry.closedAt === undefined ? {} : { closedAt: entry.closedAt }),
    ...(entry.closeReason === undefined ? {} : { closeReason: entry.closeReason }),
    calls: entry.calls,
    rejections: entry.rejections,
    injected: entry.injected,
    channel: entry.channel,
    extraArgs: entry.extraArgs,
    // **这条入口的落盘凭据面**：`argv-mcp-config` 通道写的那份文件里**没有任何令牌**
    // （只有「怎么拉起代理」）。这个字段是**可核对的事实**，不是声明 —— 探针会逐键比对文件内容。
    configHasCredential: false,
    // 手递凭据的**变量名**（不是值）—— 让读日志的人知道令牌是从哪条路送进去的。
    handoffEnvKeys: entry.channel === 'argv-mcp-config' ? [MCP_BRIDGE_HANDOFF_ENV.url, MCP_BRIDGE_HANDOFF_ENV.token] : [],
  })

  const tools = (): ToolsRuntimeLike | undefined => ctx.get?.<ToolsRuntimeLike>('tools')
  const agents = (): AgentsRuntimeLike | undefined => ctx.get?.<AgentsRuntimeLike>('agents')

  /** 关闭入口：abort 在飞调用 → 停监听 → 删配置文件。幂等。 */
  const closeEntry = (entry: BridgeEntry, reason: string): void => {
    if (entry.closed) return
    entry.closed = true
    entry.closedAt = new Date().toISOString()
    entry.closeReason = reason
    try { clearTimeout(entry.timer) } catch { /* 已经清了 */ }
    try { entry.controller.abort(new Error(`mcp-bridge ${entry.id} closed: ${reason}`)) } catch { /* abort 失败不影响关闭 */ }
    try { entry.server.closeAllConnections?.() } catch { /* 老版本 Node 没有 */ }
    try { entry.server.close() } catch { /* 已经关了 */ }
    if (entry.configPath.length > 0) {
      try { rmSync(entry.configPath, { force: true }) } catch { /* 删不掉也不影响入口已失效 */ }
    }
    const set = byAgent.get(entry.agentId)
    if (set !== undefined) {
      set.delete(entry.id)
      if (set.size === 0) byAgent.delete(entry.agentId)
    }
    entries.delete(entry.id)
    log('bridge.close', {
      bridgeId: entry.id, sessionId: entry.sessionId, reason,
      calls: entry.calls, rejections: entry.rejections, ms: Date.now() - entry.openedAt.getTime(),
    })
  }

  /** MCP `tools/list` 的条目（schema 直接取该成员作用域里的**真** schema）。 */
  const toolListFor = (entry: BridgeEntry): { tools: unknown[]; missingInScope: string[]; schemasFrom: string } => {
    const runtime = tools()
    let schemas: readonly { name?: unknown; description?: unknown; parameters?: unknown }[] = []
    let schemasFrom = 'tools.schemas(agent)'
    if (typeof runtime?.schemas === 'function') {
      try {
        schemas = runtime.schemas(entry.agent) ?? []
      } catch (error: unknown) {
        schemasFrom = `tools.schemas threw: ${error instanceof Error ? error.message : String(error)}`
        schemas = []
      }
    } else {
      schemasFrom = 'tools.schemas is unavailable in this composition'
    }
    const byName = new Map<string, { name?: unknown; description?: unknown; parameters?: unknown }>()
    for (const schema of schemas) {
      if (typeof schema?.name === 'string') byName.set(schema.name, schema)
    }
    const out: unknown[] = []
    const missing: string[] = []
    for (const name of allowlist) {
      const schema = byName.get(name)
      if (schema === undefined) { missing.push(name); continue }
      const parameters = schema.parameters
      out.push({
        name,
        ...(typeof schema.description === 'string' && schema.description.length > 0 ? { description: schema.description } : {}),
        inputSchema: parameters !== null && typeof parameters === 'object' ? parameters : { type: 'object', properties: {} },
      })
    }
    return { tools: out, missingInScope: missing, schemasFrom }
  }

  const rpcError = (id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  })
  const rpcResult = (id: unknown, result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result })

  /** 执行一次被桥接的工具调用（**唯一**的执行为；作用域永远是入口绑定的那个 Agent）。 */
  const callTool = async (
    entry: BridgeEntry,
    name: string,
    args: unknown,
    signal: AbortSignal,
    rpcId: unknown,
  ): Promise<Record<string, unknown>> => {
    const callId = randomUUID()
    const started = Date.now()
    const runtime = tools()
    if (runtime === undefined || typeof runtime.execute !== 'function') {
      entry.rejections += 1
      log('mcp.tool/reject', { bridgeId: entry.id, tool: name, callId, reason: 'tools-runtime-unavailable' })
      return rpcError(rpcId, -32603, 'DSH tools runtime is unavailable in this composition; the bridge refuses to guess')
    }
    // ① 白名单：桥接**只**暴露首期最小集合；集合外的名字一律响亮拒绝（不落回宿主全量工具面）。
    if (!allowlist.includes(name)) {
      entry.rejections += 1
      log('mcp.tool/reject', { bridgeId: entry.id, tool: name, callId, reason: 'not-in-bridge-allowlist', allowlist })
      return rpcError(rpcId, -32602, `tool "${name}" is not bridged by this entry`, {
        reason: 'BRIDGE_TOOL_NOT_ALLOWED', allowlist,
      })
    }
    // ② 作用域：必须在**该成员自己的 Agent 作用域**里可见。不可见就不是它的工具 —— 拒绝。
    if (typeof runtime.get !== 'function') {
      entry.rejections += 1
      log('mcp.tool/reject', { bridgeId: entry.id, tool: name, callId, reason: 'tools.get-unavailable' })
      return rpcError(rpcId, -32603, 'tools.get is unavailable, so the bridge cannot prove this tool is visible in the member scope; refusing')
    }
    let definition: { name?: unknown } | undefined
    try {
      definition = runtime.get(name, entry.agent)
    } catch (error: unknown) {
      entry.rejections += 1
      const message = error instanceof Error ? error.message : String(error)
      log('mcp.tool/reject', { bridgeId: entry.id, tool: name, callId, reason: 'tools.get-threw', message })
      return rpcError(rpcId, -32603, `tools.get threw while resolving "${name}" in the member scope: ${message}`)
    }
    if (definition === undefined) {
      entry.rejections += 1
      log('mcp.tool/reject', {
        bridgeId: entry.id, sessionId: entry.sessionId, agentId: entry.agentId,
        tool: name, callId, reason: 'not-visible-in-member-scope',
      })
      return rpcError(rpcId, -32602, `tool "${name}" is not visible in the scope of the session this entry is bound to`, {
        reason: 'BRIDGE_TOOL_NOT_IN_MEMBER_SCOPE', boundSessionId: entry.sessionId,
      })
    }

    log('mcp.tool/call', {
      bridgeId: entry.id, sessionId: entry.sessionId, agentId: entry.agentId,
      tool: name, callId, args: argsFingerprint(args),
    })
    entry.calls += 1

    let result: { isError?: unknown; value?: unknown; content?: unknown; error?: { message?: unknown; info?: { name?: unknown; code?: unknown } } }
    try {
      result = await runtime.execute({ callId, name, arguments: args, agent: entry.agent, signal })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      log('mcp.tool/result', { bridgeId: entry.id, tool: name, callId, isError: true, threw: true, message, ms: Date.now() - started })
      return rpcError(rpcId, -32603, `tools.execute threw for "${name}": ${message}`)
    }

    const mapped = toMcpContent(result.content)
    const isError = result.isError === true
    const errorInfo = result.error?.info
    // **因果接榫**：把结果文本里形如 `team-message-<uuid>` 的**标识符**摘出来记进日志。
    // 这给出一个可机器校验的 join key（工具返回值里的消息 id ↔ Lead 日志里 `team/message` 的 id），
    // 而**不**把结果正文搬进日志。除此之外不摘任何文本。
    const resultText = mapped.content
      .map((block) => (block !== null && typeof block === 'object' ? String((block as { text?: unknown }).text ?? '') : ''))
      .join('\n')
    const idTokens = [...new Set(resultText.match(/team-message-[0-9a-fA-F-]{8,}/gu) ?? [])].slice(0, 4)
    log('mcp.tool/result', {
      bridgeId: entry.id, sessionId: entry.sessionId, agentId: entry.agentId, tool: name, callId,
      isError, contentBlocks: mapped.content.length, degradedBlocks: mapped.degraded,
      resultChars: resultText.length,
      ...(idTokens.length === 0 ? {} : { resultIdTokens: idTokens }),
      ...(errorInfo === undefined ? {} : { errorCode: errorInfo.code ?? null, errorName: errorInfo.name ?? null }),
      ms: Date.now() - started,
    })
    return rpcResult(rpcId, { content: mapped.content, ...(isError ? { isError: true } : {}) })
  }

  /** MCP over HTTP（Streamable HTTP 的 JSON 响应形态）。 */
  const handleMcp = async (entry: BridgeEntry, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const remote = req.socket.remoteAddress
    // ③ loopback：即便 socket 已经只在 127.0.0.1 上监听，仍然逐条复核（纵深防御 + 留痕）。
    if (!isLoopbackAddress(remote)) {
      entry.rejections += 1
      log('mcp.reject', { bridgeId: entry.id, reason: 'non-loopback-remote', remoteAddress: remote ?? null })
      sendJson(res, 403, { error: 'this MCP entry only accepts loopback clients' })
      return
    }
    // ④ 鉴权：Bearer 令牌；比较用 sha256 定长摘要 + timingSafeEqual。
    // **先鉴权、再看方法**：连 `DELETE`（关入口）也要凭据 —— 不许出现任何「无凭据可改状态」的路径。
    const header = req.headers.authorization
    const given = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const a = createHash('sha256').update(given, 'utf8').digest()
    const b = createHash('sha256').update(entry.token, 'utf8').digest()
    if (given.length === 0 || !timingSafeEqual(a, b)) {
      entry.rejections += 1
      log('mcp.reject', {
        bridgeId: entry.id,
        reason: given.length === 0 ? 'missing-bearer-token' : 'wrong-bearer-token',
        presentedFingerprint: given.length === 0 ? null : tokenFingerprint(given),
        remoteAddress: remote ?? null,
        httpMethod: req.method ?? null,
      })
      sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
      return
    }
    if (req.method === 'GET') {
      // 本入口不提供 server→client 的独立 SSE 流：明确 405，而不是挂着一个空流。
      sendEmpty(res, 405, { allow: 'POST, DELETE' })
      return
    }
    if (req.method === 'DELETE') {
      closeEntry(entry, 'client-delete')
      sendEmpty(res, 204)
      return
    }
    if (req.method !== 'POST') {
      sendEmpty(res, 405, { allow: 'POST, DELETE' })
      return
    }

    const body = await readBody(req, MAX_BODY_BYTES)
    if (!body.ok) {
      entry.rejections += 1
      log('mcp.reject', { bridgeId: entry.id, reason: 'bad-body', detail: body.error })
      sendJson(res, body.status, { error: body.error })
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(body.text)
    } catch (error: unknown) {
      entry.rejections += 1
      log('mcp.reject', { bridgeId: entry.id, reason: 'invalid-json', detail: error instanceof Error ? error.message : String(error) })
      sendJson(res, 400, rpcError(null, -32700, 'Parse error'))
      return
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    const responses: unknown[] = []
    let notificationOnly = true

    for (const raw of messages) {
      const message = (raw ?? {}) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
      const id = message.id
      const method = typeof message.method === 'string' ? message.method : ''
      const hasId = id !== undefined && id !== null
      if (hasId) notificationOnly = false
      log('mcp.http', {
        bridgeId: entry.id, sessionId: entry.sessionId, agentId: entry.agentId,
        remoteAddress: remote ?? null, rpcMethod: method, rpcId: hasId ? String(id) : null,
        protocolHeader: typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : null,
      })

      if (method === 'initialize') {
        const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        const protocolVersion = typeof requested === 'string' && KNOWN_MCP_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : FALLBACK_MCP_PROTOCOL_VERSION
        responses.push(rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_BRIDGE_SERVER_NAME, version: MCP_BRIDGE_SERVER_VERSION },
          instructions:
            `DSH tool bridge for session ${entry.sessionId} (short-lived). `
            + 'Every tool listed here executes inside that session\'s own scope; permission and cancellation '
            + 'follow the native DSH tool pipeline. A client cannot name a different caller.',
        }))
        continue
      }
      if (method.startsWith('notifications/')) continue
      if (method === 'ping') { responses.push(rpcResult(id, {})); continue }
      if (method === 'tools/list') {
        const listed = toolListFor(entry)
        log('mcp.tools/list', {
          bridgeId: entry.id, sessionId: entry.sessionId, agentId: entry.agentId,
          count: listed.tools.length,
          names: listed.tools.map((tool) => (tool as { name: string }).name),
          missingInScope: listed.missingInScope,
          schemasFrom: listed.schemasFrom,
          schemaRoots: listed.tools.map((tool) => {
            const schema = (tool as { inputSchema?: { type?: unknown; required?: unknown; properties?: unknown } }).inputSchema
            return {
              name: (tool as { name: string }).name,
              type: typeof schema?.type === 'string' ? schema.type : null,
              required: Array.isArray(schema?.required) ? schema.required.length : null,
              properties: schema?.properties !== null && typeof schema?.properties === 'object'
                ? Object.keys(schema.properties as object).length
                : null,
            }
          }),
        })
        responses.push(rpcResult(id, { tools: listed.tools }))
        continue
      }
      if (method === 'tools/call') {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
        const name = typeof params.name === 'string' ? params.name : ''
        if (name.length === 0) {
          responses.push(rpcError(id, -32602, 'tools/call requires params.name'))
          continue
        }
        // 客户端断开就取消这次工具调用（不把取消语义丢在桥这里）。
        const clientGone = new AbortController()
        const onClientGone = (): void => { if (!res.writableFinished) clientGone.abort(new Error('mcp client disconnected')) }
        res.once('close', onClientGone)
        const composed = composeSignal(entry.controller.signal, clientGone.signal)
        let response: Record<string, unknown>
        try {
          response = await callTool(entry, name, params.arguments ?? {}, composed.signal, id)
        } finally {
          composed.dispose()
          res.removeListener('close', onClientGone)
        }
        responses.push(response)
        continue
      }
      if (method === 'resources/list') { responses.push(rpcResult(id, { resources: [] })); continue }
      if (method === 'resources/templates/list') { responses.push(rpcResult(id, { resourceTemplates: [] })); continue }
      if (method === 'prompts/list') { responses.push(rpcResult(id, { prompts: [] })); continue }
      if (method === 'logging/setLevel') { responses.push(rpcResult(id, {})); continue }
      entry.rejections += 1
      log('mcp.reject', { bridgeId: entry.id, reason: 'unsupported-method', method })
      responses.push(rpcError(id, -32601, `method not found: ${method}`))
    }

    if (notificationOnly && responses.length === 0) { sendEmpty(res, 202); return }
    sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0])
  }

  const handleRequest = (entry: BridgeEntry, req: IncomingMessage, res: ServerResponse): void => {
    const pathOnly = (req.url ?? '').split('?')[0] ?? ''
    if (pathOnly !== entry.expectedPath) {
      entry.rejections += 1
      log('mcp.reject', {
        bridgeId: entry.id, reason: 'wrong-path', path: pathOnly,
        remoteAddress: req.socket.remoteAddress ?? null,
      })
      sendJson(res, 404, { error: 'not found' })
      return
    }
    // 路径对了以后**先鉴权**，方法判定放在鉴权之后（见 `handleMcp`）。
    void handleMcp(entry, req, res).catch((error: unknown) => {
      log('mcp.reject', { bridgeId: entry.id, reason: 'handler-threw', detail: error instanceof Error ? error.message : String(error) })
      if (!res.writableEnded) sendJson(res, 500, { error: 'internal bridge error' })
    })
  }

  // ── 原生管线观察器：把「这一次调用真的过了宿主的工具管线」记成独立证据 ──
  // 纪律：**任何**出口都要 `return next()`，否则会把工具管线整条吞掉（本项目踩过同类坑）。
  const pipelineListener = (exec: unknown, next?: unknown): unknown => {
    try {
      const row = (exec ?? {}) as { agent?: { id?: unknown }, name?: unknown, callId?: unknown }
      const agentId = typeof row.agent?.id === 'string' ? row.agent.id : undefined
      const open = agentId === undefined ? undefined : byAgent.get(agentId)
      if (open !== undefined && open.size > 0) {
        log('pipeline.execute', {
          phase: 'tools/execute', agentId,
          tool: typeof row.name === 'string' ? row.name : null,
          callId: typeof row.callId === 'string' ? row.callId : null,
          bridgeIds: [...open],
        })
      }
    } catch {
      // 观测失败绝不许影响管线
    }
    return typeof next === 'function' ? (next as () => unknown)() : undefined
  }
  if (options.observePipeline !== false && typeof ctx.on === 'function') {
    try {
      ctx.on('tools/execute', pipelineListener as never)
      log('observer.installed', { event: 'tools/execute', note: 'native tool pipeline observer; always returns next()' })
    } catch (error: unknown) {
      log('observer.failed', { event: 'tools/execute', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const openForTurn = async (input: McpBridgeOpenInput): Promise<McpBridgeHandle | undefined> => {
    const origin = input.origin
    const channel: McpBridgeChannel = input.channel ?? 'argv-mcp-config'
    // ① 门槛（**按通道**，两种通道的注入向量不同，不能共用一条）：
    //    · argv-mcp-config：目标 CLI 没有**已验证**的 `--mcp-config` 支持 ⇒ 不开（不许「开了却没人能用」）；
    //    · acp-mcp-servers：注入向量是 ACP 协议字段 `session/new.mcpServers`（SDK schema 里是协议的一部分），
    //      **不碰 argv**，所以「认不认 --mcp-config」与它无关。这条通道的门槛是 ② 的活 Agent 绑定，
    //      以及调用方确认这一轮走的是 ACP 传输（`acp` 通道才会读 `mcpServers`）。
    if (channel === 'argv-mcp-config') {
      if (input.command !== undefined && !supportsMcpConfigInjection(input.command)) {
        logSkip({
          origin, channel, reason: 'target-cli-has-no-verified-mcp-config-injection',
          commandBase: cliBasename(input.command), sessionId: input.sessionId ?? null,
        })
        return undefined
      }
    } else {
      log('bridge.inject', {
        origin, channel, reason: 'acp-session-mcp-servers',
        commandBase: input.command === undefined ? null : cliBasename(input.command),
        sessionId: input.sessionId ?? null,
        note: 'injection vector is the ACP session/new.mcpServers field, not argv',
      })
    }
    // ② 没有活 Agent ⇒ 不开（作用域绑定是硬前提，绑不上就不许有入口）。
    const sessionId = input.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      logSkip({ origin, channel, reason: 'no-session-id' })
      return undefined
    }
    const agent = agents()?.get?.(sessionId)
    if (agent === undefined) {
      logSkip({ origin, channel, reason: 'no-live-agent-for-session', sessionId })
      return undefined
    }

    const id = randomBytes(6).toString('hex')
    const token = randomBytes(32).toString('base64url')
    const ttlMs = Math.max(5_000, Math.min(input.ttlMs ?? defaultTtlMs, maxTtlMs))
    const openedAt = new Date()
    const expiresAt = new Date(openedAt.getTime() + ttlMs)
    const expectedPath = `/mcp/${id}`

    const entry: BridgeEntry = {
      id, sessionId, agentId: sessionId, agent, origin, channel, token,
      tokenFingerprint: tokenFingerprint(token),
      // ACP 通道**不落盘**配置文件（没有 argv 注入这回事）⇒ 这里如实留空，
      // 不报一个「其实不存在、也不会被读」的路径。
      configPath: channel === 'argv-mcp-config' ? join(options.configDir, `cfg-${id}.json`) : '',
      expectedPath, ttlMs, openedAt, expiresAt,
      controller: new AbortController(),
      server: undefined as unknown as Server,
      timer: undefined as unknown as NodeJS.Timeout,
      port: 0, url: '', injected: false, extraArgs: [],
      calls: 0, rejections: 0, closed: false,
    }

    const server = createServer((req, res) => { handleRequest(entry, req, res) })
    // 常驻 keep-alive 会把 close() 拖住：压短空闲超时，并在 close 时强拆连接。
    server.keepAliveTimeout = 3_000
    server.headersTimeout = 10_000
    server.requestTimeout = 0
    server.on('clientError', (_error, socket) => { try { socket.destroy() } catch { /* 已经断了 */ } })
    entry.server = server
    entry.timer = setTimeout(() => { closeEntry(entry, 'ttl-expired') }, ttlMs)
    entry.timer.unref?.()

    // 端口必须真的 listen 成功才算得出 URL/argv。**绝不**返回「端口未知」的假句柄。
    const port = await new Promise<number | null>((resolve) => {
      let settled = false
      const done = (value: number | null): void => { if (!settled) { settled = true; resolve(value) } }
      server.once('error', (error: Error) => {
        log('bridge.open-failed', { bridgeId: id, sessionId, origin, detail: error.message })
        done(null)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const boundPort = address !== null && typeof address === 'object' ? address.port : 0
        const boundAddress = address !== null && typeof address === 'object' ? address.address : ''
        if (boundPort <= 0 || boundAddress !== '127.0.0.1') {
          log('bridge.open-failed', { bridgeId: id, sessionId, origin, detail: `unexpected bind ${boundAddress}:${boundPort}` })
          done(null)
          return
        }
        done(boundPort)
      })
    })
    if (port === null) { closeEntry(entry, 'listen-failed'); return undefined }

    entry.port = port
    entry.url = `http://127.0.0.1:${port}${expectedPath}`
    entries.set(id, entry)
    const set = byAgent.get(sessionId) ?? new Set<string>()
    set.add(id)
    byAgent.set(sessionId, set)

    // ── MCP 配置落盘（**只** `argv-mcp-config` 通道需要）────────────────────────
    //
    // **安全修复（2026-10-13）**：这份文件曾经写着 `url` + `Authorization: Bearer <令牌>`
    // ⇒ **令牌明文落盘**。`mode: 0o600` 在 Windows 上**不是强制 ACL**，所以那不是保护。
    // 现在文件里**只有**「怎么把本插件的 stdio 代理拉起来」，凭据**一律不进文件**：
    // 它在**每次 spawn 独立**的 CLI 子进程环境里交给代理（`handoffEnv`），
    // 代理再转发到本机 loopback 入口。**不许**为了「让功能看起来在」而保留任何明文路径：
    // 若代理脚本不存在（旧构建 / 半拷贝态），这里**显式拒绝开入口**，而不是回退到明文。
    //
    // `acp-mcp-servers` 通道**不落盘任何东西** —— 它的注入向量是内存里构造的
    // `session/new.mcpServers` 条目，令牌只出现在那次请求里（比 headless 更严，不是更松）。
    const args: string[] = []
    if (channel === 'argv-mcp-config') {
      const proxyScript = proxyScriptPath()
      if (!existsSync(proxyScript)) {
        log('bridge.open-failed', {
          bridgeId: id, sessionId, origin, channel, reason: 'proxy-script-missing',
          proxyScript,
          detail: 'stdio 代理脚本不存在 ⇒ **拒绝开入口**（绝不回退到「把令牌写进配置文件」那条明文路）',
        })
        closeEntry(entry, 'proxy-script-missing')
        return undefined
      }
      try {
        mkdirSync(options.configDir, { recursive: true })
        // 传进去的只有「解释器」和「代理脚本」：两个参数都**不含凭据**。
        writeFileSync(
          entry.configPath,
          `${JSON.stringify(mcpConfigDocument(nodeExecutable(), proxyScript), null, 2)}\n`,
          { encoding: 'utf8', mode: 0o600 },
        )
        entry.injected = true
      } catch (error: unknown) {
        log('bridge.open-failed', {
          bridgeId: id, sessionId, origin, channel,
          detail: `cannot write mcp config: ${error instanceof Error ? error.message : String(error)}`,
        })
        closeEntry(entry, 'config-write-failed')
        return undefined
      }
      args.push('--mcp-config', entry.configPath)
      // 「本轮只加载我给的那一个 server」（可核对的安全边界，见 `strictMcpConfigArgs`）。
      args.push(...strictMcpConfigArgs())
      if (input.authorizedTools !== false) args.push(...allowedToolArgs(MCP_BRIDGE_SERVER_NAME, 'send_message'))
    } else {
      entry.injected = true
    }
    entry.extraArgs = args

    log('bridge.open', {
      ...viewOf(entry),
      bindAddress: '127.0.0.1',
      note: input.note ?? null,
      mcpServerName: MCP_BRIDGE_SERVER_NAME,
      // 落盘的注入形态：headless 现在是**不含令牌的 stdio 代理**；ACP 是内存里的 http 条目。
      configType: channel === 'argv-mcp-config' ? 'stdio-proxy' : 'http',
      tokenInLog: false,
      // 令牌**不在**配置文件里（修复后的关键事实）；在 ACP 通道里它只出现在那一次请求的 header。
      tokenInConfigFile: false,
      // ACP 通道下一步会把令牌拼进 `session/new.mcpServers[0].headers[0].value`（形状照 schema）。
      mcpServersInjectedBy: channel === 'acp-mcp-servers' ? 'session/new.mcpServers' : 'argv --mcp-config (stdio proxy)',
      // 只记「注入了什么形状」：用**占位值**算出字段名清单，**不记** url 与令牌。
      mcpServerShape: mcpServerShapeLabels(mcpServerDescriptors('<redacted>', '<redacted>')),
      // headless 通道的落盘形状（只有字段名，值都是占位符）。
      stdioProxyConfigShape: channel === 'argv-mcp-config'
        ? configDocumentKeys(mcpConfigDocument('<node>', '<proxy.js>'))
        : [],
    })

    return {
      get id() { return entry.id },
      get sessionId() { return entry.sessionId },
      get agentId() { return entry.agentId },
      get port() { return entry.port },
      get url() { return entry.url },
      get tokenFingerprint() { return entry.tokenFingerprint },
      get configPath() { return entry.configPath },
      get expiresAt() { return entry.expiresAt.toISOString() },
      get channel() { return entry.channel },
      get extraArgs() { return entry.extraArgs },
      // 每次读都**新建**对象；令牌只在这个模块里拼进 header（句柄没有取令牌的方法）。
      get mcpServers() { return mcpServerDescriptors(entry.url, entry.token) },
      // 手递凭据：**每次读新建一份**，且只对 headless 通道有值。
      // 调用方拿它去拼**这一轮 CLI 子进程**的环境；令牌不经过 argv、不经过配置文件。
      // 里面还带上 `ELECTRON_RUN_AS_NODE=1`（见 `proxySpawnEnvironment`）：宿主若跑在 Electron 里，
      // 少了它代理会**开出一个 GUI 窗口**而不是跑脚本 —— 那是与安全无关、但会让整条链静默失效的坑。
      get handoffEnv() {
        return entry.channel === 'argv-mcp-config'
          ? { ...handoffEnv(entry.url, entry.token, options.proxyLogPath), ...proxySpawnEnvironment() }
          : {}
      },
      close: (reason: string) => { closeEntry(entry, reason) },
      view: () => viewOf(entry),
    }
  }

  return {
    openForTurn,
    list: () => [...entries.values()].map(viewOf),
    events: (limit = 200) => ring.slice(Math.max(0, ring.length - limit)),
    closeAll: (reason: string, sessionId?: string) => {
      for (const entry of [...entries.values()]) {
        if (sessionId !== undefined && entry.sessionId !== sessionId) continue
        closeEntry(entry, reason)
      }
    },
    closeOne: (id: string, reason: string) => {
      const entry = entries.get(id)
      if (entry === undefined) return false
      closeEntry(entry, reason)
      return true
    },
    paths: {
      logPath: options.logPath,
      configDir: options.configDir,
      // **活的**视图（getter）：`GET /mcp-bridge` 每次读到的都是当前计数。
      get skipLog(): McpBridgeSkipLog { return skipLogView() },
    },
  }
}

/** 供探针/自检使用：本模块认识的契约面（不改运行期行为）。 */
export const MCP_BRIDGE_CONTRACT = {
  serverName: MCP_BRIDGE_SERVER_NAME,
  serverVersion: MCP_BRIDGE_SERVER_VERSION,
  tools: MCP_BRIDGE_TOOLS,
  channels: MCP_BRIDGE_CHANNELS,
  /** ACP 通道注入条目的形状（字段名清单；不含 url / 令牌）。 */
  acpServerShape: mcpServerShapeLabels(mcpServerDescriptors('<redacted>', '<redacted>')),
  /** ACP 通道注入的传输类型（本桥接是 loopback 上的 HTTP MCP 服务端）。 */
  acpServerType: 'http' as const,
  knownProtocolVersions: KNOWN_MCP_PROTOCOL_VERSIONS,
  fallbackProtocolVersion: FALLBACK_MCP_PROTOCOL_VERSION,
  mcpConfigCliBasenames: MCP_CONFIG_CLI_BASENAMES,
  defaultTtlMs: DEFAULT_TTL_MS,
  maxTtlMs: MAX_TTL_MS,
  loopbackAddresses: LOOPBACK_ADDRESSES,
  /** `bridge.skip` 的写盘上界参数（tight-loop 修复的可核对面；限流不删诊断）。 */
  skipDedupe: MCP_BRIDGE_SKIP_DEDUPE,
} as const

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
export const MCP_BRIDGE_SESSION_EVENT_NOTE =
  'mcp-bridge does not write session-level tool/call|tool/result events: only dsh-agent-loop '
  + 'executeToolCalls appends them (running build dsh-agent-loop/lib/index.js:682, :697); '
  + 'ctx.tools.execute does not, and injecting an orphan tool message would corrupt the '
  + 'log-derived next request of the in-process member.'
