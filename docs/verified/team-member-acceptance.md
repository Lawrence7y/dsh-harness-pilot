# 团队成员能力：U1（绑定时序）+ 2.2（两名成员验收）+ 2.3（工具通道）实测报告

> 本文件只写**本轮实测到的东西**，并按「确证 / 推断 / 未查」分级。
> 所有结论都指到可复核的产物：宿主落盘转录、CLI 自己写的 manifest、插件观测日志、运行版 asar 源码位置。

---

## 0. 一句话结论

1. **U1 = 成立（确证）**：新生团队成员的绑定**确实在它自己的第一次 LLM 请求之前**写入正式绑定表，
   且来源归因正确（`provider=pilot-cli`、`model=<目标名>`，由请求层 `agent/request` 改写）。
2. **2.2 = 4 项 PASS / 1 项 PASS-WITH-CAVEAT / 1 项 FAIL / 2 项 PASS**（逐项见 §4），
   其中 **④ 双向成员通信不通过** —— 直接后果是下面的 2.3。
3. **2.3 = 未完成（确证）**：这条路由上只有 **prompt 文本**，**没有可执行通道**。
   DSH 工具 schema 确实被渲染进 CLI 的 prompt，但适配器**从不产出 `tool-call` 块**，
   而工具执行由「assistant 消息里出现 tool-call 块」触发 ⇒ `executeToolCalls` **永不执行**。
4. `prepareContinuable` **一次都没有被用来造假外部成员**：全部成员都是官方
   `agentTeams.spawnTeammate(lead, {provider:'spawn', context:'fresh'})` 产生的**真**进程内 DSH 子代理，
   外部性来自**每轮请求被改道**给外部 CLI。成员 = **进程内 Agent + 进程外推理**。

---

## 1. 测量环境与版本（**必须一起读**，否则证据会被误用）

| 项 | 值 |
|---|---|
| 宿主 | `D:\DeepSeek\resources\app.asar`（rc.2 打包运行版；**不是** `D:\Project\deepseek-harness-master` 那份 checkout） |
| 插件 home | `C:\Users\Administrator\.dsh\plugins\harness-pilot` |
| 探针日志 | `C:\Users\Administrator\.dsh\profiles\desktop\probe\out\team-member-binding.jsonl`（宿主进程 cwd = profile 目录） |
| 绑定表 | `C:\Users\Administrator\.dsh\plugins\harness-pilot\session-bindings.json`（与 `POST /session/binding` **同一个文件**） |
| 会话转录 | `C:\Users\Administrator\.dsh\sessions\<cwd-slug>\<sessionId>\session.v4.jsonl.zstd`（多帧 zstd） |
| CLI 侧痕迹 | `C:\Users\Administrator\.dsh\harness-accounts\<档案>\logs\runs\<run>\{manifest.json, qodercli.log}` |

### 各次测量的插件版本（`GET /api/diag/loaded`，均为 `anyStale=false`，即磁盘=已加载）

| 测量 | `index.js` | `llm-adapter.js` | 结果 |
|---|---|---|---|
| U1（单成员，HOLDS） | `28be2ea43b1a` | `11db79b2ebb8` | `probe/out/team-member-u1.json` |
| 2.2 v2（①②③④⑥） | `444a0dce6c4d` | `11db79b2ebb8` | `probe/out/team-member-acceptance.json` |
| 2.2 ⑤⑦ 定向复验 | `09333dc56fc9` | `11db79b2ebb8` | `probe/out/team-member-cancel-recovery.json` |
| 9 项回归 | `3460bfe70cbc` | `28ee830ede49` | `probe/out/regression-suite.json` |

