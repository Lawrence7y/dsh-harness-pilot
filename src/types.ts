/**
 * Shared vocabulary for every harness transport.
 *
 * 一条设计原则：transport 只负责「把任务送进去、把输出取出来」，不认识 DSH。
 * 这样每个 transport 都能被单独测试，也能在 provider / tool 两条调用路径上复用。
 */

/** 一条通往其他 harness 的具体通道。 */
export type TransportKind = 'headless' | 'acp' | 'pty' | 'window' | 'cdp'

// ── 持久原生会话（最小改造计划 P1/P2 的共享词表）──────────────────────────
//
// 定义在 types.ts（而不是 transport 模块）是因为 TargetConfig / DispatchSpec /
// DispatchOutcome 三处都要引用，而 transports 反过来 import 本模块 —— 放这里才无环。

/** 结构化 CLI 协议（只有声明了能力的目标才启用 JSONL 原生解析；实测依据 work/cli-session-audit/）。 */
export type NativeCliProtocol = 'claude-stream-json' | 'agy-jsonl'

/** 目标声明的结构化协议能力。 */
export interface NativeCliConfig {
  readonly protocol: NativeCliProtocol
  /** 新会话旗标；`{sessionId}` 占位符替换成新 UUID。空数组 = 首轮由 CLI 生成（mint）。 */
  readonly newSessionArgs: readonly string[]
  /** 精确恢复旗标；`{sessionId}` 占位符替换成原生会话 ID（不用 `--continue` 猜「最近」）。 */
  readonly resumeArgs: readonly string[]
  /** 结构化输出旗标（如 `--output-format stream-json`）。 */
  readonly outputArgs: readonly string[]
  /**
   * prompt 的**内联旗标**（可选；`{prompt}` 占位符替换成本轮 prompt，如 `['-p', '{prompt}']`）。
   *
   * 为什么需要：2026-10-16 现场实测，agy 的 `-p` 是「必须紧跟参数」的旗标
   * （原话 `flag needs an argument: -p`），**不接受** stdin prompt；缺省行为
   * （prompt 一律走 stdin）对它必错。声明了本字段的目标，native 与 headless 两条路
   * 都把 prompt 按占位符放进 argv（spawn 走 argv 数组，无 shell 转义问题），
   * 不再写 stdin。超长命令行仍由既有的 32k 护栏显式拒绝（不截断）。
   */
  readonly promptArg?: readonly string[]
}

/** 派发输入里的持久会话引用（逻辑会话由 NativeSessionStore 冻结）。 */
export interface NativeSessionRef {
  /** 逻辑会话 ID（`ns-…`；与 task run ID 明确区分）。 */
  readonly logicalId: string
  /** 已知的原生会话 ID；有值 ⇒ 本轮按精确恢复执行。缺省/为空 ⇒ 新轮（CLI mint 或新 UUID）。 */
  readonly nativeSessionId?: string
}

/** 结构化轮次终态。 */
export type NativeRunState =
  | 'completed' | 'failed' | 'cancelled'
  | 'recovery_needed' | 'waiting_permission' | 'upstream_queued' | 'unknown'

/** 一次派发的结构化原生信息（有则记录；未知字段如实缺省，绝不编造）。 */
export interface NativeRunInfo {
  readonly sessionId?: string
  readonly requestId?: string
  readonly runState?: NativeRunState
  readonly protocol?: string
  /** 本轮是精确恢复（resume）还是新会话（new）。 */
  readonly sessionMode?: 'new' | 'resume'
  readonly events?: number
  /** 轮内观察到的结构化信号（去重；如 waiting_permission / upstream_queued——接入执行面，不只解析）。 */
  readonly signals?: readonly NativeRunState[]
}

/** `auto` 通道梯子顺序（前一个不可用就降到下一个）。 */
export const DEFAULT_TRANSPORT_ORDER: readonly TransportKind[] = ['acp', 'headless', 'pty', 'cdp', 'window']

/** 窗口级操控提示（GUI / 终端 harness）。 */
export interface WindowSpec {
  /** 窗口标题匹配：普通子串或 `/正则/`。 */
  title: string
  /** 进程映像名匹配（如 `ZCode.exe`，普通子串）。 */
  process: string
  /** `harness_open` 用来把窗口拉起来的命令行；留空表示该 harness 需要用户自己先打开。 */
  launch: string
  /** 提交一条 prompt 的按键（默认回车）。 */
  submitKeys: string[]
  /** 打字前先按的快捷键，用来把焦点带到聊天输入框（GUI harness 常用，如 ZCode 的 ctrl+n）。 */
  openInputKeys: string[]
  /** prompt 内部换行的按键（很多 TUI 用 shift+enter / ctrl+j）。 */
  newlineKeys: string[]
  /** 等待窗口出现的上限。 */
  appearTimeoutMs: number
  /** 文本静默多久算「输出稳定」。 */
  settleMs: number
}

