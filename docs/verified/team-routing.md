# 产品化团队路由：`harness_spawn_teammate`（非 probe 口径验收）

> 本文只写**实测到的东西**。拿不到证据的一律标「未验证」，不外推、不给百分比。
> 全部证据的采集时间：2026-10-14 02:17–02:57（本地），活宿主 `http://127.0.0.1:4200`，
> 插件构建产物 `D:\Project\dsh-harness-pilot\lib\**`，`GET /api/diag/loaded` 的 `anyStale=false`。

---

## 0. 这一轮补的是什么缺口（逐条对应）

收尾前「团队能力」只有 `POST /probe/team/*` 一条驱动路径，而它的意图表是
`desired = new Map<string, TeamMemberProbeTarget>()`，**按成员名称索引**（`src/index.ts` 的
`createTeamMemberProbe`）。由此产生三件事，本轮全部处理：

| # | 缺口 | 本轮的处置 | 判据在哪 |
|---|---|---|---|
| 1 | **没有产品入口**：`configure` 只有探针 HTTP 路径能调，模型/用户没有创建身份的正式工具 | 新增产品工具 `harness_spawn_teammate`（`src/tools.ts`）+ 用户可见 HTTP 面 `/api/team/*`（`src/index.ts`） | §2、§3 |
| 2 | **没有 Lead/team 隔离**：两个团队的同名成员互相覆盖 | 隔离键改为意图 `(leadSessionId, memberName)` + 解析 `childSessionId`；**不含**「全局成员名」单独成键 | §4 |
| 3 | **绑定是「事后补写」**：`member.id` 要等 spawn 返回 | 改由团队日志事件 `team/member` 在**首轮之前**写绑定 | §5 |

另外**不采用** `prepareContinuable`（理由见 §8）。

---

## 1. 产品入口与隔离键（用户可见面）

### 1.1 模型面向的工具

```
harness_spawn_teammate({
  target,            // 必填：harness_list 里的目标名，且必须 transport=auto
  name, prompt,      // 必填：成员名（团队内唯一）与初始任务
  accountId?,        // 可选：账号档案 id
  model?,            // 可选：该成员每一轮用的模型
  description?, context?
})
```

与宿主原生 `spawn_teammate` 的关系是**补充而不是替代**：名字不同 ⇒ 共存。
原生那个的 schema 只有 `name/description/prompt/context`，`provider` 来自 agent-team 配置的
`freshProvider`/`forkProvider`（`dsh-experimental-tool-agent-team/lib/index.js:17-18,59,290`），
**不接受** Harness/账号/模型。

### 1.2 用户可见的 HTTP 面（`src/index.ts`，全部在 `API_PATH` 下）

| 方法 | 路径 | 作用 | 实测 |
|---|---|---|---|
| GET | `/harness-pilot/api/team/routing` | 成员 → Harness / 账号（**脱敏标签**）/ 模型 / 解析来源 | **200** |
| GET | `/harness-pilot/api/team/pending` | 已冻结但还没解析出子会话 id 的意图 | **200** |
| GET | `/harness-pilot/api/team/events` | 解析/拒绝的审计记录 | **200** |
| POST | `/harness-pilot/api/team/dispatch` | 按该成员**冻结的**配方执行一轮 | **200**（`facts` 带 pid/exitCode/promptDelivery） |

未挂载时 `/team/*` 一律 **503**（不让调用方以为「查了但没有」）。

### 1.3 隔离键（**不是全局成员名**）

```
意图键  = (leadSessionId, memberName)     ← 团队身份来自「成员是 Lead 的直接子会话」
解析键  = childSessionId                  ← 一旦知道子会话 id，路由只认它
```

`leadSessionId` 就是宿主的 **TeamId**：`dsh-experimental-agent-team/lib/types/roster.js:64-98`
的 `tryMembership()` 把 `root.id` 当 `TeamId(root.id)`，成员是它的直接子会话。
**从这个键里拿掉 `leadSessionId` 就等于回到按成员名匹配** —— 所以 `src/team-routing.ts`
的 `resolveByIntent()` 在没有该 Lead 的意图时**只**返回可读原因，**不做任何模糊/跨团队命中**。

---

## 2. 首轮之前绑定：时序实测（这是本条最关键的判据）

判据用**宿主自己的事件 + 本插件审计记录的先后**（不靠毫秒推断语义）。一次真实
Lead 调用的完整链条（本地时间，同一进程）：

| 时刻 | 来源 | 事件 |
|---|---|---|
| 18:36:43.662 | 本插件审计 | `prepare.accepted`（冻结 `target=qoder-cn-acct-a`、`account=acct:…-aa`、`model=performance`，`accountApplied=true modelApplied=true`） |
| 18:36:43.662 | 本插件审计 | `resolve.written`（`childSessionId=4305e984-…`，`via=session/event:team/member`，`setAt` 同刻） |
| **18:36:46.162** | **本插件审计** | **成员会话的第一次模型请求** |
| 18:36:46.166 | 宿主（`bridge.open`） | 该成员的桥接入口打开，`channel=argv-mcp-config`，`injected=true` |
| 18:36:48.335 | 宿主（`mcp.http`） | **外部 CLI `initialize`**，`remoteAddress=127.0.0.1` |
| 18:36:48.346 / .360 | 宿主 | `notifications/initialized` / `tools/list`（6 个工具） |
| 18:36:53.433 | 宿主 | `notifications/cancelled` |
| 18:36:54.371 | 宿主 | `bridge.close{turn-settled}` |
| 18:36:53.545 | 宿主（进程池） | `spawn-exit runId=p1-qoder-cn-acct-a:headless exitCode=0` |

