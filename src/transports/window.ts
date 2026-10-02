/**
 * window 通道：把任务「像人一样」打进另一个 harness 的窗口，再把可见文本读回来。
 *
 * 适用对象：没有 CLI 一次性模式、也没有 CDP 调试端口的 GUI / TUI harness
 * （ZCode、MiMo、Cursor 之类）。这一档是最后兜底，代价也最明确：
 *
 *   * 输入是「真键盘」——定位窗口 → 聚焦 → 逐行 pyautogui 打字 / 贴剪贴板 → 按提交键；
 *   * 输出是「屏幕快照文本」——UIA 无障碍树或控制台缓冲区，**不是解析过的回答**；
 *   * 判完成只能靠「屏幕不再变化」，所以静止阈值 `window.settleMs` 是这一档的核心参数。
 *
 * 三条铁律：
 *   1. 读不到文本就报错，绝不编造输出（hp_helper 读空时会带 note，原样回传）；
 *   2. 文本次级一律走 `helper.type()`（ASCII 直接打、非 ASCII 走剪贴板），
 *      绝不拿 `key` 拼字符串——那是给按键名用的；
 *   3. `dispatchWindow` 永不 reject，异常折进 stopReason（与 headless 通道一致）。
 *
 * 本文件只依赖 `helper.ts` 的客户端接口与 `types.ts` 的类型，不 import 任何运行时值，
 * 因此可以被独立编译 / 单独测试。
 */
import type { HelperWindow, WindowHelper } from '../helper.js'
import type { DispatchOutcome, DispatchSpec, ReadResult, TargetConfig } from '../types.js'

/** 一屏文本的读取上限（字符）；与 config.maxScreenChars 的默认值一致。 */
const DEFAULT_SCREEN_LIMIT = 8000

/** dispatch 的轮询间隔：太密会白烧 helper 的 CPU，太疏会漏掉短暂中间态。 */
const POLL_MS = 700

/** 「可用窗口」的最小边长；抓 0x0 的隐藏/傀儡窗口没有意义。 */
const MIN_SIDE = 40

/** 一次窗口会话：attach 到的目标以及 attach 瞬间的屏幕基线。 */
export interface WindowSession {
  /** 目标注册名（`TargetConfig.name`）。 */
  readonly target: string
  readonly hwnd: number
  readonly pid: number
  readonly title: string
  readonly process: string
  /** attach 瞬间读到的屏幕文本（空串表示「窗口暂时没输出」，不代表读失败）。 */
  readonly initialText?: string
  /** attach 瞬间文本来源：`uia` / `console` / `none`。 */
  readonly initialSource?: string
  /** attach 备注：窗口是我们启动的还是复用现成的、focus 是否被系统拒绝、初始读取是否失败。 */
  readonly attachNote?: string
  /**
   * 这个窗口是不是本插件启动的。
   * 只有 `true` 时 `closeWindow` 才会真的关闭窗口 —— 附着到用户已经开着的 harness 时，
   * 关会话只应该「脱手」，绝不能把用户的窗口关掉（Electron 应用常会顺手缩到托盘）。
   */
  readonly owned?: boolean
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, Math.max(0, ms))
    signal?.addEventListener('abort', done, { once: true })
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 窗口有实际可见面积才叫可用。 */
function usable(window: HelperWindow): boolean {
  return (window.rect?.width ?? 0) > MIN_SIDE && (window.rect?.height ?? 0) > MIN_SIDE
}

function area(window: HelperWindow): number {
  return (window.rect?.width ?? 0) * (window.rect?.height ?? 0)
}

/**
 * 找到候选窗口；若唯一匹配的窗口被最小化（矩形退化），先聚焦唤醒（helper 会 SW_RESTORE）
 * 再重新测量，避免把「最小化的 GUI harness」误判成「没在运行」。
 */
async function findUsable(helper: WindowHelper, match: { title?: string; process?: string }): Promise<HelperWindow | undefined> {
  const candidates = await helper.find(match)
  const usableOne = pickWindow(candidates)
  if (usableOne !== undefined) return usableOne
  const minimized = candidates[0]
  if (minimized === undefined) return undefined
  try {
    await helper.focus(minimized.hwnd)
    await new Promise(resolve => setTimeout(resolve, 400))
  } catch {
    // 聚焦失败也继续用原始 rect 兜底
  }
  return pickWindow(await helper.find(match)) ?? { ...minimized, minimized: false }
}