/**
 * 从 harness **自己的服务**读回回复（可选，配合 `CdpSpec.readback`）。
 *
 * 适用场景：Electron GUI 的正文是虚拟滚动，窗口被遮挡时渲染还会冻结，DOM 读回可能落后一轮；
 * 而这类应用通常自带一个本地服务/CLI（OpenCode 桌面端就是 `opencode-cli session export`），
 * 能给出确定性的会话 JSON。
 */
export interface CdpReadbackSpec {
  /** 页面内取「当前会话 id」的表达式，须返回字符串（例如从当前标签页的 href 里取）。 */
  sessionIdExpression: string
  /** 要执行的命令；留空 = 不做服务端读回。 */
  command: string
  /** 命令参数；每项里的 `{sessionId}` 占位符会被替换。 */
  args: string[]
  /**
   * 函数体（在 Node 里以 `new Function('data', extract)` 求值）：
   * `data` 是命令 stdout 解析出的 JSON，需 `return` 回复字符串。
   */
  extract: string
  /** 命令超时（毫秒）。 */
  timeoutMs: number
}

/** Chromium / Electron harness 的 CDP 通道提示。 */
export interface CdpSpec {
  /** 启动时附加的参数，用于打开调试端口（如 `--remote-debugging-port=9333`）。 */
  launchArgs: string[]
  /** 固定端口；0 表示每个会话自动挑一个空闲端口。 */
  port: number
  /** 判断「正在回答」的 DOM 选择器（可选）。 */
  busySelector: string
  /** 读取对话正文的选择器（可选；留空则用 body.innerText）。 */
  transcriptSelector: string
  /** 输入框选择器（可选；留空则用自动启发式）。 */
  inputSelector: string
  /** 发送按钮选择器（可选；留空则用 Enter / 自动启发式）。 */
  sendSelector: string
  /**
   * 服务端读回兜底（可选）：DOM 读回不可靠的 GUI harness 用它从应用**自己的服务**取精确回复。
   *
   * 触发条件：派发结束，但读到的正文里始终没出现本轮 prompt 的回显
   * （虚拟滚动只渲染可视区 + 窗口被遮挡时渲染冻结，都会让 DOM 落后一轮）。
   * 命中时返回值以服务端回复为准，DOM 快照仍留在 facts/diagnostic 里可查。
   */
  readback: CdpReadbackSpec
  /**
   * 首选页面匹配串（可选；大小写不敏感，匹配 title 或 url）。
   *
   * 一个 Electron 应用常常在同一个调试端口上暴露多个 page：主窗口、辅助窗口、
   * iframe 页。会话正文/输入框未必在主窗口里 —— 例如 Qoder CN IDE 1.32 把 agent
   * 对话搬到了独立的 Quest 窗口（`.../lingma/agents-window/...`），workbench 里
   * 根本没有输入框。配上这个串就把附着页面钉到真正有输入框的那个。
   * 留空 = 只用内置打分。匹配到会加一大笔分；配了却不匹配会扣分（软约束，不硬失败）。
   */
  pageMatch: string
}

