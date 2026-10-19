/**
 * 会话编排层：把「一个目标 + 一条任务」按通道梯子送出去，并管理长期交互会话。
 *
 * 通道是**懒加载**的：某个通道的依赖在这台机器上不存在（没装 python、没装 SDK、
 * 没有 ConPTY）时，插件仍然能正常加载，只是那一档自动跳过 —— 这也是为什么
 * 这里用运行时 import 而不是顶层 import。
 */
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WindowHelper } from './helper.js'
import type { AccountManagers } from './account-managers.js'
import { recordWorkBuddyAuthorization } from './workbuddy-isolation.js'
import { probeCommand } from './launcher.js'
import { dispatchHeadless, killTree } from './transports/headless.js'
// 结构化原生会话分支（P2）：只有声明了 nativeCli 能力的目标、且派发带了 nativeSession
// 引用时才启用；旧 text CLI 路径（dispatchHeadless）原样保留，行为不变。
import { dispatchNativeCli } from './transports/native-cli.js'
import { dispatchPty, probePty, PtySession, type SpawnTerminal } from './transports/pty.js'
import type { DispatchOutcome, DispatchSpec, ReadResult, TargetConfig, TransportKind } from './types.js'
import { findTarget, type ResolvedConfig } from './config.js'
import { listDshModels, listHarnessModels, modelEntriesFor, overviewStateFor, type DshProviderModels } from './models.js'
import { discoverLocalModelCatalog } from './native-model-catalog.js'
import { countByKind } from './model-sources.js'
import type { DiscoveryState, ModelEntry, ModelKind } from './model-sources.js'
import {
  DEFAULT_POOL_POLICY,
  pidsFromFacts,
  PoolDeniedError,
  ProcessPool,
  type PoolPolicy,
  type PoolTask,
  type SpawnObserverHost,
} from './processpool.js'
import { pluginHome } from './settings.js'
// R4：受管目标的烘焙账号识别（共享实现；门禁/绑定都从这一处取）。
import { NATIVE_MANAGED_WORKBUDDY_IDS, bakedAccountRefOf } from './account-target.js'

/** 通道模块的最小结构契约（模块由子代理实现，这里只依赖契约）。 */
interface AcpModule {
  probeAcp(target: TargetConfig): { available: boolean; detail?: string }
  dispatchAcp(spec: DispatchSpec): Promise<DispatchOutcome>
}
interface CdpSessionLike {
  readonly port: number
  readonly pageId: string
  /** kill_first 的记账（杀了哪些 pid）；未执行过终止时为 undefined。 */
  readonly launchNote?: string
  read(options: { limit: number }): Promise<ReadResult>
  send(input: { text: string; submit?: boolean }): Promise<{ note: string }>
  /** 原始 JS 求值逃生口（CDP 会话有；其他通道没有）。 */
  evaluate?(expression: string): Promise<unknown>
  /** 真实 CDP 鼠标事件（CDP 会话有；合成事件点不开 Radix 菜单，还会卡死 ZCode）。 */
  mouse?(action: 'click' | 'move', x: number, y: number): Promise<void>
  close(): Promise<void>
}
interface CdpModule {
  probeCdpTarget(target: TargetConfig, port: number, options?: { killFirst?: boolean }): Promise<{ available: boolean; detail: string }>
  openCdp(target: TargetConfig, options: { cwd?: string; launch?: boolean; killFirst?: boolean; killForce?: boolean; portBase: number; timeoutMs?: number }): Promise<CdpSessionLike>
  dispatchCdp(spec: DispatchSpec, options: { launch?: boolean; portBase?: number }): Promise<DispatchOutcome>
  /** 非破坏首启（2026-10-16）：没在跑就带调试端口拉起；已在跑绝不杀。 */
  ensureCdpLaunched(target: TargetConfig, options: { cwd?: string; portBase: number }): Promise<CdpEnsureLike>
}
/** `transports/cdp.js` 的 `ensureCdpLaunched` 返回值的最小契约。 */
interface CdpEnsureLike {
  readonly target: string
  readonly status: 'already-attachable' | 'launched' | 'blocked-running-without-port' | 'failed'
  readonly port?: number
  readonly pid?: number
  readonly pids?: readonly number[]
  readonly detail: string
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
  readonly ok: boolean
  /** 给人看的说明（成功=点到了什么；失败=为什么没点到）。 */
  readonly detail: string
  /** 近失配候选，让模型换个说法重试（UIA 的 alternatives / DOM 的候选文字）。 */
  readonly candidates?: readonly string[]
}

/** 长期存活的交互式会话（窗口 / CDP / pty）。 */
export interface InteractiveSession {
  readonly id: string
  readonly target: TargetConfig
  readonly transport: TransportKind
  readonly detail: string
  /**
   * 通道降级告警：请求的通道没选上、实际用了别的通道时才有。
   * 以前这里是**静默** `continue`，用户以为在用 cdp，其实跑的是 window —— 那本身就是误导。
   */
  readonly warning?: string
  read(options: { limit: number; mode?: 'auto' | 'uia' | 'console' }): Promise<ReadResult>
  send(input: { text?: string; submit?: boolean }): Promise<{ note: string }>
  /** 只有 CDP 会话能求值页面 JS（用于按文字点按钮、打开面板）。 */
  evaluate?(expression: string): Promise<unknown>
  /** 只有 CDP 会话能派发真实鼠标事件（某些 GUI 的菜单只认真实 pointerdown）。 */
  mouse?(action: 'click' | 'move', x: number, y: number): Promise<void>
  /** 窗口会话：按可见名字点 UIA 元素（GUI harness 打开面板/新建任务）。 */
  clickElement?(name: string): Promise<ClickOutcome>
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
  /**
   * 最后一次被真正使用的时刻（`read` / `send` / `evaluate` / `mouse` / `clickElement`）。
   * 空闲回收按它判定，而不是按 `openedAt` —— 一个一直在被读的会话不该被当成空闲。
   */
  readonly lastUsedAt?: number
}

export interface PoolEventRecord {
  readonly level: 'info' | 'warn'
  readonly at: number
  readonly message: string
}