⇒ **绑定早于该成员首轮 2.5 秒**，并且该首轮的 CLI 子进程真的起了、真的按 MCP 协议连上了入口。

### 2.1 为什么绑定能在 spawn **期间**写下去

`team/member` 是**团队日志**里的一条事件（`roster.js:241-262` 的
`journal.appendAndFlush(root,'team/member',{version:2,teamId,member})`），它带齐三项：
`teamId`（＝ Lead 会话）、`member.id`（子会话）、`member.name`（成员名）。
而成员的首个 prompt 是稍后 `ctx.subagents.startContinuable()` 内部
`submitMaterialized(..., delivery:'queue')` 才投递的（`dsh-subagent/lib/index.js:1738-1744`）。
所以「收到 `team/member` ⇒ 此刻写绑定」在**结构上**保证早于首轮。

该事件经宿主的 `session/event` 转发（`dsh-session/lib/index.js:1466-1473`；
观察者由 `invokeContainedSessionObservers()` 逐个 try/catch 调用、**不看返回值**）——
因此本插件的观察者**不接管、不转发**任何东西，团队日志的 append 路径不因它改变。

### 2.2 兜底路径（`agent/created`）以及它**不**做的事

插件还挂了一条兜底：`agent/created` 时按 `(childSessionId, parentSessionId)` 反查成员名
（先读团队日志，再用成员 prompt 抬头）。反查不到就**不绑**，并记
`resolve.deferred{reason:"成员名反查不到 ⇒ 不绑（不按模糊名字跨团队命中）"}`。
**这一步不参与「首轮前绑定」的保证** —— 保证由 §2.1 那条事件提供；兜底只是覆盖
「事件缺失时仍有一条可解释来源」。

---

## 3. `account` 与 `model` **同时可用**

### 3.1 两个参数各自的落点（以及本轮修掉的**静默丢弃**）

| 参数 | 落点 | 本轮发现 |
|---|---|---|
| `accountId` | `SessionBinding.accountId` → `llm-adapter.streamFor()` 的 `accountId` → 派发侧按**冻结配方**合并 `--config-dir`/env | 冻结配方原先只在内存意图里，重载即丢（§6） |
| `model` | ⚠️ **原先根本没有落点** | 请求层改道决策产出的 `selection.model` 是**目标名**（`pilot-cli` 路由语义），所以 `binding.model` 从来没被读进这次派发 ⇒ **argv 里没有模型** |

修复（`src/llm-adapter.ts` + `src/index.ts`，都是加法）：

- `PilotCliDeps.frozenModelFor(sessionId)`：按会话 id 取**创建时冻结**的模型；
- `PilotCliDispatchRequest.model`：把它显式交给派发；
- `streamFor()` 里 `const model = frozenModel ?? boundModel`，随后
  `registry.dispatch({ ..., model })` —— 这才走到 `sessions.ts:465` 的 `withModel()`，
  由它把模型落成 argv。

### 3.2 argv 实证（零额度、零 spawn）

`probe/verify-team-routing-frozen-recipe.mjs` —— 用**运行期同一份** `headlessArgv()` 与
`withModel()` 语义在离线状态下把命令行拼出来（`headless` 通道的 `facts` **故意不含完整
argv**，因为它带着整段 prompt）：

```
qoderclicn.exe --config-dir …\harness-accounts\qoder-cn-a --config-dir …\qoder-cn-a -m Qwen3.8-Flash -p
```

| 判据 | 结果 |
|---|---|
| 冻结路径的**账号那一步**与既有 `withAccountTarget` 逐字等价（args + env） | **PASS**（两账号各一次） |
| argv 里出现该档案的 `--config-dir` | **PASS** |
| argv 里出现冻结模型**且恰好一次** | **PASS** |
| **反证**：不传 model 时该串不出现 | **PASS** |

⇒ 14 项全 PASS，`exit=0`。

### 3.3 「模型真的被用了」与「模型非法」都有**响亮**的判据（实测，非推断）

在该 CLI（`qoderclicn 1.1.13`）上直接测：

- `--model Qwen3.8-Flash` ⇒ 被接受、正常出结果；
- `--model definitely-not-a-model-xyz` ⇒ **exit 42** + `Invalid model "…"` + 列出可用模型。

因此这一格**不存在「静默无效」**：模型要么被接受、要么 CLI 自己报错。
配套地，`prepare()` 会用**该 CLI 自己报出的清单**做模型校验（`knownModels`）：
清单读得到且模型不在其中 ⇒ **建成员之前显式拒绝**（`MODEL_NOT_OFFERED`）；
清单读不到 ⇒ **不据此拒绝**（「没测到」≠「不存在」），模型照传，合法性由 CLI 判。
本机 qoder 目标的 `modelsCommand` 未配置（`/api/models` 的 `mechanism="argv -m {model}"`、
`note="no modelsCommand configured for this harness"`）⇒ 走的是「不据此拒绝」那一支，
已如实记进审计（`prepare.model-check`）。

### 3.4 不静默丢 model / 不回退账号的具体形式

- 目标**声明了** `modelArgs` ⇒ 交给 `withModel()`（不重复注入）；
- 目标**没声明** ⇒ `modelArgsFor()` 用该 CLI 已实测的 `--model` 补上；
- 两者都不成立 ⇒ **显式拒绝派发**（`refusing to dispatch without the frozen model`），不静默跑默认模型；
- 账号：`prepare()` 判活（不在生效档案里 ⇒ `ACCOUNT_REFUSED`），修复路径**只有**「同 id 的档案回来再建」，
  没有「换一个账号凑一下」这条分支。