/** 一个可派发任务的其他 harness。全部字段都有默认值，配置文件只需写差异。 */
export interface TargetConfig {
  /** 注册名，模型用它指定 harness（如 `opencode`、`zcode`）。 */
  name: string
  /** `auto` 或固定通道名。 */
  transport: string
  description: string
  /** 可执行文件（裸名走 PATH）。 */
  command: string
  /** headless / pty 的固定参数；prompt 默认追加在末尾。 */
  args: string[]
  /** 启动 ACP server 的参数（默认 `['acp']`）。 */
  acpArgs: string[]
  /** 会话内切换的 ACP 模型（走 session/set_config_option；ACP 没有 --model 参数）。 */
  acpModel: string
  /**
   * 指定模型的 argv 模板：`{model}` 会被替换成模型 id。
   * 例：`['--model', '{model}']`（opencode/agy/claude）、`['-m', '{model}']`（codex）。
   */
  modelArgs: string[]
  /**
   * 会话「推理等级」声明（可选；**不声明 = 该模型不提供推理等级选择**，如 GUI 档位的桌面端）。
   *
   * 2026-10-15 用户要求「全部供应商的全部模型都能选择推理强度，并按模型定制」：
   * 宿主模型目录按 adapter `resolveModel` 返回的 `reasoning {efforts, defaultEffort}`
   * 渲染推理等级子菜单，选中值经请求配置回到本插件 → 按 `args` 模板（`{effort}` 替换）
   * 追加到派发命令行。词表必须与该 CLI 真实支持的档位一致（不得编造）：
   *   · codex：`-c model_reasoning_effort="<id>"`（minimal/low/medium/high）
   *   · claude：`--effort <id>`（low/medium/high/xhigh/max）
   *   · pi：`--thinking <id>`（off/minimal/low/medium/high/xhigh/max）
   */
  thinking?: {
    readonly levels: readonly { readonly id: string, readonly name: string }[]
    readonly default: string
    readonly args: readonly string[]
  }
  /** 列出该 harness 可用模型的命令（如 `opencode`）。留空表示不支持列出。 */
  modelsCommand: string
  /** 列模型命令的参数。 */
  modelsArgs: string[]
  /** 列模型结果缓存时长（毫秒）。 */
  modelsCacheMs: number
  /** 列模型命令的超时（毫秒）。有的 harness 要联网拉列表，需要放宽。 */
  modelsTimeoutMs: number
  /**
   * 模型**目录文件**（可选；如 WorkBuddy/CodeBuddy 的 `models.json`）。
   *
   * 有的 harness 不提供列模型命令，但发布包里带一个模型目录文件。留空表示不适用；
   * 读取只提取 `models[].id` 这类**名字**字段，绝不读取任何值字段（该文件可能紧挨着密钥）。
   */
  modelsFile: string
  /**
   * 厂商**产品配置缓存**（如 `~/.workbuddy/cache/acc-product-config-v3.json`）。
   *
   * 与 `modelsFile` 不同：这份是厂商 product config，`models[]` 是**完整名册**
   * （本机实测：国内 55 条 / 国际 30 条），带 `id`/`name`/`vendor`/`isDefault`/
   * `maxInputTokens`/`maxOutputTokens`/`supports*`/`relatedModels`。
   * 名册里的 id 大多**不能**作为 `--model` 取值 ⇒ 一律按「仅展示」归类；
   * 它解决的是「模型数量不全」与「缺元数据」。
   *
   * ⚠️ 读取纪律：**只读 `models` 数组**，绝不读取同文件里的 `authentication` 等凭据字段
   * （离线探针对源码做静态断言）。
   */
  productConfigFile: string
  /**
   * 静态模型清单（可选；仅当该 CLI 的 `--model` 只接受**固定取值**时用）。
   *
   * 例：WorkBuddy/CodeBuddy 2.156.0 的 `-p --model` 只接受四个别名
   * （`deep-model`/`fast-model` 实测完成真实任务；`balanced-model`/`primary-model` 来自
   * 其帮助文本）；它目录文件里的 `r-*` id 与 `name` 都会被**响亮拒绝**（矩阵实测）。
   * 所以选择器里只出能真正生效的取值 —— 不把“能列出来”冒充“能选”。
   */
  modelsFixed: string[]
  /** true = prompt 走 stdin 而不是命令行参数。 */
  promptViaStdin: boolean
  /** 覆盖工作目录；留空继承父会话 workspace。 */
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  /** `auto` 时的通道优先级。 */
  order: string[]
  /**
   * **结构化原生会话协议能力**（可选；不声明 = 该目标仍走旧的 text CLI 路径，行为不变）。
   *
   * 只有声明了本能力的目标（五路产品入口中的 WorkBuddy/WorkBuddyAI/Qoder CN CLI/Antigravity）
   * 才会在派发带 `nativeSession` 引用时启用 JSONL 原生解析与精确恢复。
   * Qoder CN IDE **不声明**本能力：它没有等价的 headless CLI，桌面入口不冒充 CLI 会话。
   */
  nativeCli?: NativeCliConfig
  window: WindowSpec
  cdp: CdpSpec
}

/**
 * 一次执行的**请求身份**。创建时固化；之后改默认值**不得**影响已创建的执行
 * （这是「不串号」的落点）。
 */