/** 在一批候选里挑：前台优先，其次可用矩形面积最大（hp_helper 的 find 已按相似规则排序，这里再定一次，便于测试）。 */
function pickWindow(candidates: readonly HelperWindow[]): HelperWindow | undefined {
  const usableOnes = candidates.filter(usable)
  if (usableOnes.length === 0) return undefined
  const sorted = [...usableOnes].sort((left, right) => {
    if (left.foreground !== right.foreground) return left.foreground ? -1 : 1
    if (left.minimized !== right.minimized) return left.minimized ? 1 : -1
    return area(right) - area(left)
  })
  return sorted[0]
}

/** 目标窗口的匹配条件：只带非空字段（全空会被 helper 解释成「任意窗口」）。 */
function windowMatch(target: TargetConfig): { title?: string; process?: string } {
  const spec = target.window
  const title = spec.title.trim()
  const process = spec.process.trim()
  return {
    ...(title.length > 0 ? { title } : {}),
    ...(process.length > 0 ? { process } : {}),
  }
}

/** 判断一串命令是否「GUI 可执行文件」：裸 .exe 路径（可带引号）且没有 shell 元字符。 */
function guiExecutable(command: string): string | undefined {
  const trimmed = unquote(command.trim())
  if (!/\.exe$/i.test(trimmed)) return undefined
  if (/[&|<>^]/.test(trimmed)) return undefined
  return trimmed
}

/** 去掉 cmd 风格的外层引号。 */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  return value
}

function matchDescription(target: TargetConfig): string {
  const spec = target.window
  const parts: string[] = []
  if (spec.title.trim().length > 0) parts.push(`title '${spec.title.trim()}'`)
  if (spec.process.trim().length > 0) parts.push(`process '${spec.process.trim()}'`)
  return parts.length > 0 ? parts.join(' + ') : '(title/process 均未配置)'
}

/** 「找不到窗口」时给模型的可执行指令：说清匹配条件、为什么没起来、下一步该调什么。 */
function noWindowMessage(target: TargetConfig, waitedMs?: number): string {
  const command = target.window.launch.trim()
  const waited = waitedMs === undefined ? '' : ` after waiting ${waitedMs}ms`
  const hint = command.length > 0
    ? `call harness_open(target='${target.name}') to launch it (\`${command}\`), or start it manually and retry`
    : `start it manually and retry (target '${target.name}' has no window.launch command, so harness_open cannot launch it)`
  return `no window matching ${matchDescription(target)}${waited} — the harness is not running; ${hint}`
}

/**
 * attach 到（必要时启动）harness 窗口。
 *
 * 顺序：先在现有窗口里找（前台优先 → 面积最大）→ 找不到且 `options.launch === true`
 * 且目标配了 `window.launch` → 由 helper 拉起一个独立终端窗口再等它出现 → 仍找不到就抛错。
 * attach 成功后立即 focus，并读一次屏幕文本作为基线（供 dispatch 做 diff）。
 */
