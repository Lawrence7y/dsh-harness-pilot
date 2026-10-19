# dsh-harness-pilot 修复方案：P1 / P3 / P7

> 基于对 `D:\Project\dsh-harness-pilot` 当前源码的通读（非推测），坐标均为 `src/` 下实际行号。

---

## 0. 先说一个会决定工作量的事实

`codex-plugin/server/runtime/*` **不是**由 `scripts/build.mjs` 生成的，而是 `lib/*` 的**手工分叉副本**
（build.mjs 只做三件事：junction 链接依赖 → `tsc src → lib` → 拷 `client/client.js`，见 `scripts/build.mjs:87-104`）。

后果：**下面每一个修复都要落两遍**，否则 DSH 侧修好了、Codex 侧还是老行为。
建议先做一次小重构（见 §5.1），把这个分叉收敛掉，再动业务逻辑。

---

## 1. P1（阻断级）单实例应用：给出可复制的补救命令 + 端口，或 `kill_first=true` 自己完成

### 1.1 现状与根因

三个独立的缺陷叠在一起，才导致"卡死且无从下手"：

**(a) 报错是散文，不是命令，而且不带端口。**
`src/transports/cdp.ts:1134-1139`：

```ts
if (running.running && !isolatedProfile) {
  throw new Error(
    `target '${target.name}' is already running without --remote-debugging-port (${image}, pid ${running.pids.join(', ')}); `
    + `close it and call harness_open (which relaunches with the flag), or use the window channel`,
  )
}
```
它知道 pid、知道目标，却**不告诉用户该用哪个端口**——而端口恰恰是必须知道的。

**(b) 端口是在检查之后才算的，所以那一刻根本还不知道。**
`src/transports/cdp.ts:1134` 抛错，`src/transports/cdp.ts:1142` 才 `pickLaunchPort()`。
顺序反了 → 想给端口也给不出。必须把 `pickLaunchPort` 提到单实例检查**之前**，
并把选中的端口贯穿整条流程（也保证 `kill_first` 复用时端口确定）。

**(c) 这个错误经常根本传不到用户眼前。**
`src/sessions.ts:306-317` 的 `open()` 对每一档通道只做 `preflight`，不可用就 `continue`：

```ts
const check = await this.preflight(kind, target)
attempts.push(`${kind}=${check.available ? 'ok' : 'skip'} (${check.detail})`)
if (!check.available) continue          // ← CDP 的详细原因在这里被吞掉
```
而 `probeCdpTarget`（`cdp.ts:1073`）在单实例场景返回 `available:false`。
于是要么静默降级到 window 通道（用户以为自己在用 CDP），要么最后抛一条把 5 档原因拼在一起的
聚合错误——关键的那条淹没在里面。

### 1.2 方案 A：结构化错误 + 可直接复制的补救块（含端口）

新增错误类型，把"诊断"变成"数据"：

```ts
// src/transports/cdp.ts
export class SingleInstanceBlocked extends Error {
  readonly target: string
  readonly image: string
  readonly pids: number[]
  readonly port: number          // ← 已经选好的、真正会用的端口
  readonly portBase: number
  readonly command: string
  readonly launchArgs: string[]  // 已解析成具体端口的 argv
}
```

`openCdp` 抛出时渲染成这样（示例为实测目标 zcode）：

```
target 'zcode' is already running WITHOUT --remote-debugging-port
  image: ZCode.exe   pids: 1182200
  port this plugin would use: 9333   (cdp.port=9333, scan range 9333..9353)

Pick ONE:

  [A] let the plugin do the whole thing (recommended)
        harness_open  target=zcode  kill_first=true

  [B] close it, then harness_open (relaunches with the flag for you)
        Stop-Process -Name ZCode -Force

  [C] close + relaunch with the flag, in one line (PowerShell)
        Stop-Process -Name ZCode -Force -ErrorAction SilentlyContinue
        Start-Process 'D:\zai\ZCode\ZCode.exe' -ArgumentList '--remote-debugging-port=9333'

  [D] skip CDP entirely — drive the existing window
        harness_open  target=zcode  transport=window

  [E] ready-to-run script written for you:
        C:\Users\...\.dsh\plugins\harness-pilot\remedies\relaunch-zcode-9333.ps1
```