> ⚠️ **并发写入是真实存在的干扰**：本轮期间另有子代理在改 `src/index.ts`、`src/federation/**`、
> `src/llm-adapter.ts`、`src/processpool.ts`，插件因此反复热重载（回归跑批期间 `index.js` 换过 3 个哈希、
> 其中一次查询落在重载窗口返回 `(unreachable)`）。每次测量都在报告里记了 `pluginBefore/After`；
> **三次测量各自的 before/after 都相同**（版本稳定），回归跑批则是在 2 次版本漂移下仍然 9/9。

---

## 2. U2 —— `agent/created` 的精确 payload 与触发时机（**确证**）

### 2.1 一个必须先纠正的前提：**checkout 不是运行版**

- **运行版**（从 `app.asar` 里取出，`probe/_asar-read.cjs` → `probe/out/_live-dsh-agent-types.js:319-336`）：

```js
async announce(agent, source, signal) {
    ...
    await this.ctx.serial(entry.carrier, 'agent/created', {
        agent: entry.agent,
        source,
        ...signal === undefined ? {} : { signal },
    });
}
```

- **checkout**（`packages/core/agent/lib/types/index.js:332`）写的是 `emit` + `{ agent: entry.agent }`，**没有** `source` / `signal`。
- 实测观测到的 `payloadKeys` = `["agent","source","signal"]`（日志 seq 3）—— 与**运行版**一致，与 checkout 不一致。

⇒ **payload = `{ agent, source, signal? }`**；并且它是 `ctx.serial` 派发，**监听器会被 await**
（不是 fire-and-forget）。「从源码 checkout 推断宿主行为」这一步本身就是错的。

### 2.2 触发时机（确证：`agent/created` 严格早于第一次 LLM 请求）

`dsh-agent-loop` 的 `publish`（运行版 `_live-agent-loop.js` 同源结构）：
`sessions.enter(session)` → `sessions.announce(session)` → **`agents.announce(agent)` = `agent/created`** → `agent/session-start`。
而成员创建路径是 `startContinuable(...)`：先 `materialize`（内部走 `agents.create` → publish → `agent/created`），
**之后**才 `submitMaterialized(request.prompt)`（`continuation.js:200-209`）把初始 prompt 投进 inbox。
⇒ 事件顺序上 `agent/created` 必然早于「成员第一次模型请求」。

### 2.3 **在那时刻子会话里读不到 prompt**（这是关键的可观测事实）

实测 seq 3 的 `childEvents`（`agent/created` 触发**那一刻**该子会话已落盘的事件类型）：

```
subagent/descriptor, sandbox/mode, approval/policy, permission/preset, subagent/model-selection-policy
```

**没有 `user/message`**。原因（确证）：子会话的 seed 只由 `seedDescriptorTurn` 生成 ——
`Session.create(childId, seed)` + `append('subagent/descriptor')`（`descriptor-seed.js:19-23`），
初始 prompt 要等 `submitMaterialized` 才落盘。

⇒ 「在 `agent/created` 时读子会话的 prompt 来认出这是哪个成员」**按设计就不可能成功**。
可行的接缝是 **Lead 的会话日志**：

- `TeamRoster.spawnAdmitted` 先 `journal.appendAndFlush(root, 'team/member', {member})`（`roster.js:240-249`，`member.id === childId`），
  **之后**才 `subagents.startContinuable(...)`（`:252`）；
- `TeamJournal.appendAndFlush` = `root.session.append(type, data)`（**同步**）+ `await ctx.sessions.flush(root.session)`（`journal.js:49-57`）。

⇒ `agent/created` 触发时，Lead 日志里**一定**已经有那条 `team/member`（含成员名）。本轮探针即用此接缝，
日志里记为 `identifiedBy: "lead-journal:team/member"`。

### 2.4 另一个必须指出的运行版事实：`Session` 没有 `events` accessor

运行版 `Session`（`probe/out/_live-dsh-session-types.js`）只有 `log` 字段、`eventAt(seq)`、`get seq()`。
**没有** `session.events`。本插件自己的 `sessionLogRead`（`src/index.ts`）用的就是 `seq`+`eventAt` 这一对。
用 `session.events` 会让读取路径**永远返回 undefined**，看起来像「宿主没给数据」。

