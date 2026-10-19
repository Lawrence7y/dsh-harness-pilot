/**
 * 进程池 / 并发闸门 / 空闲回收 —— 一条**显式**的准入与收尾账本。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 先说清楚这个模块**不做什么**（这一节比它做什么更重要）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **它不预先常驻任何进程。** 池里没有任何「预热」「保活」逻辑：唯一让进程诞生的
 *    地方仍是各 transport 的 `spawn`（headless 一次性打印 / acp 每任务一个 server）。
 *    本模块只管「此刻允许跑几个」与「跑完是否真的清干净了」。
 *
 * 2. **它对树外厂商常驻守护进程不负责、也不碰。** 例如 `opencode.exe serve --service`
 *    是厂商自己的共享服务，可能在本插件从未运行过时就存在。本模块**绝不**终结
 *    非自己拉起的进程；完整进程集合口径的内存统计由 `/diag/processes` 负责
 *    （见 index.ts `processInventory()`），本模块只对自己 `run()` 期间存活的进程树负责。
 *
 * 3. **它不把「超限」变成别的执行方式。** 超限只有两个结果：`queued`（等待，并如实
 *    报告自己在排队）或 `rejected`（显式拒绝，带可读原因）。**没有**「超限就换一个
 *    通道 / 换一个 harness / 悄悄丢掉」这条路径 —— 那是本项目零容忍的静默降级。
 *
 * 4. **它不声称「已经释放」而不核对。** 任务出口时先**实测**该进程树是否还在
 *    （`tasklist` / `kill -0`），核不到就记 `unconfirmed`；空闲窗口到点后再核一次，
 *    仍未消失就进 `lingering` 并把 pid 报出来。宁可报「没核实」也不报一个漂亮的假数字。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（现状核查的结论，不是设想）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 核查 `src/sessions.ts` / `src/transports/*` / `src/tasks.ts` 后的实际情形：
 *   · `SessionRegistry.dispatch()` 是**所有**派发的收敛点（`/dispatch`、`/task/start`
 *     的回调、`src/provider.ts` 的子代理 provider、`harness_dispatch` 工具都经它），
 *     而它**没有任何并发闸门** —— 同时来 20 条就同时起 20 棵进程树；
 *   · `TaskManager.start()` 有一个 `maxConcurrent`，但它只挡住 `harness_task_start`
 *     这一条入口（超限抛错），**直连派发**（`harness_dispatch` → `/dispatch`）绕过它；
 *   · headless / acp 的任务出口已经用 `killTree()` 清整棵树（实测 0 残留），
 *     所以"已释放"是可核对的；但 `harness_open` 打开的**长期会话**（pty/cdp/window）
 *     在 `disposeAll()` 之前会一直留着，没有任何空闲回收。
 *
 * 于是本模块补上三件缺的事：按需启动（本来就按需，这里把它写成不变量）、
 * 可配置并发上限（排队或拒绝，二者都显式）、空闲回收（可观测 + 零残留核对）。
 *
 * ✅ **陈旧代码前置校验的覆盖情况（2026-10-14 第二次扩项后）**：`/diag/loaded` 的
 * `SELF_MODULES` 现在按一条**穷尽规则**定义 —— 「本插件服务端运行期的全部构建产物」
 * （`lib/` 下递归的全部 `.js`，排除浏览器侧 `client.js`；**清单项数不在此手抄，以机械判据为准（`lib/` 产物集合 == `src/index.ts` 的 SELF_MODULES 集合）；2026-10-15 v4.1 按此判据补入本轮新模块 native-sessions / receipt-outbox / transports/native-cli 与 7 个历史漏项；历史：2026-10-14 三次
 * 扩项加入 `account-managers.js`，此前加入 `account-target.js` 与 `overview-description.js`；
 * 上一轮 38 项时加入了 `team-routing.js`）。
 * 逐字清单**只**在 `src/index.ts` 维护，这里**故意不再重抄**：抄一遍就会滞后一次
 * （本文件历史上已经因为重抄而滞后过两回，那两句"anyStale 证明不了 X"就是这么过期的）。
 * 要核对一致性请用机械判据：`lib/` 下（除 `client.js`）的 `.js` 名称集合 == 清单集合。
 * 本轮新进清单的是**最后一类盲区**：`federation/` 下的 12 个模块、`models.js`、
 * `mcp-bridge-proxy.js`、`task-tools.js`、以及其余构建产物。
 * **已包含 `processpool.js` 与 `transports/acp.js`**（两者此前都不含，那两句
 * "anyStale 证明不了本文件 / ACP 那一档"的提醒因此**已经过时**，保留在此只为说明它们曾经是盲区）。
 * 实测：`anyStale===false` 时 `processpool.js` 与 `transports/headless.js` 的
 * loaded/disk 哈希确实逐字一致。2026-10-14 扩项后 `catalog-edit.js` / `provider.js` /
 * `transports/acp.js` / `mcp-bridge.js` 也进了清单，所以「磁盘与已加载一致」这句话现在对这四项
 * 同样成立 —— 但**行为取证仍是必需的**：`anyStale=false` 只说明**这份进程**跑的是当前源码，
 * 不说明那条能力真的被接线、真的被调用过（例如桥接入口开了却没人调 `tools/call`）。
 * 池自身另有 `loadedAt` / `moduleFile` 可核对（见 `describe()` 与落盘的 `stateFile`）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 「真正拥有」是什么意思（这一节是 2026-10-13 补的可核对定义）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 曾经的问题：headless / acp 的 `spawn()` 不回报 pid，于是池账目里恒为
 * `spawnedPids=[]` —— 池**没有登记自己拉起的进程**，于是「取消」与「空闲回收」
 * 都**不可观测**（只能写一句"未登记"）。这不是一个好看的数字问题，而是能力缺口：
 * 没有 owned 清单，就无法回答"我取消的那条任务，它的进程到底停了没有"。
 *
 * 现在的定义（三条都可核对、都不是推断）：
 *   1. **owned pid 的唯一来源**是"我们真的 spawn 了它"这条事实链：
 *      transport 在 `spawn()` 成功的**那一刻**经 `onSpawn` 回报（`observedVia='spawn-hook'`），
 *      或派发结果的 `facts` 里带回同一个真实 pid（`observedVia='facts'`）。
 *      **绝不**用全机快照、**绝不**按映像名匹配来补 pid。
 *   2. **启动生命周期事实**（`RunRecord.spawnedFacts`）：pid / 通道 / 命令 /
 *      `spawnedAt` / `exitedAt` / `exitCode` / `exitSignal` / `terminatedBy` / `cancelled`。
 *      迟到的出口回报（abort 之后 `close` 晚于派发结算）会**回填**进已结算的账目，
 *      不让退出码/信号因为时序丢掉。
 *   3. **取消可观测**：`task.signal` abort 时**运行期即时**记账（`cancel.requestedAt`），
 *      宽限期到点**实测** owned pid 是否真的消失 → `clean` / `not-confirmed`；
 *      只有在"还活着"时才会**代为终止这些 owned pid**（且必须显式记账、显式告警）。
 *      **树外厂商常驻守护进程从不在 owned 清单里**，因此永不被这条路径碰到。
 *
 * ⚠️ 给以后加 `facts` 字段的人一条硬约束：`pidsFromFacts()` 只按**键名含 `pid`**
 * 的数值字段摘 pid（这是既有契约，`probe/verify-processpool.mjs` 有断言）。所以
 * **不要**给时间戳起名 `pidStartedAt` 这类带 `pid` 又带数字的名字 —— 那会被当成一个 pid。
 * 本文件与 transport 用的名字是 `spawnedAtMs` / `exitedAtMs`。
 */

import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// 压力观测（P5）：整机内存水位（os.freemem/totalmem；只读，无副作用）。
import { freemem, totalmem } from 'node:os'

// ─────────────────────────────────────────────────────────────────────────────
// 策略
// ─────────────────────────────────────────────────────────────────────────────

/** 超限时的行为：`reject` = 显式拒绝；`wait` = 显式排队（等多久也如实报）。 */
export type QueueMode = 'reject' | 'wait'

export interface PoolPolicy {
  /** 同时允许**在跑**的准入数上限；`0` = 不限（默认 4，与运行时设置的 maxConcurrent 同源）。 */
  maxConcurrency: number
  /** 等待队列容量；仅在 `queueMode='wait'` 时有意义；`0` = 不排队（等价于 reject）。 */
  maxQueue: number
  queueMode: QueueMode
  /** 排队等待上限（毫秒）；超时**显式拒绝**，不静默放行。 */
  queueWaitMs: number
  /** 最后一个任务结束之后，再等多久做「释放核对」。这就是空闲窗口（毫秒）。 */
  idleReapMs: number
  /**
   * **长期交互会话**（harness_open 开出的 pty/cdp/window/acp）按「最后一次使用」判定的
   * 空闲回收窗口（毫秒）。与 `idleReapMs` 刻意分成两个字段：
   *
   * `idleReapMs` 的对象是「已结束 run 的进程核对」，30s 是合理的收尾节奏；而交互会话的
   * 使用节奏由**调用方的轮次间隔**决定 —— 实测 Leader「开完会话、隔一轮再来投」的间隔远超
   * 30s，复用同一个默认值等于「开会话必被回收」（现场表现为隔一轮 `unknown session`，
   * 2026-10-16 实测 4 个桌面会话全灭）。默认放宽到 30 分钟：既要兜住「被忘掉的 GUI 会话
   * 是几百 MB 常驻」，也不能把「正常的轮次间隔」当成「废弃」。
   */
  idleSessionReapMs: number
  /**
   * 取消（`task.signal` abort）之后，给 transport 自己收尾的宽限期（毫秒）。
   *
   * 到点**实测**「本池拥有的 pid 还在不在」：还在就按 `terminateOwnedOnCancel` 处置，
   * 并把结果如实记进账目（`cancelConfirmed` / `cancelNotConfirmed`）。这个字段存在的
   * 唯一理由是：**取消不能只是"发了信号就当成功"**。
   */
  cancelGraceMs: number
  /**
   * 宽限期过后本池拥有的 pid 仍活着时，池是否**代为**终止（默认 `true`）。
   *
   * ⚠️ 只对「本池这次运行真的拉起、且由 transport 在 spawn 处回报过 pid」的进程生效：
   * 树外厂商常驻守护进程（例如 `opencode.exe serve --service`）**从不在**这份清单里，
   * 因此永远不会被这条路径碰到（无法只凭进程名区分谁拉起的 ⇒ 池不做归因、也不越界）。
   * 置为 `false` 时池**不杀**，但必须显式标注"取消未确认"，绝不静默放过。
   */
  terminateOwnedOnCancel: boolean
  /** 是否是"同一个池"。配置变了会 `generation += 1`，便于事后判读快照属于哪一代。 */
  generation: number
}

export const DEFAULT_POOL_POLICY: PoolPolicy = {
  maxConcurrency: 4,
  maxQueue: 32,
  queueMode: 'reject',
  queueWaitMs: 120_000,
  idleReapMs: 30_000,
  idleSessionReapMs: 30 * 60_000,
  cancelGraceMs: 4_000,
  terminateOwnedOnCancel: true,
  generation: 1,
}

/**
 * 运行时设置 `maxConcurrent` 落在池上的**确切含义**（一处定义，避免各处理解不一致）：
 *
 *   · `0`  → 不限（用户在设置页的明确选择，**不**被"默认值"覆盖）；
 *   · `>0` → 同时最多这么多条派发；第 N+1 条按 `queueMode` **显式排队或显式拒绝**。
 *   · `queueMode` 默认 `'reject'`：这是**可审计**的一档 —— 被拒的请求一定带着
 *     "显式拒绝/不会改道"的文本回到调用方，而排队会让调用方以为自己"在跑"。
 *     要换成排队，把第二个参数传 `'wait'` 即可（一处开关）。
 */
export function applyRuntimeConcurrency(maxConcurrent: number, queueMode: QueueMode = 'reject'): Partial<PoolPolicy> {
  return {
    maxConcurrency: Math.max(0, Math.round(Number.isFinite(maxConcurrent) ? maxConcurrent : DEFAULT_POOL_POLICY.maxConcurrency)),
    queueMode,
  }
}