export interface RequestedIdentity {
  readonly harnessId?: string
  /** 账号档案 id；派发时据此解析配置目录与启动方式。 */
  readonly accountId?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly permissionMode?: string
}

/** 一次执行的**实际身份**：由通道与 CLI 的真实行为回报。 */
export interface ActualIdentity {
  readonly harnessId?: string
  readonly accountId?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly permissionMode?: string
  readonly transport?: TransportKind
  readonly nativeSessionId?: string
}

/**
 * 一个 MCP server 的 ACP 配置（`DispatchSpec.mcpServers` 的元素）。
 *
 * **形状逐字对应 ACP 的 schema**（见 `DispatchSpec.mcpServers` 的注释；出处：
 * `@agentclientprotocol/sdk/dist/schema/zod.gen.js:2347-2416` 与 `schema/schema.json` 的 `$defs`）。
 * 这里把 `headers` / `args` / `env` 标成可选，只表示**调用方可以不给**；
 * `src/transports/acp.ts` 会**补齐空数组**，保证上线对象一定满足 schema 的必填项
 * （否则 `vecSkipError` 会把它静默丢掉）。
 */
export type McpServerSpec =
  | {
      readonly type: 'http' | 'sse'
      readonly name: string
      readonly url: string
      readonly headers?: readonly { readonly name: string; readonly value: string }[]
    }
  | {
      readonly type: 'stdio'
      readonly name: string
      readonly command: string
      readonly args?: readonly string[]
      readonly env?: readonly { readonly name: string; readonly value: string }[]
    }