---

## 3. U1 —— 绑定能不能在第一次 LLM 请求之前写完？**成立（确证）**

### 3.1 判据（来自上级，未放宽）

> 第一次 LLM 请求发生时绑定**已在**，且**来源归因正确** ⇒ U1 成立。

先后用**单一日志里的自增 `seq`**判定（不靠毫秒；同毫秒时时间戳分不出来）。

### 3.2 证据（`probe/out/team-member-u1.json` + 观测日志）

成员 `u1-sttw` → 目标 `qoder-cn-acct-a`，子会话 `1782ab83-1ed6-45f0-90e8-d636bc760403`：

| seq | 事件 | 关键字段 |
|---|---|---|
| 3 | `agent/created` | `payloadKeys=["agent","source","signal"]`、`idMatchesHeader=true`、`childEvents` 里**无** `user/message` |
| 4 | `bind.written` | `via="agent/created"`、`identifiedBy="lead-journal:team/member"`、`sink="session-bindings"` |
| 5 | `llm/stream` | `requestIndex=1`、`provider="pilot-cli"`、`model="qoder-cn-acct-a"`、`bindingAtRequest.present=true` |

⇒ **第一次**模型请求时 `bindingAtRequest.present === true`，且请求已经跑在 `pilot-cli` 上
（说明请求层 `agent/request` 改写确实读到了绑定）。

**落盘交叉核对**：`session-bindings.json` 里确有该会话，`harnessId="qoder-cn-acct-a"`、`accountId="qoder-cn-a"`、
`setAt="2026-10-13T14:50:33.951Z"` —— 与 seq 4 同一秒，且**写入的是正式绑定表**（不是探针内存）。
宿主转录 `1782ab83-…/session.v4.jsonl.zstd` 的 `request/header.config = {provider:"pilot-cli", model:"qoder-cn-acct-a"}`。

### 3.3 两名成员各自第 1 次请求（v2 复核）

`probe/out/team-member-acceptance.json` 的 `firstRequests`：
`a:{index:1, provider:"pilot-cli", model:"qoder-cn-acct-a", bindingPresent:true}`、
`b:{index:1, provider:"pilot-cli", model:"qoder-cn-acct-b", bindingPresent:true}`。

### 3.4 顺带确证：**冷恢复路径上 U1 同样成立**

成员被中断后其进程内 Agent 会被**冷恢复**（`ownerCtx.agents.resume` → 重新 publish），
于是 `agent/created` **对同一个子会话再触发一次**（观测日志 seq 34/35、56/57；第二次的 `childEvents`
里已带着上一轮的完整历史 `agent/inbox/spliced … turn/end`）。此时绑定同样在「恢复后的第一轮请求」之前就位。

---

## 4. 2.2 —— 两名成员逐项验收

成员构造：`agentTeams.spawnTeammate(lead, {name, description, prompt, context:'fresh', provider:'spawn', signal})`。
两名绑定成员 `tm-a-*`→`qoder-cn-acct-a`、`tm-b-*`→`qoder-cn-acct-b`；
另有一名 **`tm-c-*` 故意不配置目标**（从诞生起就是原生）作 A/B 正对照；
`tm-d-*`/`tm-cr-*`（后一次）用于取消 / 恢复。

> **绑定里不带 `accountId`**：`qoder-cn-acct-a` / `-b` 这两个目标自己在 `src/config.ts:354-371` 里
> 钉死了 `--config-dir`。带上 `accountId: qoder-cn-a` 会被适配器**正确拒绝**
> （`PILOT_CLI_UNAVAILABLE`：「账号 qoder-cn-a 属于 Harness「qoder-cn」，与目标「qoder-cn-acct-a」不是同一个 Harness」）。

### ① 真实外部 CLI 调用 —— **PASS**