/** 宽松归一化：字段缺失/类型不对/越界都收敛到合法值（配置写错不该让池静默变成不限）。 */
export function normalizePoolPolicy(raw: Partial<PoolPolicy> | undefined, base: PoolPolicy = DEFAULT_POOL_POLICY): PoolPolicy {
  const int = (value: unknown, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.round(value)))
  }
  return {
    maxConcurrency: int(raw?.maxConcurrency, base.maxConcurrency, 0, 512),
    maxQueue: int(raw?.maxQueue, base.maxQueue, 0, 4096),
    queueMode: raw?.queueMode === 'wait' ? 'wait' : 'reject',
    queueWaitMs: int(raw?.queueWaitMs, base.queueWaitMs, 1000, 24 * 60 * 60 * 1000),
    idleReapMs: int(raw?.idleReapMs, base.idleReapMs, 1000, 24 * 60 * 60 * 1000),
    idleSessionReapMs: int(raw?.idleSessionReapMs, base.idleSessionReapMs, 5000, 7 * 24 * 60 * 60 * 1000),
    cancelGraceMs: int(raw?.cancelGraceMs, base.cancelGraceMs, 100, 10 * 60 * 1000),
    terminateOwnedOnCancel: raw?.terminateOwnedOnCancel === undefined
      ? base.terminateOwnedOnCancel
      : raw.terminateOwnedOnCancel === true,
    generation: int(raw?.generation, base.generation, 1, Number.MAX_SAFE_INTEGER),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// spawn 处回报的**启动生命周期事实**（headless / acp 在真正 spawn 的那一刻回报）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 子进程为什么结束。**由 transport 在出口如实回报**，池不猜。
 *
 * `transport-settle-kill` = 通道在自己的出口（settle）里对整棵树发了 `killTree`；
 * `child-exit` = 子进程自己退出的（正常跑完或自己报错退出）。
 */
export type SpawnTerminator =
  | 'caller-abort'
  | 'timeout'
  | 'transport-settle-kill'
  | 'child-exit'
  | 'spawn-error'
  | 'pool-cancel-escalation'
  | 'unknown'

/** transport 在 `spawn()` 成功那一刻回报的事实（这是"我拉起了哪个进程"的**唯一**来源）。 */
export interface SpawnObservation {
  /** 真正由我们 `spawn()` 出来的根进程 pid（后代由 tree-kill 负责，不在这里猜）。 */
  readonly pid: number
  /** 通道名（headless / acp / pty / cdp / window）。 */
  readonly channel: string
  /** 实际交给 spawn 的命令（解析后的可执行文件），只用于记账与排障。 */
  readonly command: string
  /** 回报时刻（`Date.now()`），即**启动瞬间**的观测。 */
  readonly at: number
  /** 完整命令行字符数（下界，便于和 argv 上限那条事实对上）。 */
  readonly argvChars?: number
}

/** 子进程结束时回报的事实。 */
export interface SpawnExitObservation {
  readonly at?: number
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly terminatedBy?: SpawnTerminator
  /** 是否因调用方取消（abort）而结束。 */
  readonly cancelled?: boolean
}

/** transport 在出口调用它回报"这个 pid 何时/为何结束"。幂等：第一次回报为准。 */
export type SpawnExitReporter = (exit: SpawnExitObservation) => void

/**
 * transport 的**可选**挂钩：`spawn()` 成功后立刻回报 pid 与启动时刻，
 * 并拿到一个"结束时回报"的回调。
 *
 * 为什么必须是"spawn 那一刻"而不是"派发结束之后写进 facts"：后者只有等任务收尾
 * 才知道 pid，池在**运行期**就登记不了自己拥有的进程，于是"取消 / 空闲回收"都不可观测
 * —— 那正是 `spawnedPids=[]` 的由来。这里把它补成一个 hook。
 */
export interface SpawnObserverHost {
  readonly onSpawn?: (fact: SpawnObservation) => SpawnExitReporter | void
}

/** 池账目里每个**自己拉起的**进程的完整生命周期事实（只记事实，不做归因）。 */
export interface SpawnFactView {
  readonly pid: number
  readonly channel: string
  readonly command: string
  readonly spawnedAtMs: number
  readonly spawnedAt: string
  readonly exitedAtMs: number | null
  readonly exitedAt: string | null
  readonly exitCode: number | null
  readonly exitSignal: string | null
  readonly terminatedBy: SpawnTerminator | null
  /** 是否因调用方取消而结束。 */
  readonly cancelled: boolean
  /** 该 pid 的来源：`spawn-hook` = transport 在 spawn 处回报；`facts` = 派发结果的 facts 里摘出。 */
  readonly observedVia: 'spawn-hook' | 'facts'
}

/** 一次运行的取消观测。 */
export interface CancelStateView {
  readonly requestedAtMs: number
  readonly requestedAt: string
  /** 谁发起的取消（目前是 `caller-abort`；保留字段是为了以后能区分超时/成员停止）。 */
  readonly source: string
  /** 取消后实测：本运行拥有的 pid 还有几个活着；`null` = 没测到。 */
  carriedAlive: number | null
  /** 取消后本池**代为**终止的 pid（只在宽限期后仍活着时发生）。 */
  killAttemptedPids: readonly number[]
  /** 终止尝试的结果：`clean` = 实测已消失；`pending` = 还在核；`not-confirmed` = 仍活着。 */
  status: 'pending' | 'clean' | 'not-confirmed'
  readonly confirmedAt: string | null
}

/** 完整进程集合（本机全部进程）的一次采样——与 `/diag/processes` **同一口径**（tasklist 全表）。 */
export interface ProcessSetSample {
  readonly at: string
  readonly totalProcesses: number
  readonly totalMB: number
  /** 树外厂商常驻进程：**只统计**，池绝不终止、也不做归因。 */
  readonly vendorProcessCount: number
  readonly vendorTotalMB: number
  readonly vendorProcesses: readonly { readonly name: string, readonly pid: number, readonly mb: number }[]
}

/** 一次空闲回收的完整证据（含**回收前后**的完整进程集合对比）。 */
export interface ReapRecord {
  readonly at: string
  readonly reason: 'timer' | 'manual' | 'dispose'
  readonly windowMs: number
  readonly checkedRuns: number
  /** 本轮核对过的、本池自己拉起的 pid。 */
  readonly ownedPidsChecked: readonly number[]
  readonly lingering: readonly number[]
  readonly unconfirmed: number
  readonly inventoryBefore: ProcessSetSample | null
  readonly inventoryAfter: ProcessSetSample | null
  readonly deltaProcesses: number | null
  readonly deltaMB: number | null
  /** 对比期间树外厂商进程集合**发生变化**时的前后清单（如实报告，并声明非本池所为）。 */
  readonly vendorChanged: { readonly before: readonly number[], readonly after: readonly number[] } | null
  readonly note: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 记账类型
// ─────────────────────────────────────────────────────────────────────────────

export interface PoolTask {
  /** 逻辑名（本插件用 `目标名:通道`，便于事后把并发数和实际 harness 对上）。 */
  readonly name: string
  /** 已固化的请求身份（只读；池不解析、不打印原始 accountId —— 由调用方负责脱敏）。 */
  readonly identityNote?: string
  /** 调用方取消信号：排队期间被取消 → 立刻以 `denied` 结果退出（不是静默丢弃）。 */
  readonly signal?: AbortSignal
  /** 本次的硬超时，用来推导排队预算；不给则用策略里的 queueWaitMs。 */
  readonly timeoutMs?: number
}

/** 准入结果。`kind` 是**唯一**的判定入口，调用方不许绕过它自己猜。 */
export type Admission =
  | { readonly kind: 'running', readonly id: string, readonly waiver?: string }
  | { readonly kind: 'queued', readonly id: string, readonly position: number, readonly running: number, readonly limit: number }

/** 拒绝原因。每一种都必须能出现在调用方看到的文本里。 */
export type DenyReason =
  | 'at-capacity'
  | 'queue-full'
  | 'queue-timeout'
  | 'aborted-while-queued'
  | 'outcome-unknown-while-queued'

export class PoolDeniedError extends Error {
  readonly reason: DenyReason
  readonly detail: string
  readonly running: number
  readonly limit: number

  constructor(reason: DenyReason, detail: string, running: number, limit: number) {
    super(detail)
    this.name = 'PoolDeniedError'
    this.reason = reason
    this.detail = detail
    this.running = running
    this.limit = limit
  }
}

/** 一次已完成运行的账目（**只**记录事实，不做归因）。 */
export interface RunRecord {
  readonly id: string
  /** 任务名（目标:通道）。 */
  readonly name: string
  readonly startedAt: number
  readonly endedAt: number
  readonly durationMs: number
  /** 准入是否等了：`queuedMs > 0` 就是真排过队。 */
  readonly queuedMs: number
  /** 结束原因：通道自己报的 stopReason；`denied` = 根本没跑。 */
  readonly stopReason: string
  /** 该运行期间本池**实际拉起**的进程 pid（来自 transport 的 facts / 显式登记）。 */
  readonly spawnedPids: readonly number[]
  /**
   * 这些 pid 的**完整生命周期事实**：何时启动、何时结束、退出码/信号、是否被取消。
   *
   * 与 `spawnedPids` 同时给出是刻意的：pid 只回答"它是谁"，这份事实回答"它经历了什么"。
   * `observedVia` 标明该 pid 是 transport 在 spawn 处回报的（`spawn-hook`，**真正拥有**），
   * 还是从派发结果 facts 里摘出的（`facts`，同样是真实回报，但没有启动瞬间的时刻）。
   */
  readonly spawnedFacts: readonly SpawnFactView[]
  /** 取消观测：调用方取消这一条时，它的进程被终止的过程与实测结果；没取消过 = null。 */
  readonly cancel: CancelStateView | null
  /** 是否发生过取消（等价于 `cancel !== null`，单列出来是为了让机器可判不必解引用）。 */
  readonly cancelled: boolean
  /**
   * 取消**未能确认**（宽限期后拥有的 pid 仍活着，且没被终止/终止后仍在）。
   * `true` 时这是一次**显式失败标注**，不得当成"已取消干净"。
   */
  readonly cancelNotConfirmed: boolean
  /**
   * 出口核对时，因为"我们自己刚发过终止、进程还没消失"而**额外等待**的毫秒数。
   *
   * 为什么需要它：`killTree` 在 Windows 上是 `taskkill /T /F`（**异步**子进程），
   * transport 记完账就 resolve 了；紧接着实测会把"正在死"读成"还活着"（实测 ACP 通道
   * 在 4 路并发验收里就出现了两次这种假阳性）。这段等待是**有界**的（≤1.5s）：等完还在
   * 就照实报残留 —— 既不把假阳性当真相，也不把真残留等成"干净"。
   */
  readonly releaseGraceMs: number
  /** 出口核对：这些 pid 任务结束时还在吗。 */
  readonly releasedAtTaskEnd: boolean | null
  /** 空闲窗口到点后的第二次核对；`null` = 尚未核对。 */
  releasedAfterIdle: boolean | null
  /** 空闲核对时仍未消失的 pid（**如实列出，不隐藏**）。 */
  lingeringPids: readonly number[]
  /** 本运行的实测峰值工作集（MB）；`null` = 没测到（不假装 0）。 */
  readonly peakTreeMB: number | null
  readonly detail?: string
}

export interface QueuedTaskView {
  readonly id: string
  readonly name: string
  readonly position: number
  readonly waitingMs: number
}

/** 池状态快照：**这就是「可观测」的落点**（HTTP / 文件 / 探针都读它）。 */
export interface PoolSnapshot {
  readonly at: string
  /** 加载本模块时的时间（判断「跑的是不是新的 processpool.js」的可靠依据）。 */
  readonly loadedAt: string
  readonly moduleFile: string
  readonly policy: PoolPolicy
  readonly running: number
  readonly runningNames: readonly string[]
  readonly queueLength: number
  readonly queued: readonly QueuedTaskView[]
  /** 压力观测（P5，最小字段）：池自身水位 + 整机内存（诚实口径：不是进程树相加）。 */
  readonly pressure?: {
    readonly running: number
    readonly queueLength: number
    readonly ownedPidCount: number
    readonly systemFreeMemMb: number
    readonly systemTotalMemMb: number
    readonly sampledAt: string
  }
  readonly peakConcurrency: number
  /**
   * 拿到**运行名额**的次数（= 真的被放进去跑了多少条）。
   * ⚠️ 名字刻意带 `ToRun`：被拒绝的请求**不**计入这里（它们进 `denied`）——
   * 曾经叫 `admitted` 时会被误读成「经过准入判定的总数」，与事实不符。
   */
  readonly admittedToRun: number
  readonly completedRuns: number
  readonly denied: Readonly<Record<DenyReason, number>>
  readonly deniedTotal: number
  /**
   * **每一次拒绝都留下"它等了多久"**（毫秒累计）。
   *
   * 为什么不只记次数：一条排队超时被拒的请求如果只在 `denied['queue-timeout']` 里留一个
   * 计数，事后没人能回答"它到底等了多久才被拒" —— 那等于把一次真实的等待抹掉。
   */
  readonly deniedWaitMs: Readonly<Record<DenyReason, { readonly count: number, readonly totalMs: number, readonly maxMs: number }>>
  /** 一旦 > 0，说明池**没能**核对释放（工具失败等）—— 必须显示，不许当成 0 残留。 */
  readonly unconfirmedReleases: number
  /** 任务结束时仍活着的 pid（正常情况下应为空）。 */
  readonly lingeringAtTaskEnd: readonly number[]
  /** 空闲窗口过后仍未消失的 pid。 */
  readonly lingeringAfterIdle: readonly number[]
  readonly idleWindowMs: number
  readonly idleSince: string | null
  readonly idleReapRuns: number
  readonly lastIdleReapAt: string | null
  /** 长期交互会话（harness_open 打开的）的空闲回收统计。 */
  readonly sessionsReaped: number
  readonly sessionsReapedTargets: readonly string[]
  /** 累计统计：每一次 run 的 spawnedPids 总和（**本池自己拉起的**，不含树外守护进程）。 */
  readonly spawnedTotal: number
  /**
   * 本池**真正拥有**的进程 pid 的完整清单（历史 + 在跑，去重）。
   *
   * 「拥有」的定义是可核对的：这些 pid 都是某个 transport 在 `spawn()` 处回报、
   * 或派发结果 `facts` 里带回来的**真实 pid**。它**不是**全机快照、也不是按进程名猜的。
   * 池只对这份清单里的 pid 做存活核对与（取消兜底时的）终止。
   */
  readonly ownedPids: readonly number[]
  /** 当前正在跑的运行各自拥有的 pid（运行期实时登记，不等任务结束）。 */
  readonly runningOwnedPids: readonly { readonly id: string, readonly name: string, readonly pids: readonly number[] }[]
  /** 取消账：请求数 / 实测确认干净数 / 未确认数。 */
  readonly cancellations: { readonly requested: number, readonly confirmed: number, readonly notConfirmed: number }
  /** 最近若干次空闲回收的完整证据（含回收前后完整进程集合对比）；最新在前。 */
  readonly reapRecords: readonly ReapRecord[]
  /** 最近一次空闲回收（= reapRecords[0]，便于只读一处）。 */
  readonly lastReap: ReapRecord | null
  /**
   * 树外厂商常驻进程的**当前统计**（只统计，绝不终止、不归因）。
   * 这份数据与 `/diag/processes` 的 `vendorProcesses` 同源同口径（tasklist 全表 + 映像名匹配）。
   */
  readonly vendorProcesses: ProcessSetSample | null
  readonly recentRuns: readonly RunRecord[]
  readonly notes: readonly string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 进程存活性 / 工作集的**实测**工具（失败返回 null，绝不返回一个假的 0）
// ─────────────────────────────────────────────────────────────────────────────

/** `tasklist` 与 `kill -0` 的薄封装：只回答「这个 pid 现在还在不在」。 */
function runCapture(file: string, args: readonly string[]): Promise<{ ok: boolean, stdout: string }> {
  return new Promise((resolve) => {
    try {
      execFile(file, [...args], { windowsHide: true, timeout: 15_000, maxBuffer: 4 << 20 }, (error, stdout) => {
        resolve({ ok: error === null || error === undefined, stdout: String(stdout ?? '') })
      })
    } catch {
      resolve({ ok: false, stdout: '' })
    }
  })
}

/** 单次进程表快照：pid → 工作集字节数（KB×1024）。查不到就是查不到。 */
export async function sampleProcessTable(): Promise<Map<number, number> | null> {
  if (process.platform === 'win32') {
    const out = await runCapture('tasklist', ['/FO', 'CSV', '/NH'])
    if (!out.ok) return null
    const table = new Map<number, number>()
    for (const line of out.stdout.split(/\r?\n/)) {
      const m = /^"[^"]+","(\d+)","[^"]*","[^"]*","([\d,]+) K"$/.exec(line.trim())
      if (m === null) continue
      table.set(Number(m[1]), Number((m[2] ?? '').replace(/,/g, '')) * 1024)
    }
    return table.size > 0 ? table : null
  }
  const out = await runCapture('ps', ['-eo', 'pid=,rss='])
  if (!out.ok) return null
  const table = new Map<number, number>()
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (m === null) continue
    table.set(Number(m[1]), Number(m[2]) * 1024)
  }
  return table.size > 0 ? table : null
}

/**
 * 树外厂商常驻守护进程的映像名（**只用于统计**）。
 *
 * 与 `src/index.ts` 的 `processInventory()` 里那份清单同源；将来应改成从**此处唯一导入**
 * （单一事实来源）。注意：这份匹配只回答"它像不像厂商常驻守护进程"，**不回答**"它是谁拉起的"
 * —— 无法只凭进程名区分，所以池对它**只统计、不终止、不归因**。
 */
export const VENDOR_DAEMON_IMAGE = /^(opencode|WorkBuddy|WorkBuddyAI|qodercli|qoderclicn|qodersec|agy|kimi|cursor)\.exe$/i

/**
 * 采样**完整进程集合**（本机全部进程 + 树外厂商常驻进程统计）。
 *
 * 与 `/diag/processes` **同一口径**（都来自 `tasklist /FO CSV /NH` 全表；POSIX 上等价地
 * 读 `ps -eo pid=,rss=`）。池用它做"回收前后进程数/内存对比"，而不是只看自己那棵树
 * —— 只看自己正是"看起来精确其实误导"的那个坑。采样失败返回 `null`（不假装 0）。
 */
export async function sampleProcessSet(): Promise<ProcessSetSample | null> {
  const table = await sampleProcessTable()
  if (table === null) return null
  const names = await processImageNames()
  let totalBytes = 0
  const vendors: { name: string, pid: number, mb: number }[] = []
  for (const [pid, bytes] of table) {
    totalBytes += bytes
    const name = names?.get(pid)
    if (name === undefined) continue
    if (!VENDOR_DAEMON_IMAGE.test(name)) continue
    vendors.push({ name, pid, mb: Math.round(bytes / 1024 / 1024 * 10) / 10 })
  }
  vendors.sort((a, b) => b.mb - a.mb)
  return {
    at: new Date().toISOString(),
    totalProcesses: table.size,
    totalMB: Math.round(totalBytes / 1024 / 1024),
    vendorProcessCount: vendors.length,
    vendorTotalMB: Math.round(vendors.reduce((sum, row) => sum + row.mb * 1024 * 1024, 0) / 1024 / 1024 * 10) / 10,
    // 与 `/diag/processes` 一致：只列最大的 20 个（统计口径，不是"我拥有的进程"）。
    vendorProcesses: vendors.slice(0, 20),
  }
}

/** pid → 映像名（只用于**统计**树外厂商进程；查不到就是查不到）。 */
async function processImageNames(): Promise<Map<number, string> | null> {
  if (process.platform !== 'win32') {
    const out = await runCapture('ps', ['-eo', 'pid=,comm='])
    if (!out.ok) return null
    const map = new Map<number, string>()
    for (const line of out.stdout.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
      if (m === null) continue
      map.set(Number(m[1]), (m[2] ?? '').split(/[\\/]/).pop() ?? '')
    }
    return map.size > 0 ? map : null
  }
  const out = await runCapture('tasklist', ['/FO', 'CSV', '/NH'])
  if (!out.ok) return null
  const map = new Map<number, string>()
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)",/.exec(line.trim())
    if (m === null) continue
    map.set(Number(m[2]), m[1] ?? '')
  }
  return map.size > 0 ? map : null
}