**关于「④ 脚本」**：选项 [E] 就是把它落成实物——插件把 `[C]` 的等价脚本写进
`<home>/plugins/harness-pilot/remedies/relaunch-<target>-<port>.ps1` 并回传**绝对路径**。
好处是命令里带引号/空格/中文路径时不会被终端转义吃掉，用户双击或 `pwsh -File` 即可。
脚本内容固定三行（Stop → Start → 打印 endpoint 校验提示），且**端口已固化**，无需用户再想。

要点：
- `[C]` 的 argv 由 `launchArgsFor(target, port)` 生成，与插件自己启动时**完全一致**（含 `<port>` 占位符与
  硬编码端口改写），不会出现"手动起的端口和插件期望的不一样"。
- `[A]/[B]/[C]` 都只用 `image`（`window.process` 或 command basename）定位进程，绝不按端口或模糊名匹配。

### 1.3 方案 B：`kill_first=true` 端到端

**参数贯穿**（4 处签名）：

| 层 | 文件 | 改动 |
|---|---|---|
| 工具面 | `src/tools.ts:906-938` | `harness_open` 增 `kill_first: { type:'boolean' }` |
| 编排 | `src/sessions.ts:298-319` | `open(target,{cwd,launch,killFirst})` |
| 分发 | `src/sessions.ts:360-363` | `create('cdp')` 透传 |
| 通道 | `src/transports/cdp.ts:1088-1091` | `openCdp(..., { killFirst })` |

**终止逻辑**（新增 `terminateForLaunch()`，复用 `headless.ts:14` 的 `killTree`）：

```ts
async function terminateForLaunch(image, seenPids, opts): Promise<{ killed: number[] }> {
  // 1) 漂移护栏：重新枚举，若出现 seenPids 之外的新 pid → 拒绝
  const now = processRunning(image)
  const fresh = now.pids.filter(pid => !seenPids.includes(pid))
  if (fresh.length > 0 && !opts.force) {
    throw new Error(`refusing to kill: ${image} has NEW pid(s) ${fresh.join(', ')} that appeared after the check — `
      + `someone may have started it deliberately. Re-run harness_open to re-read the pid set, or pass kill_force=true.`)
  }
  // 2) 优雅优先：taskkill /PID x /T （不带 /F = 发 WM_CLOSE），轮询 graceMs
  // 3) 仅对幸存者 /F
  // 4) 复核；仍在跑就如实报错并列出 pid
}
```

**安全约束（这是破坏性操作，必须写死）**：
1. **只在"CDP 端点不存在 + 单实例阻塞"这条分支里执行**。若端点已存在，代码在 `cdp.ts:1101-1111` 就 attach 返回了，永不走到这里——**绝不重启用户已经开着的、能用的应用**。
2. **绝不**在 `isolatedProfile`（带 `--user-data-dir=`）时触发——那种情况本来就能并存。
3. **漂移护栏**：pid 集合与检查时不一致就拒绝（除非显式 `kill_force=true`）。
4. **优雅优先**：先 `WM_CLOSE`，`graceMs`（默认 3000）后才 `/F`；给应用落盘的机会。
5. **白名单校验**：`image` 必须等于 `window.process` 或 command 的 basename，且不得为空、
   不得是 `cmd.exe`/`powershell.exe`/`explorer.exe` 等系统进程——防止配置写错时误杀。
6. **全程记账**：被杀掉的 `image + pids` 写进工具返回文本、会话 `detail` 和插件日志，可审计。