判据是三条**互相独立**的事实同时成立（而不是 provider 名）：

| 事实 | A（qoder-cn-acct-a） | B（qoder-cn-acct-b） |
|---|---|---|
| 宿主转录 `request/header.config` | `{provider:"pilot-cli", model:"qoder-cn-acct-a"}` | `{provider:"pilot-cli", model:"qoder-cn-acct-b"}` |
| **CLI 自己写的** `manifest.json` | 1 次运行，`argv` 含 `-p` 且 `--config-dir …\harness-accounts\qoder-cn-a`（`cli_version=1.1.41`, pid 48564） | 1 次运行，`--config-dir …\qoder-cn-b`（pid 968） |
| 回复真的落进会话 | 61 字，含本次唯一票据 `HPMA-TDLWX` | 61 字，含 `HPMB-TDLWX` |

`manifest.json` 是**外部 CLI 进程自己写的**（含 `argv`/`pid`/`started_at`），不是本插件的自报 ——
这是「这一轮确实由外部 CLI 产生」最硬的一条。

### ② 不同账号身份，互不串号 —— **PASS**

- A 的回复**不含** B 的票据，B 的回复**不含** A 的票据（各只含自己那一个）；
- A 的全部 CLI 运行 `--config-dir` 落在 `qoder-cn-a`，B 的全部落在 `qoder-cn-b`；
- 两个档案的隔离本身由 `--config-dir` 提供（该档案目录内含自己的 `.auth/`，见 `/api/accounts` 的 `isolation` 披露）。

### ③ `actual` 供应商与模型 —— **PASS-WITH-CAVEAT**

给的是**实际采用值**，取自宿主自己写在 assistant 消息上的来源（不是请求值、也不是绑定位）：

- A：`assistant/message.source = {provider:"pilot-cli", model:"qoder-cn-acct-a", kind:"model"}`
- B：`assistant/message.source = {provider:"pilot-cli", model:"qoder-cn-acct-b", kind:"model"}`

⚠️ **未确定（不得外推）**：`model` 在本路由上的语义是**目标名（票据）**，不是上游模型 id。
绑定里没有 `model` ⇒ 适配器不发 `-m` ⇒ 外部 CLI 用它自己的默认模型。CLI 的 `manifest.json`
**不记模型**，所以「上游究竟是哪个模型」本轮**没有**独立取到。
（已知陷阱「ACP 的 `set_config_option` 对不存在的模型也会成功」在本路由**不适用**：这条路由不走 ACP，
走的是 headless argv 派发，且请求层改写发生在请求落盘**之前**，转录可证。）

### ④ 双向成员通信 —— **FAIL**（本轮唯一不通过项，与 2.3 同源）

**改道成员（A 第 2 轮，仍绑定 `qoder-cn-acct-a`）**，prompt 明确要求调用 `send_message` 与 `list_agents`：

| 观测量 | 值 |
|---|---|
| assistant 里 `tool-call` 块 | **0** |
| 工具执行类事件（`/tool/i`） | **[]**（空） |
| A **自己发出**的 `team/message` 事件（按 `message.senderId === A 会话 id` 过滤） | **0** |
| 请求头里的 DSH 工具 schema 数 | **45**（确实渲染进 prompt 了） |
| 该轮正文 | 574 字（模型用**文字**描述了它"要"做什么，但没有任何工具被执行） |

**A/B 正对照 —— 原生成员 C（从诞生起未绑定，从没被改道过）**，同一句 prompt：

| 观测量 | 值 |
|---|---|
| assistant 里 `tool-call` 块 | **2** |
| 工具执行类事件 | **`["tool/call","tool/result"]`** |
| C 自己发出的 `team/message/queued` | **1**（`senderId === C 会话 id`，内容含拼接 token `HPC-FROMC-OK-TDLWX`） |
| C 的回复原文 | 明确写出两次工具调用的结果：`send_message → status: queued, message id team-message-ed30751e-…`；`list_agents` 返回 `lead / tm-a / tm-b / tm-c` |

