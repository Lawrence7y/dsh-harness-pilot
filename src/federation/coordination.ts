/**
 * 账号切换的**并发协调**（纯逻辑，可离线单测）。
 *
 * ## 要解决的三个真实风险
 * 1. **互相覆盖登录态**：两个任务同时对同一个账号做切换/登录类动作，后一个会踩掉前一个。
 * 2. **反复切换**：多个任务几乎同时发现「当前账号额度耗尽」，于是各自切一次，
 *    结果在几个账号之间来回横跳，每次切换都要重新建立会话。
 * 3. **重复消耗同一账号**：切到同一个目标账号后，多个任务挤在一起，把它也迅速耗尽。
 *
 * ## 做法
 *   · **租约（lease）**：对某个账号的「切换/登录类动作」同一时刻只允许一个持有者，
 *     租约**带过期时间**（持有者崩了不会永久死锁）。
 *   · **抑制窗口（suppression window）**：某个账号刚被切过去，短时间内**不再重复切**，
 *     让多个并发任务复用这一次切换的结果，而不是各切各的。
 *   · **目标账号并发上限**：同一个目标账号同时承载的任务数有上限，避免把一个账号挤爆。
 *
 * ## 边界（必须说清）
 *   · 这是**进程内**协调：DSH 重启或换进程后状态清零（不做分布式锁 —— 本插件是单进程模型）；
 *   · 只协调「切换动作」，**不碰凭据**，也不代替各 Harness 自己的登录互斥；
 *   · 租约过期只是**防死锁**，不代表动作成功。
 *
 * ## 脱敏边界（返回给调用方的**文本**必须脱敏，内部状态必须保留原始 id）
 * 本模块返回的 `reason` 会**原样**进入切换账本（`index.ts` 把它写进 `SwitchEventRecord.reason`）
 * 并**原样渲染**到账号池事件表（`client.js` 的 `h('td', …, str(e.reason))`）。实测过：
 * 并发租约拒绝的 reason 里裸插账号 id，用户在真实浏览器里**直接看到了原始账号名**。
 *
 * 而账本自己的落盘校验 `findUnredacted` **只扫 `fromAccount` / `toAccount`**，
 * 根本不看 `reason` / `detail` —— 所以这里漏出去的 id，那道闸门**拦不住**。
 * 结论：脱敏必须在**拼 reason 的地方**做（本文件），不能指望下游某个渲染点自觉。
 *
 * 两条纪律：
 *   · **只脱敏返回文本**：`state.leases` / `state.assignments` / `state.recentSwitches`
 *     的**索引键**继续用**原始** accountId —— 换成脱敏标签会让租约查不到自己
 *     （`leases[accountId]` 命中失败 = 租约形同虚设，两个任务会同时改同一个账号登录态）；
 *   · **复用既有的 `redactAccount`**（`poolconfig.ts`），不另造第二套边界 ——
 *     否则同一个账号在事件表里会显示成两个不同标签，跨页对照失效。
 */

// 复用账号池同一套脱敏（`acct:…<尾 2 位><长度 36 进制>`）：同一账号输出**稳定相同**，便于对照。
// 依赖方向是单向的：poolconfig → accounts/pool/quota，没有任何模块 import 本文件，故不构成循环。
import { redactAccount } from './poolconfig.js'

export interface Lease {
  readonly accountId: string
  readonly holder: string
  readonly acquiredAt: number
  readonly expiresAt: number
  /** 租约用途：切换 / 登录类动作。 */
  readonly purpose: 'switch' | 'login'
}

export interface CoordinationState {
  readonly leases: Readonly<Record<string, Lease>>
  /** 账号 → 最近一次「被切换过去」的时间。 */
  readonly recentSwitches: Readonly<Record<string, number>>
  /** 目标账号 → 当前承载它的任务集合。 */
  readonly assignments: Readonly<Record<string, readonly string[]>>
}

export const EMPTY_COORDINATION: CoordinationState = { leases: {}, recentSwitches: {}, assignments: {} }

export interface CoordinationPolicy {
  /** 租约时长（毫秒）。持有者崩了靠它自动释放。 */
  readonly leaseMs: number
  /** 抑制窗口：账号刚被切过去后，多久内不再重复切。 */
  readonly suppressionMs: number
  /** 同一个目标账号最多同时承载多少个任务。 */
  readonly maxTasksPerAccount: number
}

export const DEFAULT_COORDINATION: CoordinationPolicy = {
  leaseMs: 120_000,
  suppressionMs: 60_000,
  maxTasksPerAccount: 4,
}

export type AcquireResult =
  | { readonly ok: true, readonly lease: Lease }
  | { readonly ok: false, readonly reason: string, readonly heldBy?: string, readonly retryAfterMs?: number }

/** 清掉已过期的租约（**只**因过期释放，绝不因为「等太久」而抢占别人）。 */
export function reapExpired(state: CoordinationState, now: number): CoordinationState {
  const leases: Record<string, Lease> = {}
  for (const [accountId, lease] of Object.entries(state.leases)) {
    if (lease.expiresAt > now) leases[accountId] = lease
  }
  return { ...state, leases }
}

/**
 * 申请对某账号执行「切换 / 登录类动作」的租约。
 *
 * 同一账号同一时刻**只允许一个持有者**；租约过期后自动可被接管（防死锁）。
 */
