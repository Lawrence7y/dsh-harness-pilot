
---

## 17. 进程生命周期 / 并发约束 / 空闲回收（本路：processpool）

> 只追加，不改上文。本节回答三件事：**按需启动**、**并发上限（超限显式排队或拒绝）**、
> **空闲回收**；并且把「完整进程集合」口径的内存实测一并落在这里。

### 17.1 现状核查（先读代码，不是照抄任务书）

| 事实 | 证据位置 |
|---|---|
| `SessionRegistry.dispatch()` 是**所有**派发的收敛点（`/dispatch`、`/task/start` 回调、`src/provider.ts` 子代理 provider、`harness_dispatch` 工具都经它） | `src/sessions.ts` `dispatch()`；`src/index.ts` `dispatch: async (spec, options) => await registry.dispatch(...)`；`src/provider.ts:160` |
| 这条路径上**原本没有任何并发闸门** | 核 `sessions.ts` 全文：`dispatch()` 直接 `this.run(chosen, request)`，无计数、无队列 |
| 唯一的 `maxConcurrent` 只挡 `harness_task_start` 一条入口，且是**抛错**不排队 | `src/tasks.ts:338`；`src/settings.ts` `maxConcurrent`（默认 4，设置页可编辑，0=不限） |
| 进程是**每任务起、任务出口清整棵树**（headless `spawn` + `killTree`；acp `spawn` + 任何出口 `killTree`） | `src/transports/headless.ts:14/59/96`、`src/transports/acp.ts:282/229` |
| `harness_open` 打开的长期会话（pty/cdp/window）在 `disposeAll()` 之前一直活着，**没有任何空闲回收** | `src/sessions.ts` `open()` / `create()` / `disposeAll()` |
| 完整进程集合口径**已有**（树内 + 树外厂商常驻，含 `opencode.exe serve --service`） | `src/index.ts` `processInventory()` ← `GET /harness-pilot/api/diag/processes` |

结论：缺的正是**并发上限**与**空闲回收**；「按需启动」本来就是这样，本节把它写成**不变量**并补了证据。

### 17.2 实现了什么

**新增 `src/processpool.ts`**（`ProcessPool` + `PoolPolicy` + `PoolDeniedError`），并在
`src/sessions.ts` 接线（`SessionDeps.pool` / `SessionDeps.poolStateFile`、`poolGate()`、
`closeIdleSessions()`、`setPoolPolicy()`、`poolEventLog()`）。

1. **按需启动**：池里没有任何预热/保活逻辑。唯一的进程诞生处仍是各 transport 的 `spawn`。
   池做的第一件事是**准入判定**，第二件事是**出口核对**。
2. **并发上限**（`maxConcurrency`，默认 4，与设置页 `maxConcurrent` 同源）：
   - `queueMode='reject'`（**默认**）：超限**立刻显式拒绝**，抛 `PoolDeniedError('at-capacity')`；
   - `queueMode='wait'`：**显式排队**，位置与 `waitingMs` 可观测；排队预算 =
     `min(queueWaitMs, 本次 timeoutMs)`，用完即**显式拒绝**（`queue-timeout`）；
     队列满则 `queue-full`，排队期间被取消则 `aborted-while-queued`。
   - 四种拒绝原因**全部计数并留时刻与等待时长**（`denied` / `deniedWaitMs` / `denialLog()`）。
3. **空闲回收**（`idleReapMs`，默认 30 s）：
   - 任务出口先**实测**「我登记过的 pid 是否已消失」（`tasklist` / `kill -0`）→
     `releasedAtTaskEnd`；空闲窗口到点后再核对一次 → `releasedAfterIdle`。
     核不到就记 `null` 并计入 `unconfirmedReleases`，**绝不**当成 0 残留。
   - `closeIdleSessions()` 按**最后一次真正使用**（`lastUsedAt`，Proxy 拦截
     read/send/evaluate/mouse/clickElement）关闭超窗长期会话，`dryRun` 可先看会发生什么。
   - 状态落盘 `<pluginHome>/run/processpool-state.json`（探针/运维**不重启**也能读）。