⇒ **结论**：`send_message` / `list_agents` / `team_task_*` 这些工具在**改道轮次里没有可执行通道**，
所以「成员→Lead」「成员→成员」两个方向**都不成立**；而**同一套团队机制**在原生轮次里**真的可用**
（工具真执行、消息真落盘成 durable `team/message`）。**不通的是这条路由，不是团队机制。**

> 探针测量纪律留档（v1 曾在这里出过错）：`team/message/queued` 是写在 **Lead 日志**里的，
> **Lead 自己投递消息也会写它** ⇒ 不能拿「Lead 侧新增 team/message 条数」当成员发消息的证据。
> 现在双重排除：① 按 `message.senderId === 成员会话 id` 过滤；② 要求成员发出的内容含一个
> **在投递文本里从不出现**的拼接 token（prompt 里只给 `"HPC"`、`"-FROMC-"`、`"OK-…"` 三段，要求它自己拼）。

**Lead → 成员（服务层）**：本轮用 `agentTeams.sendMessage(lead, {target, content, delivery:'wakeup'})`
（即 `send_message` / `followup_task` 工具**内部调用的同一个服务方法**）投递了 4 次，**每次都真的驱动了成员的一轮**
（transcript 的 `turn/start` 递增、回复含本次票据）⇒ 这条方向的服务语义可用。
**但**这证明的是**服务**可用，**不是**「模型在改道轮次里能通过工具调它」—— 后者即上面的 FAIL。

### ⑤ 取消 —— **PASS**（行为可观察，不是「接口返回成功」）

- 第 1 次调用 `agentTeams.interrupt(lead, name)`（= `interrupt_agent` 工具内部同一个服务方法）时，
  返回的**采样状态 = `"running"`** —— 这是「这次取消确实测在一个活轮次上」的前提（v1 那次采样到
  `"inactive"`，因为轮次早已因别的原因结束，那次**不算数**）。
- 该成员的该轮**确实结束了**，终态 = `{"kind":"aborted","reason":{"kind":"parent"}}`。
- 机制（确证，代码）：`roster.interrupt` → `ctx.subagents.interrupt(childId, {kind:'ancestor', agent:caller})`
  （`roster.js:178-191`）；headless 传输层在 abort 时 **`killTree(child.pid)`** 并
  `finish('aborted','cancelled by caller')`（`src/transports/headless.ts:102-110`）。
- **已知边界（确证 + 未查）**：只能 abort **当轮**；它杀不掉外部 CLI **已经在目标系统里产生的副作用**。
  「副作用是否已被撤销」本轮**没有测**，属**未查**。

### ⑥ 第二轮任务：绑定仍在、上下文在、身份未漂移 —— **PASS**

- A 第 2 次请求的观测记录：`requestIndex=2`、`bindingAtRequest.present=true`
  （`harnessKind="external"`、`harnessId="qoder-cn-acct-a"`）；
- 第 2 轮 `request/header.config` 与第 1 轮**同 provider 同 model**；
- 第 2 轮的 user 消息数 = 1（新任务确实投进去了，不是重放第 1 轮）；
- 转录是**同一个会话文件**（turn 序号递增），不是新建会话。

> ⚠️ 同一成员**多跑几轮会被 argv 上限挡住** —— 见 §5.1。实测第 3 轮起 `spawn ENAMETOOLONG`。

### ⑦ 恢复 —— **PASS**（v2 那次 FAIL 的判据是我自己的代理指标，已定位并修正）

v2 那一轮 ⑦ 判 FAIL，原因是「绑定 `setAt` 被改写」。**事后查明不是产品行为**：