export async function openWindow(
  helper: WindowHelper,
  target: TargetConfig,
  options: { cwd?: string; launch?: boolean; timeoutMs?: number },
): Promise<WindowSession> {
  const spec = target.window
  const match = windowMatch(target)
  if (match.title === undefined && match.process === undefined) {
    // 全空匹配 = find 返回「全部窗口」，会误attach到用户当前的前台窗口并往里面打字；宁可报错。
    throw new Error(
      `target '${target.name}' has neither window.title nor window.process configured — refusing to attach to an arbitrary window; `
      + 'set window.title (substring or /regex/) and/or window.process in the profile config',
    )
  }
  const appearTimeoutMs = Math.max(1000, options.timeoutMs ?? spec.appearTimeoutMs ?? 20000)

  let found = await findUsable(helper, match)
  let launchedByUs = false
  const notes: string[] = []
  if (found === undefined && options.launch === true) {
    const configured = spec.launch.trim()
    // GUI harness（Electron/IDE）没有终端窗口：window.launch 可留空，直接用 target.command 作为可执行文件拉起。
    const command = configured.length > 0 ? configured : (guiExecutable(target.command) ? target.command.trim() : '')
    if (command.length === 0) throw new Error(noWindowMessage(target))
    const gui = guiExecutable(command) !== undefined
    const launchTitle = `HP:${target.name}`
    const launched = await helper.launch({
      command: gui ? unquote(command) : command,
      mode: gui ? 'gui' : 'terminal',
      ...(gui ? {} : { title: launchTitle }),
      ...(options.cwd !== undefined && options.cwd.length > 0 ? { cwd: options.cwd } : {}),
      waitMs: appearTimeoutMs,
    })
    notes.push(`launched \`${command}\` (mode=${gui ? 'gui' : 'terminal'}, host=${launched.host}, pid=${launched.pid}${gui ? '' : `, title=${launchTitle}`})`)
    launchedByUs = true
    if (launched.window !== null && usable(launched.window)) {
      found = launched.window
    } else {
      found = pickWindow(await helper.find(match))
      if (found === undefined) found = await helper.waitForWindow(match, appearTimeoutMs)
      // 兜底：终端模式下 launch 出来的进程是 wt.exe / conhost.exe，未必匹配 target.window.process；
      // 但窗口标题是我们自己起的 `HP:<name>`，认它一定是对的。
      if (found === undefined && !gui) found = await helper.waitForWindow({ title: launchTitle }, 4000)
      if (found === undefined) {
        throw new Error(`no window matching ${matchDescription(target)} appeared within ${appearTimeoutMs}ms ${notes.join('; ')}`)
      }
    }
  }
  if (found === undefined) throw new Error(noWindowMessage(target, appearTimeoutMs))

  const session: WindowSession = {
    target: target.name,
    hwnd: found.hwnd,
    pid: found.pid,
    title: found.title,
    process: found.process,
    owned: launchedByUs,
  }

  try {
    const focused = await helper.focus(session.hwnd)
    if (!focused.focused) notes.push(`focus(hwnd=${session.hwnd}) was refused by the foreground-lock policy — keystrokes may land in the wrong window`)
  } catch (error: unknown) {
    notes.push(`focus(hwnd=${session.hwnd}) failed: ${errorText(error)}`)
  }

  let initialText: string | undefined
  let initialSource: string | undefined
  try {
    const snapshot = await helper.text(session.hwnd, { pid: session.pid, mode: 'auto', limit: DEFAULT_SCREEN_LIMIT })
    initialText = snapshot.text
    initialSource = snapshot.source
    if (snapshot.note !== undefined && snapshot.note.length > 0) notes.push(snapshot.note)
  } catch (error: unknown) {
    notes.push(`initial screen read failed: ${errorText(error)}`)
  }

  return {
    ...session,
    ...(initialText !== undefined ? { initialText } : {}),
    ...(initialSource !== undefined ? { initialSource } : {}),
    ...(notes.length > 0 ? { attachNote: notes.join('; ') } : {}),
  }
}

/** 读一屏可见文本；source 原样透传（uia / console / none），helper 的 note 作为 diagnostic。 */
export async function readWindow(
  helper: WindowHelper,
  session: WindowSession,
  options: { limit: number; mode?: 'auto' | 'uia' | 'console' },
): Promise<ReadResult> {
  const reply = await helper.text(session.hwnd, {
    pid: session.pid,
    mode: options.mode ?? 'auto',
    limit: options.limit,
  })
  return {
    text: reply.text,
    source: reply.source,
    ...(reply.note !== undefined && reply.note.length > 0 ? { diagnostic: reply.note } : {}),
  }
}

/**
 * 目标窗口现在是不是前台？`true` 是、`false` 不是、`undefined` 是「探测不到」（那就别拦）。
 * 用 cmd=info 里的 foreground 字段（hp_helper 的 GetForegroundWindow 快照）。
 */
async function foregroundState(helper: WindowHelper, hwnd: number): Promise<boolean | undefined> {
  try {
    const reply = await helper.call('info', {}, 15000)
    const foreground = reply.foreground
    if (foreground === null || foreground === undefined || typeof foreground !== 'object') return undefined
    const value = (foreground as { hwnd?: unknown }).hwnd
    return typeof value === 'number' ? value === hwnd : undefined
  } catch {
    return undefined
  }
}

/** 前台窗口是谁（用于把「焦点被谁抢了」写进报错里）。 */
async function foregroundName(helper: WindowHelper): Promise<string> {
  try {
    const reply = await helper.call('info', {}, 15000)
    const foreground = reply.foreground
    if (foreground === null || foreground === undefined || typeof foreground !== 'object') return ''
    const value = foreground as { title?: unknown; process?: unknown }
    const title = typeof value.title === 'string' ? value.title : ''
    const process = typeof value.process === 'string' ? value.process : ''
    if (title.length === 0 && process.length === 0) return ''
    return `'${title}' (${process})`
  } catch {
    return ''
  }
}