export interface SessionDeps {
  readonly config: ResolvedConfig
  readonly helper: WindowHelper
  /** 宿主 `ctx.subprocess.spawnTerminal`；缺失时 pty 档自动跳过。 */
  readonly spawnTerminal?: SpawnTerminal
  /** 宿主 `ctx.llm`：用于读出「本 profile 已配置的供应商模型」。 */
  readonly llm?: { listProviders(): { id: string, name: string }[], listModels(provider: string): Promise<{ id: string }[]> }
  readonly log?: (level: 'info' | 'warn', message: string) => void
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
  readonly accountRuntimeGate?: (accountId: string, targetName: string) => Promise<string | undefined>
  readonly accountManagers?: Pick<AccountManagers, 'beginExecution'>
  readonly prepareAccountTarget?: (target: TargetConfig, accountId?: string) => TargetConfig
  /**
   * 该目标是否被用户在「Harness 管理」里**停用**。
   * 停用必须**显式拒绝**派发，而不是静默换一个 harness 或通道执行。
   */
  readonly isTargetDisabled?: (targetName: string) => boolean
  /**
   * 并发上限 / 空闲窗口的初值（可配置）。缺省 = `DEFAULT_POOL_POLICY`（上限 4、拒绝式）。
   * 之后由设置页经 `SessionRegistry.setPoolPolicy()` 实时改。
   */
  readonly pool?: Partial<PoolPolicy>
  /**
   * 池状态落盘路径。给了之后探针/运维能在**不重启**的前提下读到池的真实状态
   * （否则只能靠进程内自测）。
   */
  readonly poolStateFile?: string
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
  /**
   * **缓存里的**四态与四类计数（`/api/models` 的完整结果只在按需测量时给）。
   *
   * 为什么概览只给缓存：四态要嘛读原生配置（便宜），要嘛问 CLI（起进程）。
   * 概览是高频接口，不能每次刷新都把 35 个 CLI 都拉起来 —— 所以这里如实分两层：
   *   · 概览 = 缓存/静态可得的部分（`measured:false` 时不假装测过）；
   *   · 设置页上的「测量」按钮 = 显式去问一次（走 `/api/models`，有 refresh 语义）。
   */
  readonly modelState?: DiscoveryState
  readonly modelCounts?: Readonly<Record<ModelKind, number>>
  /** 缓存是否命中的直白标记（false = 上面两个字段来自静态配置，不是刚问出来的）。 */
  readonly modelMeasured?: boolean
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

/**
 * 落盘缓存（seeded）的展示 TTL：6 小时。
 *
 * 只影响「重载后先展示上次发现」，不影响新鲜度纪律：后台预热会 orce 刷新每条目标，
 * 刷新结果覆盖它并重新落盘；超过这个年龄的落盘条目在加载时就被丢掉。
 */
export const SEEDED_MODEL_TTL_MS = 6 * 60 * 60 * 1000

/** 会话被关闭的原因（墓碑上必须带；`unknown session` 的可解释性靠它）。 */
export type ClosedSessionReason = 'idle-reap' | 'dispose' | 'explicit' | 'replaced'

export class SessionRegistry {
  private modelCacheKey(target: TargetConfig): string {
    return target.name + '\0' + createHash('sha256').update(JSON.stringify([target.modelsCommand, target.modelsArgs, target.env])).digest('hex')
  }
  private readonly sessions = new Map<string, InteractiveSession>()
  /**
   * 已关闭会话的**墓碑**（FIFO，上限 100 条）。
   *
   * 为什么需要：会话被空闲回收/插件卸载关掉之后，调用方再拿旧 id 来用时只能看到一句
   * `unknown session "…"`（2026-10-16 现场：4 个桌面会话隔一轮全灭，调用方完全无从判断
   * 是「从未存在」还是「被回收了、该重开」）。墓碑让 get() 未命中时能给出**可执行**的
   * 解释：谁、什么时候、被什么关的、下一步怎么办。
   */
  private readonly closedSessions: { id: string, target: string, transport: TransportKind, reason: ClosedSessionReason, closedAt: number, idleMs?: number }[] = []
  /**
   * 模型列表缓存（按目标的**配置指纹**做键，避免每次起进程问）。
   *
   * `name` 是目标名：键是哈希，**必须**把名字也存进来，否则无法把缓存**持久化**后按名字回填
   * （2026-10-15 加的：重载后首建目录要么 14.8s 全查一遍，要么只剩「CLI 默认模型」）。
   * `seeded === true` 表示这条来自**落盘的**上次发现（`at` 可能是几十分钟前）——
   * 它仍可用于展示，但调用方会把这一事实写进 note，并且后台预热立刻刷新它。
   */
  private readonly modelCache = new Map<string, {
    readonly at: number
    readonly name: string
    readonly models: string[]
    readonly note: string
    readonly entries?: readonly ModelEntry[]
    readonly state?: DiscoveryState
    readonly seeded?: boolean
  }>()
  private readonly acpModule = { loaded: false, value: undefined as AcpModule | undefined }
  private readonly cdpModule = { loaded: false, value: undefined as CdpModule | undefined }
  private readonly windowModule = { loaded: false, value: undefined as WindowModule | undefined }
  private counter = 0
  /**
   * 并发闸门 + 空闲核对账本。
   *
   * ⚠️ 惰性构造：`pluginHome()` 在**构造时**求值（读 env 与 homedir），若在 SessionRegistry
   * 构造那一刻环境还没就位，早构造会冻结一个错的目录。所以这里用 getter 兜住时序。
   */
  private poolBox: ProcessPool | undefined
  /** 空闲回收巡检计时器（长期交互会话的空闲释放）。 */
  private idleTick: NodeJS.Timeout | undefined
  /** 池的事件环形缓冲（`/diag/processpool` 之类只读出口用；不落盘时也能看到）。 */
  private readonly poolEvents: PoolEventRecord[] = []

  constructor(private readonly deps: SessionDeps) {
    if (deps.pool !== undefined || deps.poolStateFile !== undefined) {
      // 显式给了策略/落盘路径：立刻建池（并 arm 空闲计时器）。
      void this.pool()
    }
  }

  /**
   * 并发闸门实例（惰性、单例）。公开是**故意的**：设置页改 `maxConcurrent` 之后要能
   * 实时把新上限推给它（`setPoolPolicy`），只读出口也要能拿到快照。
   */
  pool(): ProcessPool {
    if (this.poolBox === undefined) {
      this.poolBox = new ProcessPool({
        ...(this.deps.pool === undefined ? {} : { policy: this.deps.pool }),
        stateFile: this.deps.poolStateFile ?? join(pluginHome(), 'run', 'processpool-state.json'),
        // 取消兜底：宽限期后本池**自己拉起的** pid 仍活着时，池可以代为终止。
        // ⚠️ 注入的是 `killTree`，而池只会把它用在自己登记过的 owned pid 上 ——
        // 树外厂商常驻守护进程（opencode `serve --service` 之类）从不进入那份清单，
        // 因此永远不会被这条路径碰到（不做归因、不越界）。
        terminateOwned: (pid: number, note) => {
          this.log('warn', `harness-pilot: 取消兜底 —— 终止本插件自己拉起的 pid ${pid}（${note.runName}，${note.reason}）`)
          killTree(pid)
        },
        log: (level, message) => {
          this.poolEvents.push({ level, at: Date.now(), message })
          if (this.poolEvents.length > 200) this.poolEvents.shift()
          this.log(level, message)
        },
      })
      this.armIdleTick()
    }
    return this.poolBox
  }