- 观测日志 seq **56/57** 显示：成员被中断后其 Agent 被**冷恢复**，`agent/created` 对同一子会话**再触发一次**
  （`childEvents` 里带着上一轮的 `agent/inbox/spliced … turn/end`），而当时的探针**没有幂等判断**，
  把**等值**的绑定重写了一遍，只是把 `setAt` 推后（`15:07:23.433Z → 15:07:29.165Z`）。
- 修正：`agent/created` 路径加**幂等**（目标相同 ⇒ 只记 `bind.kept`，不重写）。这是本轮**唯一**的产品侧代码改动。

**定向复验（`probe/out/team-member-cancel-recovery.json`，同一插件版本 before==after）**：

| 判据 | 值 |
|---|---|
| 中断时目标状态 | `"running"` |
| 第 1 轮终态 | `{"kind":"aborted","reason":{"kind":"parent"}}` |
| 中断后同一成员**真的又跑了一轮** | 是（含本次恢复票据 `HPCR-TN5BW`，路由仍 `pilot-cli`/`qoder-cn-acct-a`，正文 27 字） |
| 绑定**未被重写** | 是（`setAt` `2026-10-13T15:14:08.579Z → 15:14:08.579Z`） |
| **已完成的写操作未被重放** | 是（`turn/end` 1→2，只 +1；该成员已发出的 `team/message` 0→0） |
| 幂等日志 | `["5:bind.written", "12:bind.kept"]` ← 第一次写、冷恢复时**保留** |

---

## 5. 本轮额外确证的边界（都会影响后续设计，必须一起读）

### 5.1 **prompt 走 argv ⇒ 长会话会 `spawn ENAMETOOLONG`**（确证）

- `qoder-cn-acct-a` / `-b` 这两个目标**没有**声明 `promptViaStdin`，因此
  `headlessArgv` 把 prompt **拼进 argv**（`src/transports/headless.ts:32-39`）。
- 每轮渲染进 prompt 的东西包含 **45 个 DSH 工具 schema**（`request/header.tools` 实测 45）**加全部历史**。
- 实测（v1，同一成员）：第 1、2 轮正常；**第 3、4、5 轮**全部
  `pilot-cli: 无法把这一轮交给外部 CLI "qoder-cn-acct-a"：spawn ENAMETOOLONG`
  （`code: PILOT_CLI_UNAVAILABLE`；转录 `turn/end.reason.kind="error"`）。
- ⇒ 「让一个被改道的成员长期跑很多轮」目前**不成立**。这是**已实测**的限制。

### 5.2 适配器会拒绝「账号 + 账号已钉死的目标」错配（确证）

见 §4 开头。这不是缺陷：它拒绝把一个无关的配置目录塞给另一个 CLI。

### 5.3 并发写入导致 `src/index.ts` 一度无法编译（如实留档）

- 23:10 有并发子代理改了 `src/index.ts`（`docs/verified/write-ownership.md` 把该文件的团队/U1 区域判给 M=本路），
  引入 3 个未定义标识符（`DispatchSpec` / `thawAccount` / `fingerprintOf`），叠加新文件 `src/processpool.ts`
  的 readonly 赋值错误 ⇒ `node scripts/build.mjs` **退出码非 0**。
- 本路只做**加法**：在那三条 import 里补齐缺失名字（**未回滚任何人的改动**）。随后 `exit=0`，
  三个 client 工件 SHA256 全等（`DAB6D9CD6CB60FDC…`）。`processpool.ts` 的 3 个错误在其后续提交里已消失。

---

## 6. 诚实分级

### 6.1 确证（本轮直接实测，或有 file:line 的代码依据）