export function acquire(
  state: CoordinationState,
  input: { accountId: string, holder: string, purpose: Lease['purpose'], now: number },
  policy: CoordinationPolicy = DEFAULT_COORDINATION,
): { readonly state: CoordinationState, readonly result: AcquireResult } {
  const reaped = reapExpired(state, input.now)
  const existing = reaped.leases[input.accountId]
  if (existing !== undefined) {
    if (existing.holder === input.holder) {
      // 同一个持有者重复申请 → 续租，不报错（幂等，避免调用方自己把自己挡住）
      const renewed: Lease = { ...existing, acquiredAt: input.now, expiresAt: input.now + policy.leaseMs }
      return { state: { ...reaped, leases: { ...reaped.leases, [input.accountId]: renewed } }, result: { ok: true, lease: renewed } }
    }
    return {
      state: reaped,
      result: {
        ok: false,
        // ⚠️ `input.accountId` 是**原始**账号 id，绝不能裸插进 reason —— 这行会进账本、上界面。
        reason: `账号 ${redactAccount(input.accountId)} 正被另一个任务（${existing.holder}）执行${existing.purpose === 'login' ? '登录' : '切换'}类动作，本次不同时进行以免互相覆盖登录态`,
        // ⚠️ `heldBy` **故意保持原样**：它的值是 `input.scope.id`（会话 / 任务 / 团队成员 id），
        // **不是**账号 id（见 index.ts 的 acquire 调用：`holder: input.scope.id`）。
        // 过一层 redactAccount 会把它变成 `acct:…` 形状 —— 那是**谎报**（把非账号说成账号），
        // 还会与调用方自己的 scope 标识对不上；`verify-quota-pool.mjs` 的 F1 也断言了
        // `heldBy === 'task-1'`。所以这里只把「账号 id」这一项脱敏，`heldBy` 保持可读的机器档案 id。
        heldBy: existing.holder,
        retryAfterMs: Math.max(0, existing.expiresAt - input.now),
      },
    }
  }
  const lease: Lease = {
    accountId: input.accountId,
    holder: input.holder,
    acquiredAt: input.now,
    expiresAt: input.now + policy.leaseMs,
    purpose: input.purpose,
  }
  return { state: { ...reaped, leases: { ...reaped.leases, [input.accountId]: lease } }, result: { ok: true, lease } }
}

export function release(state: CoordinationState, accountId: string, holder: string): CoordinationState {
  const existing = state.leases[accountId]
  // 只有持有者自己能释放 —— 否则一个任务会解掉别的任务的锁。
  if (existing === undefined || existing.holder !== holder) return state
  const leases = { ...state.leases }
  delete leases[accountId]
  return { ...state, leases }
}

/**
 * 是否应**抑制**这次切换。
 *
 * 场景：多个并发任务几乎同时发现当前账号额度耗尽，各自都想切。
 * 若不做抑制，会出现「任务 A 切到 B、任务 B 也切到 B、任务 C 又切一次」这种反复切换，
 * 每次都重建会话。这里让窗口内的重复切换**复用**第一次的结果。
 */
export function shouldSuppressSwitch(
  state: CoordinationState,
  accountId: string,
  now: number,
  policy: CoordinationPolicy = DEFAULT_COORDINATION,
): { readonly suppress: boolean, readonly reason: string, readonly sinceMs?: number } {
  const last = state.recentSwitches[accountId]
  if (last === undefined) return { suppress: false, reason: '该账号近期没有被切换过' }
  const elapsed = now - last
  if (elapsed >= policy.suppressionMs) {
    return { suppress: false, reason: `距上次切到该账号已 ${Math.round(elapsed / 1000)}s，超过抑制窗口`, sinceMs: elapsed }
  }
  return {
    suppress: true,
    sinceMs: elapsed,
    reason: `该账号在 ${Math.round(elapsed / 1000)}s 前刚被切过去（抑制窗口 ${Math.round(policy.suppressionMs / 1000)}s）：`
      + '本次复用那一次切换的结果，而不是再切一次 —— 避免多任务反复切换、重复重建会话',
  }
}

export function noteSwitch(state: CoordinationState, accountId: string, now: number): CoordinationState {
  return { ...state, recentSwitches: { ...state.recentSwitches, [accountId]: now } }
}

/**
 * 登记「某任务现在用某账号」。返回是否允许（超出目标账号并发上限则拒绝）。
 * 目的是避免多个任务挤在同一个账号上把它也迅速耗尽。
 */
export function assign(
  state: CoordinationState,
  input: { accountId: string, taskId: string, now: number },
  policy: CoordinationPolicy = DEFAULT_COORDINATION,
): { readonly state: CoordinationState, readonly ok: boolean, readonly reason: string } {
  const current = state.assignments[input.accountId] ?? []
  if (current.includes(input.taskId)) {
    return { state, ok: true, reason: '该任务已在用这个账号（幂等）' }
  }
  if (current.length >= policy.maxTasksPerAccount) {
    return {
      state,
      ok: false,
      // 同上：`input.accountId` 是原始 id，返回文本必须过 redactAccount。
      reason: `目标账号 ${redactAccount(input.accountId)} 已承载 ${current.length} 个任务（上限 ${policy.maxTasksPerAccount}）：`
        + '再挤进去会把它也迅速耗尽，请等待或选择另一个账号',
    }
  }
  return {
    state: { ...state, assignments: { ...state.assignments, [input.accountId]: [...current, input.taskId] } },
    ok: true,
    // 同上。注意 `state.assignments` 的**索引键**仍是原始 id（脱敏只发生在这行文本上）。
    reason: `已登记：${redactAccount(input.accountId)} 现在承载 ${current.length + 1} 个任务`,
  }
}

export function unassign(state: CoordinationState, accountId: string, taskId: string): CoordinationState {
  const current = state.assignments[accountId]
  if (current === undefined) return state
  const next = current.filter(id => id !== taskId)
  const assignments = { ...state.assignments }
  if (next.length === 0) delete assignments[accountId]
  else assignments[accountId] = next
  return { ...state, assignments }
}