/** 一次派发的输入。 */
export interface DispatchSpec {
  /** 已解析的目标。 */
  readonly target: TargetConfig
  /** 任务正文。 */
  readonly prompt: string
  /** 运行目录（绝对路径）。 */
  readonly cwd: string
  /** 调用方取消。 */
  readonly signal: AbortSignal
  /** 硬超时（毫秒）。 */
  readonly timeoutMs: number
  /** 追加在该目标固定参数之后的额外参数（例如 `--model opencode-go/deepseek-v4.1-flash`）。 */
  readonly extraArgs?: readonly string[]
  /**
   * **ACP 通道**的 `session/new.mcpServers`：本次派发要在该会话里挂上的 MCP server
   * （只有 `acp` 通道用得上；headless 走 `extraArgs` 的 `--mcp-config`）。
   *
   * ⚠️ **形状必须逐字匹配 ACP 的规范 schema**，否则会被**静默跳过**：
   * `zNewSessionRequest.mcpServers = requiredDefaultOnError(vecSkipError(zMcpServer), () => [])`
   * （`node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js:2425`），而
   * `vecSkipError = z.array(item.catch(skippedItem)).transform(items => items.filter(i => i !== skippedItem))`
   * （`dist/schema-deserialize.js:93-97`）—— **形状错的条目被丢掉，整条 `session/new` 照常成功**。
   *
   * 逐字核对过的必填项（`zod.gen.js:2347-2416` 与 `schema/schema.json` 的 `$defs` 一致）：
   *   · `http` / `sse`：`{type, name, url, headers}` —— `headers` 是**必填数组**（可空数组，但键必须在）；
   *   · `stdio`：`{name, command, args, env}` —— `args` / `env` 是**必填数组**，
   *     且该分支**没有 `type` 判别字段**（`zMcpServerStdio` 是裸的，不 `.and({type: literal})`）。
   *
   * `type: 'stdio'` 是本插件这一侧的类型判别字段；`acp` 通道在**上线的对象**里按规范
   * **不带**它（`src/transports/acp.ts`）。令牌等敏感值只允许从这里流到 CLI，
   * **不许**进 `facts` / `diagnostic` / 任何日志（`acp` 通道只记 `type:name`）。
   */
  readonly mcpServers?: readonly McpServerSpec[]
  /** 本次派发使用的模型 id；按目标配置的 `modelArgs` / `acpModel` 落到对应机制上。 */
  readonly model?: string
  /** 创建时固化的请求身份（含账号档案）；派发过程中**只读**。 */
  readonly identity?: RequestedIdentity
  /**
   * 该次派发的**受管账号执行前门禁已经真跑过并通过**（由已经测过一次的调用方声明）。
   *
   * 为什么需要这个字段：受管账号的两条真实派发路径会在同一次任务里**串起来** ——
   * 子代理 provider（`provider.ts` 的 `start()`）先测一次门禁，然后它调用的
   * `sessions.dispatch()` 又会经过**同一套**门禁（那是 HTTP `/dispatch`、`/task/start`
   * 与 `harness_task_start` 的唯一收口）。不声明就会在一次任务里连起两个厂商 `--version`
   * 子进程：既慢，又可能因为前一个进程还没退干净而**误判**成「版本没测到」——
   * 那会把一次正常派发拦成显式拒绝。
   *
   * ⚠️ 只有**真的测过并通过**的调用方才允许置 `true`；不置/置 `false` 一律**重测**。
   * 它不是「跳过门禁」的开关，而是「这次已经测过」的声明。
   */
  readonly accountGateChecked?: boolean
  /**
   * 该账号档案要求的额外环境变量（例如把配置目录指向档案）。
   * 与目标自身 env 合并，**档案优先**——否则账号隔离会静默失效。
   */
  readonly identityEnv?: Readonly<Record<string, string>>
  /**
   * **本轮**追加给 CLI 子进程的环境变量（`headless` / `acp` 通道都读；**合并顺序最后、优先级最高**）。
   *
   * 与 `identityEnv` 的区别是**生命周期与用途**：
   *   · `identityEnv` 在**创建会话时固化**，描述「这个会话是谁」（账号档案、配置目录）；
   *   · `extraEnv` 是**一次性**的，描述「这一轮额外需要什么」——
   *     目前唯一的用途是 MCP 桥接的**手递凭据**（`McpBridgeHandle.handoffEnv`）：
   *     令牌只经这里进入 CLI 子进程环境，再由 CLI 深拷贝给它 spawn 的 stdio 代理，
   *     于是**不必**把凭据写进任何落盘的配置文件。
   *
   * ⚠️ **纪律**：里面可能含**凭据**。调用方**不得**把它记进日志 / 诊断 / API 响应 /
   * `facts`；它只许流向 `spawn(..., { env })`。允许出现在这里的**只有**本轮一次性、
   * 短寿命、且作用域限于本机 loopback 的值。
   */
  readonly extraEnv?: Readonly<Record<string, string>>
  /** 可选的过程输出回调（尽力而为）。 */
  readonly onProgress?: (chunk: string) => void
  /**
   * **持久原生会话引用**（可选；只有 `target.nativeCli` 声明了协议能力时生效）。
   *
   * 有值时 headless 通道改走结构化 JSONL 分支（`transports/native-cli.ts`）：
   *   · `nativeSessionId` 有值 ⇒ 按目标 `resumeArgs` 精确恢复（恢复失败显式 `recovery_needed`，不静默新建）；
   *   · 缺省 ⇒ 新轮（`newSessionArgs` + 新 UUID，或 CLI 首轮 mint）。
   * 命名纪律：逻辑会话 ID（`ns-…`）与 task run ID（UUID）是两种标识，不得混用。
   */
  readonly nativeSession?: NativeSessionRef
}

export type DispatchStopReason = 'completed' | 'error' | 'aborted' | 'timeout'

/** 一次派发的结果。 */
export interface DispatchOutcome {
  readonly transport: TransportKind
  /** harness 的回答正文（window/cdp 通道可能是屏幕快照文本）。 */
  readonly text: string
  /** 未净完成时由通道给出的诊断。 */
  readonly diagnostic?: string
  readonly stopReason: DispatchStopReason
  /** 实际身份（通道与 CLI 真实回报的值）。 */
  readonly identity?: ActualIdentity
  /**
   * 请求值与实际值不一致的可读说明。**空数组=一致**。
   * 非空时调用方**必须**把差异显示出来，不得静默算成功。
   */
  readonly mismatch?: readonly string[]
  /** 附加事实：窗口句柄、CDP 端口、退出码等。 */
  readonly facts?: Record<string, string | number | boolean | undefined>
  /**
   * 结构化原生信息（可选；只有走 JSONL 原生分支的轮次才有）。
   * `runState` 是**结构化终态**：退出码 0 / 非空 stdout 都不单独算成功，
   * 终态以厂商 result 事件为准；`recovery_needed` = 精确恢复未确认，绝不静默新建。
   */
  readonly native?: NativeRunInfo
}

/** 读一屏的结果。 */
export interface ReadResult {
  readonly text: string
  /** 文本来源：无障碍树 / 控制台缓冲区 / DOM / PTY。 */
  readonly source: string
  readonly diagnostic?: string
}