  /**
   * 实时改并发上限 / 空闲窗口。**只影响之后的新准入** —— 已经跑起来的不动
   * （中途改上限会让「谁占了名额」不可解释）。
   */
  setPoolPolicy(raw: Partial<PoolPolicy>): PoolPolicy {
    const applied = this.pool().setPolicy(raw)
    this.armIdleTick()
    return applied
  }

  /** 池事件（最近 200 条，含拒绝原因）—— 拒绝必须**留痕**，这是零静默降级的一部分。 */
  poolEventLog(): readonly PoolEventRecord[] {
    return [...this.poolEvents]
  }

  // ── 空闲回收（长期交互会话） ───────────────────────────────────────────

  private armIdleTick(): void {
    const window = this.pool().currentPolicy().idleSessionReapMs
    if (this.idleTick !== undefined) clearInterval(this.idleTick)
    // 巡检粒度 = 窗口的 1/4（下限 1s），窗口越大越省；只做只读判定，不动进程。
    const period = Math.max(1000, Math.round(window / 4))
    this.idleTick = setInterval(() => {
      void this.closeIdleSessions()
    }, period)
    if (this.idleTick.unref !== undefined) this.idleTick.unref()
  }

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
  async closeIdleSessions(options: { dryRun?: boolean, windowMs?: number } = {}): Promise<{ readonly windowMs: number, readonly closed: readonly string[], readonly candidates: readonly { id: string, target: string, transport: TransportKind, idleMs: number }[] }> {
    const windowMs = options.windowMs ?? this.pool().currentPolicy().idleSessionReapMs
    const now = Date.now()
    const candidates: { id: string, target: string, transport: TransportKind, idleMs: number }[] = []
    const closed: string[] = []
    for (const [id, session] of [...this.sessions]) {
      const lastUsed = session.summary.lastUsedAt ?? session.summary.openedAt
      const idleMs = now - lastUsed
      if (idleMs < windowMs) continue
      candidates.push({ id, target: session.summary.target, transport: session.transport, idleMs })
      if (options.dryRun === true) continue
      // 关掉它 —— 这一步才是真的把进程释放掉（close() 走 transport 自己的收尾）。
      const ok = await this.close(id, 'idle-reap')
      if (ok) closed.push(`${session.summary.target}/${session.transport}#${id}`)
    }
    if (options.dryRun !== true && closed.length > 0) this.pool().noteReapedSessions(closed)
    return { windowMs, closed, candidates }
  }

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

  /**
   * 通道预检：只判断「这一档能不能用」，不派发任务（避免失败后重复执行）。
   *
   * `killFirst` 会改变 cdp 的判定：单实例阻塞时，带 kill_first 的 cdp **可用**
   * （插件会先终止再带端口拉起）。不传则维持"如实报告被挡住"的只读语义。
   */
  async preflight(kind: TransportKind, target: TargetConfig, options: { killFirst?: boolean } = {}): Promise<{ available: boolean; detail: string }> {
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
        return await module.probeCdpTarget(target, port, { killFirst: options.killFirst === true })
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

  /**
   * 桌面目标的**非破坏首启**（2026-10-16 统筹修复请求）：
   * 目标没在跑就带 `--remote-debugging-port=<分配端口>` 拉起，让第一次启动就带端口，
   * 之后派发直接附着 —— 全程不终止任何进程（单实例在跑且无端口时如实回报 blocked，
   * 杀不杀由调用方走 kill_first 显式决定）。
   *
   * 只对 cdp 梯子里的目标有意义：headless/pty 目标不是 GUI 应用，明确拒绝。
   */
  async launchDesktop(target: TargetConfig, options: { cwd?: string } = {}): Promise<CdpEnsureLike> {
    const usesCdp = target.transport === 'cdp' || target.order.includes('cdp')
    if (!usesCdp) {
      return {
        target: target.name,
        status: 'failed',
        detail: `target '${target.name}' is not a desktop (cdp) harness — harness_launch only applies to GUI targets whose ladder includes cdp`,
      }
    }
    const module = await this.cdp()
    if (module === undefined || module.ensureCdpLaunched === undefined) {
      return { target: target.name, status: 'failed', detail: 'cdp: transport module unavailable' }
    }
    return await module.ensureCdpLaunched(target, { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), portBase: this.deps.config.cdpPortBase })
  }

  /** 按梯子选一档并跑一次任务；失败不会自动换档重跑（避免重复执行）。 */
  async dispatch(spec: DispatchSpec, options: { transport?: string } = {}): Promise<DispatchOutcome> {
    let release: (() => void) | undefined
    try { release = this.deps.accountManagers?.beginExecution(spec.target) }
    catch { return { transport: 'headless', text: '', stopReason: 'error', diagnostic: '共享账号槽正在切换，本次 CLI 派发明确拒绝；未启动进程', facts: { managerSlotBusy: true } } }
    try {
      const target = this.deps.prepareAccountTarget?.(spec.target, spec.identity?.accountId) ?? spec.target
      const outcome = await this.dispatchUnleased({ ...spec, target }, options)
      if (target.env.DSH_WORKBUDDY_FROZEN_HOME && outcome.stopReason === 'completed' && outcome.text.trim().length > 0) recordWorkBuddyAuthorization(target)
      return target.env.DSH_WORKBUDDY_PRINCIPAL_FINGERPRINT === undefined ? outcome : { ...outcome, facts: { ...outcome.facts, nativeHomeIsolated: true, nativePrincipalFingerprint: target.env.DSH_WORKBUDDY_PRINCIPAL_FINGERPRINT } }
    } catch (error) {
      return { transport: 'headless', text: '', stopReason: 'error', diagnostic: error instanceof Error ? error.message : '账号隔离准备失败', facts: { accountIsolationDenied: true } }
    } finally { release?.() }
  }