---

## 4. 第二团队同名成员隔离负控（实测 PASS）

两个**真实 Lead**（`session-hp-prod-lead-a-mv71efcl` / `session-hp-prod-lead-b-mv71efcl`）
各自调产品工具建一个**同名**成员 `iso-worker-mv71efcl`：

| | Lead A | Lead B |
|---|---|---|
| childSessionId | `81d3e402-0690-47d0-a1ab-d851fe164394` | `402c2f9d-f172-4b5f-ba2e-9f37114836f1` |
| target | `qoder-cn-acct-a` | `qoder-cn-acct-b` |
| account（脱敏） | `acct:…-aa` | `acct:…-ba` |
| model | `Qwen3.8-Flash` | `Qwen3.8-Flash` |
| via | `session/event:team/member` | `session/event:team/member` |

- **两条独立记录、不同子会话、不同目标、不同账号** ⇒ 同名不会互相命中（`sameNameDistinctRows=2`）。
- 两个成员的桥接事件各自独立（按 `sessionId` join）：各有
  `bridge.open → mcp.http{initialize, notifications/initialized, tools/list} → mcp.tools/list{count:6} → bridge.close{turn-settled}`。
- 隔离负控（消息方向）：⚠️ **本节原来的 PASS 落在错域，已在 §13 更正并重测**。
  原文写的是「给团队 A 的成员发一条含唯一业务词 `quartzwave…` 的消息后，团队 B 的同名成员的转录里
  **没有**该词（PASS）」—— 但那一轮的三条 `/probe/team/send` **全部 HTTP 500**（caller 是探针自己的
  Lead，不是这两个产品 Lead），所以团队 A 的成员**根本没收到过**那条消息；而且判据里
  `bAssistantCount=0`（团队 B 的成员当时没有任何助手转录）⇒「没收到」**恒真**、证据不足。
  重测（§13.7）用**正面对照**（两侧各自确实收到了自己那条、且 `source.senderId` 是**自己的** Lead）
  + **原始 JSONL** 扫描 ⇒ 隔离结论仍成立，但依据换成了宿主自写的投递收据。

---

## 5. 停用/删除账号 ⇒ 新建拒绝（实测 PASS）

`probe/verify-team-routing-account-refusal.mjs`（真实 Lead + 真实账号档案 CRUD）：

| 步骤 | 结果 |
|---|---|
| 0 创建**临时**账号档案（收尾删除；不碰内置档案） | PASS |
| 1 账号**在册**时真实 Lead 调产品工具 | PASS（工具跑完） |
| 2 成员出现在产品路由表（`target=qoder-cn-acct-a`、临时账号、`model=Qwen3.8-Flash`） | PASS |
| 3 删除该档案 | PASS（`ok=true`） |
| 4 另一个真实 Lead 调同一工具 ⇒ **被拒绝** | PASS（审计 `prepare.refused{code:ACCOUNT_REFUSED}`） |
| 5 **没有**新成员诞生（路由表条数不变、第二个 Lead 下无条目） | PASS |
| 6 已建成员的**冻结快照仍然可用**（`/team/dispatch` 真的 spawn 出进程） | PASS |
| 7 收尾：临时账号不在生效档案里（无残留） | PASS |
| 8 账号被删后**新建**被拒（产品工具原文，零额度直判） | PASS |

§5 第 8 行的零额度判据来自 `probe/verify-team-routing-refusal-text.mjs`（不经模型转述）：

- 账号不在生效档案里 ⇒ `ACCOUNT_REFUSED`，**没有**冻结任何意图（`pendingIntents=0`、`routes=0`）；
- 原因文本里出**脱敏标签** `acct:…edr`，**不含**原始档案 id（`leaksRawAccountId=false`）；
- **对照**：同一账号放回 `accountSeeds()` ⇒ 被接受（`accountApplied=true modelApplied=true`）
  ⇒ 证明拒绝由「账号消失」引起，**不是这段代码恒拒**；
- 非 `transport=auto` 的目标 ⇒ `TARGET_NOT_DISPATCHABLE`（不静默降级）。

### 5.1 一条**判据**层面的更正（本轮自己踩的）

第一版探针把「Lead 的回复里是否出现字面量 `ACCOUNT_REFUSED`」当判据 ⇒ 红。
真因：工具抛出的文本回到模型手里后，模型**转述**了它（说「该账号不可用」），
不是拒绝没发生。**把判据绑在「模型怎么转述」上本身就是脆的**，已改为：
拒绝这件事由**审计记录**（工具自己写的，不经模型）判，工具**原文**由零额度探针直判。

---

## 6. 冷恢复：读「已绑定的快照」（实测 PASS，含一个真缺陷）

### 6.1 缺陷与修复

冻结配方原先只存在**内存意图**对象上，而 `routes` 落盘 ⇒ 插件一重载：
记录从文件恢复了、意图却是空的 ⇒ `frozenRecipeOf()` 返回 `undefined` ⇒
一条**在册**的成员派发时被拒成「不在路由表里」。实测复现（`/team/dispatch` →
`session 4305e984-… is not in the team routing table`，而同时 `/team/routing` 列出它）。

修复：

- `TeamRoute.frozen`：**冻结配方随记录一起落盘**，记录**自足**；
- `frozenRecipeOf()`：先读记录自带的配方，内存意图只作补充；
- `load()`：对不自足的旧记录**不静默收下**（计 `skipped` 并喊出来），
  读文件出错也**不静默当空表**（ENOENT 除外）。