**零静默降级是怎么保证的**（不是靠约定，是靠代码形状）：

- 池的准入只有三个出口：`running` / `queued` / `throw PoolDeniedError` —— 没有第四条路；
- `SessionRegistry.poolGate()` 只捕获 `PoolDeniedError`，并把它翻成**可见的拒绝结果**
  （`stopReason=error`、`text=''`、`diagnostic` 里写"显式拒绝/没有执行"、`mismatch` 里写
  "**不会**改用别的通道、**不会**改用别的 harness"、`facts.poolDenied=true`）；
- 其余异常**原样上抛**（宁可让调用方看到失败，也不换成另一种执行方式）。

### 17.3 并发上限实测（离线单元，`probe/verify-processpool.mjs`，**全部 PASS**）

| 场景 | 实测 |
|---|---|
| 8 路同时打上限 2 | `admittedToRun=2`、`deniedTotal=6`、`peakConcurrency=2` ⇒ **2+6=8，零静默丢失** |
| 拒绝原因分布 | `{"at-capacity":6}`，无"原因不明"的失败 |
| 上限 2 / 拒绝式，第 3 条 | 抛 `PoolDeniedError('at-capacity')`；`queueLength=0`（**没有**偷偷排队）；`admittedToRun+deniedTotal=3`（账目闭合） |
| 上限 2 / 排队式，第 3、4 条 | `queueLength=2`、位置 `[1,2]`、`waitingMs` 在长；4 条**全部**跑完（排队是等，不是丢）；`queueStats={count:2,p50:408,max:408}` |
| 队列满 / 排队超预算 | `queue-full`（202 ms 内**立刻**拒绝）/ `queue-timeout`（实测等 1001 ms，预算 1000 ms）—— 两种都留痕 |
| 排队超时那条的等待时长 | `queueWaitBudgetOf('queued-1')=1001ms`、`denialLog()` 里可查（**不是查不到的黑洞**） |
| 空闲回收（真实 pid） | 登记 `[29744]` → 出口 `releasedAtTaskEnd=true`（tasklist 独立复核也在）→ 空闲窗口后 `releasedAfterIdle=true`、`lingering=[]`、`unconfirmed=0` |
| 诚实边界 | 没有 pid 可核对时 `spawnedPids=[]` 且两项保持 `null`（不假装核对过） |
| 策略归一化 | `NaN` 上限 → 回落默认 4（**不是 0=不限**）；未知 `queueMode` → 回落 `reject`（最保守）；负预算 → 钳到 1000 ms；显式 `0` 保留（用户明确选择） |

### 17.4 并发上限实测（在线：接在**真实派发收敛点**上，`probe/verify-processpool-live.mjs`，37/37 PASS）

在线探针直接 `new SessionRegistry({...})` 并调 `registry.dispatch()`（就是宿主走的那条路）：

- **[B] 显式拒绝可读**：占满 2 个名额后派一条真实目标 →
  `stopReason=error`、`textChars=0`、
  `facts={"poolDenied":true,"poolDenyReason":"at-capacity","poolRunning":2,"poolLimit":2,"ladder":"headless=ok …"}`；
  `diagnostic` =「并发闸门**显式拒绝**了 "agy:headless"：concurrency limit 2 reached …」；
  `mismatch` =「这是显式拒绝 —— **不会**改用别的通道、**不会**改用别的 harness、没有被静默丢弃，更没有被当成成功。」；
  被拒时**仍如实回报请求身份**（`{"harnessId":"agy","transport":"headless"}`）；
  池事件日志留下 `DENIED` 告警（`poolEvents=3`）。