  private async dispatchUnleased(spec: DispatchSpec, options: { transport?: string } = {}): Promise<DispatchOutcome> {
    // ── 启用门禁 ──
    // 用户在「Harness 管理 → 注册表」停用的目标必须**显式拒绝**。
    // 绝不允许静默改用别的 harness / 别的通道执行 —— 那会让「停用」变成谎话。
    if (this.deps.isTargetDisabled?.(spec.target.name) === true) {
      return {
        transport: 'headless',
        text: '',
        stopReason: 'error',
        diagnostic:
          `harness target "${spec.target.name}" 已在「Harness 管理 → 注册表」中被停用，已显式拒绝派发。`
          + '如需使用，请先在那里重新启用；本次不会静默改用其它 harness 或通道。',
        identity: {
          harnessId: spec.target.name,

        },
        mismatch: [],
        facts: { disabled: true },
      }
    }

    // ── 受管账号的**执行前**门禁（真实测量，不是配方核对）──
    // 与上面「启用门禁」同级：都在**任何副作用之前**（还没选通道、还没进并发闸、还没 spawn）。
    // 判据是**真去测**（随包适配器 sha256 + 厂商 CLI `--version` 实测），不是读配方字符串。
    // 调用方已真测过一次的（`spec.accountGateChecked === true`）不重测 —— 否则一次任务里
    // 会连起两个厂商子进程，并且可能因为前一个还没退干净而把正常派发误判成拒绝。
    //
    // ── R4（Codex 审查）：受管目标的有效账号不依赖调用方显式传入 ──
    // 五路产品入口把账号烘焙在目标 argv 里（受管 wrapper 第 2 参数 / `--config-dir`）。
    // 只看 `spec.identity?.accountId` 时，省略账号 = 整体绕过门禁（独立反例复现过）。
    // 有效账号解析是**共享实现**（`account-target.ts` 的 `bakedAccountRefOf`）：
    //   · 省略 ⇒ 用烘焙账号照常执行版本/哈希门禁；
    //   · 显式 ≠ 烘焙 ⇒ 显式拒绝（不猜谁生效）；显式 = 烘焙 ⇒ 照常。
    const baked = bakedAccountRefOf(spec.target)
    let gateAccountId = spec.identity?.accountId ?? ''
    if (baked !== undefined && baked.kind === 'managed-wrapper') {
      if (!NATIVE_MANAGED_WORKBUDDY_IDS.includes(baked.value)) {
        return {
          transport: 'headless',
          text: '',
          stopReason: 'error',
          diagnostic: `受管 wrapper 的账号 id "${baked.value}" 不在已验收清单（${NATIVE_MANAGED_WORKBUDDY_IDS.join(', ')}）内：目标配方可能被改动，本轮**显式拒绝**执行（未选通道、未 spawn、未进门禁）。`,
          identity: { harnessId: spec.target.name },
          mismatch: [],
          facts: { accountGateDenied: true, bakedWrapperUnknown: true },
        }
      }
      if (gateAccountId.length > 0 && gateAccountId !== baked.value) {
        return {
          transport: 'headless',
          text: '',
          stopReason: 'error',
          diagnostic: `显式账号与目标烘焙账号冲突（显式=${gateAccountId}，烘焙=${baked.value}）：两个「--config-dir」/wrapper id 谁生效由 CLI 决定，不猜 —— 本轮**显式拒绝**执行（未选通道、未 spawn、未进门禁）。`,
          identity: { harnessId: spec.target.name },
          mismatch: [],
          facts: { accountGateDenied: true, bakedAccountConflict: true },
        }
      }
      gateAccountId = baked.value
    }
    if (gateAccountId.length > 0 && spec.accountGateChecked !== true && this.deps.accountRuntimeGate !== undefined) {
      const gateRefusal = await this.deps.accountRuntimeGate(gateAccountId, spec.target.name)
      if (gateRefusal !== undefined) {
        return {
          transport: 'headless',
          text: '',
          stopReason: 'error',
          diagnostic: gateRefusal,
          // 拒绝派发**不声明**任何实际身份（尤其不写 accountId/model）：没有 run、没有实际值。
          identity: { harnessId: spec.target.name },
          mismatch: [],
          facts: { accountGateDenied: true },
        }
      }
    }

    // ── 账号档案环境覆盖 ──
    // 档案的 env（例如把配置目录指向该档案）必须**覆盖**目标自身的 env：
    // 否则两个账号会读同一个配置目录，隔离静默失效。
    const baseTarget = spec.identityEnv === undefined
      ? spec.target
      : { ...spec.target, env: { ...spec.target.env, ...spec.identityEnv } }
    const target = withModel(baseTarget, spec.model)
    const request: DispatchSpec = target === spec.target && baseTarget === spec.target ? spec : { ...spec, target }
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
        identity: { harnessId: target.name },
        mismatch: [],
        facts: { ladder: report.join('; ') },
      }
    }