### 6.2 生产实证

重载后（真实 `state.loaded` 事件）：

```json
{"event":"state.loaded","detail":{"routes":2,"skipped":0,
 "file":"C:\\Users\\Administrator\\.dsh\\plugins\\harness-pilot\\team-routing.json"}}
```

⇒ 两条记录（**含冻结配方**）完整冷载，`skipped=0`。
冷恢复后**身份值未变**且 `setAt` **未被推后**。

> ⚠️ 本节原来把这条写成「`probe/verify-team-routing-member-rounds.mjs` 第 5 项 PASS」——
> 那一项的判据**只比 `setAt` 与三个值**，而当时的三条投递**全部 HTTP 500**（见 §13.1），
> 也就是说：**判据为真，但它测的不是「冷恢复」**（那个会话压根没被唤醒过）。
> 重测后（§13.6）判据换成「投递前在线对象拿不到 + 投递后重新在线 + 持久层新增一轮 +
> `descriptorCount` 不变（走的是重放而不是重建）+ 新轮的助手归属 === 冻结目标」，
> `setAt` 降级为**辅助**记录。

### 6.3 幂等（同一缺口的一体两面）

实测抓到：`team/member` 写一次（seq 1/2）后，`agent/created` 兜底**又写一次**（seq 3），
内容完全相同、只把 `setAt` 推后 2.5 秒。后果不是功能错，而是**判据失真**：
「绑定早于首轮」这句话在日志里出现两条，且第二条落在首轮**之后**，读的人可能据此得出相反结论。
已修：同意图对同一子会话**不重写**（记 `resolve.kept`）。

---

## 7. 桥接硬门：**外部 CLI 真的能连上桥接**（实测 PASS）

`probe/verify-team-routing-bridge-gate.mjs`（只读 `GET /harness-pilot/api/mcp-bridge`）：

| 层 | 判据 | 结果 |
|---|---|---|
| L2 | `mcp.http{rpcMethod:"initialize", remoteAddress:"127.0.0.1"}` | **PASS**（9 次，`loopbackOnly=true`） |
| L2″ | 握手后续 `notifications/initialized` / `tools/list` | **PASS** |
| L2′ | 判据落在**当前在册**入口上 | 曾在在册入口 `eca3da2bf9a4`（seq 3612，`sessionId=3f7e9dd1-…`）上 PASS；空闲时 SKIP（见下） |
| L3 | `mcp.tool/call` → `mcp.tool/result{isError:false}` | **PASS**（12/12，工具 `send_message`） |
| L4 | 通道 = headless `argv-mcp-config` | **PASS** |

**一条探针自身的更正**：L1「此刻有桥接入口」原写成 FAIL 判据 ⇒ 空闲时必红。
入口是**逐轮**开的（`openForTurn` … `close('turn-settled')`），所以「此刻 0 个」的常态含义是
「现在没有在飞的轮次」，不是「链路坏了」。已改为 **NOTE（前置条件，不是判据）**。

⚠️ **本项不覆盖 ACP 通道**：`acp-mcp-servers` 的真机主动 `tools/call`（C1f）**仍未验收**
（见 `docs/verified/mcp-bridge.md` §12）—— 那是另一件事，不能互相顶替。

---

## 8. 为什么**不**采用 `prepareContinuable`（结论未变，附本轮复核）

`src/provider.ts` 文件头（36-43 行）已写下理由，本轮复核后不变：

- `ContinuableCreateRequest`（rc.2 `typert.host.js:334`）字段是 `sessionId / parent / signal`；
  `ContinuableStartSpec.request` 又是 `Omit<SubagentStartRequest, …>` —— **两处都没有账号字段**；
- `startContinuable()` 的产物是**宿主自己的 continuable child**：
  `activations.materialize()` 造 DSH 会话、`submitMaterialized(..., delivery:'queue')` 投首轮
  （`dsh-subagent/lib/index.js:1719-1744`）。一次性外部 CLI 派发器伪装成它，**只会**
  得到「`spawn_teammate` 成功、外部 CLI 一次不被调用」——那正是用户已实测并**明确禁止**的形态。

本模块走的是「原生 spawn + 产品路由服务」那条路；`HarnessProvider` 保持只有 `start`、
`capabilities = NO_START_CAPABILITIES`，**没有** `prepareContinuable`
（运行版 rc2 `dsh-subagent/lib/index.js:3149-3152` 会据此抛 `UNSUPPORTED_CAPABILITY` —— 这是**如实**的）。

---

## 9. 仍未通过 / 未验证（不含糊）

