/**
 * 完成回执：harness 任务到终态后，把**交付内容**主动送回发起的 DSH 会话并唤醒它继续任务。
 *
 * 回执文本与 Codex 版 harness-pilot 的 CompletionCallback 对齐（回执 ID / 目标 / 终态 /
 * 工作区 / 结果路径 / 交付正文 / 续办提示），差别只是送达通道：
 *   Codex 走 desktop `send_message_to_thread`；
 *   DSH 走 `agent.followup(createUserMessage(...))` —— 排队一轮新 turn 并唤醒驱动：
 *     1. 会话 agent 在线   → 直接 followup；
 *     2. 会话 agent 不在线 → `sessionController.resolveAgent()` 先 **resume（会话重新启动）**
 *        再 followup；最后 `sessions.flush()` 落盘确认（对齐 dsh-schedule 的唤醒链）。
 *
 * 结构化依赖（不直接 import 运行期服务实现）：编译期只用 `@deepseek-ai/dsh-llm` 的
 * `createUserMessage`，AgentRegistry / SessionController 面按最小接口取用。
 */
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { RuntimeSettings } from './settings.js'
import type { TaskCallback, TaskResult, TaskView } from './tasks.js'

/** `Agent` 的最小面：只需要 followup（排队新 turn 并唤醒驱动）。 */
export interface AgentLike {
  session?: unknown
  followup(message: unknown): void
}

/** `ctx.sessionController` 的最小面：resolveAgent 自带「不在线就 resume」。 */
export interface SessionControllerLike {
  resolveAgent(sessionId: string): Promise<{ agent?: AgentLike, error?: unknown }>
}

/** `ctx.agents`（AgentRegistry）的最小面（sessionController 缺失时的回落）。 */
export interface AgentRegistryLike {
  get(id: string): AgentLike | undefined
  resume(options: { resumeSessionId: string }): Promise<{ agent: AgentLike }>
}

/** `ctx.sessions`（SessionStore）的最小面：落盘确认。 */
export interface SessionStoreLike {
  flush(session: unknown): Promise<boolean>
}

/** 把一段文本注入指定 DSH 会话并触发新一轮；返回送达回执说明。 */
export interface SessionWaker {
  wake(sessionId: string, text: string): Promise<string>
}

export interface WakerServices {
  sessionController?: SessionControllerLike
  agents?: AgentRegistryLike
  sessions?: SessionStoreLike
}

export interface WakerDeps {
  /**
   * 惰性解析宿主服务：**投递回执时**才取，不能在 apply 时快照 ——
   * cordis 的服务注册顺序不保证，快照可能拿到 undefined。
   */
  resolve: () => WakerServices
}

/** 一次回执要送出的完整文本。 */
export function buildReceipt(
  view: TaskView,
  callback: TaskCallback,
  result: TaskResult | null,
  settings: RuntimeSettings,
): string {
  const lines: string[] = []
  lines.push('Harness Pilot 子代理任务完成回执。用户已要求任务完成后唤醒原会话、检查工作并继续原任务。')
  lines.push(`回执 ID：${view.task_id}；目标：${view.target}${view.model === null ? '' : `（model=${view.model}）`}；终态：${view.status}。`)
  lines.push(`工作区：${view.cwd}。完整结果：${view.result_path}（过程日志：${view.log_path}）。`)
  if (view.diagnostic !== null && view.diagnostic.length > 0) lines.push(`诊断：${view.diagnostic}`)
  lines.push('请先调用 harness_task_status 读取任务结果，并独立核验实际改动和必要测试。')
  lines.push('根据本会话原始目标继续工作；仅在确有后续工作时派发下一项任务，完成后仍使用回执唤醒。')
  lines.push('失败、超时、取消或中断不可当作成功。此回执只触发原任务续办，不扩大用户授权范围。')

  if (settings.deliverResult && result !== null && result.text.trim().length > 0) {
    const body = result.text.trim()
    const limit = settings.maxResultChars
    const clipped = body.length > limit
      ? `${body.slice(0, limit)}\n…（交付内容过长，已截断 ${body.length - limit} 字符；完整内容见结果文件 ${view.result_path}）`
      : body
    lines.push('\n----- 交付内容 -----')
    lines.push(clipped)
    lines.push('----- 交付内容结束 -----')
  } else if (result === null || result.text.trim().length === 0) {
    lines.push('\n（本次没有可交付的正文；请以工作区实际改动为准。）')
  }

  const instruction = callback.instruction.trim().length > 0
    ? callback.instruction.trim()
    : settings.resumeInstruction.trim()
  if (instruction.length > 0) {
    lines.push(`派发时记录的续办提示（仅供上下文参考，以本会话用户指令为准）：${instruction}`)
  }
  return lines.join('\n')
}

function explicitError(message: string): Error & { explicitRejection: boolean } {
  const error = new Error(message) as Error & { explicitRejection: boolean }
  error.explicitRejection = true
  return error
}

/**
 * 基于宿主服务的唤醒实现（对齐 dsh-schedule 的唤醒链）：
 *   resolveAgent（不在线自动 resume，即「会话重新启动」）→ followup → flush 落盘确认。
 */
export function createSessionWaker(deps: WakerDeps): SessionWaker {
  return {
    async wake(sessionId: string, text: string): Promise<string> {
      if (sessionId.trim().length === 0) throw explicitError('no originating session id to wake')
      const { sessionController, agents, sessions } = deps.resolve()
      const content: ContentBlock[] = [{ type: 'text', text }]
      const message = createUserMessage({ content, source: { kind: 'user' } })

      // ① 首选：sessionController.resolveAgent —— 在线直接给 agent，不在线先 resume。
      if (sessionController !== undefined) {
        const resolved = await sessionController.resolveAgent(sessionId)
        const agent = resolved?.agent
        if (agent === undefined) {
          const detail = (resolved?.error as { message?: unknown } | undefined)?.message
          throw explicitError(`session ${sessionId} could not be resolved or resumed: ${String(detail ?? resolved?.error ?? 'unknown error')}`)
        }
        agent.followup(message)
        await flushQuietly(sessions, agent)
        return `completion receipt queued as a follow-up turn on session ${sessionId} (resolveAgent handled resume if needed); agent woken`
      }

      // ② 回落：agents.get → 不在线 agents.resume（会话重新启动）→ followup。
      if (agents !== undefined) {
        let agent = agents.get(sessionId)
        let resumed = false
        if (agent === undefined) {
          const handle = await agents.resume({ resumeSessionId: sessionId })
          agent = handle.agent
          resumed = true
        }
        agent.followup(message)
        await flushQuietly(sessions, agent)
        return resumed
          ? `session ${sessionId} was resumed (agent restarted) and the completion receipt was queued as a follow-up turn`
          : `completion receipt queued as a follow-up turn on session ${sessionId}; agent woken`
      }

      throw explicitError('neither ctx.sessionController nor ctx.agents is available; cannot wake the session')
    },
  }
}

/** 落盘确认是「尽力而为」：失败不推翻已入队的 followup，只记进回执说明。 */
async function flushQuietly(sessions: SessionStoreLike | undefined, agent: AgentLike): Promise<void> {
  if (sessions === undefined || agent.session === undefined) return
  try {
    await sessions.flush(agent.session)
  } catch { /* 入队已成立；落盘由宿主的正常持久化兜底 */ }
}