| # | 结论 | 证据 |
|---|---|---|
| E1 | 运行版 `agent/created` payload = `{agent, source, signal?}`，经 `ctx.serial` 派发（监听器被 await） | `probe/out/_live-dsh-agent-types.js:319-336`（从运行中 asar 取出）；观测日志 seq 3 的 `payloadKeys` |
| E2 | checkout 的 `{agent}` + `emit` 版本**不是**运行版 | 同上两条对比 |
| E3 | `agent/created` 严格早于成员第一次 LLM 请求 | `agent-loop` publish 顺序（enter→session announce→**agents.announce**→session-start）＋ `continuation.js:200-209` 把 `submitMaterialized` 放在 `materialize` 之后 |
| E4 | `agent/created` 那一刻子会话里**没有**初始 prompt | 观测日志 seq 3 的 `childEvents`（只有 `subagent/descriptor` 等 5 条）；`descriptor-seed.js:19-23` |
| E5 | Lead 日志在 `agent/created` 时**已有** `team/member`（含 `member.id===childId`） | `roster.js:240-249`（在 `:252` `startContinuable` 之前）＋ `journal.js:49-57`（`append` 同步 + `await flush`） |
| E6 | 运行版 `Session` **没有** `events` accessor，只有 `log`/`eventAt(seq)`/`get seq()` | `probe/out/_live-dsh-session-types.js` |
| E7 | **U1 成立**：第一次请求时绑定已在，来源归因正确 | `probe/out/team-member-u1.json`（seq 3→4→5）；`session-bindings.json`；宿主转录 `request/header` |
| E8 | 2.2 ① 两条独立证据链（宿主转录 + CLI 自写 manifest.argv） | `probe/out/team-member-acceptance.json` 的 `cliRuns` |
| E9 | 2.2 ② 两账号互不串号 | 同上（票据互不含 + `--config-dir` 各自归位） |
| E10 | 2.2 ③ 实际采用值 = `pilot-cli` + 目标名（取自 `assistant/message.source`） | 同上 |
| E11 | 2.2 ④ **改道轮次里 DSH 工具不可执行**（0 tool-call 块、0 工具事件、0 成员发出的 team/message），而**原生对照成员真的执行了**（2 tool-call 块、`tool/call`+`tool/result`、1 条 `team/message/queued`） | 同上 `turns.a2` / `turns.c1` / `control` |
| E12 | `executeToolCalls` 只在 assistant 消息含 `tool-call` 块时被调用 | 运行版 `probe/out/_live-agent-loop.js:1153-1155` |
| E13 | 适配器**只**产出 `text` 块（`block-start` 的唯一 `blockType` 是 `'text'`），从不产出 `tool-call` 块 | `src/llm-adapter.ts:302`、`:332-344` |
| E14 | 工具 schema 确实被渲染进 CLI 的 prompt（= 「写进 prompt」而不是桥接） | `src/llm-adapter.ts:276-278`；实测 `request/header.tools` = 45 |
| E15 | 2.2 ⑤ 取消行为可观察：中断时 `previousStatus="running"`，该轮终态 `{kind:"aborted",reason:{kind:"parent"}}` | `probe/out/team-member-cancel-recovery.json`；`roster.js:178-191`；`headless.ts:102-110` |
| E16 | 2.2 ⑥ 第 2 轮：绑定仍在、同一路由、新 user 消息 | `probe/out/team-member-acceptance.json` 的 `turns.a2` + 观测日志 `requestIndex=2` |
| E17 | 2.2 ⑦ 恢复：又跑一轮、绑定未被重写、无重放（幂等日志 `bind.written`→`bind.kept`） | `probe/out/team-member-cancel-recovery.json` |
| E18 | 冷恢复会让 `agent/created` 对同一子会话**再触发一次** | 观测日志 seq 34/35、56/57（第二次 `childEvents` 已含上一轮历史） |
| E19 | prompt 走 argv ⇒ 第 3 轮起 `spawn ENAMETOOLONG` | v1 `turns.a3/a4/a5` 的 `turn/end.reason`；`headless.ts:32-39`；目标未声明 `promptViaStdin` |
| E20 | 适配器拒绝「账号 + 已钉死账号的目标」错配 | 宿主转录 `turn/end.reason`（`PILOT_CLI_UNAVAILABLE` 原文） |
| E21 | 9 项回归 9/9 PASS（期间插件版本漂移 2 次仍全过） | `probe/out/regression-suite.json` |
| E22 | profile 未被改写 | `cordis.yml=33B0735DD8756CAF…`、`cordis.patch.yml=2D0C57810C6083EB…`（与预期一致） |