/**
 * 打字前的安全闸：键盘注入是「进前台窗口」的，目标窗口不在前台就会打进别人的窗口
 * （实测这台机器上会被浏览器/别的自动化抢走焦点）。这里再确认一次，
 * 仍然不在前台就直接报错 —— 宁可失败，也不往用户的窗口里打字。
 */
async function ensureForeground(helper: WindowHelper, session: WindowSession): Promise<void> {
  if (await foregroundState(helper, session.hwnd) !== false) return
  try {
    await helper.focus(session.hwnd)
  } catch {
    // 下面统一判定
  }
  if (await foregroundState(helper, session.hwnd) !== false) return
  const who = await foregroundName(helper)
  throw new Error(
    `refusing to type: window '${session.title}' (hwnd=${session.hwnd}, process=${session.process}) is not in the foreground`
    + `${who.length > 0 ? ` — ${who} holds it` : ''}; keystrokes would land in the wrong window. `
    + 'Bring the harness window to the front (or retry when the desktop is idle) and dispatch again.',
  )
}

/**
 * 把一段 prompt 打进窗口：先聚焦，然后逐行 `helper.type()`，
 * 换行用 `window.newlineKeys`（很多 TUI 里回车 = 提交，所以换行要另配键），
 * 最后按 `window.submitKeys` 提交。返回一句给模型看的人话备注。
 *
 * 注意：聚焦失败会直接抛错（见 ensureForeground）——盲打进前台窗口比失败危险得多。
 */
export async function sendToWindow(
  helper: WindowHelper,
  target: TargetConfig,
  session: WindowSession,
  input: { text?: string; submit?: boolean },
): Promise<{ note: string }> {
  const spec = target.window
  const notes: string[] = []
  try {
    const focused = await helper.focus(session.hwnd)
    if (!focused.focused) notes.push('focus was refused by the foreground-lock policy')
  } catch (error: unknown) {
    notes.push(`focus failed: ${errorText(error)}`)
  }
  await ensureForeground(helper, session)

  // 有些 GUI harness 的聊天输入框默认没有焦点：先按它自己的快捷键把输入框叫出来
  // （ZCode 是 ctrl+n 新建任务）。这一步必须在打字之前、且与打字同一次调用里做，
  // 否则中间任何一次外部操作都可能把焦点带走。
  const openInputKeys = spec.openInputKeys.filter(key => key.trim().length > 0)
  let openedViaKeys = false
  if (openInputKeys.length > 0 && (input.text ?? '').length > 0) {
    try {
      await helper.key(openInputKeys)
      notes.push(`pressed ${openInputKeys.join('+')} to open the input`)
      openedViaKeys = true
      await new Promise(resolve => setTimeout(resolve, 1200))
      await ensureForeground(helper, session)
    } catch (error: unknown) {
      notes.push(`openInputKeys failed: ${errorText(error)}`)
    }
  }
  // GUI harness（Electron / IDE）的光标默认不在聊天输入框里：先用 UIA 找到输入框并点中它，
  // 再粘贴文本。终端 harness 没有 Edit 控件，这里会 found:false，退化成原来的「直接打字」。
  let inputElement: { ct: string; name: string; aid: string; rect: number[] } | undefined
  if (openedViaKeys) {
    // 已经用快捷键把输入框叫出来了，这时再点 UIA 元素只会把焦点打散。
    notes.push('skipped the UIA input click because the input was opened with keys')
  } else {
    try {
      const located = await helper.focusInput(session.hwnd)
      if (located.found && located.element !== undefined) {
        inputElement = located.element
        notes.push(
          `clicked input <${located.element.ct}${located.element.name.length > 0 ? ` "${located.element.name.slice(0, 40)}"` : ''}>`
          + ` at ${located.clicked === undefined ? '?' : `${located.clicked.x},${located.clicked.y}`}`,
        )
      } else {
        notes.push(`no UIA input element found (${located.reason ?? 'unknown'}); typing into the focused window`)
      }
    } catch (error: unknown) {
      notes.push(`input locate failed: ${errorText(error)}`)
    }
  }
  await ensureForeground(helper, session)

  const text = input.text ?? ''
  if (text.length > 0) {
    const lines = text.split(/\r?\n/)
    // 空数组会让 hp_helper 直接报错（它要求 keys 非空）；此时只能贴成一行并明确告诉调用方。
    const newlineKeys = spec.newlineKeys.filter(key => key.trim().length > 0)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      if (line.length > 0) await helper.type(line)
      if (index < lines.length - 1) {
        if (newlineKeys.length === 0) {
          notes.push('window.newlineKeys is empty — line breaks were not sent')
          continue
        }
        await helper.key(newlineKeys)
      }
    }
  }

  const submit = input.submit !== false
  const submitKeys = spec.submitKeys.filter(key => key.trim().length > 0)
  let submitted = false
  if (submit) {
    if (submitKeys.length === 0) {
      notes.push('window.submitKeys is empty — nothing was pressed to submit')
    } else {
      await helper.key(submitKeys)
      submitted = true
    }
  }

  const lines = text.length > 0 ? text.split(/\r?\n/).length : 0
  const actions = [`typed ${text.length} chars in ${lines} line(s)`, submitted ? `pressed ${submitKeys.join('+')}` : 'not submitted']
  const head = `${actions.join(', ')} into window '${session.title}' (hwnd=${session.hwnd}, process=${session.process})`
  return { note: notes.length > 0 ? `${head} [${notes.join('; ')}]` : head }
}

