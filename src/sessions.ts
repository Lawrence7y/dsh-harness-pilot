/**
 * 会话编排层：把「一个目标 + 一条任务」按通道梯子送出去，并管理长期交互会话。
 *
 * 通道是**懒加载**的：某个通道的依赖在这台机器上不存在（没装 python、没装 SDK、
 * 没有 ConPTY）时，插件仍然能正常加载，只是那一档自动跳过 —— 这也是为什么
 * 这里用运行时 import 而不是顶层 import。
 */
import { randomUUID } from 'node:crypto'
import type { WindowHelper } from './helper.js'
import { probeCommand } from './launcher.js'
import { dispatchHeadless } from './transports/headless.js'
import { dispatchPty, probePty, PtySession, type SpawnTerminal } from './transports/pty.js'
import type { DispatchOutcome, DispatchSpec, ReadResult, TargetConfig, TransportKind } from './types.js'
import { findTarget, type ResolvedConfig } from './config.js'
import { listDshModels, listHarnessModels, type DshProviderModels } from './models.js'

/** 通道模块的最小结构契约（模块由子代理实现，这里只依赖契约）。 */
interface AcpModule {
  probeAcp(target: TargetConfig): { available: boolean; detail?: string }
  dispatchAcp(spec: DispatchSpec): Promise<DispatchOutcome>
}
interface CdpSessionLike {
  readonly port: number
  readonly pageId: string
  read(options: { limit: number }): Promise<ReadResult>
  send(input: { text: string; submit?: boolean }): Promise<{ note: string }>
  /** 原始 JS 求值逃生口（CDP 会话有；其他通道没有）。 */
  evaluate?(expression: string): Promise<unknown>
  /** 真实 CDP 鼠标事件（CDP 会话有；合成事件点不开 Radix 菜单，还会卡死 ZCode）。 */
  mouse?(action: 'click' | 'move', x: number, y: number): Promise<void>
  close(): Promise<void>
}
interface CdpModule {
  probeCdpTarget(target: TargetConfig, port: number): Promise<{ available: boolean; detail: string }>
  openCdp(target: TargetConfig, options: { cwd?: string; launch?: boolean; portBase: number; timeoutMs?: number }): Promise<CdpSessionLike>
  dispatchCdp(spec: DispatchSpec, options: { launch?: boolean; portBase?: number }): Promise<DispatchOutcome>
}
interface WindowSessionLike {
  readonly hwnd: number
  readonly pid: number
  readonly title: string
  readonly process: string
}
interface WindowModule {
  openWindow(helper: WindowHelper, target: TargetConfig, options: { cwd?: string; launch?: boolean; timeoutMs?: number }): Promise<WindowSessionLike>
  readWindow(helper: WindowHelper, session: WindowSessionLike, options: { limit: number; mode?: 'auto' | 'uia' | 'console' }): Promise<ReadResult>
  sendToWindow(helper: WindowHelper, target: TargetConfig, session: WindowSessionLike, input: { text?: string; submit?: boolean }): Promise<{ note: string }>
  closeWindow(helper: WindowHelper, session: WindowSessionLike): Promise<void>
  dispatchWindow(helper: WindowHelper, spec: DispatchSpec, options: { session?: WindowSessionLike; launch?: boolean }): Promise<DispatchOutcome>
}

const ALL_TRANSPORTS: readonly TransportKind[] = ['acp', 'headless', 'pty', 'cdp', 'window']

/** 长期存活的交互式会话（窗口 / CDP / pty）。 */
export interface InteractiveSession {
  readonly id: string
  readonly target: TargetConfig
  readonly transport: TransportKind
  readonly detail: string
  read(options: { limit: number; mode?: 'auto' | 'uia' | 'console' }): Promise<ReadResult>
  send(input: { text?: string; submit?: boolean }): Promise<{ note: string }>
  /** 只有 CDP 会话能求值页面 JS（用于按文字点按钮、打开面板）。 */
  evaluate?(expression: string): Promise<unknown>
  /** 只有 CDP 会话能派发真实鼠标事件（某些 GUI 的菜单只认真实 pointerdown）。 */
  mouse?(action: 'click' | 'move', x: number, y: number): Promise<void>
  /** 窗口会话：按可见名字点 UIA 元素（GUI harness 打开面板/新建任务）。 */
  clickElement?(name: string): Promise<{ found: boolean; detail: string }>
  close(): Promise<void>
  readonly summary: LiveSessionSummary
}