// ─────────────────────────────────────────────────────────────────────────────
// 池
// ─────────────────────────────────────────────────────────────────────────────

interface QueueEntry {
  readonly id: string
  readonly task: PoolTask
  readonly enqueuedAt: number
  readonly deadline: number
  resolve: (value: Admission) => void
  reject: (error: unknown) => void
  timer?: NodeJS.Timeout
  onAbort?: () => void
}

/** 运行期跟踪的一个**自己拉起的**进程（pid + 启动生命周期事实）。 */
interface LiveSpawn {
  readonly pid: number
  readonly channel: string
  readonly command: string
  readonly spawnedAtMs: number
  readonly observedVia: 'spawn-hook' | 'facts'
  exitedAtMs: number | null
  exitCode: number | null
  exitSignal: string | null
  terminatedBy: SpawnTerminator | null
  cancelled: boolean
  /** 出口回报是否已经到过（后到的回报不覆盖先到的）。 */
  exitReported: boolean
}

interface LiveCancel {
  readonly requestedAtMs: number
  readonly source: string
  aliveAfterRequest: number | null
  readonly killAttemptedPids: number[]
  status: 'pending' | 'clean' | 'not-confirmed'
  confirmedAtMs: number | null
}

interface LiveRun {
  readonly id: string
  readonly task: PoolTask
  readonly admittedAt: number
  readonly queuedMs: number
  pids: Set<number>
  /** pid → 该 pid 的启动生命周期事实（池**真正拥有**的进程清单）。 */
  spawned: Map<number, LiveSpawn>
  cancel: LiveCancel | null
  cancelNotConfirmed: boolean
  releaseChecked: boolean | null
  releaseLingering: number[]
  peakTreeMB: number | null
  /** 取消观测用的 abort 监听器（结束时必须摘掉，避免泄漏）。 */
  abortListener?: () => void
  /** 直接 acquire 的（外部托管的长期进程）：跳过空闲核对，由调用方负责释放。 */
  external: boolean
}

/**
 * 内部可变版 `RunRecord`：出口之后仍可能有**迟到的事实**（例如 abort 之后子进程的
 * `close` 事件晚于派发结算），必须能写回账目 —— 否则"退出码/信号"会永远缺一格，
 * 而那正是可观测性最要紧的一格。
 */
type RunRecordMutable = { -readonly [K in keyof RunRecord]: RunRecord[K] } & {
  spawnedFacts: SpawnFactView[]
  spawnedPids: number[]
  cancel: CancelStateView | null
  cancelled: boolean
  cancelNotConfirmed: boolean
}

export interface ProcessPoolOptions {
  policy?: Partial<PoolPolicy>
  /** 日志出口（拒绝 / 回收都要留痕）。 */
  log?: (level: 'info' | 'warn', message: string) => void
  /**
   * 池状态落盘路径。默认落在插件的 `run` 目录下（`HARNESS_PILOT_HOME` 可覆盖），
   * 让探针/运维能在**不重启、不改 index.ts** 的情况下读到池的真实状态。
   */
  stateFile?: string
  /** 注入时钟（测试用）。 */
  now?: () => number
  /**
   * 取消兜底时**代为终止一个本池拥有的 pid** 的能力（由 wiring 层注入 `killTree`）。
   *
   * ⚠️ 两个纪律写在这里：
   *   1. 不注入 = 池**没有**代为终止的能力；那时它必须把"取消未确认"**显式标出来**，
   *      绝不静默当成已取消干净（零静默降级）。
   *   2. 这个方法**只会**被本池用在自己登记过的 owned pid 上 —— 永不用于全机快照、
   *      永不用于按进程名匹配出来的树外厂商常驻进程。
   */
  terminateOwned?: (pid: number, note: { readonly runId: string, readonly runName: string, readonly reason: string }) => void
}