    const outcome = await this.poolGate(`${target.name}:${chosen}`, chosen, request, async (extras) => await this.run(chosen, { ...request, ...extras }))
    return foldOutcomeIdentity(spec, target.name, chosen, outcome, report.join('; '))
  }

  private asPoolTask(name: string, spec: DispatchSpec): PoolTask {
    return {
      name,
      // 请求身份只带 harness/模型（**不带** accountId：原始账号 id 不许外流到日志/快照）。
      ...(spec.identity === undefined
        ? {}
        : { identityNote: [spec.identity.harnessId ?? '', spec.identity.model ?? ''].filter(part => part.length > 0).join('/') }),
      signal: spec.signal,
      timeoutMs: spec.timeoutMs,
    }
  }

  /** 把池的拒绝翻成一次**可见的**派发结果：不执行、不改道、不说"成功"。 */
  private poolDenial(name: string, error: unknown, requested: TransportKind | string): DispatchOutcome {
    if (error instanceof PoolDeniedError) {
      // 排队期间被调用方取消：这是**取消**，不是错误 —— stopReason 必须如实。
      const aborted = error.reason === 'aborted-while-queued'
      return {
        transport: requested as TransportKind,
        text: '',
        stopReason: aborted ? 'aborted' : 'error',
        diagnostic: aborted
          ? `"${name}" 在排队期间被取消：${error.detail}`
          : `并发闸门**显式拒绝**了 "${name}"：${error.detail}`,
        mismatch: [
          `并发上限（${error.limit}）已满：本次**没有执行** "${name}"。`,
          '这是显式拒绝 —— **不会**改用别的通道、**不会**改用别的 harness、没有被静默丢弃，更没有被当成成功。',
        ],
        facts: {
          poolDenied: true,
          poolDenyReason: error.reason,
          poolRunning: error.running,
          poolLimit: error.limit,
        },
      }
    }
    return {
      transport: requested as TransportKind,
      text: '',
      stopReason: 'error',
      diagnostic: `并发闸门无法给出准入结论，出于"不静默降级"的纪律拒绝执行 "${name}"：${error instanceof Error ? error.message : String(error)}`,
      mismatch: [`准入失败：本次**没有执行** "${name}"（原因见 diagnostic）。`],
      facts: { poolDenied: true, poolDenyReason: 'unknown' },
    }
  }

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
  private async poolGate(
    name: string,
    chosen: TransportKind,
    spec: DispatchSpec,
    run: (extras: SpawnObserverHost) => Promise<DispatchOutcome>,
  ): Promise<DispatchOutcome> {
    const pool = this.pool()
    const task = this.asPoolTask(name, spec)
    try {
      return await pool.run<DispatchOutcome>(task, async (ctx) => {
        const observer: SpawnObserverHost = {
          // 池的 `noteSpawn` 返回"结束时回报"的回调，原样交给 transport。
          onSpawn: fact => ctx.noteSpawn(fact),
        }
        const outcome = await run(observer)
        // pid 除了运行期登记之外，再从 facts 摘一遍（`facts.pid`）—— 两条路径任一命中即可；
        // 都摘不到就是"未登记"，**不会**被当成已核对。
        return {
          value: outcome,
          spawnedPids: pidsFromFacts(outcome.facts),
          stopReason: outcome.stopReason,
          ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
        }
      })
    } catch (error: unknown) {
      if (error instanceof PoolDeniedError) {
        // 拒绝必须留痕：池自己的日志是一处，这里补一条带目标名的告警。
        this.log('warn', `harness-pilot: 并发闸门拒绝了 "${name}"（${error.reason}, ${error.running}/${error.limit}）—— 未执行，未改道`)
        return this.poolDenial(name, error, chosen)
      }
      throw error
    }
  }

  private async run(kind: TransportKind, spec: DispatchSpec & SpawnObserverHost): Promise<DispatchOutcome> {
    switch (kind) {
      case 'headless':
        // 持久原生会话分支：声明了 nativeCli 协议能力的目标 + 派发带了 nativeSession 引用
        // ⇒ 走结构化 JSONL 解析与精确恢复；其余一切照旧（旧 text CLI 路径零改动）。
        if (spec.nativeSession !== undefined && spec.target.nativeCli !== undefined) {
          return await dispatchNativeCli(spec)
        }
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

  /** 这条会话的「首选通道」：显式 transport 优先，否则 order 里第一个有会话概念的档。 */
  private preferredSessionTransport(target: TargetConfig): TransportKind | undefined {
    if (target.transport !== '' && target.transport !== 'auto') {
      return (ALL_TRANSPORTS as readonly string[]).includes(target.transport)
        ? target.transport as TransportKind
        : undefined
    }
    const order = (target.order.length > 0 ? target.order : ALL_TRANSPORTS)
      .filter((kind): kind is TransportKind => (ALL_TRANSPORTS as readonly string[]).includes(kind))
    return order.find(kind => kind !== 'headless')
  }

  /**
   * 打开一个长期交互会话（GUI harness 优先 CDP，其次窗口，最后 pty）。
   *
   * - `transport`：强制只走某一档。补救命令 `harness_open target=… transport=window`
   *   依赖它，用来"CDP 被单实例挡住时改走窗口"。
   * - `killFirst`：透传给 cdp 通道，用于「目标在跑但没带调试端口」的单实例场景。
   */
  private readonly managerSessionLeases = new Map<string, () => void>()
  async open(
    target: TargetConfig,
    options: { cwd: string; launch?: boolean; killFirst?: boolean; killForce?: boolean; transport?: string },
  ): Promise<InteractiveSession> {
    const release = this.deps.accountManagers?.beginExecution(target)
    try {
      const prepared = this.deps.prepareAccountTarget?.(target) ?? target
      const session = await this.openUnleased(prepared, options)
      if (release === undefined) return session
      if (this.managerSessionLeases.has(session.id)) { release(); return session }
      this.managerSessionLeases.set(session.id, release)
      const close = session.close.bind(session)
      session.close = async () => {
        await close()
        this.managerSessionLeases.get(session.id)?.()
        this.managerSessionLeases.delete(session.id)
        // 经由 registry.close() 进来时墓碑已记过（幂等）；被直接调用时在这里补记。
        this.recordClosed(session.id, 'explicit', session.summary)
        this.sessions.delete(session.id)
      }
      return session
    } catch (error) { release?.(); throw error }
  }
  private async openUnleased(
    target: TargetConfig,
    options: { cwd: string; launch?: boolean; killFirst?: boolean; killForce?: boolean; transport?: string },
  ): Promise<InteractiveSession> {
    const launch = options.launch ?? true
    const killFirst = options.killFirst === true
    const killForce = options.killForce === true
    const forced = typeof options.transport === 'string' && options.transport.trim().length > 0
      ? options.transport.trim()
      : undefined
    let order: TransportKind[] = (target.order.length > 0 ? target.order : ALL_TRANSPORTS)
      .filter((kind): kind is TransportKind => (ALL_TRANSPORTS as readonly string[]).includes(kind))
    if (forced !== undefined) {
      if (!(ALL_TRANSPORTS as readonly string[]).includes(forced)) {
        throw new Error(`unknown transport "${forced}"; expected one of ${ALL_TRANSPORTS.join(', ')}`)
      }
      if (forced === 'headless') {
        throw new Error('the headless transport has no interactive session; use harness_dispatch or harness_task_start for it')
      }
      order = [forced as TransportKind]
    }
    const attempts: string[] = []
    for (const kind of order) {
      if (kind === 'headless') continue // headless 没有会话概念
      // killFirst 必须传进预检：否则单实例阻塞时 cdp 被判为不可用 → continue →
      // openCdp() 的 kill_first 分支永远走不到（曾经的真实 bug：提示了却从不执行）。
      const check = await this.preflight(kind, target, { killFirst })
      attempts.push(`${kind}=${check.available ? 'ok' : 'skip'} (${check.detail})`)
      if (!check.available) continue
      try {
        const session = await this.create(kind, target, { cwd: options.cwd, launch, killFirst, killForce })
        if (session !== undefined) {
          const note = sessionTransportNote(forced, this.preferredSessionTransport(target), kind, attempts)
          // ⚠️ `{...session, warning}` 是**浅拷贝**：调用方拿到的是那个拷贝，
          // 它调 read/send 时**不会**经过本来的 Proxy —— 时间戳不刷新，空闲回收就会误杀
          // 一个正在被用的会话。所以拷贝之后要**重新**包一层追踪，并把表里的那条换成同一个对象。
          const ready = note === undefined ? session : this.withIdleTracking({ ...session, warning: note })
          this.sessions.set(ready.id, ready)
          return ready
        }
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
    options: { cwd: string; launch: boolean; killFirst: boolean; killForce: boolean },
  ): Promise<InteractiveSession | undefined> {
    if (kind === 'pty') {
      if (this.deps.spawnTerminal === undefined) return undefined
      const session = await PtySession.open(target, { cwd: options.cwd, spawnTerminal: this.deps.spawnTerminal })
      // ⚠️ 2026-10-16 现场实测（P-9）：Electron 桌面应用（qoder-cn-desktop / workbuddy-desktop）
      // 在 ConPTY 里**没有任何终端输出**（GUI 窗口脱离伪终端）——pty 会话"开成功"但屏幕永远是空的，
      // 调用方只能拿到一句空 read。这里在开档时就把这种情况判为**本档失败**并抛出，
      // 让 openUnleased 的逐档循环自动降下一档（window/cdp），而不是交出一个空会话。
      if (session.read().text.trim().length === 0) {
        await session.close().catch(() => undefined)
        throw new Error(
          `pty opened for "${target.name}" but produced no terminal output within the first-frame window — `
          + 'GUI/Electron harnesses have no terminal output on a pty; this target needs the window (or cdp) transport. '
          + `Retry with harness_open(target='${target.name}', transport='window').`,
        )
      }
      const raw = this.wrapPty(session, target)
      // 存进表里和交回给调用方的必须是**同一个**被追踪的对象：只包一处会出现
      // 「工具层在用、时间戳不刷新 → 空闲回收误杀正在用的会话」。
      const wrapped = this.withIdleTracking(raw)
      this.sessions.set(wrapped.id, wrapped)
      return wrapped
    }
    if (kind === 'cdp') {
      const module = await this.cdp()
      if (module === undefined) return undefined
      const session = await module.openCdp(target, {
        cwd: options.cwd,
        launch: options.launch,
        killFirst: options.killFirst,
        killForce: options.killForce,
        portBase: this.deps.config.cdpPortBase,
      })
      const id = this.mintId()
      // kill_first 是破坏性操作：把「杀了谁」并进 detail，让它在会话列表里可见、可审计。
      const detail = session.launchNote === undefined
        ? `cdp port ${session.port} page ${session.pageId}`
        : `cdp port ${session.port} page ${session.pageId}; ${session.launchNote}`
      const summary: LiveSessionSummary = {
        id,
        target: target.name,
        transport: 'cdp',
        detail,
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
      const tracked = this.withIdleTracking(wrapped)
      this.sessions.set(id, tracked)
      return tracked
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
          // ok=false 是「没点到」这个事实本身，调用方据此**停止后续输入**（P3 误投递修复）。
          return {
            ok: result.found,
            detail,
            ...(result.alternatives === undefined || result.alternatives.length === 0
              ? {}
              : { candidates: result.alternatives }),
          }
        },
        close: async () => {
          await module.closeWindow(this.deps.helper, session)
        },
      }
      const tracked = this.withIdleTracking(wrapped)
      this.sessions.set(id, tracked)
      return tracked
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

  /**
   * 「这个 id 为什么不在活会话表里」的解释（未命中且无墓碑时返回 undefined ——
   * 那就是「从未在本进程里开过」，如实说，不编造历史）。
   */
  explainMissing(id: string): string | undefined {
    const index = this.closedSessions.find(entry => entry.id === id)
    if (index === undefined) return undefined
    const ago = Math.max(0, Math.round((Date.now() - index.closedAt) / 1000))
    const idle = index.idleMs === undefined ? '' : `，关闭前已空闲 ${Math.round(index.idleMs / 1000)}s`
    const reason = index.reason === 'idle-reap'
      ? `被空闲回收器关闭（窗口 ${this.pool().currentPolicy().idleSessionReapMs}ms${idle}）`
      : index.reason === 'dispose'
        ? '随插件卸载/重载被整体关闭'
        : index.reason === 'replaced'
          ? '被同一目标的重新打开替换关闭'
          : '被显式关闭'
    return `session "${id}"（${index.target}/${index.transport}）${reason}，距今 ${ago}s。`
      + '它不是「从未存在」，而是**已关闭** —— 请重新 harness_open 打开一个新会话再投递（旧 id 不会复活）。'
  }

  private recordClosed(id: string, reason: ClosedSessionReason, summary?: LiveSessionSummary): void {
    if (this.closedSessions.some(entry => entry.id === id)) return // 同一 id 只记一次（幂等）
    this.closedSessions.push({
      id,
      target: summary?.target ?? '(unknown)',
      transport: summary?.transport ?? ('headless' as TransportKind),
      reason,
      closedAt: Date.now(),
      ...(summary === undefined ? {} : {
        idleMs: Date.now() - (summary.lastUsedAt ?? summary.openedAt),
      }),
    })
    while (this.closedSessions.length > 100) this.closedSessions.shift()
  }

  async close(id: string, reason: ClosedSessionReason = 'explicit'): Promise<boolean> {
    const session = this.sessions.get(id)
    if (session === undefined) return false
    this.sessions.delete(id)
    this.recordClosed(id, reason, session.summary)
    try {
      await session.close()
    } catch {
      // 关闭失败不影响列表状态
    }
    return true
  }

  async disposeAll(): Promise<void> {
    if (this.idleTick !== undefined) {
      clearInterval(this.idleTick)
      this.idleTick = undefined
    }
    this.poolBox?.dispose()
    const ids = [...this.sessions.keys()]
    for (const id of ids) await this.close(id, 'dispose')
  }

  /**
   * 给长期会话挂上「最后使用时刻」追踪。
   *
   * 为什么用 Proxy 而不是把每个方法都包一层：`read` / `send` / `evaluate` / `mouse` /
   * `clickElement` 五条路径都要刷新时间戳，手写五处将来一定会漏一处 ——
   * 而漏掉的那一处会让空闲回收**误杀**一个其实在用的会话。Proxy 按方法名统一拦截，
   * 新增方法自动被覆盖。`summary` 是对象引用（接口上只读），这里改的是它上面的字段。
   */
  private withIdleTracking(session: InteractiveSession): InteractiveSession {
    const summary = session.summary as { lastUsedAt?: number }
    summary.lastUsedAt = Date.now()
    const USE_METHODS = new Set(['read', 'send', 'evaluate', 'mouse', 'clickElement'])
    return new Proxy(session, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (typeof property === 'string' && USE_METHODS.has(property) && typeof value === 'function') {
          return (...args: unknown[]) => {
            summary.lastUsedAt = Date.now()
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return value
      },
    })
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
  async targetModels(target: TargetConfig, options?: { readonly force?: boolean }): Promise<{ models: string[], note: string, entries?: readonly ModelEntry[], state?: DiscoveryState }> {
    const cached = this.modelCache.get(this.modelCacheKey(target))
    const now = Date.now()
    // ⚠️ 缓存条目**形状不符**（缺 `entries`：插件热更之前写进去的）时视为**未命中**。
    // 不能把旧形状当命中返回 —— 那会让「四态 / 来源分类」在升级后一直空白（实测踩到过）。
    // ⚠️ 来自**落盘**的条目（`seeded`）用更长的 TTL：它的用途正是「重载后先即时展示上次发现」，
    // 若仍按 5 分钟的 `modelsCacheMs` 判命中，就会立刻再查一遍 —— 那就等于没有它。
    // 它**不会**因此变陈旧：后台预热对每条目标 `force` 刷新一次，刷到就覆盖（并重新落盘）。
    const ttl = cached?.seeded === true ? SEEDED_MODEL_TTL_MS : target.modelsCacheMs
    if (options?.force !== true && cached !== undefined && cached.entries !== undefined && now - cached.at < ttl) {
      return { models: cached.models, note: cached.note, entries: cached.entries, ...(cached.state === undefined ? {} : { state: cached.state }) }
    }
    const found = await listHarnessModels(target, target.modelsTimeoutMs)
    this.modelCache.set(this.modelCacheKey(target), {
      at: now,
      name: target.name,
      models: found.models,
      note: found.note,
      entries: found.entries,
      state: found.state,
    })
    return { models: found.models, note: found.note, ...(found.entries === undefined ? {} : { entries: found.entries }), ...(found.state === undefined ? {} : { state: found.state }) }
  }

  /**
   * **把上次发现落盘**（`index.ts` 在预热跑完后调用）。
   *
   * 只导出**新鲜**（非 seeded）的条目：seeded 的是「上次落盘又读回来」的，再写回去只是搬来搬去。
   * 另外跳过 `entries` 为空的条目：回填时它一样会被丢（`entries.length === 0` 视为没有发现），
   * 写进去只是白占体积（实测落盘里有 `zcode-cli=0` 这类空条目）。
   */
  exportModelCache(): Array<{
    readonly name: string
    readonly at: number
    readonly models: readonly string[]
    readonly note: string
    readonly entries?: readonly ModelEntry[]
    readonly state?: DiscoveryState
  }> {
    const rows: Array<{ name: string, at: number, models: readonly string[], note: string, entries?: readonly ModelEntry[], state?: DiscoveryState }> = []
    for (const value of this.modelCache.values()) {
      if (value.seeded === true) continue
      if (value.entries === undefined || value.entries.length === 0) continue
      rows.push({
        name: value.name,
        at: value.at,
        models: value.models,
        note: value.note,
        entries: value.entries,
        ...(value.state === undefined ? {} : { state: value.state }),
      })
    }
    return rows
  }

  /**
   * 用**落盘的**上次发现回填缓存（挂载时一次性）。
   *
   * 两条纪律：
   *   · 只接受**在 `maxAgeMs` 以内**的条目（更老的就当没有 —— 不能拿一天前的模型清单冒充「现在能选」）；
   *   · 回填的条目保留原始 `at`、并标 `seeded`，`note` 追加「本地缓存，N 分钟前发现」，界面上看得见它的来路。
   * @returns 回填了几条
   */
  seedModelCache(rows: readonly {
    readonly name: string
    readonly at: number
    readonly models: readonly string[]
    readonly note: string
    readonly entries?: readonly ModelEntry[]
    readonly state?: DiscoveryState
  }[], options: {
    readonly maxAgeMs: number
    /**
     * **算缓存键用的目标变换**，必须与读取路径（`syncModelsFor` → `modelScopedTarget`）一致。
     *
     * ⚠️ 2026-10-15 实测踩到的坑：第一版按**未加账号作用域**的目标算键，而读取路径按
     * `modelScopedTarget()`（会往 `modelsArgs` 里加 `--config-dir`）算键 ——
     * 键不同 ⇒ 回填的条目**读不到**，重载后首建目录依旧 16.5s（带账号的组尤其明显）。
     */
    readonly scope?: (target: TargetConfig) => TargetConfig
  }): number {
    const now = Date.now()
    let seeded = 0
    for (const row of rows) {
      if (typeof row.name !== 'string' || row.name.length === 0) continue
      if (!Array.isArray(row.entries) || row.entries.length === 0) continue
      const age = now - Number(row.at)
      if (!Number.isFinite(age) || age < 0 || age > options.maxAgeMs) continue
      const target = this.deps.config.resolvedTargets.find((entry) => entry.name === row.name)
      if (target === undefined) continue
      let scoped = target
      try {
        scoped = options.scope?.(target) ?? target
      } catch {
        // 作用域算不出来（例如账号档案已被删除）⇒ 退回未作用域的目标（键仍自洽）。
      }
      const minutes = Math.max(1, Math.round(age / 60_000))
      this.modelCache.set(this.modelCacheKey(scoped), {
        at: Number(row.at),
        name: row.name,
        models: [...row.models],
        note: `${row.note}（本地缓存：${minutes} 分钟前发现；插件重载后先展示它，后台正在刷新）`,
        entries: row.entries,
        state: row.state,
        seeded: true,
      })
      seeded += 1
    }
    return seeded
  }

  /** 清掉模型缓存（UI 上「刷新模型」用）。 */
  clearModelCache(target?: TargetConfig): void {
    if (target) this.modelCache.delete(this.modelCacheKey(target))
    else this.modelCache.clear()
  }

  /**
   * **只读**模型缓存（**不**起子进程）：给 `pilot-cli` 路由的目录出口用。
   *
   * 为什么需要它：`listModels()` 是宿主高频调用且必须同步（`dsh-llm` 目录刷新会反复问），
   * 而 `targetModels()` 未命中缓存时会**起子进程**问 CLI。两者不能混用：
   * 目录出口只看缓存，缓存未命中就只宣传「默认模型」条目，同时由调用方排一轮后台预热。
   */
  cachedModels(target: TargetConfig): { models: string[], note: string, entries?: readonly ModelEntry[], state?: DiscoveryState } | undefined {
    const cached = this.modelCache.get(this.modelCacheKey(target))
    if (cached === undefined) return undefined
    return { models: cached.models, note: cached.note }
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
      const hasModelSource = target.modelsCommand.length > 0 || target.modelsFixed.length > 0 || target.modelsFile.length > 0
      let modelsNote = target.modelsCommand.length > 0
        ? `${target.modelsCommand} ${target.modelsArgs.join(' ')}`.trim()
        : (target.modelsFixed.length > 0
          ? '静态清单（只列 --model 实测接受的取值）'
          : (target.modelsFile.length > 0 ? `catalog file ${target.modelsFile}（只取名字）` : ''))
      if (options.models === true && hasModelSource) {
        const found = await this.targetModels(target)
        models = found.models
        modelsNote = found.note
      }
      // 概览只给**缓存/静态**能得到的那一半（四态与四类计数）；没测过就标 `measured:false`，
      // 界面据此提示「点『测量』去问一次」，绝不把没测过的目标说成「没有配置供应商」。
      const cachedNow = this.cachedModels(target)
      const localNow = discoverLocalModelCatalog(target)
      const overviewEntries = modelEntriesFor({
        ...(cachedNow === undefined ? {} : { cliQuery: cachedNow.models }),
        catalog: localNow.entries,
        modelsFixed: (target.modelsFixed ?? []).filter((entry) => entry.trim().length > 0),
      })
      const overviewState = overviewStateFor({
        target,
        catalog: localNow.entries,
        entries: overviewEntries,
        probeAvailable: probe.available,
        ...(cachedNow?.state === undefined ? {} : { cachedState: cachedNow.state }),
        notes: probe.available ? [] : [probe.error ?? '入口不可用'],
      })
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
        canSelectModel: target.modelArgs.length > 0 || target.acpArgs.length > 0,
        models,
        modelsNote,
        modelState: overviewState,
        modelCounts: countByKind(overviewEntries),
        modelMeasured: cachedNow !== undefined,
      })
    }
    targets.sort((left, right) => {
      if (left.available !== right.available) return left.available ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    return {
      plugin: { name: PLUGIN_NAME, version: pluginVersion() },
      defaultTarget: this.deps.config.defaultTarget,
      targets,
      sessions: this.list(),
      dsh: { providers: await listDshModels(this.deps.llm) },
      generatedAt: Date.now(),
    }
  }
}

// ── 模块级纯函数（放在类之后，便于离线单测）──────────────────────────

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
export function sessionTransportNote(
  forced: string | undefined,
  preferred: TransportKind | undefined,
  used: TransportKind,
  attempts: readonly string[],
): string | undefined {
  if (forced !== undefined) {
    if (preferred === undefined || preferred === used) return undefined
    return `NOTE: transport=${used} was explicitly forced by the caller`
      + ` (this target's ladder would otherwise prefer ${preferred}).`
      + ' This is NOT a downgrade — nothing was substituted behind your back.'
  }
  if (preferred === undefined) {
    return `NOTE: could not determine the ladder's preferred channel for this target, so transport=${used} was used.`
  }
  if (preferred === used) return undefined
  const reasons = attempts.filter(entry => !entry.startsWith(`${used}=`)).join('; ')
  return `NOTE: ${preferred} was not usable for this session, so ${used} is being used instead`
    + (reasons.length > 0 ? ` — ${reasons}` : '')
    + '. Force a channel with harness_open transport=<acp|pty|cdp|window>.'
}

export const PLUGIN_NAME = '@dsh-external/dsh-harness-pilot'

let versionCache: string | undefined

/**
 * 插件版本**从 package.json 读**，不再硬编码。
 *
 * 之前这里写死 `0.1.0`，而 package.json 是 `0.1.1` —— `/overview` 因此长期自报错误版本。
 * 硬编码的版本号一定会漂移；改成读真实文件，读不到时给出显式占位而不是一个假的数字。
 */
export function pluginVersion(): string {
  if (versionCache !== undefined) return versionCache
  try {
    const here = dirname(fileURLToPath(import.meta.url)) // …/lib
    const raw = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: unknown }
    versionCache = typeof raw.version === 'string' && raw.version.length > 0 ? raw.version : 'unknown'
  } catch {
    versionCache = 'unknown'
  }
  return versionCache
}

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
export function foldOutcomeIdentity(
  spec: DispatchSpec,
  targetName: string,
  chosen: TransportKind,
  outcome: DispatchOutcome,
  ladder: string,
): DispatchOutcome {
  const requestedModel = spec.identity?.model ?? spec.model
  const facts: Record<string, string | number | boolean | undefined> = { ...outcome.facts, ladder }
  // Configuration acknowledgements (including ACP success) are not native execution receipts.
  const applied = typeof facts.acpModelApplied === 'boolean' ? facts.acpModelApplied : undefined
  const actualModel = outcome.identity?.model || undefined
  const actualProvider = outcome.identity?.provider || undefined
  const mismatch: string[] = [...(outcome.mismatch ?? [])]
  if (applied === false && requestedModel) {
    mismatch.push(`请求模型 "${requestedModel}" 的 ACP 配置切换失败；是否实际采用需原生执行回报确认`)
  }
  for (const [field, requested, actual] of [
    ['model', requestedModel, actualModel],
    ['provider', spec.identity?.provider, actualProvider],
  ] as const) {
    if (requested && actual && requested !== actual) {
      mismatch.push(`请求 ${field}="${requested}"，原生回报实际 ${field}="${actual}"`)
    }
  }

  const nativeSessionId = outcome.identity?.nativeSessionId ?? (typeof facts.sessionId === 'string' && facts.sessionId.length > 0 ? facts.sessionId : undefined)
  return {
    ...outcome,
    facts,
    identity: {
      ...outcome.identity,
      harnessId: outcome.identity?.harnessId ?? targetName,
      accountId: outcome.identity?.accountId ?? (facts.poolDenied === true ? undefined : spec.identity?.accountId),
      provider: actualProvider,
      model: actualModel,
      transport: facts.poolDenied === true ? undefined : chosen,
      ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
    },
    mismatch,
  }
}

// reload-marker 000413
// reload2 000637
// reload3 000817
// reload4 001016
// reload5 001145
// reload6 001216