| # | 项目 | 状态 | 实测到哪一步 |
|---|---|---|---|
| 1 | 成员**跨轮**消息往返（Lead→成员→Lead，≥3 轮自发双向） | **PASS（§13 修正 caller 域后重测）** | 两个产品 Lead 各自的**真实 Agent** 作 caller（显式 `leadSessionId`）：双向都通。Lead→成员：宿主自写的 `source.senderId` === 该 Lead、`team/message/queued`+`delivered` 两条边、成员当轮消费了内容；成员→Lead：**成员模型自己调 `send_message`**，Lead A 的持久层里有 `senderId === 子会话` 的收据。⚠️ 本节原先写「真因是这些成员的会话在首轮结束后已被 dispose」—— **那是错域推断**：当时的 FAIL 真因是三条投递**全部 HTTP 500**（caller 发给了探针自己的 Lead），与会话在不在线无关；详见 §13.1 |
| 2 | **取消**（`interrupt_agent`） | **PASS（§13.5）** | 先证目标**真的在飞**（在线轮次骨架有 `turn/start` 无 `turn/end`；`interrupt` 返回的**取消前**状态 `previousStatus === "running"`），再验中断：`result` 无 `threw`、该轮没跑到 400。⚠️ 原判据**只看 HTTP 200** —— 而 `{threw:…}` 也回 200 ⇒ 那次是**假 PASS** |
| 3 | 隔离负控（消息方向） | **PASS（§13.7，已换依据）** | 原 PASS 的判据在 `bAssistantCount=0` 时**恒真**（证据不足）。重测要求**两侧都有正面对照**（各自确实收到自己那条、`senderId` 是自己 Lead、且真的跑了一轮），并扫**原始 JSONL**：A 里没有 B 的 token/messageId、B 里没有 A 的 |
| 4 | 冷恢复后身份不变 | **PASS（§13.6，判据已加强）** | 除「三个值未变」外，还要求：投递前**在线对象拿不到**、投递后**重新在线**、持久层**新增一轮**、`subagent/descriptor` 计数**不变**（重放而非重建）、恢复后**每一轮**的助手归属 === 冻结目标（本轮 3 轮全覆盖）。`setAt` 只作辅助 |
| 5 | ACP 通道真机 `tools/call` | **未验收** | 沿用 `docs/verified/mcp-bridge.md` §12 的结论，本轮未复测。 |
| 6 | 「CLI 那一轮到底用了哪个模型」的**来自 CLI 自身**的证据 | **未验证** | 现有证据是 argv（§3.2）+ CLI 对非法模型 exit 42（§3.3）+ 该轮真的连上桥接（§4）+ **助手消息的 `source.{provider,model}`**（§13.6，宿主记的「这一轮用的是谁」）。**仍然没有**从 CLI 自己的日志/响应里独立读出「我这次用的是 X 模型」。 |
| 7 | `--strict-mcp-config` 在**其它** CLI 上是否存在 | **未验证** | 只在 `qoderclicn 1.1.13` 上核对过（`--help` 有该开关）。 |
| 8 | `ctx.sessionQuery.observeSession()` **本身**对成员转录的判定 | **未验证（§13.4）** | 持久层读取走的是宿主**落盘文件本体**（`session.v*.jsonl.zstd`，多帧 zstd 逐帧解）。它与 `observeSession` 读**同一份持久化**，但后者还带 header 兼容性校验 / 回放校验 / 中断轮次闭合补齐 —— 本插件没有该 HTTP 面，本轮写入范围不允许新增端点 ⇒ 不声称 |

---

## 10. `SELF_MODULES` 覆盖核对（独立算哈希，排除**假覆盖**）

`probe/verify-team-routing-selfmodules.mjs`（不读插件自报，直接解析 `src/index.ts` 的清单 +
遍历 `lib/**/*.js` + 独立算 sha256）：

| 判据 | 结果 |
|---|---|
| 清单条数 == 磁盘 `.js` 条数（去掉浏览器侧 `client.js`） | **38 == 38** |
| `setEqual`（集合相等） | **true** |
| 清单里有、磁盘上没有（**假覆盖**） | `[]` |
| 磁盘上有、清单里没有（**真盲区**） | `[]` |
| 重复条目 | `[]` |
| 读不出来的条目（`hashFile` 会给 `(unreadable)`） | `[]` |
| 结论 | **COVERED** |
| `GET /api/diag/loaded` 的 `modules.Count` | **38**，`anyStale=false`，逐项 `loadedHash == diskHash` |

⚠️ 两点如实说明：
1. **37 → 38**：本轮加入 `team-routing.js`。旧清单 37 项时该等式**也是**成立的（同一脚本实测 COVERED）；
2. **`anyStale=false` 只说明清单内文件是新的**（与 `src/federation/binding.ts` 文件头那句警告同一条纪律）。
   清单**外**的东西必须行为取证 —— 本文 §2–§7 全部是行为取证，没有一条靠 `anyStale`。

---

## 11. 复现命令

```bash
# 覆盖核对（独立算 sha256；零额度）
node probe/verify-team-routing-selfmodules.mjs

# 硬门：外部 CLI 真的连上桥接（只读活宿主；零额度）
node probe/verify-team-routing-bridge-gate.mjs

# 冻结配方：argv 等价 + 模型真的进命令行（零额度、零 spawn）
node probe/verify-team-routing-frozen-recipe.mjs

# 拒绝文本原文（零额度、零 spawn）
node probe/verify-team-routing-refusal-text.mjs

# 非 probe 口径产品验收（**花额度**：每个 Lead 一轮）
node probe/verify-team-routing-product-acceptance.mjs

# 停用/删除账号 ⇒ 新建拒绝（**花额度**：两个 Lead 各一轮）
node probe/verify-team-routing-account-refusal.mjs

# 成员生命周期（**花额度**：多次成员轮次）
# ⚠️ v1 有错域（见 §13）：必须传两个**产品** Lead 的会话 id；探针现在会显式把它们当 caller
node probe/verify-team-routing-member-rounds.mjs <leadA> <memberA> <leadB> <memberB>
```

⚠️ **`/probe/team` 是全局 Lead 会话**：两个验收**不要并发跑**（会互相摧毁证据）。
本轮全部**单进程串行**执行。

---

## 12. 写入范围声明