export interface LiveSessionSummary {
  readonly id: string
  readonly target: string
  readonly transport: TransportKind
  readonly detail: string
  readonly openedAt: number
  readonly closed: boolean
}

export interface SessionDeps {
  readonly config: ResolvedConfig
  readonly helper: WindowHelper
  /** 宿主 `ctx.subprocess.spawnTerminal`；缺失时 pty 档自动跳过。 */
  readonly spawnTerminal?: SpawnTerminal
  /** 宿主 `ctx.llm`：用于读出「本 profile 已配置的供应商模型」。 */
  readonly llm?: { listProviders(): { id: string, name: string }[], listModels(provider: string): Promise<{ id: string }[]> }
  readonly log?: (level: 'info' | 'warn', message: string) => void
}

/** 单个 harness 在设置页/概览里的画像。 */
export interface TargetOverview {
  readonly name: string
  readonly description: string
  readonly transport: string
  readonly order: string[]
  readonly command: string
  readonly commandPath?: string
  readonly available: boolean
  readonly reason?: string
  /** 目标默认模型（ACP 会话内切换的那个）或空。 */
  readonly model: string
  /** 是否支持「派发时指定模型」。 */
  readonly canSelectModel: boolean
  /** harness 自己列出的模型（仅在请求 models 时填充）。 */
  readonly models: string[]
  readonly modelsNote: string
}

export interface Overview {
  readonly plugin: { name: string, version: string }
  readonly defaultTarget: string
  readonly targets: TargetOverview[]
  readonly sessions: LiveSessionSummary[]
  readonly dsh: { providers: DshProviderModels[] }
  readonly generatedAt: number
}

/** 模块定位器：specifier 是变量，TS 不会静态解析，缺失时只在运行时降级。 */
const loadModule = (specifier: string): Promise<unknown> => import(specifier)