const RECENT_RUNS_KEPT = 50
/**
 * 「我们自己刚发过终止」之后，出口核对的**有界**宽限（毫秒/步长）。
 *
 * 这不是"再等等看会不会自己好"，而是承认一个**实测事实**：`taskkill /T /F` 是异步子进程，
 * transport 记完账就 resolve，紧接着的实测会把"正在死"读成"还活着"。宽限有界（1.5s），
 * 到点还在就报残留 —— 宁可报残留，也不把真残留等成"干净"。
 */
const RELEASE_GRACE_MS = 1_500
const RELEASE_GRACE_STEP_MS = 250
/**
 * 一个**被 await 的**短睡（宽限重测 / 兜底终止后的复查用）。
 *
 * ⚠️ 这里**不** `unref()`：被 await 的定时器如果 unref，在没有别的 handle 的场景下
 * 事件循环会直接空掉、await 永远不 settle（实测：探针顶层 await 直接以 exit 13 挂掉）。
 * unref 只适用于"发了就不用管"的后台计时器（如 `armIdleReaper` / 取消宽限计时器）。
 */
const sleepMs = (ms: number): Promise<void> => new Promise<void>(resolve => {
  setTimeout(resolve, ms)
})

/**
 * 并发准入 + 空闲核对账本。
 *
 * 用法（`run` 是推荐入口 —— 它保证「准入 / 登记 pid / 出口核对」三件事都做了）：
 * ```ts
 * const outcome = await pool.run({ name: `${target.name}:${kind}` }, async () => {
 *   const result = await this.run(kind, spec)          // 真正的派发
 *   return { value: result, spawnedPids: pidsOf(result), stopReason: result.stopReason }
 * })
 * ```
 * 超限时 `run` 抛 `PoolDeniedError`（调用方必须把它变成**可见**的拒绝结果，
 * 不许 catch 掉再换一条路跑）。
 */
export class ProcessPool {
  private policy: PoolPolicy
  private readonly log: (level: 'info' | 'warn', message: string) => void
  private readonly now: () => number
  private readonly stateFile: string | undefined
  private readonly loadedAtMs = Date.now()
  private readonly moduleFile = modulePathHint()

  private readonly running = new Map<string, LiveRun>()
  private readonly queue: QueueEntry[] = []
  private counter = 0
  private peakConcurrency = 0
  private admittedTotal = 0
  private completedRuns = 0
  private readonly deniedCounts: Record<DenyReason, number> = {
    'at-capacity': 0,
    'queue-full': 0,
    'queue-timeout': 0,
    'aborted-while-queued': 0,
    'outcome-unknown-while-queued': 0,
  }
  private unconfirmedReleases = 0
  /** 每一次拒绝的等待时长账（见 `PoolSnapshot.deniedWaitMs` 的说明）。 */
  private readonly deniedWaits: Record<DenyReason, { count: number, totalMs: number, maxMs: number }> = {
    'at-capacity': { count: 0, totalMs: 0, maxMs: 0 },
    'queue-full': { count: 0, totalMs: 0, maxMs: 0 },
    'queue-timeout': { count: 0, totalMs: 0, maxMs: 0 },
    'aborted-while-queued': { count: 0, totalMs: 0, maxMs: 0 },
    'outcome-unknown-while-queued': { count: 0, totalMs: 0, maxMs: 0 },
  }
  private lingeringAtTaskEnd: number[] = []
  private lingeringAfterIdle: number[] = []
  private idleSinceMs: number | null = null
  private idleTimer: NodeJS.Timeout | undefined
  private idleReapRuns = 0
  private lastIdleReapAtMs: number | null = null
  private sessionsReaped = 0
  private sessionsReapedTargets: string[] = []
  private spawnedTotal = 0
  private recentRuns: RunRecordMutable[] = []
  /** 空闲回收的完整证据（回收前后完整进程集合对比）；最新在前，保留最近 20 次。 */
  private reapRecords: ReapRecord[] = []
  /** 取消账（请求 / 确认干净 / 未确认）。 */
  private cancelRequested = 0
  private cancelConfirmed = 0
  private cancelNotConfirmed = 0
  /** 树外厂商常驻进程的最近一次统计（只统计，绝不终止、不归因）。 */
  private vendorSample: ProcessSetSample | null = null
  /** 取消兜底计时器（宽限期后核对/终止）；dispose 时要收干净。 */
  private readonly cancelTimers = new Set<NodeJS.Timeout>()
  /** 被拒绝请求的账（名字 / 原因 / 等了多久）—— 拒绝必须可回溯到"哪一条、为什么、等了多少"。 */
  private recentDenials: { readonly name: string, readonly reason: DenyReason, readonly waitedMs: number, readonly at: number }[] = []
  private readonly terminateOwned: ProcessPoolOptions['terminateOwned']
  constructor(options: ProcessPoolOptions = {}) {
    this.policy = normalizePoolPolicy(options.policy)
    this.log = options.log ?? (() => undefined)
    this.now = options.now ?? (() => Date.now())
    this.stateFile = options.stateFile
    this.terminateOwned = options.terminateOwned
  }

  // ── 策略 ────────────────────────────────────────────────────────────────

  currentPolicy(): PoolPolicy {
    return { ...this.policy }
  }

  /**
   * 改策略。**只影响之后的新准入**：已经在跑的不动（中途改上限会让"谁被算了"变得不可解释），
   * 已在排队的按新上限重新评估（`drainQueue`）。
   */
  setPolicy(raw: Partial<PoolPolicy>): PoolPolicy {
    const next = normalizePoolPolicy(raw, this.policy)
    this.policy = next
    this.log('info', `harness-pilot processpool: policy applied ${JSON.stringify({
      maxConcurrency: next.maxConcurrency,
      maxQueue: next.maxQueue,
      queueMode: next.queueMode,
      queueWaitMs: next.queueWaitMs,
      idleReapMs: next.idleReapMs,
      idleSessionReapMs: next.idleSessionReapMs,
      cancelGraceMs: next.cancelGraceMs,
      terminateOwnedOnCancel: next.terminateOwnedOnCancel,
      generation: next.generation,
    })}`)
    this.drainQueue()
    this.armIdleReaper()
    this.writeSnapshot()
    return { ...next }
  }

  private atCapacity(): boolean {
    return this.policy.maxConcurrency > 0 && this.running.size >= this.policy.maxConcurrency
  }

  // ── 准入 ────────────────────────────────────────────────────────────────

  private makeId(task: PoolTask): string {
    this.counter += 1
    return `p${this.counter}-${task.name}`
  }

  private beginRun(id: string, task: PoolTask, queuedMs: number, external: boolean): LiveRun {
    const run: LiveRun = {
      id,
      task,
      admittedAt: this.now(),
      queuedMs,
      pids: new Set<number>(),
      spawned: new Map<number, LiveSpawn>(),
      cancel: null,
      cancelNotConfirmed: false,
      releaseChecked: null,
      releaseLingering: [],
      peakTreeMB: null,
      external,
    }
    this.running.set(id, run)
    this.admittedTotal += 1
    if (this.running.size > this.peakConcurrency) this.peakConcurrency = this.running.size
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    this.idleSinceMs = null
    // 取消要**在运行期**就能观测到：调用方的 signal 一 abort 就记账，而不是等收尾才发现。
    if (task.signal !== undefined) {
      const onAbort = (): void => this.noteCancelRequest(id, 'caller-abort')
      run.abortListener = onAbort
      if (task.signal.aborted) onAbort()
      else task.signal.addEventListener('abort', onAbort, { once: true })
    }
    return run
  }

  private denialCount(reason: DenyReason, waitedMs = 0): void {
    this.deniedCounts[reason] += 1
    const ledger = this.deniedWaits[reason]
    const waited = Math.max(0, Math.round(waitedMs))
    ledger.count += 1
    ledger.totalMs += waited
    ledger.maxMs = Math.max(ledger.maxMs, waited)
  }

  /** 记录一条**已拒绝**请求的等待时长；也给外部（探针）用来回答"它等了多久"。 */
  private noteDenial(task: PoolTask, reason: DenyReason, waitedMs: number): void {
    this.denialCount(reason, waitedMs)
    this.recentDenials = [{ name: task.name, reason, waitedMs: Math.max(0, Math.round(waitedMs)), at: this.now() }, ...this.recentDenials].slice(0, RECENT_RUNS_KEPT)
  }

