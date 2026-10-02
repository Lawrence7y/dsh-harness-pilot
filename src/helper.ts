/**
 * 窗口助手客户端：常驻 python 子进程（python/hp_helper.py）的 NDJSON 客户端。
 *
 * 为什么用常驻进程：每次动作都要 import pyautogui / uiautomation（约 1s），
 * 常驻后单次调用降到毫秒级；进程崩了会自动重启并重试一次。
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface HelperWindow {
  hwnd: number
  pid: number
  title: string
  class: string
  process: string
  exe: string
  rect: { x: number; y: number; width: number; height: number } | null
  minimized: boolean
  visible: boolean
  foreground: boolean
}

interface HelperReply {
  ok: boolean
  error?: string
  [key: string]: unknown
}

function helperScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'hp_helper.py')
}

function pythonCandidates(configured: string): string[] {
  const candidates: string[] = []
  const trimmed = configured.trim()
  if (trimmed.length > 0) candidates.push(trimmed)
  try {
    const where = spawnSync('where.exe', ['python'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    for (const line of `${where.stdout ?? ''}`.split(/\r?\n/)) {
      const path = line.trim()
      if (path.length > 0) candidates.push(path)
    }
  } catch {
    // where.exe 不存在时忽略
  }
  candidates.push('python', 'py', 'python3')
  return [...new Set(candidates)]
}

export class WindowHelper {
  private child: ChildProcessWithoutNullStreams | null = null
  private sequence = 0
  private readonly waiting = new Map<number, (reply: HelperReply) => void>()
  private startPromise: Promise<HelperReply> | null = null
  private hello: HelperReply | null = null
  private lastError = ''

  constructor(private readonly pythonPath: string) {}

  info(): HelperReply | null {
    return this.hello
  }

  private start(): Promise<HelperReply> {
    const script = helperScriptPath()
    const failures: string[] = []
    for (const python of pythonCandidates(this.pythonPath)) {
      const probe = spawnSync(python, ['-c', 'import pyautogui, uiautomation, win32gui, PIL'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 40000,
      })
      if (probe.error !== undefined || probe.status !== 0) {
        const detail = probe.error?.message ?? `${String(probe.stderr ?? '').trim().slice(0, 200)}`
        failures.push(`${python}: exit ${String(probe.status)} ${detail}`)
        continue
      }
      const child = spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcessWithoutNullStreams
      const hello = new Promise<HelperReply>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('window helper did not announce itself within 30s')), 30000)
        const reader = createInterface({ input: child.stdout })
        reader.on('line', (line: string) => {
          let message: HelperReply
          try {
            message = JSON.parse(line) as HelperReply
          } catch {
            return
          }
          const id = message.id as number | undefined
          if (id !== undefined && this.waiting.has(id)) {
            const settle = this.waiting.get(id)!
            this.waiting.delete(id)
            settle(message)
            return
          }
          if (message.hello !== undefined) {
            this.hello = message
            clearTimeout(timer)
            resolve(message)
          }
        })
      })
      child.stderr.on('data', (chunk: Buffer) => {
        this.lastError = chunk.toString('utf8').slice(0, 400)
      })
      child.on('exit', () => {
        if (this.child === child) {
          this.child = null
          this.hello = null
        }
        for (const [id, settle] of this.waiting) {
          this.waiting.delete(id)
          settle({ ok: false, error: `window helper exited unexpectedly${this.lastError ? `: ${this.lastError}` : ''}` })
        }
      })
      this.child = child
      return hello
    }
    return Promise.reject(new Error(
      'cannot start the window helper: no python interpreter with pyautogui + uiautomation + pywin32 + Pillow was found ('
      + `${failures.join('; ')}). Install them (pip install pyautogui uiautomation pywin32 pillow) or set config.pythonPath.`,
    ))
  }

  async ensure(): Promise<HelperReply> {
    if (this.child !== null && this.hello !== null) return this.hello
    if (this.startPromise === null) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null
      })
    }
    return await this.startPromise
  }

  /** 已启动则为 true；用于能力探测而不触发启动副作用。 */
  get running(): boolean {
    return this.child !== null && this.hello !== null
  }

  async call(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<HelperReply> {
    await this.ensure()
    const child = this.child
    if (child === null || child.stdin.destroyed) throw new Error('window helper is not running')
    const id = ++this.sequence
    return await new Promise<HelperReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`window helper timed out after ${timeoutMs}ms (cmd=${cmd})`))
      }, timeoutMs)
      this.waiting.set(id, (reply) => {
        clearTimeout(timer)
        if (reply.ok) resolve(reply)
        else reject(new Error(String(reply.error ?? `window helper failed (cmd=${cmd})`)))
      })
      child.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`)
    })
  }

  async windows(includeInvisible = false): Promise<HelperWindow[]> {
    const reply = await this.call('windows', { include_invisible: includeInvisible }, 30000)
    return (reply.windows ?? []) as HelperWindow[]
  }

  async find(match: { title?: string; process?: string; pid?: number }, timeoutMs = 20000): Promise<HelperWindow[]> {
    const reply = await this.call('find', {
      ...(match.title ? { title: match.title } : {}),
      ...(match.process ? { process: match.process } : {}),
      ...(match.pid !== undefined ? { pid: match.pid } : {}),
    }, timeoutMs)
    return (reply.windows ?? []) as HelperWindow[]
  }

  /** 轮询等待窗口出现（带面积门槛，避免抓到 0x0 的隐藏窗口）。 */
  async waitForWindow(
    match: { title?: string; process?: string; pid?: number },
    timeoutMs = 20000,
  ): Promise<HelperWindow | undefined> {
    const deadline = Date.now() + Math.max(500, timeoutMs)
    for (;;) {
      const found = await this.find(match, Math.max(2000, Math.min(8000, deadline - Date.now())))
      const usable = found.find(window => (window.rect?.width ?? 0) > 40 && (window.rect?.height ?? 0) > 40)
      if (usable !== undefined) return usable
      if (Date.now() >= deadline) return undefined
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }

  async focus(hwnd: number): Promise<{ focused: boolean }> {
    const reply = await this.call('focus', { hwnd }, 20000)
    return { focused: Boolean(reply.focused) }
  }

  async text(hwnd: number, options: { pid?: number; mode?: 'auto' | 'uia' | 'console'; limit?: number } = {}): Promise<{ text: string; source: string; note?: string }> {
    const reply = await this.call('text', {
      hwnd,
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    }, 45000)
    return { text: String(reply.text ?? ''), source: String(reply.source ?? 'none'), ...(reply.note !== undefined ? { note: String(reply.note) } : {}) }
  }

  async shot(path: string, options: { hwnd?: number; region?: [number, number, number, number]; maxWidth?: number } = {}): Promise<{ path: string; width: number; height: number; region: unknown }> {
    const reply = await this.call('shot', {
      path,
      ...(options.hwnd !== undefined ? { hwnd: options.hwnd } : {}),
      ...(options.region !== undefined ? { region: options.region } : {}),
      ...(options.maxWidth !== undefined ? { max_width: options.maxWidth } : {}),
    }, 45000)
    return { path: String(reply.path), width: Number(reply.width), height: Number(reply.height), region: reply.region }
  }

  async type(text: string): Promise<void> {
    await this.call('type', { text }, 120000)
  }

  async key(keys: string | string[], repeats = 1): Promise<void> {
    await this.call('key', { keys, repeats }, 30000)
  }

  async click(x: number, y: number, options: { button?: string; clicks?: number } = {}): Promise<void> {
    await this.call('click', { x, y, ...options }, 30000)
  }

  async launch(spec: { command: string; mode?: 'terminal' | 'gui'; title?: string; cwd?: string; waitMs?: number }): Promise<{ pid: number; host: string; window: HelperWindow | null }> {
    const reply = await this.call('launch', {
      command: spec.command,
      mode: spec.mode ?? 'terminal',
      ...(spec.title !== undefined ? { title: spec.title } : {}),
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(spec.waitMs !== undefined ? { wait_ms: spec.waitMs } : {}),
    }, Math.max(30000, (spec.waitMs ?? 20000) + 15000))
    return { pid: Number(reply.pid), host: String(reply.host ?? ''), window: (reply.window ?? null) as HelperWindow | null }
  }

  async close(hwnd: number): Promise<void> {
    await this.call('close', { hwnd }, 15000)
  }

  /** 定位并点中窗口里的输入框；找不到返回 found:false（不算错误，调用方退化到直接打字）。 */
  async focusInput(hwnd: number, options: { name?: string; settleMs?: number } = {}): Promise<{
    found: boolean
    element?: { ct: string; name: string; aid: string; rect: number[] }
    clicked?: { x: number; y: number }
    reason?: string
  }> {
    const reply = await this.call('input', {
      hwnd,
      ...(options.name !== undefined && options.name.length > 0 ? { name: options.name } : {}),
      ...(options.settleMs !== undefined ? { settle_ms: options.settleMs } : {}),
    }, 30000)
    return {
      found: Boolean(reply.found),
      ...(reply.element !== undefined ? { element: reply.element as { ct: string; name: string; aid: string; rect: number[] } } : {}),
      ...(reply.clicked !== undefined ? { clicked: reply.clicked as { x: number; y: number } } : {}),
      ...(reply.reason !== undefined ? { reason: String(reply.reason) } : {}),
    }
  }

  /** 按可见名字点击窗口内元素（UIA）：打开面板、点「新建任务」这类按钮。 */
  async clickByName(hwnd: number, name: string, options: { kind?: string; settleMs?: number } = {}): Promise<{
    found: boolean
    element?: { ct: string; name: string; rect: number[] }
    clicked?: { x: number; y: number }
    reason?: string
    alternatives?: string[]
  }> {
    const reply = await this.call('click_name', {
      hwnd,
      name,
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.settleMs !== undefined ? { settle_ms: options.settleMs } : {}),
    }, 45000)
    return {
      found: Boolean(reply.found),
      ...(reply.element !== undefined ? { element: reply.element as { ct: string; name: string; rect: number[] } } : {}),
      ...(reply.clicked !== undefined ? { clicked: reply.clicked as { x: number; y: number } } : {}),
      ...(reply.reason !== undefined ? { reason: String(reply.reason) } : {}),
      ...(reply.alternatives !== undefined ? { alternatives: reply.alternatives as string[] } : {}),
    }
  }

  /** 列出窗口内的可交互元素（诊断用；失败不抛错）。 */
  async elements(hwnd: number, options: { kind?: 'all' | 'input' | 'interactive'; limit?: number } = {}): Promise<unknown[]> {
    const reply = await this.call('elements', {
      hwnd,
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    }, 45000)
    return (reply.selected ?? []) as unknown[]
  }

  dispose(): void {
    const child = this.child
    this.child = null
    this.hello = null
    if (child !== null) {
      try {
        child.stdin.end()
      } catch {
        // 已关闭
      }
      try {
        child.kill()
      } catch {
        // 已退出
      }
    }
  }
}
