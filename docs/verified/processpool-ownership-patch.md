# 进程池「owned 进程 / 取消 / 空闲回收」的 `src/index.ts` 接线补丁（交 Lead 串行集成）

> **背景**：`src/index.ts` 的写入所有权归 **M**（见 `docs/verified/write-ownership.md`），
> 本路（owned-process 修复）**没有**改它。下面三条是**精确补丁**（文件 / 锚点 / 要加的行），
> 由 Lead 在 M 释放后串行集成。
>
> **重要**：本路所有已取证的结论（88/88 探针、宿主账目、14/14 与 10/10 回归）**都不依赖**
> 这三条补丁 —— 进程池默认就会把快照落到 `<pluginHome>/run/processpool-state.json`，
> 默认策略也能观测。补丁解决的是「设置页的上限 / 便捷只读出口 / 厂商名单单一来源」三件**便利性与一致性**问题。

---

## 补丁 1（**有实质影响**）：把运行时 `maxConcurrent` 推给进程池

**问题（实测）**：运行中的宿主用 `new SessionRegistry({ config, helper, … })` 建注册表，
**没有**传 `pool` 策略；而设置页的 `maxConcurrent` 只推给了 `TaskManager`
（`tasks.setMaxConcurrent(...)`）。于是**进程池的并发上限恒为默认 4**，
用户在设置页把它改成 2 或 8 时，**直连派发**（`harness_dispatch` / `/dispatch`）那条路径**不受影响**。
这不是本路引入的缺陷，但正是「上限要跟着设置走」这条要求的最后一段接线。

**锚点 1a — import**（在 `src/index.ts:118` 的 `import { SessionRegistry } from './sessions.js'` 之后加一行）：

```ts
import { applyRuntimeConcurrency, VENDOR_DAEMON_IMAGE } from './processpool.js'
```

**锚点 1b — 初始策略**（`src/index.ts:3044` 的 `let runtimeSettings: RuntimeSettings = loadSettings()` 之后加）：

```ts
  // 运行时 maxConcurrent 必须**同时**推给进程池：否则设置页改了上限，直连派发仍按默认 4 走。
  registry.setPoolPolicy(applyRuntimeConcurrency(runtimeSettings.maxConcurrent))
```

**锚点 1c — 设置页改动时**（`src/index.ts:3140` 的 `tasks.setMaxConcurrent(runtimeSettings.maxConcurrent)` 之后加一行）：

```ts
    registry.setPoolPolicy(applyRuntimeConcurrency(runtimeSettings.maxConcurrent))
```

> 说明：`setPoolPolicy` **只影响之后的新准入**（已在跑的不动），这是刻意设计：中途改上限会让
> 「谁被算了」不可解释；被拒绝的那条会带可读文本回到调用方（不会静默改道）。
> `queueMode` 默认 `'reject'`（显式拒绝，最可审计）；要改成排队，给 `applyRuntimeConcurrency` 传第二个参数 `'wait'`。

---

## 补丁 2（只读出口）：`GET /diag/processpool`

**目的**：让「池此刻拥有哪些进程 / 取消账 / 最近一次空闲回收的前后对比」能**不读文件、不重启**地看到。

**锚点 2a — `ApiExtras`**（`src/index.ts` 的 `export interface ApiExtras {` 内，
紧跟 `pool?: { … }`（账号池）那一段之后加）：

```ts
  /**
   * 进程池的只读出口（并发闸门 / owned 进程 / 取消 / 空闲回收证据）。
   * 未挂载时 `/diag/processpool` 返回 503，**不**假装有数据。
   */
  processPool?: () => { readonly describe: () => unknown, readonly eventLog: () => unknown }
```

**锚点 2b — 路由**（`src/index.ts` 里 `/diag/loaded` 那个 `if` 块（以
`json(200, { ...loadedCodeReport(), pluginVersion: pluginVersion() })` + `return` + `}` 收尾）**之后**插入）：

```ts
      // ── GET /diag/processpool：并发闸门 / owned 进程 / 取消 / 空闲回收的只读快照 ──
      // 「我拉起了哪些进程、它们何时起止、取消有没有真的终止、空闲回收前后完整进程集合差多少」
      // 都能在这里看到；数据由池自己写（`ProcessPool.describe()`），这里只读、不触发任何动作。
      if (url.pathname === `${API_PATH}/diag/processpool`) {
        if (method !== 'GET') {
          methodNotAllowed('GET')
          return
        }
        const pool = extras.processPool?.()
        if (pool === undefined) {
          json(503, { error: 'process pool is not mounted in this composition' })
          return
        }
        json(200, { ...(pool.describe() as Record<string, unknown>), events: pool.eventLog() })
        return
      }
```

**锚点 2c — 挂载**（`src/index.ts:3856` 的 `pool: poolExtras,` 之后加一行）：

```ts
        processPool: () => ({ describe: () => registry.pool().describe(), eventLog: () => registry.poolEventLog() }),
```

---

## 补丁 3（单一事实来源）：厂商常驻进程名单

**现状**：`src/index.ts:328` 与 `src/processpool.ts` 各写了一份厂商映像名正则，两份将来会漂移。

**锚点 3 — 替换**（`src/index.ts:328`）：

```ts
// 单一事实来源：与进程池的统计口径同一份（`src/processpool.ts` 导出）。
const VENDOR_DAEMON = VENDOR_DAEMON_IMAGE
```

（配合锚点 1a 的 import。）两份语义**逐字相同**，所以这是纯重构，不改变
`/diag/processes` 的任何输出；改完之后「树外厂商进程只统计、不终止、不归因」这条纪律就只有一处定义。

---

## 集成后建议的最小验证（不消耗模型额度）

1. `node scripts/build.mjs`（退出 0）；
2. 等约 20 s，`GET /harness-pilot/api/diag/loaded` 应 `anyStale=false`，
   且 `processpool.js` 的 `loadedHash === diskHash`；
3. `GET /harness-pilot/api/diag/processpool` 应 200，并含
   `ownedPids` / `runningOwnedPids` / `cancellations` / `lastReap` / `vendorProcesses` 字段；
4. `GET /harness-pilot/api/diag/processes` 的输出**应与补丁 3 之前逐字一致**（纯重构的判据）；
5. 设置页把 `maxConcurrent` 改成 1 保存 → 再取 `/diag/processpool`，`policy.maxConcurrency` 应为 1
   （补丁 1 的判据）。