  /**
   * 申请一个名额。**不会**静默放行：要么 `running`，要么 `queued`，要么抛 `PoolDeniedError`。
   *
   * 排队预算的推导（这里有一个刻意的选择）：`queueWaitMs` 与「本任务自己的 timeoutMs」
   * 取较小值 —— 一个总超时 5 秒的任务不该在队列里等 2 分钟。两者都不给则用策略默认值。
   */
  async admit(task: PoolTask): Promise<Admission> {
    const id = this.makeId(task)
    if (!this.atCapacity()) {
      const run = this.beginRun(id, task, 0, false)
      this.announce(run)
      return { kind: 'running', id }
    }

    const running = this.running.size
    const limit = this.policy.maxConcurrency
    const detailBase = `concurrency limit ${limit} reached (${running} running: ${[...this.running.values()].map(r => r.task.name).join(', ')})`

    if (this.policy.queueMode !== 'wait' || this.policy.maxQueue <= 0) {
      this.noteDenial(task, 'at-capacity', 0)
      this.log('warn', `harness-pilot processpool: DENIED ${task.name} — ${detailBase}；queueMode=${this.policy.queueMode}（显式拒绝，不排队、不改道）`)
      this.writeSnapshot()
      throw new PoolDeniedError(
        'at-capacity',
        `${detailBase}。池的 queueMode 是 "${this.policy.queueMode}"，因此**显式拒绝**：`
        + '本次没有执行，也**不会**改用别的通道 / 别的 harness 重试。请等一条跑完，或调高 maxConcurrency（设置页 maxConcurrent）。',
        running,
        limit,
      )
    }
    if (this.queue.length >= this.policy.maxQueue) {
      this.noteDenial(task, 'queue-full', 0)
      this.log('warn', `harness-pilot processpool: DENIED ${task.name} — queue full (${this.queue.length}/${this.policy.maxQueue})`)
      this.writeSnapshot()
      throw new PoolDeniedError(
        'queue-full',
        `${detailBase}，且等待队列已满（${this.queue.length}/${this.policy.maxQueue}）。**显式拒绝**，未执行、未改道。`,
        running,
        limit,
      )
    }

    const budget = task.timeoutMs !== undefined && task.timeoutMs > 0
      ? Math.min(this.policy.queueWaitMs, Math.max(1000, task.timeoutMs))
      : this.policy.queueWaitMs
    const enqueuedAt = this.now()
    const position = this.queue.length + 1
    this.log('info', `harness-pilot processpool: QUEUED ${task.name} at position ${position} (${running}/${limit} running, budget ${budget}ms) — 排队的任务会如实报告自己排过队`)

    return await new Promise<Admission>((resolve, reject) => {
      const entry: QueueEntry = { id, task, enqueuedAt, deadline: enqueuedAt + budget, resolve, reject }
      entry.timer = setTimeout(() => {
        this.removeFromQueue(entry)
        const waited = this.now() - entry.enqueuedAt
        this.noteDenial(task, 'queue-timeout', waited)
        this.log('warn', `harness-pilot processpool: DENIED ${task.name} after queueing ${waited}ms (budget ${budget}ms) — queue wait budget exhausted`)
        this.writeSnapshot()
        reject(new PoolDeniedError(
          'queue-timeout',
          `${task.name} 在等待队列里排了 ${waited}ms（预算 ${budget}ms）仍没轮到（${this.running.size}/${limit} 在跑）。`
          + '**显式拒绝**：不会超时后偷偷放行，也不会改道执行。',
          this.running.size,
          limit,
        ))
      }, budget)
      if (entry.timer.unref !== undefined) entry.timer.unref()
      if (task.signal !== undefined) {
        const onAbort = (): void => {
          this.removeFromQueue(entry)
          this.noteDenial(task, 'aborted-while-queued', this.now() - entry.enqueuedAt)
          this.log('info', `harness-pilot processpool: ${task.name} cancelled while queued after ${this.now() - entry.enqueuedAt}ms (caller abort)`)
          this.writeSnapshot()
          reject(new PoolDeniedError(
            'aborted-while-queued',
            `${task.name} 在排队期间被调用方取消。未执行。`,
            this.running.size,
            limit,
          ))
        }
        entry.onAbort = onAbort
        if (task.signal.aborted) {
          onAbort()
          return
        }
        task.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.queue.push(entry)
      this.writeSnapshot()
    })
  }

  private removeFromQueue(entry: QueueEntry): void {
    const index = this.queue.indexOf(entry)
    if (index >= 0) this.queue.splice(index, 1)
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (entry.onAbort !== undefined && entry.task.signal !== undefined) {
      entry.task.signal.removeEventListener('abort', entry.onAbort)
    }
  }

  /** 有空位就放行队首（只在有真实空位时调用）。 */
  private drainQueue(): void {
    while (!this.atCapacity() && this.queue.length > 0) {
      const entry = this.queue.shift()!
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
      if (entry.onAbort !== undefined && entry.task.signal !== undefined) {
        entry.task.signal.removeEventListener('abort', entry.onAbort)
      }
      const queuedMs = this.now() - entry.enqueuedAt
      const run = this.beginRun(entry.id, entry.task, queuedMs, false)
      this.announce(run, queuedMs)
      entry.resolve({ kind: 'running', id: entry.id })
    }
    // 队首之后的 position 会变：重排一次快照即可（没有 await，不会撕开一致性）。
    this.writeSnapshot()
  }

  private announce(run: LiveRun, queuedMs = 0): void {
    this.log('info', `harness-pilot processpool: START ${run.task.name} (${this.running.size}/${this.policy.maxConcurrency || '∞'} running${queuedMs > 0 ? `, queued ${queuedMs}ms` : ''})`)
    this.writeSnapshot()
  }

  // ── 运行期登记 / 结束 ───────────────────────────────────────────────────

  /**
   * 把 transport 真实回报的 pid 登记进本运行（`facts.pid` / 子进程 pid 都从这里进）。
   *
   * ⚠️ 这里登记的是**真正拥有**的进程：pid 必须来自"我们真的 spawn 了它"这条事实链
   * （spawn 钩子或派发结果 facts）。池**不会**用全机快照或按映像名匹配来补 pid ——
   * 那会把树外厂商常驻进程误当成自己的，进而在取消/回收时误杀。
   */
  notePid(id: string, pid: number | undefined): void {
    if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return
    const run = this.running.get(id)
    if (run === undefined) return
    const value = Math.round(pid)
    if (!run.pids.has(value)) this.spawnedTotal += 1
    run.pids.add(value)
    if (!run.spawned.has(value)) {
      run.spawned.set(value, {
        pid: value,
        channel: 'unknown',
        command: '(reported via dispatch facts)',
        spawnedAtMs: this.now(),
        observedVia: 'facts',
        exitedAtMs: null,
        exitCode: null,
        exitSignal: null,
        terminatedBy: null,
        cancelled: false,
        exitReported: false,
      })
    }
  }

  /**
   * **spawn 那一刻**的登记入口（transport 在真正 `spawn()` 成功后调用）。
   *
   * 返回的回调给 transport 在出口回报「何时/为何结束、退出码/信号、是否被取消」。
   * 这条路径是 `spawnedPids` 能反映**真实拥有**的关键：登记发生在运行期，
   * 而不是等派发结算之后补一个 pid。
   */
  noteSpawn(id: string, fact: SpawnObservation): SpawnExitReporter {
    const run = this.running.get(id)
    const pid = Number.isFinite(fact.pid) ? Math.round(fact.pid) : -1
    if (run === undefined || pid <= 0) {
      // 运行已经结算（迟到回报）也不许假装成功：如实留一条日志，不吞掉。
      this.log('warn', `harness-pilot processpool: spawn observation for unknown run ${id} (pid=${String(fact.pid)}) — 未登记，仅留痕`)
      return () => undefined
    }
    if (!run.pids.has(pid)) this.spawnedTotal += 1
    run.pids.add(pid)
    if (!run.spawned.has(pid)) {
      run.spawned.set(pid, {
        pid,
        channel: fact.channel,
        command: fact.command,
        spawnedAtMs: fact.at,
        observedVia: 'spawn-hook',
        exitedAtMs: null,
        exitCode: null,
        exitSignal: null,
        terminatedBy: null,
        cancelled: false,
        exitReported: false,
      })
    }
    this.log('info', `harness-pilot processpool: OWNED pid ${pid} started by ${fact.channel} for ${run.task.name}`
      + ` (command=${fact.command}${fact.argvChars === undefined ? '' : `, argvChars=${fact.argvChars}`})`)
    this.appendEvent({
      event: 'spawn',
      runId: run.id,
      run: run.task.name,
      pid,
      channel: fact.channel,
      command: fact.command,
      at: new Date(fact.at).toISOString(),
      ...(fact.argvChars === undefined ? {} : { argvChars: fact.argvChars }),
    })
    this.writeSnapshot()
    return (exit: SpawnExitObservation): void => { this.noteSpawnExit(pid, exit) }
  }

  /**
   * 出口回报：这个 owned pid 何时/为何结束。**第一次回报为准**（后到的不覆盖先到的）。
   *
   * 迟到的回报（abort 之后子进程的 `close` 晚于派发结算）会被写回**已结算**的账目里
   * —— 退出码/信号是取消可观测的关键一格，不能因为时序就丢掉。
   */
  noteSpawnExit(pid: number, exit: SpawnExitObservation): void {
    const value = Math.round(pid)
    if (!Number.isFinite(value) || value <= 0) return
    const at = exit.at ?? this.now()
    const apply = (spawn: LiveSpawn): void => {
      if (spawn.exitReported) return
      spawn.exitReported = true
      spawn.exitedAtMs = at
      spawn.exitCode = exit.exitCode === undefined ? null : exit.exitCode
      spawn.exitSignal = exit.signal === undefined ? null : exit.signal
      spawn.terminatedBy = exit.terminatedBy ?? 'unknown'
      if (exit.cancelled === true) spawn.cancelled = true
    }
    for (const run of this.running.values()) {
      const spawn = run.spawned.get(value)
      if (spawn !== undefined) {
        apply(spawn)
        this.appendEvent({ event: 'spawn-exit', runId: run.id, run: run.task.name, pid: value, exitCode: spawn.exitCode, signal: spawn.exitSignal, terminatedBy: spawn.terminatedBy, cancelled: spawn.cancelled })
        return
      }
    }
    for (const record of this.recentRuns) {
      const spawn = record.spawnedFacts.find(entry => entry.pid === value)
      if (spawn === undefined) continue
      if (spawn.exitedAtMs !== null) return
      const patched: SpawnFactView = {
        ...spawn,
        exitedAtMs: at,
        exitedAt: new Date(at).toISOString(),
        exitCode: exit.exitCode === undefined ? null : exit.exitCode,
        exitSignal: exit.signal === undefined ? null : exit.signal,
        terminatedBy: exit.terminatedBy ?? 'unknown',
        cancelled: spawn.cancelled || exit.cancelled === true,
      }
      record.spawnedFacts = record.spawnedFacts.map(entry => (entry.pid === value ? patched : entry))
      this.appendEvent({ event: 'spawn-exit', runId: record.id, run: record.name, pid: value, exitCode: patched.exitCode, signal: patched.exitSignal, terminatedBy: patched.terminatedBy, cancelled: patched.cancelled, late: true })
      this.writeSnapshot()
      return
    }
    this.log('warn', `harness-pilot processpool: exit observation for pid ${value} 不属于本池任何运行 —— 未登记（不把它算成"我的进程"）`)
  }

  /**
   * 记下**取消请求**（调用方 abort）并安排一次宽限期后的**实测核对**。
   *
   * 「取消可观测」在这里落成三件事：① 请求时刻被记下；② 宽限期后**实测**该运行拥有的
   * pid 还在不在；③ 结果写进账目（`clean` / `not-confirmed`），并留一条事件。
   */
  noteCancelRequest(id: string, source: string): void {
    const run = this.running.get(id)
    if (run === undefined || run.cancel !== null) return
    run.cancel = {
      requestedAtMs: this.now(),
      source,
      aliveAfterRequest: null,
      killAttemptedPids: [],
      status: 'pending',
      confirmedAtMs: null,
    }
    this.cancelRequested += 1
    // 被取消的运行，它的 owned pid 也按"可能被取消"标记；真实结束原因仍以出口回报为准。
    for (const spawn of run.spawned.values()) spawn.cancelled = true
    this.log('info', `harness-pilot processpool: CANCEL requested for ${run.task.name} (${source}) — 拥有的 pid: [${[...run.pids].join(', ') || '(尚无：还没 spawn 出进程)'}]，`
      + `${this.policy.cancelGraceMs}ms 后实测是否真的终止`)
    this.appendEvent({ event: 'cancel-requested', runId: run.id, run: run.task.name, source, ownedPids: [...run.pids], ...(run.pids.size > 0 ? {} : { note: '取消时该运行还没有登记任何 pid' }) })
    this.writeSnapshot()
    const timer = setTimeout(() => {
      this.cancelTimers.delete(timer)
      void this.enforceCancel(id, 'grace-elapsed')
    }, this.policy.cancelGraceMs)
    if (timer.unref !== undefined) timer.unref()
    this.cancelTimers.add(timer)
  }

  /**
   * 取消的**实测核对**（宽限期到点，或结算时立刻做一次）。
   *
   * 三种结果都必须显式：
   *   · 拥有的 pid 已全部消失 → `clean`（可观测的"取消成功"）；
   *   · 仍活着且策略允许代为终止 → 终止**仅限这些 owned pid**，再实测一次；
   *   · 仍活着且不能/未能终止 → `not-confirmed` + warning（**显式失败标注**，不静默放过）。
   *
   * 池**只**碰 owned pid：树外厂商常驻守护进程从不在这份清单里。
   *
   * ⚠️ 本方法对**已结算**的运行同样有效（`finish` 会在读到残留时先记 not-confirmed，
   * 宽限计时器到点再复核一次）：实测已消失就**改判 clean 并改正计数** —— 既不误报成功，
   * 也不把"正在死"（`taskkill` 是异步的）永久钉成失败。
   */
  async enforceCancel(id: string, reason: 'grace-elapsed' | 'at-finish' = 'grace-elapsed'): Promise<{ readonly status: CancelStateView['status'], readonly alive: readonly number[] } | null> {
    const liveRun = this.running.get(id)
    const liveCancel = liveRun?.cancel ?? null
    const record = liveRun === undefined ? this.recentRuns.find(entry => entry.id === id) : undefined
    const recordCancel = record?.cancel ?? null
    if (liveCancel === null && recordCancel === null) return null
    const runId = liveRun?.id ?? record?.id ?? id
    const runName = liveRun?.task.name ?? record?.name ?? id
    const owned = liveRun !== undefined ? [...liveRun.pids] : [...(record?.spawnedPids ?? [])]
    const alreadyNotConfirmed = liveRun !== undefined ? liveRun.cancelNotConfirmed : (record?.cancelNotConfirmed ?? false)

    /** 判定收敛到一处：写状态、改正计数、留事件、写快照。 */
    const settleCancel = (status: 'clean' | 'not-confirmed', alive: readonly number[], detail: string, extra: Record<string, unknown> = {}): void => {
      if (liveRun !== undefined && liveCancel !== null) {
        liveCancel.status = status
        liveCancel.aliveAfterRequest = alive.length
        if (status === 'clean') liveCancel.confirmedAtMs = this.now()
        liveRun.cancelNotConfirmed = status === 'not-confirmed'
      } else if (record !== undefined && recordCancel !== null) {
        record.cancel = {
          ...recordCancel,
          status,
          carriedAlive: alive.length,
          confirmedAt: status === 'clean' ? new Date(this.now()).toISOString() : recordCancel.confirmedAt,
        }
        record.cancelNotConfirmed = status === 'not-confirmed'
      }
      if (status === 'clean') {
        this.cancelConfirmed += 1
        // 之前被记成"未确认"的，现在实测干净 ⇒ 把那一笔改正回来（计数必须如实）。
        if (alreadyNotConfirmed) this.cancelNotConfirmed = Math.max(0, this.cancelNotConfirmed - 1)
        this.log('info', `harness-pilot processpool: cancel CONFIRMED for ${runName} — owned pid ${owned.join(', ') || '(无)'} 实测已终止（${reason}${detail.length > 0 ? `；${detail}` : ''}）`)
        this.appendEvent({ event: 'cancel-confirmed', runId, run: runName, ownedPids: owned, reason, ...extra })
      } else {
        if (!alreadyNotConfirmed) this.cancelNotConfirmed += 1
        this.log('warn', `harness-pilot processpool: ⚠️ cancel NOT CONFIRMED for ${runName} — owned pid ${alive.join(', ')} 在取消后仍活着${detail.length > 0 ? `（${detail}）` : ''}。这是**显式失败标注**，不得当成已取消干净。`)
        this.appendEvent({ event: 'cancel-not-confirmed', runId, run: runName, alive: [...alive], reason, ...extra })
      }
      this.writeSnapshot()
    }

    if (owned.length === 0) {
      settleCancel('clean', [], '取消时该运行还没有登记任何 owned pid（没有需要终止的东西）')
      return { status: 'clean', alive: [] }
    }
    const alive = await this.alivePids(owned)
    if (alive === null) {
      // 测不到 ≠ 干净：保留原状态并显式记账（不假装成功）。
      this.log('warn', `harness-pilot processpool: cancel check for ${runName} **未能实测**（进程表工具失败）—— 记为未确认，不当作已取消干净`)
      this.appendEvent({ event: 'cancel-check-unavailable', runId, run: runName, reason })
      return { status: liveCancel?.status ?? recordCancel?.status ?? 'pending', alive: [] }
    }
    if (alive.length === 0) {
      settleCancel('clean', [], '')
      return { status: 'clean', alive: [] }
    }
    // 还活着：能代为终止就终止（**只**这些 owned pid）。
    if (this.policy.terminateOwnedOnCancel && this.terminateOwned !== undefined) {
      const attempted: number[] = [...(liveCancel?.killAttemptedPids ?? recordCancel?.killAttemptedPids ?? [])]
      for (const pid of alive) {
        attempted.push(pid)
        try {
          this.terminateOwned(pid, { runId, runName, reason: `cancel escalation (${reason})` })
        } catch (error: unknown) {
          this.log('warn', `harness-pilot processpool: terminateOwned(${pid}) failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (liveCancel !== null) liveCancel.killAttemptedPids.push(...attempted.filter(pid => !liveCancel.killAttemptedPids.includes(pid)))
      else if (record !== undefined && record.cancel !== null) {
        record.cancel = { ...record.cancel, killAttemptedPids: [...new Set(attempted)] }
      }
      this.appendEvent({ event: 'cancel-escalation-kill', runId, run: runName, pids: [...new Set(attempted)], reason })
      await sleepMs(700)
      const again = await this.alivePids(alive)
      if (again !== null && again.length === 0) {
        settleCancel('clean', [], `本池代为终止了 ${[...new Set(attempted)].join(', ')}（**只**碰自己拉起的 pid）`, { escalated: true })
        return { status: 'clean', alive: [] }
      }
      settleCancel('not-confirmed', again ?? alive, '代为终止后仍有 owned pid 活着', { escalated: true })
      return { status: 'not-confirmed', alive: again ?? alive }
    }
    const why = this.policy.terminateOwnedOnCancel ? '未注入 terminateOwned（池没有代为终止的能力）' : 'terminateOwnedOnCancel=false（策略选择不代为终止）'
    settleCancel('not-confirmed', alive, why, { escalated: false, why })
    return { status: 'not-confirmed', alive }
  }

  /** 记下**实测**峰值工作集（MB）；测不到就不调这个方法（保持 null，而不是写 0）。 */
  notePeakTreeMB(id: string, mb: number | null | undefined): void {
    if (mb === undefined || mb === null || !Number.isFinite(mb)) return
    const run = this.running.get(id)
    if (run === undefined) return
    run.peakTreeMB = run.peakTreeMB === null ? mb : Math.max(run.peakTreeMB, mb)
  }

  /** 内部：LiveSpawn → 对外事实视图。 */
  private spawnFactsOf(spawns: Iterable<LiveSpawn>): SpawnFactView[] {
    return [...spawns].map(spawn => ({
      pid: spawn.pid,
      channel: spawn.channel,
      command: spawn.command,
      spawnedAtMs: spawn.spawnedAtMs,
      spawnedAt: new Date(spawn.spawnedAtMs).toISOString(),
      exitedAtMs: spawn.exitedAtMs,
      exitedAt: spawn.exitedAtMs === null ? null : new Date(spawn.exitedAtMs).toISOString(),
      exitCode: spawn.exitCode,
      exitSignal: spawn.exitSignal,
      terminatedBy: spawn.terminatedBy,
      cancelled: spawn.cancelled,
      observedVia: spawn.observedVia,
    }))
  }

  private cancelView(cancel: LiveCancel | null): CancelStateView | null {
    if (cancel === null) return null
    return {
      requestedAtMs: cancel.requestedAtMs,
      requestedAt: new Date(cancel.requestedAtMs).toISOString(),
      source: cancel.source,
      carriedAlive: cancel.aliveAfterRequest,
      killAttemptedPids: [...cancel.killAttemptedPids],
      status: cancel.status,
      confirmedAt: cancel.confirmedAtMs === null ? null : new Date(cancel.confirmedAtMs).toISOString(),
    }
  }

  /**
   * 出口核对（**实测**）：本运行拥有的 pid 现在还在不在。
   *
   * 若有 owned pid 在实测时仍存活，就做一次**有界**宽限重测（≤`RELEASE_GRACE_MS`，步长 250ms）：
   * 因为 `taskkill /T /F` 是**异步**子进程，而 transport 发完 killTree 就 resolve 了，
   * 紧接着的实测会把"正在死"读成"还活着"（实测假阳性：4 路并发验收里两个 ACP 运行
   * 都出现 `releasedAtTaskEnd=false` 而 `reapIdle` 随后复核为 0 残留）。
   *
   * 判定纪律（两点都不能松）：
   *   · 宽限**有界**：到点仍在 ⇒ 照实报残留，绝不把真残留等成"干净"；
   *   · 无论有没有拿到"是我们杀的"这条回报，都要宽限 —— 出口回报可能迟到或缺失，
   *     而核对的目的是回答"它现在到底还在不在"，不是"调用方有没有记得通知我"。
   * 等待时长写进 `releaseGraceMs`（可观测，不藏在代码里）。
   */
  private async checkReleased(run: LiveRun): Promise<{ alive: number[] | null, graceMs: number }> {
    if (run.pids.size === 0) return { alive: [], graceMs: 0 }
    let alive = await this.alivePids([...run.pids])
    if (alive === null || alive.length === 0) return { alive, graceMs: 0 }
    let waited = 0
    while (alive.length > 0 && waited < RELEASE_GRACE_MS) {
      await sleepMs(RELEASE_GRACE_STEP_MS)
      waited += RELEASE_GRACE_STEP_MS
      const again = await this.alivePids(alive)
      if (again === null) return { alive: null, graceMs: waited }
      alive = again
    }
    if (alive.length > 0) {
      this.log('warn', `harness-pilot processpool: owned pid ${alive.join(', ')} 在 ${waited}ms 宽限重测后仍未消失（${run.task.name}）—— 记为残留，不当作已释放`)
    } else {
      this.log('info', `harness-pilot processpool: owned pid 在终止发出后 ${waited}ms 内消失（${run.task.name}）—— 有界宽限重测，不是"声称已释放"`)
    }
    return { alive, graceMs: waited }
  }

  /**
   * 结束一次运行：先**实测** pid 是否已经消失（`releasedAtTaskEnd`），再结算账目。
   * 调用方应在此前完成自己的 killTree —— 池**不替你杀进程**，只核对与记账
   * （唯一例外是取消宽限期后仍活着的 owned pid，见 `enforceCancel`，且必须显式记账）。
   */
  async finish(id: string, outcome: { readonly stopReason?: string, readonly diagnostic?: string } = {}): Promise<void> {
    const run = this.running.get(id)
    if (run === undefined) return
    this.running.delete(id)
    if (run.abortListener !== undefined && run.task.signal !== undefined) {
      run.task.signal.removeEventListener('abort', run.abortListener)
      run.abortListener = undefined
    }

    let releasedAtTaskEnd: boolean | null = null
    let lingering: number[] = []
    let releaseGraceMs = 0
    if (run.pids.size > 0) {
      const checked = await this.checkReleased(run)
      releaseGraceMs = checked.graceMs
      const alive = checked.alive
      if (alive === null) {
        releasedAtTaskEnd = null
        this.unconfirmedReleases += 1
      } else {
        lingering = alive
        releasedAtTaskEnd = alive.length === 0
      }
    }
    run.releaseChecked = releasedAtTaskEnd
    run.releaseLingering = lingering
    if (lingering.length > 0) this.lingeringAtTaskEnd = [...new Set([...this.lingeringAtTaskEnd, ...lingering])]

    // 取消过：把这次**实测**结果记进取消账（宽限期不是"必须等满"的借口，出口实测更早更有力）。
    if (run.cancel !== null && !run.external && run.pids.size > 0) {
      run.cancel.aliveAfterRequest = lingering.length
    }

    // 取消的最终判定：出口实测已消失 → clean；否则显式标注，并**留给宽限计时器**一次
    // 复核机会（`enforceCancel` 对已结算的账目同样有效）——那时若已消失会改判 clean 并**改正计数**，
    // 既不误报成功，也不把"正在死"永久记成失败。
    if (run.cancel !== null && !run.external) {
      const owned = [...run.pids]
      if (owned.length > 0 && lingering.length === 0 && releasedAtTaskEnd === true) {
        if (run.cancel.status === 'pending') {
          run.cancel.status = 'clean'
          run.cancel.aliveAfterRequest = 0
          run.cancel.confirmedAtMs = this.now()
          this.cancelConfirmed += 1
          this.appendEvent({ event: 'cancel-confirmed', runId: run.id, run: run.task.name, ownedPids: owned, reason: 'at-finish' })
        }
      } else if (owned.length > 0 && lingering.length > 0) {
        // 只在**第一次**判定未确认时计数（宽限期判定与出口判定可能都命中同一次取消）。
        if (!run.cancelNotConfirmed) this.cancelNotConfirmed += 1
        run.cancel.status = 'not-confirmed'
        run.cancelNotConfirmed = true
        this.log('warn', `harness-pilot processpool: ⚠️ cancel NOT CONFIRMED at finish for ${run.task.name} — owned pid ${lingering.join(', ')} 在 ${releaseGraceMs}ms 宽限后仍活着（出口实测）。`
          + `显式标注，不静默放过；${this.policy.cancelGraceMs}ms 的宽限计时器还会复核一次。`)
        this.appendEvent({ event: 'cancel-not-confirmed', runId: run.id, run: run.task.name, alive: lingering, escalated: false, reason: 'at-finish' })
      }
    }

    const record: RunRecordMutable = {
      id: run.id,
      name: run.task.name,
      startedAt: run.admittedAt,
      endedAt: this.now(),
      durationMs: Math.max(0, this.now() - run.admittedAt),
      queuedMs: run.queuedMs,
      stopReason: outcome.stopReason ?? 'unknown',
      spawnedPids: [...run.pids],
      spawnedFacts: this.spawnFactsOf(run.spawned.values()),
      cancel: this.cancelView(run.cancel),
      cancelled: run.cancel !== null,
      cancelNotConfirmed: run.cancelNotConfirmed,
      releaseGraceMs,
      releasedAtTaskEnd,
      releasedAfterIdle: null,
      lingeringPids: [],
      peakTreeMB: run.peakTreeMB,
      ...(outcome.diagnostic === undefined || outcome.diagnostic.length === 0 ? {} : { detail: outcome.diagnostic.slice(0, 400) }),
    }
    this.recentRuns = [record, ...this.recentRuns].slice(0, RECENT_RUNS_KEPT)
    this.completedRuns += 1

    if (run.external) {
      this.log('info', `harness-pilot processpool: END ${run.task.name} (external handle; stop=${record.stopReason})`)
    } else {
      const releaseNote = releasedAtTaskEnd === null
        ? '释放核对=未能确认（工具失败，不当作 0 残留）'
        : (releasedAtTaskEnd ? `释放核对=进程树已消失${releaseGraceMs > 0 ? `（等 ${releaseGraceMs}ms 待终止生效后实测）` : ''}` : `⚠️ 释放核对=仍有残留 ${lingering.join(',')}${releaseGraceMs > 0 ? `（已等 ${releaseGraceMs}ms）` : ''}`)
      const ownedNote = run.spawned.size === 0
        ? 'owned=0（本次没有登记任何 pid ⇒ 未核对，不是"干净"）'
        : `owned=${[...run.spawned.values()].map(spawn => `${spawn.pid}/${spawn.channel}${spawn.exitedAtMs === null ? '(结束时刻未回报)' : `(exit=${spawn.exitCode ?? spawn.exitSignal ?? '?'},${spawn.terminatedBy ?? '?'})`}`).join(' ')}`
      const cancelNote = run.cancel === null
        ? ''
        : `, 取消=${run.cancel.status}${run.cancel.killAttemptedPids.length > 0 ? `(代终止 ${run.cancel.killAttemptedPids.join(',')})` : ''}`
      this.log(releasedAtTaskEnd === false || run.cancelNotConfirmed ? 'warn' : 'info',
        `harness-pilot processpool: END ${run.task.name} (stop=${record.stopReason}, ${record.durationMs}ms, ${releaseNote}, ${ownedNote}${cancelNote})`)
    }

    this.drainQueue()
    this.armIdleReaper()
    this.writeSnapshot()
  }

  /** pid 存活探测；返回 `null` = **没测到**（不是「都不在了」）。 */
  private async alivePids(pids: readonly number[]): Promise<number[] | null> {
    if (pids.length === 0) return []
    if (process.platform === 'win32') {
      const out = await runCapture('tasklist', ['/FO', 'CSV', '/NH'])
      if (!out.ok) return null
      const present = new Set<number>()
      for (const line of out.stdout.split(/\r?\n/)) {
        const m = /^"[^"]+","(\d+)",/.exec(line.trim())
        if (m !== null) present.add(Number(m[1]))
      }
      if (present.size === 0) return null
      return pids.filter(pid => present.has(pid))
    }
    const alive: number[] = []
    for (const pid of pids) {
      try {
        process.kill(pid, 0)
        alive.push(pid)
      } catch {
        // ESRCH = 已经退出，正是我们要的结果
      }
    }
    return alive
  }

  /**
   * 直接借一个名额（给「外部托管的长期进程」用：pty/cdp/window 会话的句柄由调用方持有）。
   * 返回的 `release()` 只做记账 —— 真正关进程是调用方的事。
   */
  async acquire(task: PoolTask): Promise<{ readonly id: string, release: (note?: { readonly stopReason?: string }) => Promise<void> }> {
    const admission = await this.admit(task)
    if (admission.kind !== 'running') {
      // admit 在 wait 模式会一直等到有名额才 resolve，因此这里理论上到不了；
      // 真到了也必须显式失败，绝不能把"没拿到名额"当成"拿到了"。
      throw new PoolDeniedError('outcome-unknown-while-queued', `${task.name}: acquire() resolved without a running slot`, this.running.size, this.policy.maxConcurrency)
    }
    const run = this.running.get(admission.id)
    if (run !== undefined) run.external = true
    return {
      id: admission.id,
      release: async (note) => {
        await this.finish(admission.id, { stopReason: note?.stopReason ?? 'released' })
      },
    }
  }

  /**
   * 推荐入口：准入 → 跑 → 出口核对，一气呵成。
   *
   * `runner` 的返回值里带上 `spawnedPids`（transport 的 facts 或显式登记），
   * 池据此做「是否真的没了」的核对；不给 pid 就是 **未核对**（会计入 unconfirmed 的数，
   * 而不是被当成"干净"）。
   */
  async run<T>(
    task: PoolTask,
    runner: (ctx: {
      readonly id: string
      readonly notePid: (pid: number | undefined) => void
      readonly notePeakTreeMB: (mb: number | null) => void
      /**
       * **spawn 那一刻**登记 pid + 启动生命周期事实（推荐路径；返回结束回报回调）。
       *
       * 与 `notePid` 的区别是时序与信息量：`noteSpawn` 让池在**运行期**就拥有这份进程清单，
       * 并在出口拿到"退出码/信号/是否被取消"。只给一个裸 pid 也能记账，但取消/回收的
       * 可观测性会弱一档（那时 `spawnedFacts.observedVia` 会是 `facts` 而不是 `spawn-hook`）。
       */
      readonly noteSpawn: (fact: SpawnObservation) => SpawnExitReporter
    }) => Promise<{
      readonly value: T
      readonly spawnedPids?: readonly number[]
      readonly stopReason?: string
      readonly diagnostic?: string
    }>,
  ): Promise<T> {
    const admission = await this.admit(task)
    const ctx = {
      id: admission.id,
      notePid: (pid: number | undefined): void => this.notePid(admission.id, pid),
      notePeakTreeMB: (mb: number | null): void => this.notePeakTreeMB(admission.id, mb),
      noteSpawn: (fact: SpawnObservation): SpawnExitReporter => this.noteSpawn(admission.id, fact),
    }
    try {
      const result = await runner(ctx)
      for (const pid of result.spawnedPids ?? []) this.notePid(admission.id, pid)
      await this.finish(admission.id, { ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }), ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }) })
      return result.value
    } catch (error: unknown) {
      await this.finish(admission.id, {
        stopReason: 'error',
        diagnostic: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  // ── 空闲回收（核对口径，不是"声称已释放"） ─────────────────────────────

  private armIdleReaper(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    if (this.running.size > 0) {
      this.idleSinceMs = null
      return
    }
    if (this.idleSinceMs === null) this.idleSinceMs = this.now()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      void this.reapIdle('timer')
    }, this.policy.idleReapMs)
    if (this.idleTimer.unref !== undefined) this.idleTimer.unref()
  }

  /**
   * 空闲回收：在**空闲窗口**到点后核对「本池拉起过的进程是否真的都没了」，
   * 并给出**回收前后**的完整进程集合（进程数 / 内存）对比。
   *
   * 为什么不在这里杀进程：headless / acp 的出口已经 `killTree()` 掉整棵树，
   * 池再杀一次是多余且危险的（pid 可能已被系统复用）。池的职责是**核对并留证**：
   * 残留就进 `lingeringAfterIdle` 并 warning，而不是假装回收成功。
   *
   * ⚠️ 对比口径是**完整进程集合**（本机全部进程，`tasklist /FO CSV /NH` 全表，
   * 与 `/diag/processes` 同源同口径），不是只看自己那棵树 —— 后者会让
   * "回收后进程数回到基线"这句话在一个有 400 个进程的机器上失去意义。
   */
  async reapIdle(reason: 'timer' | 'manual' | 'dispose' = 'manual'): Promise<{
    readonly checked: number
    readonly lingering: readonly number[]
    readonly unconfirmed: number
    readonly windowMs: number
    readonly ownedPidsChecked: readonly number[]
    readonly inventoryBefore: ProcessSetSample | null
    readonly inventoryAfter: ProcessSetSample | null
    /** `null` = 有一侧没测到（**不当作 0**）。 */
    readonly deltaProcesses: number | null
    readonly deltaMB: number | null
  }> {
    const pending = this.recentRuns.filter(run => run.releasedAfterIdle === null && run.spawnedPids.length > 0)
    // 回收**前**的完整进程集合。
    const inventoryBefore = await sampleProcessSet()
    if (inventoryBefore !== null) this.vendorSample = inventoryBefore
    let unconfirmed = 0
    const lingeringAll: number[] = []
    const ownedPidsChecked: number[] = []
    for (const record of pending) {
      ownedPidsChecked.push(...record.spawnedPids)
      const alive = await this.alivePids(record.spawnedPids)
      if (alive === null) {
        unconfirmed += 1
        continue
      }
      record.releasedAfterIdle = alive.length === 0
      record.lingeringPids = alive
      if (alive.length > 0) lingeringAll.push(...alive)
    }
    if (unconfirmed > 0) this.unconfirmedReleases += unconfirmed
    if (lingeringAll.length > 0) this.lingeringAfterIdle = [...new Set([...this.lingeringAfterIdle, ...lingeringAll])]
    // 回收**后**的完整进程集合（与 before 同口径）。
    const inventoryAfter = await sampleProcessSet()
    if (inventoryAfter !== null) this.vendorSample = inventoryAfter
    this.idleReapRuns += 1
    this.lastIdleReapAtMs = this.now()
    // 非 external 的已结算运行保留在 recentRuns 里供查询；这一轮核对完就清掉 idle 计时，
    // 等下一次任务结束再重新计时（窗口语义 = 「距最后一次任务结束」）。
    this.idleSinceMs = this.running.size === 0 ? this.now() : null

    const checked = pending.length
    const deltaProcesses = inventoryBefore === null || inventoryAfter === null
      ? null
      : inventoryAfter.totalProcesses - inventoryBefore.totalProcesses
    const deltaMB = inventoryBefore === null || inventoryAfter === null
      ? null
      : Math.round((inventoryAfter.totalMB - inventoryBefore.totalMB) * 10) / 10
    // 树外厂商进程在对比期间是否变过（如实报告；**不是**本池所为 —— 本池从不终止这些 pid）。
    const vendorBefore = (inventoryBefore?.vendorProcesses ?? []).map(row => row.pid).sort((a, b) => a - b)
    const vendorAfter = (inventoryAfter?.vendorProcesses ?? []).map(row => row.pid).sort((a, b) => a - b)
    const vendorChanged = inventoryBefore !== null && inventoryAfter !== null
      && JSON.stringify(vendorBefore) !== JSON.stringify(vendorAfter)
      ? { before: vendorBefore, after: vendorAfter }
      : null
    const record: ReapRecord = {
      at: new Date(this.now()).toISOString(),
      reason,
      windowMs: this.policy.idleReapMs,
      checkedRuns: checked,
      ownedPidsChecked: [...new Set(ownedPidsChecked)],
      lingering: [...new Set(lingeringAll)],
      unconfirmed,
      inventoryBefore,
      inventoryAfter,
      deltaProcesses,
      deltaMB,
      vendorChanged,
      note: inventoryBefore === null || inventoryAfter === null
        ? '完整进程集合采样失败（工具不可用）—— 对比值记为 null，**不当作 0 残留**。'
        : `完整进程集合口径（tasklist 全表，与 /diag/processes 同源）：${inventoryBefore.totalProcesses}个/${inventoryBefore.totalMB}MB → `
          + `${inventoryAfter.totalProcesses}个/${inventoryAfter.totalMB}MB；其中树外厂商常驻进程 `
          + `${inventoryAfter.vendorProcessCount}个/${inventoryAfter.vendorTotalMB}MB（**只统计，不终止、不归因**）。`,
    }
    this.reapRecords = [record, ...this.reapRecords].slice(0, 20)

    if (lingeringAll.length > 0) {
      this.log('warn', `harness-pilot processpool: idle reaping (${reason}) — ${lingeringAll.length} pid(s) from this pool are STILL alive after ${this.policy.idleReapMs}ms idle: ${[...new Set(lingeringAll)].join(', ')}。如实报告，不隐藏。`)
    } else if (checked > 0 || reason === 'manual') {
      this.log('info', `harness-pilot processpool: idle reaping (${reason}) — checked ${checked} finished run(s), 0 lingering${unconfirmed > 0 ? `, ${unconfirmed} unconfirmed (工具失败)` : ''} (window ${this.policy.idleReapMs}ms)；`
        + `完整进程集合 ${inventoryBefore?.totalProcesses ?? '?'}个→${inventoryAfter?.totalProcesses ?? '?'}个 / ${inventoryBefore?.totalMB ?? '?'}MB→${inventoryAfter?.totalMB ?? '?'}MB`)
    }
    if (vendorChanged !== null) {
      this.log('warn', `harness-pilot processpool: 对比期间树外厂商常驻进程集合发生变化（before=[${vendorChanged.before.join(',')}] after=[${vendorChanged.after.join(',')}]）。`
        + '本池**没有**终止这些 pid（它们从不在本池的 owned 清单里）——如实报告，不做归因。')
    }
    this.appendEvent({
      event: 'idle-reap',
      reason,
      checked,
      ownedPidsChecked: record.ownedPidsChecked,
      lingering: record.lingering,
      unconfirmed,
      inventoryBefore: inventoryBefore === null ? null : { processes: inventoryBefore.totalProcesses, mb: inventoryBefore.totalMB },
      inventoryAfter: inventoryAfter === null ? null : { processes: inventoryAfter.totalProcesses, mb: inventoryAfter.totalMB },
      deltaProcesses,
      deltaMB,
    })
    this.writeSnapshot()
    return {
      checked,
      lingering: [...new Set(lingeringAll)],
      unconfirmed,
      windowMs: this.policy.idleReapMs,
      ownedPidsChecked: record.ownedPidsChecked,
      inventoryBefore,
      inventoryAfter,
      deltaProcesses,
      deltaMB,
    }
  }

  noteReapedSessions(targets: readonly string[]): void {
    if (targets.length === 0) return
    this.sessionsReaped += targets.length
    this.sessionsReapedTargets = [...this.sessionsReapedTargets, ...targets].slice(-50)
    this.log('info', `harness-pilot processpool: idle reaping closed ${targets.length} interactive session(s): ${targets.join(', ')}`)
    this.writeSnapshot()
  }

  // ── 观测 ────────────────────────────────────────────────────────────────

  /** 队列排队时长分位数（用于回答「排队是可观察的」）。 */
  queueStats(): { readonly count: number, readonly p50: number, readonly p90: number, readonly max: number } {
    const waits = this.recentRuns.filter(r => r.queuedMs > 0).map(r => r.queuedMs).sort((a, b) => a - b)
    if (waits.length === 0) return { count: 0, p50: 0, p90: 0, max: 0 }
    const at = (q: number): number => waits[Math.min(waits.length - 1, Math.floor(q * waits.length))] ?? 0
    return { count: waits.length, p50: at(0.5), p90: at(0.9), max: waits[waits.length - 1] ?? 0 }
  }

  /** 单个任务名最近一次的排队时长（毫秒）；没排过队或没跑过 → `undefined`。 */
  queueWaitBudgetOf(name: string): number | undefined {
    const record = this.recentRuns.find(run => run.name === name)
    if (record !== undefined) return record.queuedMs
    // 被拒绝的那条**也有**等待时长 —— 只查 recentRuns 会让"排队超时被拒"变成查不到的黑洞。
    const denial = this.recentDenials.find(entry => entry.name === name)
    return denial?.waitedMs
  }

  /** 最近被拒绝的请求（名字 / 原因 / 等了多久），最新在前。 */
  denialLog(): readonly { readonly name: string, readonly reason: DenyReason, readonly waitedMs: number, readonly at: string }[] {
    return this.recentDenials.map(entry => ({ name: entry.name, reason: entry.reason, waitedMs: entry.waitedMs, at: new Date(entry.at).toISOString() }))
  }

  describe(): PoolSnapshot & { readonly queueStats: ReturnType<ProcessPool['queueStats']> } {
    return {
      at: new Date(this.now()).toISOString(),
      loadedAt: new Date(this.loadedAtMs).toISOString(),
      moduleFile: this.moduleFile,
      policy: { ...this.policy },
      running: this.running.size,
      runningNames: [...this.running.values()].map(run => run.task.name),
      queueLength: this.queue.length,
      queued: this.queue.map((entry, index) => ({ id: entry.id, name: entry.task.name, position: index + 1, waitingMs: this.now() - entry.enqueuedAt })),
      peakConcurrency: this.peakConcurrency,
      admittedToRun: this.admittedTotal,
      completedRuns: this.completedRuns,
      denied: { ...this.deniedCounts },
      deniedTotal: Object.values(this.deniedCounts).reduce((sum, n) => sum + n, 0),
      deniedWaitMs: JSON.parse(JSON.stringify(this.deniedWaits)) as Record<DenyReason, { count: number, totalMs: number, maxMs: number }>,
      unconfirmedReleases: this.unconfirmedReleases,
      lingeringAtTaskEnd: [...this.lingeringAtTaskEnd],
      lingeringAfterIdle: [...this.lingeringAfterIdle],
      idleWindowMs: this.policy.idleReapMs,
      idleSince: this.idleSinceMs === null ? null : new Date(this.idleSinceMs).toISOString(),
      idleReapRuns: this.idleReapRuns,
      lastIdleReapAt: this.lastIdleReapAtMs === null ? null : new Date(this.lastIdleReapAtMs).toISOString(),
      sessionsReaped: this.sessionsReaped,
      sessionsReapedTargets: [...this.sessionsReapedTargets],
      spawnedTotal: this.spawnedTotal,
      ownedPids: [...new Set([
        ...[...this.running.values()].flatMap(run => [...run.pids]),
        ...this.recentRuns.flatMap(run => run.spawnedPids),
      ])].sort((a, b) => a - b),
      runningOwnedPids: [...this.running.values()].map(run => ({ id: run.id, name: run.task.name, pids: [...run.pids] })),
      cancellations: {
        requested: this.cancelRequested,
        confirmed: this.cancelConfirmed,
        notConfirmed: this.cancelNotConfirmed,
      },
      reapRecords: [...this.reapRecords],
      lastReap: this.reapRecords[0] ?? null,
      vendorProcesses: this.vendorSample,
      recentRuns: [...this.recentRuns],
      queueStats: this.queueStats(),
      // 压力观测（P5，最小字段）：池自身的在飞/排队 + **整机**内存水位（不是进程树相加，
      // 共享内存不重复计入的诚实口径；进程树级统计在 /diag/processes）。
      pressure: {
        running: this.running.size,
        queueLength: this.queue.length,
        ownedPidCount: [...new Set([
          ...[...this.running.values()].flatMap(run => [...run.pids]),
          ...this.recentRuns.flatMap(run => run.spawnedPids),
        ])].length,
        systemFreeMemMb: Math.round(freemem() / 1_048_576),
        systemTotalMemMb: Math.round(totalmem() / 1_048_576),
        sampledAt: new Date(this.now()).toISOString(),
      },
      notes: [
        '本池只对**自己拉起**的进程树负责（`ownedPids` / 每次运行的 `spawnedPids`+`spawnedFacts` 就是它的全部清单）；'
        + '这些 pid 都来自 transport 在 `spawn()` 处的真实回报或派发结果 facts —— **不是**全机快照、也**不是**按进程名猜的。',
        '树外厂商常驻守护进程（如 opencode `serve --service`）只出现在 `vendorProcesses`（统计口径），'
        + '**从不**进入 ownedPids，因此**绝不**被本池终止，也不做归因（无法只凭进程名区分谁拉起的）。',
        '完整进程集合口径的内存统计在 `/diag/processes`（树内 + 树外都在）；本池的 `reapRecords` 用**同源同口径**'
        + '的采样给出回收前后的进程数/内存对比，两者应能相互对上。',
        '超限只有两种结果：显式排队（queued）或显式拒绝（denied）。**没有**「超限就换通道 / 换 harness / 悄悄丢掉」这条路径。',
        'releasedAtTaskEnd / releasedAfterIdle 是**实测**核对（tasklist / kill -0）；`null` 表示没核到，绝不当成 0 残留。',
        '取消（abort）会在运行期即时记账（`cancel.requestedAt`），并在宽限期后**实测**拥有的 pid 是否真的终止：'
        + '`status=clean` 才算取消成功；`not-confirmed` 是**显式失败标注**（连"没能力代为终止"也会写明），绝不静默放过。',
        '⚠️ `/diag/loaded` 的 SELF_MODULES 现已包含 processpool.js 与 transports/headless.js'
        + '（实测 anyStale===false 时两者 loaded/disk 哈希逐字一致）；2026-10-14 扩项后'
        + ' transports/acp.js / mcp-bridge.js / catalog-edit.js / provider.js 也已进清单，'
        + '所以「仍未覆盖 transports/acp.js」这句已作废 —— 但 anyStale 只证明**这份进程**跑的是当前源码，'
        + '不证明那条能力真的被接线/被调用（仍需行为取证）。'
        + '本轮（2026-10-14 第二次扩项）改成**穷尽规则**：`lib/` 下递归的全部 `.js`（排除浏览器侧 client.js）'
        + '都在清单里（43 项 —— 含本轮新增的 `account-managers.js`、`account-target.js` 与上一轮的 `team-routing.js`），'
        + '因此 `federation/` 的 12 个模块、`models.js`、`mcp-bridge-proxy.js`、'
        + '`task-tools.js` 等此前的盲区**已全部消除** —— 「清单外还有相关模块」这句话现在不再成立。'
        + '池自身另有 loadedAt / moduleFile 可核对"跑的是不是新代码"。',
      ],
    }
  }

  /** 落盘快照。失败**不抛**（观测不能把派发带崩），但会在下一条日志里说明。 */
  writeSnapshot(): void {
    if (this.stateFile === undefined) return
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, `${JSON.stringify(this.describe(), null, 2)}\n`, { encoding: 'utf8' })
    } catch (error: unknown) {
      this.log('warn', `harness-pilot processpool: cannot write pool state file (${this.stateFile}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 追加一条事件行（jsonl），供事后按时间轴复盘「谁在什么时候被拒/被回收」。 */
  appendEvent(event: Record<string, unknown>): void {
    if (this.stateFile === undefined) return
    try {
      appendFileSync(join(dirname(this.stateFile), 'processpool-events.jsonl'), `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...event })}\n`, { encoding: 'utf8' })
    } catch {
      // 事件落盘失败不影响派发
    }
  }

  /** dispose：把计时器收干净（**不**杀任何进程 —— 进程由 transport 自己收尾）。 */
  dispose(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    for (const timer of [...this.cancelTimers]) {
      clearTimeout(timer)
      this.cancelTimers.delete(timer)
    }
    for (const run of this.running.values()) {
      if (run.abortListener !== undefined && run.task.signal !== undefined) {
        run.task.signal.removeEventListener('abort', run.abortListener)
        run.abortListener = undefined
      }
    }
    for (const entry of [...this.queue]) {
      this.removeFromQueue(entry)
      entry.reject(new PoolDeniedError(
        'aborted-while-queued',
        `${entry.task.name} 仍在排队时插件被卸载。未执行。`,
        this.running.size,
        this.policy.maxConcurrency,
      ))
    }
    this.writeSnapshot()
  }
}

/**
 * 本模块自己的文件路径提示（`moduleFile`）。
 *
 * 用途只有一个：事后判断「池快照是哪一个 processpool.js 写的」。不读文件内容、
 * 不做哈希 —— 那个能力属于 `/diag/loaded`（且它当前不覆盖本文件）。
 */
function modulePathHint(): string {
  try {
    return new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  } catch {
    return '(unknown)'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 与 transport 结果的桥接（保持 processpool 不依赖 types.js，避免循环引用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从一次 `DispatchOutcome.facts` 里摘出**真实存在过的 pid**。
 *
 * 只认名字里含 `pid` 的数值字段（headless/acp 现在会写 `facts.pid`；pty 一直写
 * `facts.pid`）。摘不到就返回空数组 —— 空数组的语义是「**未登记** pid」，
 * 会在出口核对时体现为「没有可核对的 pid」，而不是「核对通过」。
 *
 * ⚠️ 正因如此，**任何数值型 fact 都不许起含 `pid` 的名字**（`pidStartedAt` 会被当成 pid）。
 * 生命周期时刻请用 `spawnedAtMs` / `exitedAtMs`。
 */
export function pidsFromFacts(facts: Record<string, string | number | boolean | undefined> | undefined): number[] {
  if (facts === undefined) return []
  const out: number[] = []
  for (const [key, value] of Object.entries(facts)) {
    if (!/pid/i.test(key)) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    out.push(Math.round(value))
  }
  return out
}