本轮**只**新增/修改下列文件，**没有**改 `src/mcp-bridge.ts`、`src/mcp-bridge-proxy.ts`、
`src/transports/**`、`client/client.js`（除 `scripts/build.mjs` 的常规 client 拷贝）、
`package.json`、profile 配置，**没有**重启/升级宿主。

| 文件 | 性质 |
|---|---|
| `src/team-routing.ts` | **新建**（产品路由表；`harness_spawn_teammate` 的唯一权威处） |
| `src/index.ts` | 加法（import、`TeamRoutingExtras`、`/team/*` 路由、`session/event` 观察者、`frozenAccountFor`/`frozenModelFor`、`SELF_MODULES` 一项、`ctxAny.on` 类型补声明） |
| `src/tools.ts` | 加法（`harness_spawn_teammate` + 三个 deps 字段） |
| `src/llm-adapter.ts` | 加法（`frozenAccount` / `model` / `frozenModelFor`；未给 = 老行为不变） |
| `probe/verify-team-routing-*.mjs` | 新建探针 |
| `docs/verified/team-routing.md` | 本文 |
| `docs/00-verified-status-report.md` | **仅在文末追加** |

---

## 13. 更正：「成员跨轮」验收的**错域**（本轮修正；不新增功能范围）

本节是**既有验收的必要修正**。修正前 `probe/verify-team-routing-member-rounds.mjs`（下称 v1）的
①②③ FAIL 与 ⑥ PASS **都落在错域** —— 既不能用来宣称产品故障，也不能用来宣称通过。
v1 的证据留在 `probe/out/team-routing-product/member-rounds.log`（**未改动**）。

### 13.1 错在哪（逐条指到 file:line）

| # | 错域 | 证据 |
|---|---|---|
| 1 | **caller 是错的**：v1 收下了 Lead A/B 的 id，但三个 `/probe/team/send` 只传了 `to`/`message`/`delivery`，**完全没传 Lead id** | 服务端 `probe.send` 走 `ensureLead`；`ensureLead` 原先只认 **`globalThis.__hpLeadSession`**（**唯一**一条探针自己建的 Lead，`session-hp-teamlead-*`，见 `src/index.ts` 的 `session-hp-teamlead-${randomUUID()}`）。⇒ 三条消息全发给**探针自己的团队**，产品成员名不在它的花名册里，`resolveActiveMember` 抛 `active teammate "…" not found`（`dsh-experimental-agent-team/lib/index.js:350-357`）⇒ 三条 send 全 **HTTP 500**。**根本没有在两个产品 Lead 的团队里发过消息。** |
| 2 | **只看 HTTP 状态**：取消那条 `interrupt` 回 **HTTP 200**，`result` 其实是 `{threw:'active teammate … not found'}` | `probe.interrupt` 把服务端异常收进 `threw` 并照常 200 返回；v1 判据是 `interrupted.status === 200` ⇒ **假 PASS** |
| 3 | **把「在线读不到」当成「会话丢失」**：`available:false` 只是 `ctx.sessions.get(id)` 拿不到**在线对象** | 而「不在线」在 rc2 里是**正常终态**：idle → `flushFinalState` → `dispose`（`dsh-subagent/lib/types/continuation-activation.js:536-566` 的 `watchSettlement`）。⇒ 不能据此断言会话丢失 |
| 4 | **负控没有正面对照**：`assistantCount=0` 也判 PASS | 「没收到」在目标根本没有转录时**恒真** ⇒ 证据不足 |

### 13.2 修了什么（最小改动）

**只做了加法，无参时的既有行为一字未改**（其它探针仍走全局探针 Lead，不受影响）：

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/index.ts` | `ensureLead(options)` 新增可选 `leadSessionId`：给了就用**那个会话的真实 Agent** 当 caller，且**既不读也不写** `globalThis.__hpLeadSession`；没给就完全走原路（读全局 → 没有就建一条并记回全局） | 加法 |
| `src/index.ts` | `probe.send(to, message, delivery, leadSessionId?)` / `probe.interrupt(name, leadSessionId?)` 透传；`/probe/team/send` 与 `/probe/team/interrupt` 接受可选 `body.leadSessionId`，并在响应里**回显**实际使用的 caller（`result` 字段形状不变，既有探针读的仍是 `body.result`） | 加法 |
| `probe/verify-team-routing-member-rounds.mjs` | 重写（见 13.3–13.8） | 验收修正 |
| `probe/_session-store.mjs` | **新建**：持久层只读读取 | 新增 |

⚠️ **没有**为了「让测试通过」把 Agent 改成常驻 —— 产品侧一行语义都没动。

### 13.3 重测结果

`probe/out/team-routing-product/member-rounds-v2.json`（`2026-10-14T01:16:48.619Z`，活宿主 `http://127.0.0.1:4200`）：

```
=== summary (19 PASS / 0 FAIL / 0 INVALID-TEST) === verdict=PASS
=== team-routing 域：verdict=PASS {"PASS":17,"FAIL":0,"INVALID-TEST":0}
=== model-compliance 域（非路由判据）：{"PASS":2,"FAIL":0,"INVALID-TEST":0}
```

被测对象：Lead A `session-hp-prod-lead-a-mv7129vh` / Lead B `session-hp-prod-lead-b-mv7129vh`，
两条同名成员 `iso-worker-mv7129vh`（子会话 `c51cc089-…` / `8789be44-…`）。

### 13.4 在线可读 vs 持久可读（**两条路径分开记录**）