**返回文本示例**：
```
session=hp-3-a1b2c3d4 harness=zcode transport=cdp cdp port 9333 page app://./...
kill_first: terminated ZCode.exe pid 1182200 (graceful, 0.8s); relaunched with --remote-debugging-port=9333
```

### 1.4 方案 C：降级必须说出来

`src/sessions.ts:298-319` 改为：记录每档 `preflight` 的**完整原因**；若最终选中的通道与
`target.transport`（或用户显式 `transport=`）不一致，在返回文本顶部加一行显式告警：

```
NOTE: cdp was blocked (target 'zcode' already running without --remote-debugging-port, port 9333);
      fell back to the window transport. To use cdp: harness_open target=zcode kill_first=true
```

这条独立于 A/B，价值最高、改动最小——今天"静默降级"本身就是误导来源。

### 1.5 验收标准

| # | 场景 | 期望 |
|---|---|---|
| 1 | 应用在跑、无调试端口、`kill_first` 缺省 | 抛 `SingleInstanceBlocked`；消息含 **image / pids / 具体端口 / [A]-[E] 五种出路 / 脚本绝对路径** |
| 2 | 同上 + `kill_first=true` | 应用被终止并以 `--remote-debugging-port=<同一端口>` 重启；成功 attach；返回文本记录被杀的 pid |
| 3 | 检查后有人手动起了新实例 | 拒绝终止，提示 pid 漂移，不误杀 |
| 4 | 端口已被别的 harness 占用 | 报告实际选中的备用端口（`portBase+1..+20`），而非 `cdp.port` |
| 5 | `isolatedProfile`（`--user-data-dir=`） | 不触发 kill，直接启动新实例 |
| 6 | CDP 被阻塞 → 降级 window | 返回文本含显式降级告警与补救命令 |
| 7 | 应用带调试端口已在跑 | 直接 attach，**不执行任何 kill** |

---

## 2. P3（高）click 失败后不得继续插入并提交文本

### 2.1 现状与根因

`src/tools.ts:985-1007`：

```ts
if (typeof args.click === 'string' && args.click.length > 0) {
  const needle = String(args.click)
  if (session.evaluate !== undefined) {
    let clicked: unknown
    try { clicked = await session.evaluate(clickByTextSnippet(needle)) }
    catch (error) { throw new Error(`click("${needle}") failed: ...`) }   // ← 只捕获"抛异常"
    notes.push(`click(${JSON.stringify(needle)}) -> ${JSON.stringify(clicked).slice(0,400)}`)
  } else if (session.clickElement !== undefined) {
    const outcome = await session.clickElement(needle)
    notes.push(`click(...) -> ${outcome.detail}`)                          // ← 从不检查 outcome.found
  } else { throw ... }
  await sleep(...)
}
const hasText = typeof args.text === 'string' && args.text.length > 0
const note = hasText ? (await session.send({ text, submit })).note : 'read-only'   // ← 无条件发送
```

**根因**：`clickByTextSnippet()`（`src/tools.ts:81-103`）在**找不到元素时不抛异常**，而是
`return { ok: false, reason: 'no visible element matched ...', candidates: [...] }`。
而调用方只处理"抛异常"这一种失败，**成功/失败根本没被检查**，于是无论点没点中都会继续 `session.send()`。
window 通道同理：`sessions.ts:415-421` 的 `clickElement` 返回 `{found, detail}`，`found` 从未被读。

这就是"今天造成一次误投递"的机制：想点开某个面板/输入框，没点中，文本却被打进了**当时的焦点位置**并回车提交。

### 2.2 方案

**(1) 统一点击结果契约**，消除"一个返回原始 JS 对象、一个返回 `{found,detail}`"的双形态：

```ts
// src/sessions.ts
export interface ClickOutcome {
  ok: boolean
  detail: string
  candidates?: string[]   // 近失配候选，用于让模型换个说法重试
}
```
- CDP：把 `evaluate()` 的返回值归一化 —— `ok = raw?.ok === true`，`detail` 取 `reason`，
  `candidates` 取 `raw.candidates`。