/** 关窗：helper 只是 PostMessage(WM_CLOSE)；窗口早已消失不算失败。 */
export async function closeWindow(helper: WindowHelper, session: WindowSession): Promise<void> {
  // 只关「本插件启动的」窗口。附着到用户已开着的 harness 时，关会话 = 脱手，
  // 绝不能 WM_CLOSE（Electron 应用往往顺手缩进托盘，等于替用户关了窗口）。
  if (session.owned !== true) return
  try {
    await helper.close(session.hwnd)
  } catch {
    // 窗口已经关了 / 句柄失效 —— 目标状态已达成，忽略。
  }
}

/** 屏幕增量（尽力而为地喂给 onProgress）：只报新出现的行，避免把整屏反复推给模型。 */
function screenDelta(previous: string, next: string, limit = 1200): string {
  const before = new Set(previous.split(/\r?\n/))
  const fresh = next.split(/\r?\n/).filter(line => line.trim().length > 0 && !before.has(line))
  if (fresh.length === 0) return ''
  const body = fresh.join('\n')
  return body.length > limit ? `${body.slice(0, limit)}…` : body
}

/**
 * 一次性窗口派发：打字 → 轮询读屏 → 「文本相对基线变了，且此后 byte-identical 持续 settleMs」即认为答完。
 *
 * 返回的 text 是**完整的最终屏幕文本**（窗口通道没有「解析后的回答」这回事），
 * diagnostic 会明确说明这一点。永不 reject。
 */