- **[B] 账目**：`deniedTotal=1`、`admittedToRun` 仍是 2（被拒那条没占名额也没跑）。
- **[C] 真实派发一条**（目标 `agy`，prompt 最小化）：`stop=completed` 30569 ms、正文 586 字符；
  池账目出现 `agy:headless` 且 `stopReason` 与派发结果一致。
- **[D] 空闲回收 + 完整进程集合内存**（本进程 + 全部后代，递归算）：
  `回收前 1 个 / 49.9 MB → 子进程存活时 3 个 / 127.5 MB → 回收后 1 个 / 53.7 MB`；
  `releasedAtTaskEnd=true`、`releasedAfterIdle=true`、`lingering=[]`、`unconfirmed=0`。
- **[E] 长期会话空闲回收**：`dryRun` 能列出超窗候选、**不会**把刚用过的会话列进去；
  真实回收关掉了超窗会话（`close()` 被调用）、刚用过的仍活着、`sessionsReaped=1`。

### 17.5 并发验收未回归（用户点名的 2 WorkBuddy + 2 Qoder，**且这次是"带着闸门"跑的**）

```
wb-managed-a    http=200 stop=completed 13784ms chars=43 own-marker=YES foreign=[]
wb-managed-ai-b http=200 stop=completed 16786ms chars=43 own-marker=YES foreign=[]
qoder-cn-acct-a http=200 stop=completed 16884ms chars=60 own-marker=YES foreign=[]
qoder-cn-acct-b http=200 stop=completed 11258ms chars=60 own-marker=YES foreign=[]
PASS — 4 条并发真实任务各自拿到了只含自己标记的非空回复，且身份互不相同。
```

跑完后**立刻**读宿主池快照（`~/.dsh/plugins/harness-pilot/run/processpool-state.json`）：
`policy: max=4 mode=reject`、**`PEAK=4`**、四条账目就是上面那四条
（`wb-managed-a:acp` / `wb-managed-ai-b:acp` / `qoder-cn-acct-a:headless` / `qoder-cn-acct-b:headless`）。
⇒ **闸门真的在这 4 路并发里生效（峰值恰好 4），且没有误伤**（这四条全部 completed）。

三次独立复跑都成立：`PEAK=4`（第一次，`admittedToRun=9 denied=0`）、
`PEAK=4`（第二次，`admittedToRun=7 denied=1`）、以及 14/14 跑批里的第三次（`denied=0`）。

⚠️ 口径说明：最早一次 `verify-concurrency-acceptance` 也 PASS 了，但当时读快照读到的是**热重载之后**的计数器
（`peak=1`）—— 那次读数是**读错了时机**，**不作为**证据；上面这些 `PEAK=4` 都是**紧接着**运行读到的。

#### 17.5.1 闸门在**生产路径**上真的拒过一次（事实，不是演示）

第二次复跑后宿主账目为 `deniedTotal=1` / `deniedWaitMs['at-capacity']={count:1,maxMs:0}`：
有**一条真实派发**在 4 个名额被占满时被**立刻显式拒绝**（maxMs=0 = 没有排队、没有偷偷等待）。
具体是哪一条无法从池账目反推（`recentRuns` 只记跑起来的、`denialLog()` 只在内存里），
所以本节**不做归因**。事实与结论分开说：

- 事实：宿主在 14/14 跑批期间对一条请求给出了 `at-capacity` 显式拒绝；同一次跑批 **14/14 全 PASS**。
- 结论：这条拒绝**没有**变成静默丢弃，也没有把任何一条已发出的任务变成"看起来在跑其实没跑"。
- 代价（如实说）：`queueMode='reject'` 下，第 5 个并发请求会**被拒**而不是等待 —— 这是刻意的取舍
  （拒绝一定可见、可审计；排队会让调用方误以为已在执行）。要改成排队，只改一处开关：
  `applyRuntimeConcurrency(maxConcurrent, 'wait')`（见 17.11 补丁 ①）。

### 17.6 空闲回收 / 内存实测（**完整进程集合**口径，`probe/verify-idle-release.ps1`）