/** 把「本次指定模型」落成目标实际使用的参数：模型参数模板 + ACP 会话内切换。 */
function withModel(target: TargetConfig, model: string | undefined): TargetConfig {
  if (model === undefined || model.trim().length === 0) return target
  const chosen = model.trim()
  const args = [...target.args]
  if (target.modelArgs.length > 0) {
    const modelArgs = target.modelArgs.map(piece => piece.replace('{model}', chosen))
    // Positional-prompt CLIs such as agy consume the argument immediately after -p as text.
    // Place model arguments before -p, leaving the prompt as the final CLI value.
    const promptIndex = args.lastIndexOf('-p')
    args.splice(promptIndex < 0 ? args.length : promptIndex, 0, ...modelArgs)
  }
  return {
    ...target,
    args,
    acpModel: chosen,
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, InteractiveSession>()
  /** harness 模型列表缓存（按目标名，避免每次起进程问）。 */
  private readonly modelCache = new Map<string, { at: number, models: string[], note: string }>()
  private readonly acpModule = { loaded: false, value: undefined as AcpModule | undefined }
  private readonly cdpModule = { loaded: false, value: undefined as CdpModule | undefined }
  private readonly windowModule = { loaded: false, value: undefined as WindowModule | undefined }
  private counter = 0

  constructor(private readonly deps: SessionDeps) {}

  private log(level: 'info' | 'warn', message: string): void {
    this.deps.log?.(level, message)
  }

  private async acp(): Promise<AcpModule | undefined> {
    if (!this.acpModule.loaded) {
      this.acpModule.loaded = true
      try {
        this.acpModule.value = (await loadModule('./transports/acp.js')) as AcpModule
      } catch (error: unknown) {
        this.log('warn', `harness-pilot: acp transport unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.acpModule.value
  }

  private async cdp(): Promise<CdpModule | undefined> {
    if (!this.cdpModule.loaded) {
      this.cdpModule.loaded = true
      try {
        this.cdpModule.value = (await loadModule('./transports/cdp.js')) as CdpModule
      } catch (error: unknown) {
        this.log('warn', `harness-pilot: cdp transport unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.cdpModule.value
  }

  private async window(): Promise<WindowModule | undefined> {
    if (!this.windowModule.loaded) {
      this.windowModule.loaded = true
      try {
        this.windowModule.value = (await loadModule('./transports/window.js')) as WindowModule
      } catch (error: unknown) {
        this.log('warn', `harness-pilot: window transport unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.windowModule.value
  }

  /** 通道预检：只判断「这一档能不能用」，不派发任务（避免失败后重复执行）。 */
  async preflight(kind: TransportKind, target: TargetConfig): Promise<{ available: boolean; detail: string }> {
    switch (kind) {
      case 'headless': {
        const probe = probeCommand(target.command)
        return { available: probe.available, detail: probe.available ? `headless: ${probe.path}` : `headless: ${probe.error ?? 'no command'}` }
      }
      case 'acp': {
        const module = await this.acp()
        if (module === undefined) return { available: false, detail: 'acp: transport module unavailable' }
        const probe = module.probeAcp(target)
        return { available: probe.available, detail: `acp: ${probe.detail ?? (probe.available ? 'ready' : 'not ready')}` }
      }
      case 'pty': {
        if (this.deps.spawnTerminal === undefined) return { available: false, detail: 'pty: host has no ctx.subprocess.spawnTerminal' }
        const probe = probePty(target)
        return { available: probe.available, detail: probe.detail ?? (probe.available ? 'pty: ready' : 'pty: not ready') }
      }
      case 'cdp': {
        const module = await this.cdp()
        if (module === undefined) return { available: false, detail: 'cdp: transport module unavailable' }
        const port = target.cdp.port > 0 ? target.cdp.port : this.deps.config.cdpPortBase
        return await module.probeCdpTarget(target, port)
      }
      case 'window': {
        const module = await this.window()
        if (module === undefined) return { available: false, detail: 'window: transport module unavailable' }
        try {
          await this.deps.helper.ensure()
        } catch (error: unknown) {
          return { available: false, detail: `window: helper unavailable (${error instanceof Error ? error.message : String(error)})` }
        }
        const match = { ...(target.window.title ? { title: target.window.title } : {}), ...(target.window.process ? { process: target.window.process } : {}) }
        const found = Object.keys(match).length > 0 ? await this.deps.helper.find(match, 15000) : []
        if (found.length > 0) return { available: true, detail: `window: attached to "${found[0]!.title}" (hwnd ${found[0]!.hwnd})` }
        if (target.window.launch.length > 0) return { available: true, detail: `window: can launch "${target.window.launch}"` }
        return { available: false, detail: `window: no window matching ${JSON.stringify(match)} and no window.launch configured` }
      }
      default:
        return { available: false, detail: `unknown transport "${kind}"` }
    }
  }

  /** 按梯子选一档并跑一次任务；失败不会自动换档重跑（避免重复执行）。 */
  async dispatch(spec: DispatchSpec, options: { transport?: string } = {}): Promise<DispatchOutcome> {
    const target = withModel(spec.target, spec.model)
    const request: DispatchSpec = target === spec.target ? spec : { ...spec, target }
    const requested = options.transport ?? target.transport
    const candidates: TransportKind[] = requested !== '' && requested !== 'auto'
      ? [requested as TransportKind]
      : (target.order.length > 0 ? target.order : ALL_TRANSPORTS)
        .filter((kind): kind is TransportKind => (ALL_TRANSPORTS as readonly string[]).includes(kind))

    const report: string[] = []
    let chosen: TransportKind | undefined
    for (const kind of candidates) {
      const check = await this.preflight(kind, target)
      report.push(`${kind}=${check.available ? 'ok' : 'skip'} (${check.detail})`)
      if (check.available) {
        chosen = kind
        break
      }
    }
    if (chosen === undefined) {
      return {
        transport: 'headless',
        text: '',
        stopReason: 'error',
        diagnostic: `no usable transport for target "${target.name}": ${report.join('; ')}`,
        facts: { ladder: report.join('; ') },
      }
    }

    const outcome = await this.run(chosen, request)
    return { ...outcome, facts: { ...outcome.facts, ladder: report.join('; ') } }
  }

  private async run(kind: TransportKind, spec: DispatchSpec): Promise<DispatchOutcome> {
    switch (kind) {
      case 'headless':
        return await dispatchHeadless(spec)
      case 'acp': {
        const module = await this.acp()
        if (module === undefined) return { transport: 'acp', text: '', stopReason: 'error', diagnostic: 'acp module unavailable' }
        return await module.dispatchAcp(spec)
      }
      case 'pty': {
        if (this.deps.spawnTerminal === undefined) return { transport: 'pty', text: '', stopReason: 'error', diagnostic: 'host has no spawnTerminal' }
        return await dispatchPty(spec, this.deps.spawnTerminal)
      }
      case 'cdp': {
        const module = await this.cdp()
        if (module === undefined) return { transport: 'cdp', text: '', stopReason: 'error', diagnostic: 'cdp module unavailable' }
        return await module.dispatchCdp(spec, { launch: true, portBase: this.deps.config.cdpPortBase })
      }
      case 'window': {
        const module = await this.window()
        if (module === undefined) return { transport: 'window', text: '', stopReason: 'error', diagnostic: 'window module unavailable' }
        return await module.dispatchWindow(this.deps.helper, spec, { launch: true })
      }
      default:
        return { transport: 'headless', text: '', stopReason: 'error', diagnostic: `unsupported transport "${kind}"` }
    }
  }

  /** 打开一个长期交互会话（GUI harness 优先 CDP，其次窗口，最后 pty）。 */
  async open(
    target: TargetConfig,
    options: { cwd: string; launch?: boolean },
  ): Promise<InteractiveSession> {
    const launch = options.launch ?? true
    const order: TransportKind[] = (target.order.length > 0 ? target.order : ALL_TRANSPORTS)
      .filter((kind): kind is TransportKind => (ALL_TRANSPORTS as readonly string[]).includes(kind))
    const attempts: string[] = []
    for (const kind of order) {
      if (kind === 'headless') continue // headless 没有会话概念
      const check = await this.preflight(kind, target)
      attempts.push(`${kind}=${check.available ? 'ok' : 'skip'} (${check.detail})`)
      if (!check.available) continue
      try {
        const session = await this.create(kind, target, { cwd: options.cwd, launch })
        if (session !== undefined) return session
      } catch (error: unknown) {
        attempts.push(`${kind}=error (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    throw new Error(`cannot open an interactive session for "${target.name}": ${attempts.join('; ')}`)
  }

  private wrapPty(session: PtySession, target: TargetConfig): InteractiveSession {
    const id = this.mintId()
    const summary: LiveSessionSummary = {
      id,
      target: target.name,
      transport: 'pty',
      detail: `pty pid ${session.pid}`,
      openedAt: Date.now(),
      closed: false,
    }
    return {
      id,
      target,
      transport: 'pty',
      detail: summary.detail,
      summary,
      read: async () => {
        const read = session.read()
        return { text: read.text, source: read.source }
      },
      send: async input => await session.send(input),
      close: async () => {
        await session.close()
      },
    }
  }

  private async create(
    kind: TransportKind,
    target: TargetConfig,
    options: { cwd: string; launch: boolean },
  ): Promise<InteractiveSession | undefined> {
    if (kind === 'pty') {
      if (this.deps.spawnTerminal === undefined) return undefined
      const session = await PtySession.open(target, { cwd: options.cwd, spawnTerminal: this.deps.spawnTerminal })
      const wrapped = this.wrapPty(session, target)
      this.sessions.set(wrapped.id, wrapped)
      return wrapped
    }
    if (kind === 'cdp') {
      const module = await this.cdp()
      if (module === undefined) return undefined
      const session = await module.openCdp(target, { cwd: options.cwd, launch: options.launch, portBase: this.deps.config.cdpPortBase })
      const id = this.mintId()
      const summary: LiveSessionSummary = {
        id,
        target: target.name,
        transport: 'cdp',
        detail: `cdp port ${session.port} page ${session.pageId}`,
        openedAt: Date.now(),
        closed: false,
      }
      const wrapped: InteractiveSession = {
        id,
        target,
        transport: 'cdp',
        detail: summary.detail,
        summary,
        read: async ({ limit }) => await session.read({ limit }),
        send: async input => await session.send({ text: input.text ?? '', submit: input.submit }),
        ...(session.evaluate === undefined
          ? {}
          : { evaluate: async (expression: string) => await session.evaluate!(expression) }),
        ...(session.mouse === undefined
          ? {}
          : { mouse: async (action: 'click' | 'move', x: number, y: number) => await session.mouse!(action, x, y) }),
        close: async () => {
          await session.close()
        },
      }
      this.sessions.set(id, wrapped)
      return wrapped
    }
    if (kind === 'window') {
      const module = await this.window()
      if (module === undefined) return undefined
      const session = await module.openWindow(this.deps.helper, target, { cwd: options.cwd, launch: options.launch, timeoutMs: target.window.appearTimeoutMs })
      const id = this.mintId()
      const summary: LiveSessionSummary = {
        id,
        target: target.name,
        transport: 'window',
        detail: `window "${session.title}" (hwnd ${session.hwnd}, pid ${session.pid})`,
        openedAt: Date.now(),
        closed: false,
      }
      const wrapped: InteractiveSession = {
        id,
        target,
        transport: 'window',
        detail: summary.detail,
        summary,
        read: async ({ limit, mode }) => await module.readWindow(this.deps.helper, session, { limit, ...(mode === undefined ? {} : { mode }) }),
        send: async input => await module.sendToWindow(this.deps.helper, target, session, { text: input.text, submit: input.submit }),
        clickElement: async (name: string) => {
          const result = await this.deps.helper.clickByName(session.hwnd, name)
          const detail = result.found
            ? `clicked <${result.element?.ct ?? '?'} "${result.element?.name ?? ''}"> at ${result.clicked?.x ?? '?'},${result.clicked?.y ?? '?'}`
            : `no UIA element matched "${name}"${result.alternatives !== undefined && result.alternatives.length > 0 ? `; near misses: ${result.alternatives.join(' | ')}` : ''}`
          return { found: result.found, detail }
        },
        close: async () => {
          await module.closeWindow(this.deps.helper, session)
        },
      }
      this.sessions.set(id, wrapped)
      return wrapped
    }
    return undefined
  }

  private mintId(): string {
    this.counter += 1
    return `hp-${this.counter}-${randomUUID().slice(0, 8)}`
  }

  list(): LiveSessionSummary[] {
    return [...this.sessions.values()].map(session => session.summary)
  }

  get(id: string): InteractiveSession | undefined {
    return this.sessions.get(id)
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (session === undefined) return false
    this.sessions.delete(id)
    try {
      await session.close()
    } catch {
      // 关闭失败不影响列表状态
    }
    return true
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    for (const id of ids) await this.close(id)
  }

  /** 供工具层使用：把目标名解析成 TargetConfig。 */
  target(name: string | undefined): TargetConfig {
    const wanted = name === undefined || name.trim().length === 0 ? this.deps.config.defaultTarget : name.trim()
    const target = findTarget(this.deps.config, wanted)
    if (target === undefined) {
      const names = this.deps.config.resolvedTargets.map(entry => entry.name).join(', ')
      throw new Error(`unknown harness target "${wanted}"; known targets: ${names}`)
    }
    return target
  }

  /** harness 自报的模型列表（带缓存）；modelsCommand 未配置时返回空。 */
  async targetModels(target: TargetConfig): Promise<{ models: string[], note: string }> {
    const cached = this.modelCache.get(target.name)
    const now = Date.now()
    if (cached !== undefined && now - cached.at < target.modelsCacheMs) {
      return { models: cached.models, note: cached.note }
    }
    const found = await listHarnessModels(target, target.modelsTimeoutMs)
    this.modelCache.set(target.name, { at: now, models: found.models, note: found.note })
    return { models: found.models, note: found.note }
  }

  /** 清掉模型缓存（UI 上「刷新模型」用）。 */
  clearModelCache(): void {
    this.modelCache.clear()
  }

  /**
   * 设置页/概览用的全量画像：目标 + 可用性 + 模型 + 活跃会话 + DSH 已配置的供应商模型。
   * `models: true` 会去问每个 harness（起进程，慢），默认只用缓存/静态信息。
   */
  async overview(options: { models?: boolean } = {}): Promise<Overview> {
    const targets: TargetOverview[] = []
    for (const target of this.deps.config.resolvedTargets) {
      const probe = target.command.length > 0 ? probeCommand(target.command) : { available: false, error: 'no command configured (GUI-only harness)' }
      let models: string[] = []
      let modelsNote = target.modelsCommand.length > 0 ? `${target.modelsCommand} ${target.modelsArgs.join(' ')}`.trim() : ''
      if (options.models === true && target.modelsCommand.length > 0) {
        const found = await this.targetModels(target)
        models = found.models
        modelsNote = found.note
      }
      targets.push({
        name: target.name,
        description: target.description,
        transport: target.transport,
        order: [...target.order],
        command: target.command,
        ...(probe.available && probe.path !== undefined ? { commandPath: probe.path } : {}),
        available: probe.available,
        ...(probe.available || probe.error === undefined ? {} : { reason: probe.error }),
        model: target.acpModel.length > 0 ? target.acpModel : '',
        canSelectModel: target.modelArgs.length > 0 || target.acpArgs.length > 0,        models,
        modelsNote,
      })
    }
    targets.sort((left, right) => {
      if (left.available !== right.available) return left.available ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    return {
      plugin: { name: '@dsh-external/dsh-harness-pilot', version: '0.1.0' },
      defaultTarget: this.deps.config.defaultTarget,
      targets,
      sessions: this.list(),
      dsh: { providers: await listDshModels(this.deps.llm) },
      generatedAt: Date.now(),
    }
  }
}