| 路径 | 接口/文件 | 本轮用途 | 实测 |
|---|---|---|---|
| **在线** | `GET /probe/team/session` → `ctx.sessions.get(id)` | **只**判「此刻在不在线 / 在不在飞」（轮次骨架） | 投递前两个成员都 `available:false`（正常终态）；投递后**多次采样**都看到 `available:true` 且 `openTurns=1`；轮次结束后又回到 `false` |
| **持久** | 宿主落盘 `session.v*.jsonl.zstd`（`probe/_session-store.mjs`） | 判「转录里**到底有什么**」：收据 / 投递边 / 轮次骨架 / 助手归属 | 两个成员、两个 Lead 全部可读；事件类型与 seq 完整 |

⚠️ **两条路径不可互相替代**：`available:false` 只说明在线对象不在，**不**说明转录没了 ——
实测同一时刻持久层里事件齐全（成员 A 12 轮、成员 B 5 轮）。

⚠️ **落盘格式坑**：文件是**多帧拼接**的 zstd，Node 的 `zstdDecompressSync` / `createZstdDecompress`
**都只解第一帧**（实测：34225 字节 → 216 字节，只剩 `session` 头）。只看第一帧会得出
「这条会话没有事件」的**假结论**。`_session-store.mjs` 按 zstd 帧格式**逐帧**走块头求帧长再逐帧解。

⚠️ **口径边界（不许外推）**：这读的是**持久化文件本体**，不是 `ctx.sessionQuery.observeSession()`。
两者读同一份持久化，但后者还带 header 兼容性校验 / 回放校验 / 中断轮次闭合补齐
（`dsh-session-query` README「冷路径先对存储会话执行 stat…」）。本插件**没有** `sessionQuery` 的 HTTP 面，
本轮写入范围不允许新增端点 ⇒「`observeSession` 对这条转录的判定」**未验证**。

### 13.5 取消：**先证明目标真的在飞**，再看中断

1. 先投一条长任务（`Count slowly from 1 to 400…`），轮询**在线**读的轮次骨架 ⇒
   有 `turn/start`、没有 `turn/end` ⇒ `openTurns=1`（实测第一次轮询即命中，`waitedMs=5`）。
2. 再 `interrupt`。判据**不看 HTTP**：
   - `result.threw` 出现 ⇒ **一律 FAIL**；
   - `result.previousStatus`：`availability(agent)` 只有 `running` / `inactive` 两个取值
     （`dsh-experimental-agent-team/lib/index.js:728-730`），而 `interrupt` 返回的是**取消前**采样的状态
     （`lib/index.js:501-517`）⇒ **`previousStatus === "running"` 就是「那一刻真的在飞」的直接证据**；
     `inactive` ⇒ 目标没在跑 ⇒ 这一轮**没有测成取消** ⇒ `INVALID-TEST`（不是 PASS）。
3. 最后验「这一轮没跑完」：该轮助手正文里**没有**到 400。

实测：`{"previousStatus":"running"}`、`threw=false`、`reachedEnd=false`、该轮 `turn/end` 已补上（seq 125）⇒ **PASS**。

### 13.6 恢复：三项证据分开取（**不能只看 `setAt`**）

| 要证明的 | 判据 | 实测 |
|---|---|---|
| **`resume` 真的发生** | 投递**前**在线对象拿不到 + 投递**后**重新在线 + 持久层**新增一轮**；旁证：`subagent/descriptor` 计数**不变**（冷恢复**重放**已落盘的 descriptor 而不再追加，`continuation-activation.js:440-448`；被**重新创建**才会多出第二条） | 成员 A：`available:false → true`（seq 100）、turn/start `9 → 10`、descriptor 计数 1→1；成员 B：`false → true`、turn/start `4 → 5`、1→1 |
| **新轮有真实 CLI** | 新 `assistant/message` 的 `data.message.source.{provider,model}`（**宿主记的「这一轮真正用的提供方」**，不是本插件的请求值）=== 该成员**冻结的目标** | 成员 A `pilot-cli / qoder-cn-acct-a`（= `routeA.target`）；成员 B `pilot-cli / qoder-cn-acct-b`（= `routeB.target`）。对照：两个 Lead 自己是 `opencode-go / deepseek-v4.1-flash`（宿主模型）⇒ 两者**确实不同** |
| **完整绑定身份** | `/team/routing` 同一条记录（同 `childSessionId`/`leadSessionId`/`memberName`/`target`/`account`/`model`）**且**恢复后**每一轮**都跑在冻结目标上 | 记录逐字未变；本轮成员 A 恢复后 **3 轮**助手归属全部 `pilot-cli / qoder-cn-acct-a` |

`setAt` 未变（`2026-10-13T18:41:58.895Z`）只作**辅助**记录 —— v1 的 `setAt` 判据在错域里也可能为真。

契约链（供复核）：`deliverFollowup` 见 `activation === undefined` ⇒ `coldResume`
（`dsh-subagent/lib/index.js:1820-1824`）⇒ `sessionQuery.observeSession` + `foldSubagentDescriptor`
+ `materialize`（`lib/types/continuation.js:338-382`）⇒ `ownerCtx.agents.resume({resumeSessionId})`
（`lib/types/continuation-activation.js:450-457`）⇒ 恢复的 Agent 回注册表并 announce `agent/created`
（`dsh-agent/lib/types/index.js:239/319-337`）。

### 13.7 隔离负控：**必须有正面对照**

- **正面对照**（确定性、宿主自写）：成员 A 的持久层里有 `messageId` 且 `source.senderId === Lead A`；
  成员 B 同理 `=== Lead B`；两侧**都真的跑了一轮**。
  ⚠️ 对照**不**取「模型有没有逐字复述」（那是模型遵从性，见 13.8）。