- window：`ok = found`，`candidates` 取 `alternatives`。

**(2) 失败即中止，且明确声明"什么都没输入"**（`src/tools.ts:985-1007` 重写）：

```ts
const clickOutcome = /* 归一化后的 ClickOutcome */
notes.push(`click(${JSON.stringify(needle)}) -> ${clickOutcome.detail}`)
if (!clickOutcome.ok && args.send_anyway_on_click_fail !== true) {
  throw new Error(
    `click(${JSON.stringify(needle)}) did not match any element, so NOTHING was typed or submitted`
    + (clickOutcome.candidates?.length ? `; near misses: ${clickOutcome.candidates.join(' | ')}` : '')
    + `. Retry with a more exact string, or pass send_anyway_on_click_fail=true if the click was optional.`,
  )
}
```

**默认 fail-closed**，且错误消息第一句就是 "NOTHING was typed or submitted"——让模型和人都不会误判。

**(3) 逃生舱**：新增 `send_anyway_on_click_fail: boolean`（默认 `false`）。名字自解释，
只在"点的是可选面板、点不中也能继续"时显式打开。

**(4) 顺带修同类缺陷：模型切换失败同样不应继续发送。**
`src/tools.ts:963-983` 里 `report.ok === false` 只 push 一条 note 就往下走——
"你要我切到 GLM-5.3，我切失败了，但我照样把你的话发出去了"。这与 P3 是**同一类缺陷**。
建议同样 fail-closed，参数名 `send_anyway_on_model_fail`（默认 false），
或至少把 `model switch: FAILED` 提升为显式阻断。**这一条建议单独确认**，因为它会改变现有可跑通的流程。

### 2.3 验收标准

| # | 场景 | 期望 |
|---|---|---|
| 1 | CDP：`click` 文本匹配不到任何元素 + 有 `text` | **抛错**；断言 harness 侧**零输入**（屏幕文本不变）；消息含近失配候选 |
| 2 | window：UIA 无匹配元素 + 有 `text` | 同上 |
| 3 | 匹配到元素并点击成功 | 正常输入 + 提交（回归不变） |
| 4 | 点不中 + `send_anyway_on_click_fail=true` | 照常发送，返回文本注明"click failed, sent anyway" |
| 5 | `click` 与 `text` 都不给 | 纯读屏（回归不变） |
| 6 | 传输层异常（`evaluate` 抛错） | 仍然抛错（回归不变） |

测试落点：`probe/verify-send-click-guard.mjs`（沿用现有 `probe/verify-*.mjs` 风格），
用一个假的 session 桩件断言 `send()` 未被调用——这是最关键的一条断言。

---

## 3. P7（中）内部子代理无状态查询，静默失败只能靠产物缺席发现

### 3.1 现状与根因：两条异步路径，只有一条可查

| 路径 | 入口 | 落地 | 可查询性 |
|---|---|---|---|
| 后台任务 | `harness_task_start` (`task-tools.ts:76-127`) | `TaskManager` → `.json/.log/.result.json` 三件套 | ✅ `harness_task_status/list/cancel` + HTTP `/tasks` |
| 内部子代理 | `harness_agent` (`tools.ts:875-899`) 与宿主 `subagent` 工具的 `provider: harness-<name>` | `HarnessProvider.start()` (`provider.ts:53-113`)，**纯内存** | ❌ 无 |

`HarnessProvider.start()` 返回的 `runId` **只出现在当次工具返回的文本里**（`tools.ts:893`），
既不落盘也不进任何注册表。于是：

- 走宿主 `subagent` 工具（README 第 115-126 行推荐的用法）以后台方式派发 → 拿到一个 id，
  但**没有任何工具能查它现在的状态**；
