/**
 * acp 通道：用 Agent Client Protocol 跟 harness 的 ACP server 对话
 * （`opencode acp` 会在 stdio 上起一个 ACP server）。
 *
 * 为什么要有这一档：headless 是一次性打印（没有会话、没有流式进度、没有权限回调），
 * ACP 是结构化的 JSON-RPC —— session 可复用、回答按 chunk 流式到达、停止原因明确。
 *
 * 时序（SDK 1.4.0，已在本机 opencode 2.0.14 上跑通）：
 *   spawn → initialize → session/new { cwd, mcpServers }
 *         → session/prompt → 收 session/update 里的 agent_message_chunk
 *         → prompt 以 { stopReason } 收尾
 *
 * `mcpServers` 来自 `DispatchSpec.mcpServers`（由 `src/mcp-bridge.ts` 构造的桥接入口条目，
 * 令牌只在那一条 `Authorization` header 里）。形状必须逐字匹配 ACP 的 schema，
 * 否则条目会被 `vecSkipError` **静默丢掉** —— 详见下面 `buildSession` 前的注释。
 *
 * 两条铁律：
 *   1. 本模块永不 reject —— 任何异常都折叠进 DispatchOutcome.stopReason。
 *   2. 任何出口都要清掉整棵进程树（ACP server 是常驻进程，不杀就成孤儿）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type {
  ActiveSession,
  ClientApp,
  ClientContext,
  InitializeResponse,
  StopReason,
} from '@agentclientprotocol/sdk'
import { buildArgv, probeCommand } from '../launcher.js'
import type { SpawnExitReporter, SpawnObserverHost, SpawnTerminator } from '../processpool.js'
import type { DispatchOutcome, DispatchSpec, TargetConfig } from '../types.js'
import { killTree } from './headless.js'

/** stderr 只保留一个尾部窗口，避免常驻 server 把日志刷爆诊断文本。 */
const STDERR_TAIL_LIMIT = 4096
/** 诊断里摘出来的 stderr 行数 / 字符数上限（与 headless 通道风格一致）。 */
const STDERR_LINES = 4
const STDERR_EXCERPT_CHARS = 800
/** 超时下限，避免配置写了 0 反而把 harness 秒掐。 */
const MIN_TIMEOUT_MS = 1000

/** ACP 通道的可用性探测结果。 */
/**
 * ACP 通道的**偏差清单**（请求值 ≠ 实际值）。抽成导出函数是为了能**单测**：
 * 这里出过一次真实缺陷 —— 两个 `...{ mismatch: [...] }` 展开后，后者把前者整个覆盖掉，
 * 于是「模型没生效」的偏差被「extra_args 没生效」吃掉，只剩一条（甚至反过来）。
 *
 * @param applied `false` = 请求的模型没在本会话生效（ACP 没有 `--model`，只能 `session/set_config_option`）
 * @param extraArgs 本次调用方要求追加的参数（ACP 通道**不会**追加它们，必须报出来）
 */
export function acpMismatchOf(input: {
  readonly modelApplied: boolean | undefined
  readonly model: string
  readonly modelNote: string
  readonly extraArgs: readonly string[] | undefined
}): string[] {
  const mismatch: string[] = []
  if (input.modelApplied === false) {
    mismatch.push(
      `请求的模型 "${input.model}" 未在本会话生效：${input.modelNote}`,
      '本轮回复仍然保留，但它**不是**由所请求的模型产生的；请勿按「已按所选模型执行」验收。',
    )
  }
  if ((input.extraArgs?.length ?? 0) > 0) {
    mismatch.push(
      `extra_args 未在 ACP 通道生效：${(input.extraArgs ?? []).join(' ')}`,
      '原因：ACP 以 `--acp` 启动协议服务，只拼目标自带的 acpArgs，不追加自定义参数。'
      + '要下发请显式用 transport=headless（或在目标配置里改 acpArgs）。',
    )
  }
  return mismatch
}