口径 = DSH 宿主整棵树（后代递归）**＋** 树外厂商常驻进程（`GET /diag/processes`，含 `vendorProcesses`）。
真实派发一次（`agy`，prompt 最小化，`stop=completed`，正文 251 字符）：

| 时点 | 完整进程集合 | 宿主树内 | harness 子进程 | 树外厂商常驻 |
|---|---|---|---|---|
| 基线 | 387 进程 / 8699 MB | 13 进程 / 1849.7 MB | **0** | 1 个 / 323.7 MB |
| 派发中（峰值） | — | **16 进程 / 2238.4 MB** | **1** | — |
| 空闲窗口后 | 384 进程 / 8545 MB | 13 进程 / 1846.3 MB | **0** | 1 个 / 316.1 MB |

判据：**树内 harness 子进程 0 → 1 → 0**；池账目新增 1 条运行、**其中仍活着的 pid：（无）✔ 零残留**、
未核对的运行 0。树外厂商常驻进程前后**都如实列出**（1 个，323.7 MB → 316.1 MB）——
它们不归本插件负责，也**绝不**被本插件终结，但**不会**从统计里消失。

### 17.7 回归（**14/14 PASS**）

跑批脚本：`node probe/_pool-regression-suite.mjs`（11 个用户点名项 + 本节新增 3 项；串行，失败且版本漂移才重试一次）。

```
verify-federation-registry     exit=0    verify-federation-providers    exit=0
verify-federation-accounts     exit=0    verify-federation-identity     exit=0
verify-ledger-prune            exit=0    verify-quota-pool              exit=0
verify-ui-smoke                exit=0    verify-llm-adapter-unit        exit=0
verify-team-observer-waterfall exit=0    verify-task-view-redaction     exit=0
verify-lease-reason-redaction  exit=0    verify-processpool             exit=0
verify-processpool-live        exit=0    verify-concurrency-acceptance  exit=0
=== 14/14 PASS ===   （at 2026-10-13T15:36:26Z；证据 probe/out/pool-regression-suite.json）
```

- **11/11 用户点名项全部 exit=0**（含本节明确要求的 `verify-task-view-redaction` /
  `verify-lease-reason-redaction`），其中 10 项 **retried=false**。
- `verify-ui-smoke` **retried=true**：它第一次失败在**热重载窗口**（跑批期间本路又构建过一次，
  `lib/index.js` 与 `lib/llm-adapter.js` 在此期间都被并发子代理换过哈希），
  脚本按既定纪律"只在失败**且**版本漂移时重试一次"，重试即 exit=0 —— 与"产品回归"是两件事，如实分开记。
- 断言总数：`verify-processpool` **58** 条、`verify-processpool-live` **37** 条，**failures=0**。
- **如实留档的一次失败（早期跑批）**：`verify-processpool-live` 曾 exit=1，两条原因都查清了：
  1. 断言文本写的是旧措辞（`不会改用别的通道`），而 `sessions.ts` 里的 mismatch 已改成
     `**不会**改用别的通道` —— **探针跟不上产品文案**，不是产品缺陷（已修断言）；
  2. 探针默认目标选了 `opencode`，而 `opencode run` 在本机**当前**报
     `Error: No endpoints found that support tool use.`（默认模型走 OpenRouter）→ 退出码 1、无 stdout。
     这是**环境/目标选型问题**，不是进程池的问题：换成 `agy` 后同一脚本 **37/37 PASS**。
     为避免后人再踩：默认目标已改为 `agy`，并把这条实测依据写进探针代码注释。

### 17.8 陈旧代码前置校验（含一个必须说清的**盲区**）