- 进程崩溃 / 插件热重载 / 唤醒链没触发 → 该 run 永远停在"不知道"，只能靠"预期产物不存在"反推；
- `settleRunResult` 确实会产出 `diagnostic` 与非常规 `stopReason`（`provider.ts:80-91`），
  所以**同步 `harness_agent` 是能报错的**——真正静默的是异步/后台/崩溃这三种情况。

### 3.2 方案：把 provider run 纳入同一本账（推荐）

**核心思路**：不要再造第二套状态机，让 `TaskManager` 支持"外部驱动的 run"。

**(1) `TaskManager` 新增 `track()`**（`src/tasks.ts:104+`）：

```ts
track(input: {
  kind: 'subagent' | 'task'
  runId: string
  target: TargetConfig
  prompt: string
  cwd: string
  sessionId?: string
}): {
  id: string
  progress(chunk: string): void
  finish(outcome: DispatchOutcome): void
  fail(error: Error): void
}
```
`TaskManager` 本来就已经负责三件套落盘、`TaskStatus` 状态机、`callback.status` 记账
（`tasks.ts:15-52`），`track()` 只是把"谁来执行 dispatch"从内部换成外部——复用而非重写。

**(2) `HarnessProvider.start()` 接上**（`provider.ts:53-113`）：
- 进入时 `const handle = tasks.track({ kind:'subagent', runId, target, prompt, cwd, sessionId })`
- `onProgress` → `handle.progress(chunk)`
- `settleRunResult` 的 `attempt` 返回前 → `handle.finish(outcome)` / `onError` → `handle.fail(error)`

**(3) 工具面暴露**（`src/task-tools.ts`）：
- `harness_task_status` 增加别名/参数，能按 `run_id` 查（`TaskView` 增 `kind` 字段，`task-tools.ts:52-66` 的 `describe()` 里显示）；
- `harness_task_list` 同时列出两类，标注 `kind=task|subagent`；
- 新增 HTTP `GET /harness-pilot/api/runs`，设置页加"最近运行"区块（`index.ts:201+` 的 handler 已有 `/tasks`、`/task` 可照抄）。

### 3.3 方案补强：让"静默"变成"显式"

仅"可查询"还不够——用户的原话是"只能靠产物缺席发现"，所以要主动把缺席说出来：

**(a) 终态必落盘**：无论成功失败都写 `.result.json`（含 `stopReason` + `diagnostic`）。
今天 provider run 失败时磁盘上什么都没有，这正是"产物缺席"的根源。

**(b) 停滞探测（stall detector）**：run 超过 `stallTimeoutMs`（默认 120s，可配）既无 progress 也无终态
→ 状态置 `stalled`，并在 `notify=true` 时投递一条"run X 疑似卡住"的回执。
今天卡住的 run 会永远显示 `running`。

**(c) 预期产物校验（直接回应症状）**：给 `harness_agent` / `harness_task_start` 增加可选
`expect_artifacts: string[]`；终态时逐个 `existsSync` 检查，缺席则写进 `diagnostic`：

```
diagnostic: run completed (stop=completed) BUT expected artifacts are MISSING: out/report.md, out/data.json
```

**(d) 崩溃恢复**：插件加载时扫 `tasks/` 目录，把上次进程退出时仍为 `running` 的记录标为
`interrupted`（`TaskStatus` 已有这个值，`tasks.ts:17`，但目前没人写它）。这样"插件重启导致的孤儿 run"
也能被查到，而不是永远 `running`。

### 3.4 验收标准

| # | 场景 | 期望 |
|---|---|---|
| 1 | `harness_agent` 派发后立即查 `run_id` | 返回 `kind=subagent status=running` + 当前 progress |
| 2 | 宿主 `subagent` 工具（`provider: harness-zcode`）后台派发 | 同上，可查 |
| 3 | run 失败 | 磁盘有 `.result.json`，含 `stopReason=error` + `diagnostic`；可查 |
| 4 | run 挂住无输出超过 `stallTimeoutMs` | 状态变 `stalled`，且（notify 时）收到回执 |
| 5 | 插件重启后查上次的 run | 状态为 `interrupted`，不是永久 `running` |
| 6 | `expect_artifacts` 未产出 | `diagnostic` 明确列出缺失路径 |
| 7 | 现有 `harness_task_*` 行为 | 全部回归不变 |