- **负控**：A 里没有 B 的 token / messageId，B 里没有 A 的；且**扫原始 JSONL**（消息可能只出现在
  tool-call 参数或收据里，只看助手正文会漏）。
- **`assistantCount = 0` 时判什么**：判 `INVALID-TEST`。目标没有转录时「没收到」**恒真** ⇒ 证据不足。
  本轮两侧都有转录（A 6 轮、B 4 轮）且都有正面对照 ⇒ 负控 PASS。

### 13.8 一处**判据分域**：观察到的模型行为差异（**没有**放宽断言）

同一句投递、同一套框架（`mailbox.deliveryContent` 的 `Team message <id> from lead:` 抬头），
成员 B **在两次运行之间行为不同**：

| 运行 | 成员 B 的助手正文 | Lead B 的持久层收据 |
|---|---|---|
| 较早一次 | `Token sent to lead.`（**转发**给了自己的 Lead） | `team-message-5be67847-99e1-4f00-84d8-d33c40fa192d`，内容 `sablefluxmv7eemxm` |
| 本次 | `sablefluxmv7f2lr5`（**逐字复述**） | — |

⇒ 这是**模型行为差异**，不是投递/路由差异。处置：把「成员**逐字复述**」单独成项、标成
`model-compliance` 域，**保留它的 verdict 不改成 PASS**，只从**路由结论**里分离出去；
「投递 → 消费」另立一项，判据是「产生了新轮 **且**（逐字复述 **或** 转发给 Lead 并被 Lead 记录）」。
两次的事实都留在**宿主自己的持久层**里（append-only），可复查。

### 13.9 跑对 caller 之后：跨轮往返是**产品真 bug** 还是**仍未验证**？

**如实说明：本轮没有观察到「成员跨轮」这条链上的产品缺陷。**

- v1 的 ①②③ FAIL：**真因是验收的 caller 错了**（13.1 #1），与产品行为无关 ⇒ **那些 FAIL 作废**。
- v1 的 ⑥ PASS：**假 PASS**（13.1 #2）⇒ **作废**。
- v1 的 ② PASS 与 ⑤ PASS：判据在错域里也可能为真（13.1 #3/#4）⇒ **依据作废，结论另测**。
- 跑对 caller 之后，重测的 17 项路由判据**全部 PASS**。

⚠️ **这不等于「这条链一定没问题」**：本轮只覆盖**一对** Lead + 一对同名成员、**各一条**业务消息、
**一次**取消、**一次**冷恢复；`observeSession` 那一格未验证（13.4）；重复运行会让 Lead 逐渐识别出
探针模式（实测 Lead A 在转录里开始统计「第几次 nonce 回声」）⇒ **长尾行为未覆盖**。

### 13.10 仍未确定（不得外推）

| # | 项目 | 状态 |
|---|---|---|
| 1 | `ctx.sessionQuery.observeSession()` 对成员转录的判定（header 兼容 / 回放校验 / 中断轮闭合补齐） | **未验证**（本插件无该 HTTP 面；本轮写入范围不允许新增端点） |
| 2 | 中断后**未认领的 inbox 工作**为什么让成员 A 长时间保持在线（实测某次运行后 A 在线 >15 分钟而 B 已 dispose） | **未验证**（只记录了现象，未归因） |
| 3 | 成员**逐字复述** vs **转发** 的触发条件 | **未验证**（观察到两次运行不同；样本 2，不外推） |
| 4 | 多 Lead / 多成员 / 并发投递下的隔离 | **未验证**（本轮只一对同名成员） |
| 5 | 桥接侧 `tools/call` 真机（ACP 通道） | **未验收**（沿用 §9 第 5 行） |

### 13.11 复现命令与证据文件

```bash
# ⚠️ /probe/team 是全局 lead 会话：两路同跑必然互相摧毁证据 ⇒ 单进程串行
node probe/verify-team-routing-member-rounds.mjs \
  session-hp-prod-lead-a-mv7129vh iso-worker-mv7129vh \
  session-hp-prod-lead-b-mv7129vh iso-worker-mv7129vh
```

| 文件 | 内容 |
|---|---|
| `probe/out/team-routing-product/member-rounds-v2.json` | 本轮 19 项的完整证据（含 messageId / seq / 收据原文 / 投递边 / 轮次骨架 / 助手归属） |
| `probe/out/team-routing-product/member-rounds-v2.log` | 同一轮的 stdout（逐项 verdict） |
| `probe/out/team-routing-product/member-rounds.log` | **v1 的历史证据，未改动** |
| `probe/_session-store.mjs` | 持久层只读读取（多帧 zstd 逐帧解） |

### 13.12 本节写入范围

改：`src/index.ts`（**仅** `ensureLead` 接受显式 `leadSessionId` + `send`/`interrupt` 的透传与回显，全部为加法）、
`probe/verify-team-routing-member-rounds.mjs`（重写）、`docs/verified/team-routing.md`（本节 + §4/§6.2/§9/§11 的更正指引）、
`docs/00-verified-status-report.md`（**仅文末追加**）。
新增：`probe/_session-store.mjs`。
**未**改：`src/team-routing.ts`、`src/tools.ts`、`src/provider.ts`、`src/sessions.ts`、`src/mcp-bridge*.ts`、
`src/transports/**`、`client/client.js`、`package.json`、profile 配置；**未**重启/升级宿主；
**未**回滚任何他人改动；**未**改默认 profile。