### 6.2 推断（写清依据）

| # | 推断 | 依据 |
|---|---|---|
| I1 | 「改道轮次工具不通」是**路由**的性质，不是成员/团队机制的性质 | E11 的 A/B 对照（同一套机制、同一种成员；唯一变量是该轮**是否被改道**） |
| I2 | 因此**只要该轮不被改道**，团队成员可以正常使用 DSH 工具与团队通信 | I1 + E11 的正对照 |

### 6.3 未查（**不得**当作结论）

| # | 未查项 | 说明 |
|---|---|---|
| U-a | 上游真实模型 id | CLI 不记模型，绑定也不给 model ⇒ 没取到（见 ③） |
| U-b | 取消后「外部 CLI 已在目标系统产生的副作用」是否被撤销 | 只确证了进程被杀（`killTree`）与轮次以 aborted 结束；副作用未测 |
| U-c | 被中断那轮的**内容**是否会在下一轮被外部 CLI「重做」 | 观察到一次（v2：中断的长文任务在恢复轮里又被写出来，因为历史里还带着那条请求），但**没有**把它设计成实验 ⇒ 只能作为观察，不作结论 |
| U-d | 原生成员 C 的 `send_message`（`delivery:"quiet"`）何时真正 delivered | 本轮只到 `queued`（quiet 语义就是「不唤醒空闲成员」）；Lead 未跑轮次 ⇒ 未测 delivered |
| U-e | 其它目标（`wb-managed-*` / `opencode` 等）在改道路由上的行为 | 本轮只用 `qoder-cn-acct-a` / `-b` |
| U-f | 声明了 `promptViaStdin` 的目标是否就没有 ENAMETOOLONG | 未测（本轮两个目标都没声明） |

---

## 7. 本轮产物与复现命令

| 产物 | 说明 |
|---|---|
| `probe/verify-team-member-u1.mjs` | U1 时序实验（会真发 1 轮外部调用） |
| `probe/verify-team-member-acceptance.mjs` | 2.2 ①②③④⑥ + A/B 正对照（真发 4 轮外部 + 1 轮原生） |
| `probe/verify-team-member-cancel-recovery.mjs` | 2.2 ⑤⑦ 定向复验（真发 2 轮外部） |
| `probe/_regression-suite.mjs` | 9 项回归串行跑批（带「失败且期间版本变过 ⇒ 重试一次」） |
| `probe/_asar-read.cjs` | 只读地从运行中 `app.asar` 取一个文件（**运行版 ≠ checkout** 的取证工具） |
| `probe/out/team-member-u1.json` / `team-member-acceptance.json` / `team-member-cancel-recovery.json` / `regression-suite.json` | 机器可读报告 |
| `probe/out/_live-dsh-agent-types.js` / `_live-dsh-session-types.js` / `_live-agent-loop.js` | 从运行版 asar 取出的源码（引用的 file:line 指的就是这三份） |

```powershell
# 前置：确认跑的是当前源码
(Invoke-WebRequest 'http://127.0.0.1:4200/harness-pilot/api/diag/loaded' -UseBasicParsing).Content   # anyStale 必须为 false

node probe/verify-team-member-u1.mjs
node probe/verify-team-member-acceptance.mjs
node probe/verify-team-member-cancel-recovery.mjs
node probe/_regression-suite.mjs
```

> ⚠️ 三个团队探针都会**真的调用外部 CLI**（并各自消耗少量额度）；`_regression-suite.mjs` 里的
> `verify-federation-registry/providers/accounts` 也会真实 spawn 厂商 CLI。