- 改动 `src/**` → `node scripts/build.mjs`（exit=0）→ 触 `lib/*.js` mtime → 等约 23 s →
  查 `GET /harness-pilot/api/diag/loaded`：**`anyStale=false`**，五个模块 loadedHash 均 = diskHash
  （本次取样：`index.js=d06afb9b2afb` / `tasks.js=2ff85e23efca` / `sessions.js=941b5d277b22` /
  `tools.js=fd79d3484f3f` / `llm-adapter.js=b961fb5d6adc`，`at=2026-10-13T15:38:43Z`）。
  （`index.js` / `llm-adapter.js` 的哈希在本次工作期间被**并发子代理**改过多次；
  本路只在每次取样时如实记录当时的值，不声称这些哈希由本路产生。）
- 构建非 0 期间核对过三个 client 工件：`client/client.js` = `client.js` = `lib/client.js` =
  `dab6d9cd6cb60fdc3fb7847d5aee54190731893cfa16d063fa885c34e9853372`（**未变**，收尾再核一次仍是它）。
- ⚠️ **盲区（不得读成"已覆盖"）**：`/diag/loaded` 的 `SELF_MODULES` 是
  `['index.js','tasks.js','sessions.js','tools.js','llm-adapter.js']`，**不含 `processpool.js`**。
  所以 `anyStale=false` **证明不了** `processpool.js` 不是旧的。本次判断"池是新的"用的是
  **池快照自己的 `loadedAt` / `moduleFile`**（`run/processpool-state.json`）——
  这也是 `ProcessPool.describe()` 把这两项放进快照的原因。修 `SELF_MODULES` 要动 `src/index.ts`（**不在**本路写入范围）。
- 构建期间**两次**撞上并发子代理的 `src/index.ts` 半成品（先是
  `DispatchSpec`/`thawAccount`/`fingerprintOf` 未定义，后是 `readAccountEvidence` 未定义）：
  本路**没有**碰过任何别人的文件，只是**等其修好后重试**，随后 `exit=0`。
  另一路在 23:19 的补记里记录到它为本路补齐了三条 import —— 那是它的改动，本节只如实转述，不据为己有。

### 17.9 profile 哈希（收尾口径逐字一致）

| profile 文件 | 期望 | 实测 |
|---|---|---|
| `C:\Users\Administrator\.dsh\profiles\desktop\cordis.yml` | `33B0735DD8756CAF…` | **`33B0735DD8756CAF6D5ECB55ED482FB485AB950EA86794002FD08959BC2ACF42`** ✅ |
| `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml` | `2D0C57810C6083EB…` | **`2D0C57810C6083EBEB78F3D750481B725CBD75B3FB15BAE84CCA954A4C688F6E`** ✅ |

### 17.10 诚实边界（本节保留、且必须继续保留）

1. 本插件对**自己拉起的进程树**负责（`ProcessPool` 的 `spawnedPids` 就是它的全部清单）；
   对**树外厂商常驻守护进程**（实测 `opencode.exe` 314.1 MB、`qoderclicn.exe` 416.8 MB、
   `qodersec.exe` 13.8 MB）**不负责、也不擅自杀**（那是厂商共享服务，杀它会破坏其语义），
   但**必须显示**它们的内存 —— 完整进程集合口径在 `/diag/processes`，本池不重复也不替代它。
2. **不得**声称「WebUI 比桌面版更省内存」：本机**没有**同机、同时段的桌面端对照，任何"更轻"的说法都缺依据。
   本节所有内存数字都是**本机实测绝对值**，不做跨形态比较。
3. **池自己核不到 headless / acp 的子进程 pid**：这两个通道**不写** `facts.pid`，
   于是池账目里 `spawnedPids=[]`、`releasedAtTaskEnd/releasedAfterIdle` 保持 `null`
   （**池不会**据此假称"已核对干净"）。也就是说：**ACP/headless 的"零残留"目前靠外部实测**
   （`probe/measure-memory.ps1` / `probe/verify-idle-release.ps1`：出口后树内 harness 子进程回到 0），
   **不是**靠池自己的账目。要补上，需要让这两个 transport 把子进程 pid 写进 `facts`
   （或由池在运行期枚举自己的后代）——**本路未做**。