export interface AcpProbeResult {
  available: boolean
  detail?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 只保留尾部 limit 个字符（尾部才是最新的、最有用的）。 */
function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** 把 stderr 拼成一行短摘要，供 diagnostic 使用。 */
function stderrExcerpt(stderr: string): string {
  const trimmed = stderr.trim()
  if (trimmed.length === 0) return ''
  return trimmed.split(/\r?\n/).slice(-STDERR_LINES).join(' | ').slice(0, STDERR_EXCERPT_CHARS)
}

/**
 * 廉价可用性探测：只解析命令（`where.exe` + 文件系统检查），绝不 spawn 进程。
 * 语义跟 headless 的 `probeCommand` 一致：探不出来也不抛错，只回 available=false。
 */
export function probeAcp(target: TargetConfig): AcpProbeResult {
  const command = target.command.trim()
  if (command.length === 0) return { available: false, detail: 'target has no command configured' }
  const probe = probeCommand(command)
  if (!probe.available) {
    return { available: false, detail: probe.error ?? `cannot resolve "${command}" on this machine` }
  }
  // 再走一遍 buildArgv：确认参数拼接（.cmd shim 的引号规则）不会炸，仍然不 spawn。
  let argv: string[]
  let verbatim = false
  try {
    const built = buildArgv(command, target.acpArgs)
    // cmd 形态要用 verbatimArgv（整条命令行已按 cmd.exe 规则拼好引号）
    argv = built.verbatim ? built.verbatimArgv : built.argv
    verbatim = built.verbatim
  } catch (error: unknown) {
    return { available: false, detail: errorText(error) }
  }
  const resolved = probe.path ?? command
  const args = target.acpArgs.length > 0 ? ` ${target.acpArgs.join(' ')}` : ''
  return {
    available: true,
    detail: `acp server: ${resolved}${args} (argv: ${argv.join(' ')}, verbatim: ${String(verbatim)})`,
  }
}

/** ACP 停止原因 → 本通道的停止原因（映射表来自需求，别改语义）。 */
function mapStopReason(raw: StopReason | null, diagnostics: string[]): DispatchOutcome['stopReason'] {
  if (raw === null) {
    diagnostics.push('acp session ended without reporting a stop reason')
    return 'error'
  }
  switch (raw) {
    case 'end_turn':
      return 'completed'
    case 'cancelled':
      return 'aborted'
    case 'max_tokens':
      diagnostics.push('agent stopped because of max_tokens')
      return 'error'
    case 'refusal':
      diagnostics.push('agent refused the prompt (refusal)')
      return 'error'
    case 'max_turn_requests':
      diagnostics.push('agent stopped because of max_turn_requests')
      return 'error'
    default:
      diagnostics.push(`unknown ACP stop reason: ${String(raw)}`)
      return 'error'
  }
}

/** 一行描述权限请求涉及的工具调用（只为诊断可读）。 */
function describeToolCall(title: string | null | undefined, toolCallId: string): string {
  const name = typeof title === 'string' && title.trim().length > 0 ? title.trim() : toolCallId
  return name.slice(0, 160)
}

/**
 * 跑一次 ACP 派发；永不 reject（异常全部折叠成 stopReason）。
 *
 * 用的是 1.4.0 的新 API `client({name}).connectWith(stream, op)`
 * （`ClientSideConnection` 在 1.4.0 里已标 @deprecated，不再使用）。
 *
 * `spec.onSpawn` 是**可选**挂钩：ACP server 是一个常驻子进程，给了挂钩就在 `spawn()`
 * 成功那一刻把「真实拉起的 pid + 启动时刻」回报出去（进程池据此登记"我拥有的进程"），
 * 拿回的回调在出口回报"何时结束 / 退出码 / 信号 / 是否被取消"。没给也能照常跑。
 */
export async function dispatchAcp(spec: DispatchSpec & SpawnObserverHost): Promise<DispatchOutcome> {
  const started = Date.now()

  // ── 1. 先解析 argv（Windows 上 .cmd shim 必须经 cmd.exe /d /s /c）──
  let argv: string[]
  let resolved = spec.target.command
  // buildArgv 对 .cmd/.bat 会自己拼好整条命令行并要求 verbatim 原样传递
  // （否则 Node 会二次转义，cmd.exe 收到 \"…\" 直接报「不是内部或外部命令」）。
  let verbatim = false
  try {
    const built = buildArgv(spec.target.command, spec.target.acpArgs)
    argv = built.verbatim ? built.verbatimArgv : built.argv
    resolved = built.launcher.resolved
    verbatim = built.verbatim
  } catch (error: unknown) {
    return {
      transport: 'acp',
      text: '',
      diagnostic: `cannot start ACP server: ${errorText(error)}`,
      stopReason: 'error',
    }
  }

  const timeoutMs = Math.max(MIN_TIMEOUT_MS, spec.timeoutMs > 0 ? spec.timeoutMs : spec.target.timeoutMs)

  if (spec.signal.aborted) {
    return {
      transport: 'acp',
      text: '',
      diagnostic: 'cancelled by caller before the ACP server was started',
      stopReason: 'aborted',
      facts: { command: resolved, cwd: spec.cwd, durationMs: Date.now() - started },
    }
  }

  return await new Promise<DispatchOutcome>((resolve) => {
    const diagnostics: string[] = []
    let text = ''
    let stderr = ''
    let settled = false
    let killed = false
    let cancelSentFor: 'abort' | 'timeout' | null = null
    let child: ChildProcessWithoutNullStreams | undefined
    /** 真实拉起的 ACP server pid（spawn 成功那一刻记下；没成功 = null，不伪造）。 */
    let spawnedPid: number | null = null
    let timer: NodeJS.Timeout | undefined
    // 连接活着的时候才存在的东西
    let activeContext: ClientContext | null = null
    let activeSession: ActiveSession | null = null
    let sessionId = ''
    let agentName = ''
    let agentVersion = ''
    let negotiatedVersion = 0
    let rawStopReason: StopReason | null = null
    let chunks = 0
    let thoughtChars = 0
    /** 会话内换模型的结果（成功/失败都记下来，便于诊断）。 */
    let acpModelNote = ''
    /** 会话内换模型是否**真的**生效；undefined = 本次没请求换模型。 */
    let acpModelApplied: boolean | undefined
    /** ACP agent 自报的 MCP 能力（`initialize.agentCapabilities.mcpCapabilities`，脱敏：只有布尔）。 */
    let mcpAgentCapsNote = ''
    /** 本次请求注入、但 agent 没自报支持的 MCP 传输类型（空 = 都在自报支持范围内）。 */
    let mcpUnsupportedNote = ''
    // ── 启动生命周期事实（**实测**）────────────────────────────────────────
    // ACP server 是常驻进程：没有 pid 与启动/结束时刻，池就无法回答
    // "取消时它到底停了没有"。这几格是那个问题的答案。
    let spawnedAtMs: number | null = null
    let exitedAtMs: number | null = null
    let killReason: SpawnTerminator | undefined
    let treeKillIssued = false
    let observationError: string | undefined
    let exitReported = false
    let exitReporter: SpawnExitReporter | undefined
    /** 最后一次实测的退出码/信号（由 close / error 事件填）。 */
    let exitInfo: { code: number | null, signal: NodeJS.Signals | null } | undefined

    /** 把「结束事实」回报给池：第一次为准；观测失败只留痕，不影响派发。 */
    const reportExit = (terminatedBy: SpawnTerminator, extra: { exitCode?: number | null, signal?: string | null, cancelled?: boolean } = {}): void => {
      if (exitReported) return
      exitReported = true
      exitedAtMs = Date.now()
      try {
        exitReporter?.({
          at: exitedAtMs,
          terminatedBy,
          ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
          ...(extra.signal === undefined ? {} : { signal: extra.signal }),
          ...(extra.cancelled === undefined ? {} : { cancelled: extra.cancelled }),
        })
      } catch (error: unknown) {
        observationError = `exit observer failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    const facts = (): Record<string, string | number | boolean | undefined> => ({
      command: resolved,
      argv: argv.join(' '),
      cwd: spec.cwd,
      timeoutMs,
      verbatim,
      durationMs: Date.now() - started,
      textChars: text.length,
      stderrChars: stderr.length,
      chunks,
      thoughtChars,
      ...(sessionId.length > 0 ? { sessionId } : {}),
      ...(agentName.length > 0 ? { agentName } : {}),
      ...(agentVersion.length > 0 ? { agentVersion } : {}),
      ...(negotiatedVersion > 0 ? { protocolVersion: negotiatedVersion } : {}),
      ...(rawStopReason !== null ? { acpStopReason: rawStopReason } : {}),
      ...(acpModelNote.length > 0 ? { acpModelNote } : {}),
      ...(acpModelApplied !== undefined ? { acpModelApplied } : {}),
      // ── MCP 注入事实（**只记类型与名字**；url 与 Authorization 令牌绝不进 facts / 日志）──
      ...(spec.mcpServers === undefined || spec.mcpServers.length === 0
        ? {}
        : { mcpServers: spec.mcpServers.map((server) => `${server.type}:${server.name}`).join(',') }),
      ...(mcpAgentCapsNote.length === 0 ? {} : { mcpAgentCaps: mcpAgentCapsNote }),
      ...(mcpUnsupportedNote.length === 0 ? {} : { mcpUnsupportedTransports: mcpUnsupportedNote }),
      // ── 启动生命周期事实（pid 与时刻）──────────────────────────────────
      // ⚠️ 没真的 spawn 出进程时（例如 spawn 同步抛错）这里**不会**出现 pid ⇒ 池据此知道
      // "这一轮没有可核对的进程"；命名纪律同 headless：时刻字段不带 `pid` 前缀。
      ...(spawnedPid === null ? {} : { pid: spawnedPid }),
      ...(spawnedAtMs === null ? {} : { spawnedAtMs, spawnedAt: new Date(spawnedAtMs).toISOString() }),
      ...(exitedAtMs === null ? {} : { exitedAtMs, exitedAt: new Date(exitedAtMs).toISOString() }),
      ...(killReason === undefined ? {} : { terminatedBy: killReason }),
      ...(exitInfo === undefined || exitInfo.code === null ? {} : { exitCode: exitInfo.code }),
      ...(exitInfo === undefined || exitInfo.signal === null ? {} : { exitSignal: exitInfo.signal }),
      cancelled: killReason === 'caller-abort' || killReason === 'timeout',
      treeKillIssued,
      ...(observationError === undefined ? {} : { spawnObserverError: observationError }),
    })

    /** 唯一出口：清理 → 折叠诊断 → resolve。幂等。 */
    const settle = (stopReason: DispatchOutcome['stopReason'], diagnostic?: string): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      spec.signal.removeEventListener('abort', onAbort)
      if (diagnostic !== undefined && diagnostic.length > 0) diagnostics.push(diagnostic)
      // stderr 只在没跑干净的出口才进诊断，避免成功路径被 server 日志污染
      if (stopReason !== 'completed') {
        const excerpt = stderrExcerpt(stderr)
        if (excerpt.length > 0) diagnostics.push(`stderr tail: ${excerpt}`)
      }
      // 会话路由先停掉，免得 nextUpdate() 挂在半空
      try {
        activeSession?.dispose()
      } catch {
        // dispose 失败不影响结果
      }
      // ACP server 是常驻进程：任何出口都要清掉整棵进程树
      if (!killed) {
        killed = true
        if (child !== undefined) {
          killReason = cancelSentFor === 'timeout'
            ? 'timeout'
            : (cancelSentFor === 'abort' ? 'caller-abort' : 'transport-settle-kill')
          treeKillIssued = true
          killTree(child.pid)
          reportExit(killReason, { cancelled: killReason === 'caller-abort' || killReason === 'timeout' })
        }
      }
      resolve({
        transport: 'acp',
        text: text.trim(),
        ...(diagnostics.length > 0 ? { diagnostic: diagnostics.join('; ') } : {}),
        stopReason,
        /**
         * **偏差清单**（请求值 ≠ 实际值的唯一出口）。
         *
         * 两个来源必须**合并**成一个数组（早先写成两个 `...{ mismatch: [...] }` 展开，
         * 后者会把前者整个覆盖掉 —— 模型未生效的偏差会被 extra_args 的偏差吃掉）：
         *   ① 请求的模型没在本会话生效（ACP 没有 `--model`，只能 `session/set_config_option`）；
         *   ② `extra_args` 在 ACP 通道**不会生效**（实测 argv 里根本没有它们）。
         *
         * 为什么 ② 必须报出来：`harness_dispatch` 的 `extra_args` 文档写的是「追加在目标默认参数之后」，
         * 而 ACP 是用 `--acp` 起一个**协议服务**，只拼 `target.acpArgs`，`extraArgs` 一处都没引用。
         * 于是「要求用某个模型/开关去跑」被**静默忽略**，调用方拿到 completed 的回复却不知道跑的不是自己要的
         * （2026-10-14 端到端实测：`--model gpt-6-astra` 消失，CLI 用默认模型正常回答 ——
         * 最坏形态的「请求值 ≠ 实际值」）。现在不假装生效，记成 mismatch（回执/设置页/工具输出都会显示）。
         * 要真正下发这些参数，请显式用 `transport: 'headless'` 或 `'pty'`（它们会追加）。
         */
        ...(() => {
          const mismatch = acpMismatchOf({
            modelApplied: acpModelApplied,
            model: spec.target.acpModel,
            modelNote: acpModelNote,
            extraArgs: spec.extraArgs,
          })
          return mismatch.length === 0 ? {} : { mismatch }
        })(),
        facts: facts(),
      })
    }

    /** 尽力而为的取消：先发 session/cancel，再由 settle 杀掉进程树。 */
    const beginCancel = (kind: 'abort' | 'timeout'): void => {
      if (cancelSentFor !== null) return
      cancelSentFor = kind
      const context = activeContext
      const id = sessionId
      if (context !== null && id.length > 0) {
        try {
          // 不 await：通知能不能出门是 best-effort，真正的收尾是 killTree
          void Promise.resolve(context.notify('session/cancel', { sessionId: id })).catch(() => undefined)
        } catch {
          // 连接已经断了就跳过
        }
      }
      if (kind === 'timeout') {
        settle('timeout', `acp run exceeded ${timeoutMs}ms and was terminated`)
        return
      }
      settle('aborted', 'cancelled by caller (session/cancel sent first)')
    }

    const onAbort = (): void => {
      beginCancel('abort')
    }

    timer = setTimeout(() => {
      beginCancel('timeout')
    }, timeoutMs)
    spec.signal.addEventListener('abort', onAbort, { once: true })

    // ── 2. spawn ACP server ──
    let spawned: ChildProcessWithoutNullStreams
    try {
      spawned = spawn(argv[0]!, argv.slice(1), {
        cwd: spec.cwd,
        // `extraEnv`（本轮一次性，可能含 MCP 桥接的手递凭据）放最后：不被静态 env 覆盖，
        // 且**从不**落盘 / 不进日志 / 不进 facts。ACP 通道自己不用它（注入向量是协议字段），
        // 但 `DispatchSpec` 的语义是「这一轮要交给子进程的环境」，两条通道必须一致，
        // 否则「换个传输就把凭据悄悄丢了」会变成一类无法察觉的故障。
        env: { ...process.env, ...spec.target.env, ...spec.extraEnv, NO_COLOR: '1', TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // .cmd/.bat 走 cmd.exe 时必须原样传递 argv（buildArgv 已经拼好引号）
        ...(verbatim ? { windowsVerbatimArguments: true } : {}),
      })
    } catch (error: unknown) {
      settle('error', `spawn failed: ${errorText(error)}`)
      return
    }
    child = spawned
    spawnedPid = typeof spawned.pid === 'number' && spawned.pid > 0 ? spawned.pid : null
    spawnedAtMs = Date.now()
    // spawn 成功 ⇒ 立刻把 pid 回报给池（**运行期**登记，而不是等派发结算后补一个 pid）。
    if (spawnedPid !== null) {
      try {
        exitReporter = spec.onSpawn?.({
          pid: spawnedPid,
          channel: 'acp',
          command: resolved,
          at: spawnedAtMs,
          argvChars: argv.join(' ').length,
        }) ?? undefined
      } catch (error: unknown) {
        observationError = `spawn observer failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = tail(stderr + chunk, STDERR_TAIL_LIMIT)
    })
    child.on('error', (error: Error) => {
      reportExit('spawn-error', { cancelled: false })
      settle('error', `spawn failed: ${error.message}`)
    })
    // 结束事实的**独立**回报：即便 settle 已经因为取消/超时结算过，也要把真实的
    // 退出码/信号带回池（取消路径最需要这一格）。
    child.on('close', (code: number | null, signalName: NodeJS.Signals | null) => {
      exitInfo = { code, signal: signalName }
      reportExit(killReason ?? 'child-exit', {
        exitCode: code,
        signal: signalName,
        ...(killReason === 'caller-abort' || killReason === 'timeout' ? { cancelled: true } : {}),
      })
    })
    child.on('close', (code: number | null, signalName: NodeJS.Signals | null) => {
      // 正常跑完时我们已经 settle 过了；这里只兜底「还没打招呼就死掉」
      settle(
        'error',
        `acp server exited with code ${String(code)}${signalName !== null ? ` (signal ${signalName})` : ''}`,
      )
    })

    // ── 3. 协议流程 ──
    const run = async (): Promise<void> => {
      const app: ClientApp = client({ name: 'dsh-harness-pilot' })

      // session/request_permission 是必需的 client handler：缺了它 agent 第一次
      // 工具调用就会卡住。这里自动放行，并把决定记进诊断。
      app.onRequest('session/request_permission', (context: any) => {
        const options = context.params.options
        const allowed = options.find((option: any) => option.kind === 'allow_once' || option.kind === 'allow_always')
        const what = describeToolCall(context.params.toolCall.title, context.params.toolCall.toolCallId)
        if (allowed === undefined) {
          diagnostics.push(`auto-cancelled permission request (no allow_* option offered): ${what}`)
          return { outcome: { outcome: 'cancelled' } }
        }
        diagnostics.push(`auto-allowed ${allowed.kind} (${allowed.name}) for permission request: ${what}`)
        return { outcome: { outcome: 'selected', optionId: allowed.optionId } }
      })

      const stream = ndJsonStream(
        Writable.toWeb(spawned.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(spawned.stdout) as unknown as ReadableStream<Uint8Array>,
      )

      await app.connectWith(stream, async (context: any) => {
        activeContext = context

        // initialize 不会自动发：必须自己发第一条请求
        const init: InitializeResponse = await context.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        })
        negotiatedVersion = init.protocolVersion
        agentName = init.agentInfo?.name ?? ''
        agentVersion = init.agentInfo?.version ?? ''

        // ── MCP 注入：ACP 的 `session/new.mcpServers`（`DispatchSpec.mcpServers`）──
        // 形状**逐字**照 ACP 的 schema（`@agentclientprotocol/sdk/dist/schema/zod.gen.js:2347-2416`
        // 与 `schema/schema.json` 的 `$defs`，两处一致）：
        //   · http | sse → `{type,name,url,headers:[{name,value}]}`，`headers` 是**必填数组**；
        //   · stdio      → `{name,command,args,env:[{name,value}]}`，`args`/`env` 是**必填数组**，
        //                  且该分支在 schema 里**没有 `type` 判别字段**（`zMcpServerStdio` 是裸的）
        //                  ⇒ 上线对象里**不带** `type`（`type` 只是本插件这一侧的类型判别）。
        // ⚠️ `mcpServers` 用的是 `vecSkipError`（`zod.gen.js:2425` = `z.array(item.catch(skippedItem))`
        //    + 过滤，`dist/schema-deserialize.js:93-97`）：**形状错的条目被静默丢掉，整条请求照常成功**。
        //    所以这里①补齐必填键（缺省补空数组）②逐条复制成**新对象**，绝不把调用方的对象引用交给 SDK。
        const mcpServers = (spec.mcpServers ?? []).map((server) => server.type === 'stdio'
          ? {
              name: server.name,
              command: server.command,
              args: [...(server.args ?? [])],
              env: (server.env ?? []).map((row) => ({ name: row.name, value: row.value })),
            }
          : {
              type: server.type,
              name: server.name,
              url: server.url,
              headers: (server.headers ?? []).map((row) => ({ name: row.name, value: row.value })),
            })
        // agent 自报的 MCP 能力（`initialize.agentCapabilities.mcpCapabilities`）：用来如实记账，
        // 不断言「注入一定生效」—— 生效与否由 MCP 服务端是否收到请求来证明。
        const mcpCaps = (init as { agentCapabilities?: { mcpCapabilities?: unknown } } | null | undefined)
          ?.agentCapabilities?.mcpCapabilities as { http?: unknown; sse?: unknown; acp?: unknown } | undefined
        const agentMcpCaps = {
          http: mcpCaps?.http === true,
          sse: mcpCaps?.sse === true,
          acp: mcpCaps?.acp === true,
        }
        mcpAgentCapsNote = `http=${String(agentMcpCaps.http)} sse=${String(agentMcpCaps.sse)} acp=${String(agentMcpCaps.acp)}`
        // stdio 是规范里**所有 agent 必须支持**的传输（schema.json：'All Agents MUST support this transport'）；
        // http/sse/acp 只在 agent 自报支持时才是规范内的。不支持的**不静默丢**，记成可读的偏差。
        const unsupportedTransports = [...new Set((spec.mcpServers ?? [])
          .map((server) => server.type)
          .filter((type) => type === 'http' ? !agentMcpCaps.http : (type === 'sse' ? !agentMcpCaps.sse : false)))]
        if (unsupportedTransports.length > 0) {
          mcpUnsupportedNote = unsupportedTransports.join(',')
          diagnostics.push(
            `this ACP agent does not advertise mcpCapabilities for: ${mcpUnsupportedNote} `
            + `(advertised: ${mcpAgentCapsNote}); the injected MCP server(s) may be ignored by the agent`,
          )
        }

        const session = await context.buildSession({ cwd: spec.cwd, mcpServers }).start()
        activeSession = session
        sessionId = session.sessionId

        // 会话内换模型：ACP 没有 --model 参数，opencode 的默认模型可能不可用
        // （本机默认走 OpenRouter 且余额不足），只能在 session/new 之后用
        // session/set_config_option { configId: 'model' }。
        //
        // ⚠️ 这里曾经「失败不阻断本轮」—— 把失败塞进 facts 就继续，最后照样报 completed，
        // 于是**请求的模型没生效却被当成成功**。现在失败必须变成显式的 mismatch：
        // 回复仍然保留（它是真实的），但调用方一定会看到「配置值≠实际值」。
        if (spec.target.acpModel.length > 0) {
          try {
            await context.request('session/set_config_option', {
              sessionId: session.sessionId,
              configId: 'model',
              value: spec.target.acpModel,
            })
            acpModelApplied = true
            acpModelNote = `model set to ${spec.target.acpModel}`
          } catch (error: unknown) {
            acpModelApplied = false
            acpModelNote = `model switch to ${spec.target.acpModel} failed: ${error instanceof Error ? error.message : String(error)}`
          }
        }

        const promptDone = session.prompt(spec.prompt)
        // 真正的失败由 nextUpdate() 抛出；这里先挂上处理，避免 unhandled rejection
        void promptDone.catch(() => undefined)

        for (;;) {
          const message = await session.nextUpdate()
          if (message.kind === 'stop') {
            rawStopReason = message.stopReason
            break
          }
          const update = message.update
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            const delta = update.content.text
            if (delta.length === 0) continue
            chunks += 1
            text += delta
            try {
              spec.onProgress?.(delta)
            } catch {
              // 进度回调是尽力而为，不能影响派发
            }
            continue
          }
          if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
            thoughtChars += update.content.text.length
          }
        }

        // stop 通知与 prompt response 同源，这里只是把 rejection 收干净
        await promptDone
      })
    }

    void run().then(
      () => {
        if (!settled) settle(mapStopReason(rawStopReason, diagnostics))
      },
      (error: unknown) => {
        // 取消 / 超时已经结算过：这里的异常只是我们自己掐断连接的余波
        if (settled) return
        settle(mapStopReason(rawStopReason, diagnostics), `acp session failed: ${errorText(error)}`)
      },
    )
  })
}