---

## 4. 改动汇总（文件 × 问题）

| 文件 | P1 | P3 | P7 |
|---|---|---|---|
| `src/transports/cdp.ts` | `SingleInstanceBlocked`、端口前置、`terminateForLaunch`、`killFirst` | | |
| `src/sessions.ts` | `open()` 记录降级原因并显式告警；透传 `killFirst` | `ClickOutcome` 归一化 | |
| `src/tools.ts` | `harness_open` 增 `kill_first` | click/model 失败 fail-closed + 两个逃生舱参数 | `harness_agent` 记录 `run_id` |
| `src/tasks.ts` | | | `track()`、`kind`、`stalled`、`interrupted` 恢复 |
| `src/task-tools.ts` | | | `run_id` 查询、`kind` 展示 |
| `src/provider.ts` | | | 接 `track()` |
| `src/index.ts` | | | `GET /api/runs` |
| `README.md` | 新参数与补救流程 | 新参数 | 新查询方式 |
| `codex-plugin/server/runtime/**` | ⚠️ 镜像 | ⚠️ 镜像 | ⚠️ 镜像 |

---

## 5. 实施建议

### 5.1 先收敛分叉（强烈建议，否则每个修复做两遍）

给 `scripts/build.mjs` 增加一步：`lib/**` → `codex-plugin/server/runtime/**` 的编译产物同步
（注意两侧模块格式差异：`lib` 是 ESM `.js`，`codex-plugin/server/runtime` 也是 `.js`，
需确认 import 路径与 `package.json` 的 `type` 一致）。收敛后 §4 的"镜像"列消失。

### 5.2 顺序与依赖

```
P3  ──┐  最小、最独立、当天可验证（一个假 session 桩件就能测）
      ├─→ 无依赖
P1  ──┘  (A)(C) 低风险先行 → (B) kill_first 单独提交、单独评审
P7  ────→ 依赖 P1/P3 之后再做（它要动 TaskManager，P1 的 kill 也要记账）
```

- **P3 先做**：改动最小、风险最低、直接止血（误投递是真实事故）。
- **P1 拆两步**：先上 (A) 结构化错误 + (C) 降级告警（纯信息，零破坏性），
  再单独上 (B) `kill_first`（破坏性，需要更严的评审与测试）。
- **P7 最后**：`track()` 会碰 `TaskManager` 的核心状态机，等前面稳定后再动。

### 5.3 需要你拍板的三个点

1. **`kill_first` 的默认值**：建议 `false`（显式才杀）。是否接受？
2. **`send_anyway_on_model_fail`**：§2.2(4) 建议把"模型切换失败仍发送"也改成 fail-closed——
   这会改变你现有能跑通的流程，要不要一并做？
3. **`stallTimeoutMs` 默认值**：120s 是否合适（有些 harness 单轮就是好几分钟无输出）？

### 5.4 风险

| 风险 | 缓解 |
|---|---|
| `kill_first` 误杀用户正在编辑的窗口 | 漂移护栏 + 优雅优先 + 白名单 + 只在"端点不存在"分支执行；默认关闭 |
| P3 fail-closed 让原本"碰运气能过"的流程变硬失败 | 逃生舱参数；错误消息给出近失配候选便于改词重试 |
| P7 `track()` 改坏现有任务状态机 | 现有 `probe/verify-tasks-wake.mjs` 23 项断言必须全绿（README:219 记录过） |
| 两侧分叉导致只修一半 | §5.1 先收敛，或至少在 CI/脚本里加一致性检查 |