4. **拒绝的等待时长有聚合值（`deniedWaitMs` / `denialLog()`），但没有"每人一份"的持久档案**：
   环形缓冲只留最近 50 条，更早的被挤掉。
5. **`maxConcurrency` 与设置页的自动同步尚未接线**：池的默认值 4 与
   `DEFAULT_SETTINGS.maxConcurrent=4` 恰好相同，所以当前**行为一致**是巧合而非机制；
   真正的联动需要在 `src/index.ts` 里 `setPoolPolicy`（补丁见 17.11）。在此之前，
   在设置页改 `maxConcurrent` **只**影响 `harness_task_start`，**不影响**直连派发的闸门
   —— 这一点必须如实说，不能宣称"设置页改了就全都变了"。
6. **本节的在线探针是"进程内直连"**（自己 `new SessionRegistry` 打 `lib/sessions.js`），
   与宿主 HTTP 面的等价性由 17.5 的 `PEAK=4` 旁证，但两者不是同一次调用。
7. **`pidsFromFacts()` 只认名字里含 `pid` 的数值字段**：目前只有 pty 通道写 `facts.pid`。
   这是"宁可少认，不要瞎猜"的取舍（猜错 pid 会让核对变成假证据）。
8. **一次真实派发的异常读数（如实留档）**：`agy` 那次 `stop=completed`、正文 586 字符，
   但 `diagnostic` 里有 `harness exited with code 1 after producing output; stderr tail: error: Eligibility check failed…`，
   且正文是 `{"conversation_id":"","status":"ERROR",…}` 形态的 JSON。也就是说
   **"completed" 是通道按"有输出就算完成"给的判据**，不代表 agy 侧真的成功 —— 本节不把它当"能力可用"的证据。

### 17.11 需要 Lead 串行集成的补丁（**不直接改 `src/index.ts`**）

> 现状：本路的改动**已经**在宿主机上生效（`sessions.js` 被热重载，池快照
> `loadedAt=2026/10/13 15:26:17` 且已记录真实运行、`PEAK=4`）；**唯一**缺的是
> 「设置页的 `maxConcurrent` → 池上限」这条联动。下列补丁**都只在 `src/index.ts`**，
> 请串行应用后 `node scripts/build.mjs` 并等热重载（约 20 s）。

**补丁 ①（把设置提前到 SessionRegistry 之前 + 建池变量）**
锚点：`src/index.ts` 中 `const registry = new SessionRegistry({`（本路取样时约 2845 行）**之前**的位置，
在 `// ── 服务时序纪律 ──…` 注释块**之前**插入：

```ts
  // ── 进程池（并发上限 / 空闲回收）的初值 ──
  // ⚠️ 位置纪律：必须在 SessionRegistry 之前 —— 它在**构造时**就会建池
  // （因为 deps 里给了 pool/poolStateFile），所以设置必须先读出来。
  // 原来那处 `let runtimeSettings: RuntimeSettings = loadSettings()` 位于 TaskManager 之前
  // （更靠后），请删掉那一行（避免重复声明），本行取而代之。
  let runtimeSettings: RuntimeSettings = loadSettings()
  let processPool: ProcessPool | undefined
  const applyPoolPolicy = (): void => {
    if (processPool === undefined) return
    // 语义只在一处定义（`applyRuntimeConcurrency`）：0=不限；>0=上限；
    // 第 2 个参数是超限行为开关（'reject' 显式拒绝 / 'wait' 显式排队）。
    processPool.setPolicy(applyRuntimeConcurrency(runtimeSettings.maxConcurrent, 'reject'))
  }
```

**补丁 ①b（`src/index.ts` 顶部加一行 import）**
锚点：`import { SessionRegistry } from './sessions.js'` 的**下一行**：

```ts
import { applyRuntimeConcurrency, type ProcessPool } from './processpool.js'
```