export async function dispatchWindow(
  helper: WindowHelper,
  spec: DispatchSpec,
  options: { session?: WindowSession; launch?: boolean },
): Promise<DispatchOutcome> {
  const started = Date.now()
  const settleMs = Math.max(200, spec.target.window.settleMs ?? 0)
  const limit = DEFAULT_SCREEN_LIMIT
  let session = options.session
  const launchNote: string[] = []

  try {
    if (spec.signal.aborted) {
      return {
        transport: 'window',
        text: '',
        diagnostic: 'cancelled by caller before the prompt was sent',
        stopReason: 'aborted',
      }
    }

    if (session === undefined) {
      session = await openWindow(helper, spec.target, {
        cwd: spec.cwd,
        launch: options.launch === true,
        // 等窗口出现不能吃掉全部预算：两者取小。
        timeoutMs: Math.max(1000, Math.min(spec.timeoutMs, spec.target.window.appearTimeoutMs || 20000)),
      })
      if (session.attachNote !== undefined) launchNote.push(session.attachNote)
    }
    const attached = session

    const sent = await sendToWindow(helper, spec.target, attached, { text: spec.prompt, submit: true })
    spec.onProgress?.(`[window] ${sent.note}\n`)

    // 基线 = attach 时读到的屏幕（没读到就现读一次，保证 diff 有意义）。
    let baseline = attached.initialText
    if (baseline === undefined) {
      try {
        baseline = (await readWindow(helper, attached, { limit })).text
      } catch (error: unknown) {
        launchNote.push(`baseline read failed: ${errorText(error)}`)
        baseline = ''
      }
    }

    const deadline = started + Math.max(1000, spec.timeoutMs)
    let last = baseline
    let latest: ReadResult | undefined
    let changed = false
    let stableSince = Date.now()
    let polls = 0
    let readError = ''
    let consecutiveFailures = 0
    let settled = false
    let timedOut = false

    for (;;) {
      if (spec.signal.aborted) break
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        break
      }
      await sleep(Math.min(POLL_MS, remaining), spec.signal)
      if (spec.signal.aborted) break
      polls += 1

      let current: ReadResult
      try {
        current = await readWindow(helper, attached, { limit })
        consecutiveFailures = 0
      } catch (error: unknown) {
        readError = errorText(error)
        consecutiveFailures += 1
        // 一次都没读成功过（助手挂了，或 helper 的 console 分支抛异常）就别耗满整个 timeout：
        // 连续 3 次失败且已过 3s，直接报错返回，省得调用方白等。
        if (latest === undefined && consecutiveFailures >= 3 && Date.now() - started > 3000) {
          return {
            transport: 'window',
            text: '',
            diagnostic: `every screen read from window '${attached.title}' failed: ${readError}`,
            stopReason: 'error',
            facts: {
              target: attached.target,
              hwnd: attached.hwnd,
              pid: attached.pid,
              process: attached.process,
              title: attached.title,
              polls,
              durationMs: Date.now() - started,
            },
          }
        }
        continue
      }
      latest = current
      const now = Date.now()
      if (current.text !== last) {
        const delta = screenDelta(last, current.text)
        last = current.text
        // 「变了」必须是变成了**有内容**的屏：空屏不算回答。
        if (current.text !== baseline && current.text.trim().length > 0) changed = true
        stableSince = now
        if (delta.length > 0) spec.onProgress?.(`[window] screen updated:\n${delta}\n`)
      } else if (changed && now - stableSince >= settleMs) {
        settled = true
        break
      }
    }

    const text = last
    const source = latest?.source ?? attached.initialSource ?? 'none'
    const helperNote = latest?.diagnostic
    const facts: Record<string, string | number | boolean | undefined> = {
      target: attached.target,
      hwnd: attached.hwnd,
      pid: attached.pid,
      process: attached.process,
      title: attached.title,
      source,
      settleMs,
      polls,
      chars: text.length,
      durationMs: Date.now() - started,
    }

    // 读不到文本：原样回传 helper 的 note，绝不用「空回答」冒充成功。
    if (text.trim().length === 0) {
      const reason = helperNote ?? readError
      if (reason.length > 0) {
        return {
          transport: 'window',
          text: '',
          diagnostic: timedOut
            ? `no readable text in window '${attached.title}' before the ${spec.timeoutMs}ms timeout: ${reason}`
            : `no readable text in window '${attached.title}': ${reason}`,
          stopReason: 'error',
          facts,
        }
      }
      if (readError.length > 0) {
        return {
          transport: 'window',
          text: '',
          diagnostic: `every screen read failed: ${readError}`,
          stopReason: 'error',
          facts,
        }
      }
    }

    const snapshot = `screen snapshot from window '${attached.title}' (source=${source}); this is the harness's visible text, not a parsed reply`
    const details = [snapshot]
    if (launchNote.length > 0) details.push(launchNote.join('; '))
    if (helperNote !== undefined && helperNote.length > 0) details.push(helperNote)

    if (spec.signal.aborted) {
      return {
        transport: 'window',
        text,
        diagnostic: `cancelled by caller after ${Date.now() - started}ms; ${details.join('; ')}`,
        stopReason: 'aborted',
        facts,
      }
    }
    if (timedOut) {
      return {
        transport: 'window',
        text,
        diagnostic: `${details.join('; ')}; the screen never stayed unchanged for ${settleMs}ms within ${spec.timeoutMs}ms`,
        stopReason: 'timeout',
        facts,
      }
    }
    if (!settled) {
      return {
        transport: 'window',
        text,
        diagnostic: `${details.join('; ')}; the loop exited without a settled screen`,
        stopReason: 'error',
        facts,
      }
    }
    return {
      transport: 'window',
      text,
      diagnostic: `${details.join('; ')}; settled after ${settleMs}ms of no change`,
      stopReason: 'completed',
      facts,
    }
  } catch (error: unknown) {
    return {
      transport: 'window',
      text: '',
      diagnostic: errorText(error),
      stopReason: 'error',
      facts: {
        target: spec.target.name,
        ...(options.session !== undefined ? { hwnd: options.session.hwnd } : {}),
        durationMs: Date.now() - started,
      },
    }
  }
}
