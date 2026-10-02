/**
 * acp 通道：用 Agent Client Protocol 跟 harness 的 ACP server 对话
 * （`opencode acp` 会在 stdio 上起一个 ACP server）。
 *
 * 为什么要有这一档：headless 是一次性打印（没有会话、没有流式进度、没有权限回调），
 * ACP 是结构化的 JSON-RPC —— session 可复用、回答按 chunk 流式到达、停止原因明确。
 *
 * 时序（SDK 1.4.0，已在本机 opencode 2.0.14 上跑通）：
 *   spawn → initialize → session/new { cwd, mcpServers: [] }
 *         → session/prompt → 收 session/update 里的 agent_message_chunk
 *         → prompt 以 { stopReason } 收尾
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
 */
export async function dispatchAcp(spec: DispatchSpec): Promise<DispatchOutcome> {
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
        if (child !== undefined) killTree(child.pid)
      }
      resolve({
        transport: 'acp',
        text: text.trim(),
        ...(diagnostics.length > 0 ? { diagnostic: diagnostics.join('; ') } : {}),
        stopReason,
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
        env: { ...process.env, ...spec.target.env, NO_COLOR: '1', TERM: 'dumb' },
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

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = tail(stderr + chunk, STDERR_TAIL_LIMIT)
    })
    child.on('error', (error: Error) => {
      settle('error', `spawn failed: ${error.message}`)
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
      app.onRequest('session/request_permission', (context) => {
        const options = context.params.options
        const allowed = options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
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

      await app.connectWith(stream, async (context) => {
        activeContext = context

        // initialize 不会自动发：必须自己发第一条请求
        const init: InitializeResponse = await context.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        })
        negotiatedVersion = init.protocolVersion
        agentName = init.agentInfo?.name ?? ''
        agentVersion = init.agentInfo?.version ?? ''

        const session = await context.buildSession({ cwd: spec.cwd, mcpServers: [] }).start()
        activeSession = session
        sessionId = session.sessionId

        // 会话内换模型：ACP 没有 --model 参数，opencode 的默认模型可能不可用
        // （本机默认走 OpenRouter 且余额不足），只能在 session/new 之后用
        // session/set_config_option { configId: 'model' }。
        // 失败不阻断本轮：把结果记进 facts，让调用方自己判断。
        if (spec.target.acpModel.length > 0) {
          try {
            await context.request('session/set_config_option', {
              sessionId: session.sessionId,
              configId: 'model',
              value: spec.target.acpModel,
            })
            acpModelNote = `model set to ${spec.target.acpModel}`
          } catch (error: unknown) {
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