（`ProcessPool` 只作类型用；`applyRuntimeConcurrency` 是上面那个语义单点。
若不想加 import，就把补丁 ① 里那行换成字面量
`processPool.setPolicy({ maxConcurrency: runtimeSettings.maxConcurrent, queueMode: 'reject' })`
—— 但那样"0=不限"的语义会有第二处定义，日后容易走偏。）

**补丁 ②（registry 构造参数加两行）**
锚点：`const registry = new SessionRegistry({` 的 `log:` 那一项**之前**：

```ts
    // 并发上限 / 空闲窗口的初值：先给默认，紧接着 setPoolPolicy 用运行时设置覆盖。
    pool: { maxConcurrency: runtimeSettings.maxConcurrent, queueMode: 'reject', idleReapMs: 30_000 },
    poolStateFile: join(pluginHome(), 'run', 'processpool-state.json'),
```

**补丁 ③（取到池实例 + 设置变更时推送）**
在 `const applySettings = (raw: unknown): RuntimeSettings => {` 这个函数**之前**插入：

```ts
  // `SessionRegistry.pool()` 是惰性单例：这里取一次，之后设置变更直接推给它。
  processPool = registry.pool()
  applyPoolPolicy()
```

并在 `applySettings` 函数体内、`tasks.setMaxConcurrent(runtimeSettings.maxConcurrent)` 的**下一行**加：

```ts
    applyPoolPolicy()   // 设置页改 maxConcurrent → 立刻作用于直连派发的并发闸门
```

**补丁 ④（卸载时收计时器；可选但建议）**
锚点：`ctx.effect(() => () => {` 内、`void registry.disposeAll()` 的**下一行**：

```ts
    processPool?.dispose()
```

（注：`SessionRegistry.disposeAll()` **已经**会 `poolBox?.dispose()` 并清掉空闲巡检计时器；
这一行是幂等的双保险。）

**补丁 ⑤（可选，但强烈建议：让本文件被陈旧检查覆盖）**
锚点：`src/index.ts` 的 `const SELF_MODULES = ['index.js', 'tasks.js', 'sessions.js', 'tools.js', 'llm-adapter.js'] as const`：
加 `'processpool.js'`。否则 `/diag/loaded` 的 `anyStale=false` **永远**证明不了 `processpool.js` 是不是旧的（见 17.8）。
若要让设置页能看见池状态，可另开只读口 `GET /harness-pilot/api/diag/processpool` 返回
`registry.pool().describe()`（**本路未做**，因为路由注册在 `src/index.ts`）。

### 17.12 本节新增工件

| 文件 | 作用 |
|---|---|
| `src/processpool.ts` | 新增：并发闸门 + 空闲核对账本（`ProcessPool` / `PoolPolicy` / `PoolDeniedError` / `applyRuntimeConcurrency` / `pidsFromFacts` / `sampleProcessTable`） |
| `src/sessions.ts` | 接线：`SessionDeps.pool` / `poolStateFile`、`poolGate()`、`poolDenial()`、`closeIdleSessions()`、`setPoolPolicy()`、`poolEventLog()`、`withIdleTracking()`、`disposeAll()` 收计时器 |
| `probe/verify-processpool.mjs` | 离线行为验收（准入/排队/四种拒绝/回收核对/策略归一化） |
| `probe/verify-processpool-live.mjs` | 在线验收（真实 `dispatch()` 收敛点：拒绝可读性、真实派发、回收、长期会话回收） |
| `probe/verify-idle-release.ps1` | 完整进程集合口径的空闲回收实测（树内 + 树外） |
| `probe/_pool-regression-suite.mjs` | 本节回归跑批（11 点名 + 3 新增，串行，失败才在版本漂移时重试一次） |
| `probe/_find-live-target.mjs` | 一次性小工具：在**本机当前**环境里找出真能跑通的 live 目标（避免把环境问题误读成产品问题） |
| `probe/out/verify-processpool.json` / `verify-processpool-live.json` / `idle-release.json` / `pool-regression-suite.json` | 证据落盘 |
