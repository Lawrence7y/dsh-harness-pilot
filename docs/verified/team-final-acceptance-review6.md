# 团队成员「改道 + 工具桥接」最终验收 —— **独立审查 6 条判据的重做（review6）**

> 本文件是**判据侧**的报告，与同目录的 [`team-final-acceptance.md`](team-final-acceptance.md)（另一路验收写的
> **v2 脚本**报告）并列存在，两者**互相不覆盖**。分工：
> - 本文：**独立审查点名的 6 条判据缺陷**，落在**共享脚本** `probe/verify-team-final-acceptance.mjs` 上；
> - 那一份：另一路验收**新建**的 `probe/verify-team-final-acceptance-v2.mjs` 与它的产品缺陷补丁。
>
> 分级：**确证**（有落盘产物可复算）/ **推断**（由数据构造出，写明推理）/ **未查**（没测）。
> ⚠️ 全篇**不给百分比**；**不把推断写成确证**；**历史报告的结论一个字都没改**。

---

## 0. 三句话结论

1. **B→A 仍然是「未通过」**（**确证**，不许改写）：历史那一轮 B 的 CLI **零 `tool.requested`**、
   B 的回复正文明确说「本通道没有工具协议……无法直接给队友发消息」并**请求 Lead 代发**，
   桥接侧没有 B 的 call，`queued` 的发送者**不是 B**；A 复述 token 是 **Lead 代发**的结果
   —— **A 复述 token 不能算 B 自发**。新判据在**同一份历史数据**上重算，这一条**依旧不成立**。
2. **A→B 有**真实传送链**（**确证**）**：真实的 CLI 工具参数 + 返回的 `messageId` + `queued(A→B)`
   + B 收到**同一个 id** 并**受影响**（B 的回复逐字说出 token）。历史报告里这一项的桥接侧
   `calls/results` 是**空的** —— 那是**判据的漏采**，不是通道没通；新判据从**同一份桥接日志**
   里把那两行（外加一行**没有 `sessionId`** 的 `pipeline.execute`）**逐条恢复出来**（§4）。
   按独立审查的定性，这构成「已构成真实传送链」；但历史报告里 5a 的 `FAIL` **不改**（它由旧判据产出）。
3. **6 条判据缺陷全部落地**（§2 逐条），**没有一条靠放宽断言**；在**同一份历史数据**上重算的结果是
   ④ 由 FAIL → **PASS**、⑤a 传送链子判据 **PASS**、⑤b 依旧 **FAIL**、⑦ 判 **`INVALID-TEST`**
   （历史报告没有逐字段留档绑定，「完整绑定字段一致」**重算不了** ⇒ 按纪律**不判正负**）。

---

## 1. 结果并列（历史失败 / 新契约）

### 1.1 历史那一轮（00:55:55，stamp X49KE）

只读副本：`probe/out/team-final-acceptance.historical-005555.json`（**原路径 `probe/out/team-final-acceptance.json`
由团队脚本按自己的节奏维护，本文不改它**）。

| 项 | 历史判定 |
|---|---|
| ① 真实外部 CLI 调用 | PASS |
| ② 不同账号身份互不串号 | PASS |
| ③ actual 供应商与模型 | PASS |
| ④ 每成员 ≥3 轮 | **FAIL** |
| ⑤a A→B（桥接·到达并影响行为） | **FAIL**（桥接侧 `tools/call=[]`） |
| ⑤b B→A（桥接·到达并影响行为） | **FAIL**（B 的 CLI 零 `tool.requested`、`queued(senderId=B)=false`） |
| ⑤c 正对照（原生成员也能发） | PASS |
| ⑤d 负对照（作用域缺席名被拒） | PASS |
| ⑥ 取消 | PASS |
| ⑦ 冷恢复 | **FAIL**（「id 列表不同」被判重放） |

### 1.2 新契约 · 同一份历史数据**只读重算**（确证）

产物：`probe/out/team-final-acceptance-v2-review6-reanalysis.json`
复算命令：`node probe/_review6-reanalysis.mjs`（**只读**：不 spawn、不调模型、不写任何会话日志）

| 项 | 新契约判定 | 关键证据 |
|---|---|---|
| ④ 每成员 ≥3 轮 | **PASS** | A 真实完成轮 4（R1/R2/R3/R5）+ 取消轮 1（R4）；B 真实完成轮 3；8/8 普通轮票据证据齐全；8/8 普通轮 stdin 四条并集成立（例：CLI 收到 **32,065** 字符 vs 同一 pid 真实命令行 **266** 字符） |
| ⑤a 传送链子判据 | **PASS** | 7 环全真（CLI 工具参数 / `mcp.tool/call` / `result(isError=false)` / 返回 id / `queued(senderId=A)` / `delivered` / 对端回执同一 id / 对端复述 token） |
| ⑤b 传送链子判据 | **FAIL** | `cliToolArgs=false`、`bridgeCallRecovered=false` ⇒ 与历史结论方向一致 |
| ⑦ 冷恢复 | **`INVALID-TEST`** | 可重算的腿：`reasonKindCompleted=true`、`cliUnique=true`（认对 PID **34640**）、`noReplayByCount=true`、`turnDelta=+1`；但历史只留档了绑定的 3 个字段 ⇒ **「完整绑定字段一致」无法重算**（证据不足，不判正负） |

### 1.3 新契约 · 新跑一轮

见 §6（运行器为「礼貌版」：只在另一路验收空闲时才跑；被顶掉则整轮中止，退出码 4，**不产出**会被误读的结论）。

---

## 2. 六条判据缺陷：逐条「原判据 → 问题 → 新判据 → 理由」

> 每条都标明是 **判据错**（表达不出要求原文 / 会假阴假阳）还是 **产品变**（被测对象/环境变了）。
> **没有一条**是「为了让套件变绿」。

### 2.1 不许用 `sessionId` 过滤整份桥接日志（审查第 1 条）

- **原判据**：`collectRound` 先按 `e.sessionId === member.sessionId` + 时间窗得到 `inWindow`，
  之后 `call/result/pipeline/reject` 都只在这个集合里找。
- **问题（确证，可数）**：整份桥接日志 768 行里 **93 行没有 `sessionId`** ——
  `tools/execute` 69、**`pipeline.execute` 12**、`mcp.reject` 9、**`mcp.tool/reject` 3**。
  这些行只有 `bridgeId`（或 `bridgeIds[]` + `callId`）⇒ 被 `sessionId` 过滤**静默丢掉**。
- **新判据**：**先用 `sessionId` 认领本轮的 `bridge.open`**，再从**完整事件集**按
  `bridgeId` / `bridgeIds[]` / `callId` 关联其余事件（`associateBridgeEvents`）。
- **理由**：**判据错**（把「关联键」误当「过滤键」）。新判据关联进来的行**更多**，不是放宽。
- **实际结果**：历史数据重算把 5a 的桥接侧从**空**恢复成
  `call seq32`、`result seq34(isError=false, id=team-message-09329b7f…)`、
  `pipeline seq33(bridgeIds=["b5681d9e0704"], **无 sessionId**)`。

### 2.2 入口/run 必须**唯一认领**；不唯一 ⇒ `INVALID-TEST`（审查第 2 条）

- **原判据**：`entries.find(有 run 指向它) ?? entries.find(calls>0) ?? entries.at(-1)`（取第一个/最后一个）。
- **问题（确证，历史数据可复算）**：历史 ⑦ 的恢复轮（第 5 轮）**认领了上一轮（被取消那一轮）的入口与 run**
  （`selected=[…taxb35-p26620]` = **a4** 的 run），真正的恢复 run（`…-29pkyj-p34640`，PID 34640）
  被排进 `otherRunsInWindow` ⇒ 恢复轮自己的 CLI 日志（`prompt_length=34670`）**从未被读到**
  （历史 ④ 里 a5 的「CLI 收到的 prompt 长度 = null」就是这么来的）。
- **新判据**：入口必须落在该轮**真实 `[turn/start, turn/end]` 区间**内（时间戳取自**宿主转录**）且 `sessionId` 相同；
  候选**恰好 1 个**才认领；`0` ⇒ 没开过入口；**`≥2` ⇒ `INVALID-TEST`**（不许挑一个）。
  run 由 `manifest.argv` 的 `--mcp-config` 尾名 === `cfg-<入口 id>.json` 反查，同样要求唯一。
- **理由**：**判据错**（用时间先后当身份）。相邻两轮（取消 + 恢复只隔 9 秒）必然认错。
- **实际结果**：历史数据重算认对 `1373572cf27d` → run **PID 34640**；该轮真实区间内候选数 = 1。

### 2.3 发送前冻结基线；按 `messageId` 定位**真实接收轮**（审查第 3 条）

- **原判据**：`await post('/probe/team/send')` **之后**才 `nextTurn(member)`；接收方也在发送成员跑完后才数轮次。
- **问题**：发送即可能**立刻**触发一轮 ⇒ 计数把它算进去、期望轮次整体后移；旧报告里
  A 的桥接轮被记成第 3 轮（实为第 2 轮），「B 被 A 唤醒」那一轮**从未被读取**（旧报告 `b2` 直接记成 `skipped`）。
- **新判据**：**发送前**冻结基线；发送后用返回的 `messageId` 在目标会话里找团队消息回执，
  **回执落在哪一轮，那一轮就是被这条消息唤醒的轮**（`waitForReceiptTurn` / `locateTurnByReceipt` / `turnIndexOfSeq`）。
  投递失败（非 200 / 没有 `messageId`）⇒ **不空等、不猜轮次**，如实记「未发生」。
- **理由**：**判据错**（轮次是结果不是输入）。
- **实际结果**：被中止的那一轮里已可见 `send.a2 → locatedByReceipt{turnIndex:2}`（基线 1）——
  正是旧判据会漏掉的「快轮」（完整新跑见 §6）。

### 2.4 轮次按 `(sessionId, turnIndex)` 去重；取消轮**单列**（审查第 4 条）

- **原判据**：逐轮表把该成员名下 `turn !== null` 的条目都算上；`report.rounds.a2 = a2` 会把**重试轮**
  写回**第一次尝试的键**（两个键指向同一轮）。
- **问题**：轮次数**虚增**、失败的那次证据被覆盖；「skipped / 从未发生的轮」也被算进「每一轮都……」的合取里。
- **新判据**：① 每次尝试各留各的键（`report.rounds.a2Chosen` 只记「哪一次被选为本项证据轮」）；
  ② 逐轮表按 `(sessionId, turnIndex)` 去重，被丢掉的条目记进 `report.roundDuplicates`；
  ③ 只认**真实完成轮**（`reason==='completed'` 且由外部 CLI **唯一**承接），**每成员 ≥3**；
  ④ **按设计取消的轮次**（`designCancelled: true`）**单列**，由 ⑥ 判，**不要求** `completed`、**不参与**票据判据。
- **理由**：**判据错**（三处同项）。
- **实际结果**：历史数据重算 —— A 真实完成轮 4 + 取消轮 1、B 真实完成轮 3 ⇒ **每成员 ≥3 成立**。

### 2.5 `ticketSeenIn` 必须**参与断言**；stdin 要有**逐轮精确证据**（审查第 5 条）

- **原判据**：`ticketSeenIn` 只展示不断言；stdin 的判据只是「真实 argv 里没有本轮票据/特征短语」这一条**子串检查**。
- **问题**：① 一个**没有任何票据证据**的轮次也能算「跑通」；
  ② 「argv 里没有哨兵」**不等于**「prompt 走 stdin」：被**截断/改写**的 prompt 同样能通过子串检查。
- **新判据**：
  - 票据：普通轮必须在**回复正文**复述票据，**或**（工具轮）在 **CLI 自己记的 `tool.requested` 参数**里出现票据；
    两处都没有 ⇒ `ticketSeenIn='none'` ⇒ 该项 **FAIL**；**取消轮另判**。
    另记 `receiptTextHasTicket`（回执正文含票据）**只作对照**，**不顶替**上面两条。
  - stdin 四条**同时**成立：① CLI 自己数到的收到长度 N；② CLI **自己的会话存储**首个 user 消息长度 **== N**；
    ③ 同一 pid 的 **OS 层真实命令行**里既无票据也无特征短语；④ **N > 该命令行总长** ⇒ 装不进命令行。
    另引用**既有的 40 092 字节父进程见证**（§5）作为通道级证据。
- **理由**：**判据错**（两条旧判据都**弱于**要求原文）。新判据**严格更强**。
- **实际结果**：历史数据重算 —— 8/8 普通轮票据齐全（a2 是 `cli-tool-args`，其余 `reply`）；
  8/8 普通轮 stdin 四条成立。

### 2.6 恢复判据收紧为**四条并集**（审查第 6 条）

- **原判据**：`ranAgain && 绑定 harnessId === 目标 && route.provider === 'pilot-cli'`（外加「id 列表完全相同」防重放）。
- **问题**：① **太松** —— **带部分票据的 `error`/`aborted` 也能过关**；
  ② 「id **集合完全相同**」**表达不出「重放」与「新投递」的区别** —— 恢复动作本身就是一条**新**投递，
  于是**任何**正常恢复都会被判成重放（历史 ⑦ 的 FAIL 就是这么来的）。
- **新判据**：同时满足 ① `reasonKind === 'completed'`；② CLI **唯一关联**（不唯一 ⇒ `INVALID-TEST`）；
  ③ **完整绑定字段一致**（字段名集合 + 每个字段值 + `accountId` **值**比较；原始 `accountId` **不打印**）；
  ④ **回执闭环完整**（该 messageId 在 A 会话落地、`senderId`=lead、Lead 侧有 `delivered`、
  A 的回复含**完整**恢复票据）；另保留「逐 id 计数」防重放（既有 id 计数不增加，新增 id 单列）。
- **理由**：**判据错**（四条都是把要求原文写严）。
- **实际结果**：历史数据重算判 **`INVALID-TEST`** —— 历史报告只留档了 3 个绑定字段
  （`harnessKind/harnessId/setAt`），**「完整绑定字段一致」重算不了**，按纪律**不降级成正/负**。

---

## 3. B→A：**仍然是「未通过」**（历史结论不改写）

| 判据腿 | 历史事实（确证） |
|---|---|
| B 的 CLI 侧工具调用 | **零** `tool.requested` |
| B 的回复正文 | 「I understand the request, but I'm unable to execute it… no tool protocol… **I cannot send messages to teammates directly**」，随后**列出「如果工具可用我会发什么」**并请 Lead 代发 |
| 桥接侧 | 该轮入口只有 `initialize / tools/list / close`，**0 个 `tools/call`** |
| `queued` 的发送者 | **不是 B**（A 收到的那条 token 消息由 **Lead** 代发，`senderName=lead`） |
| A 复述 token | 发生了 —— 但**不能算 B 自发** |

新判据在同一份数据上重算 = **FAIL**（`cliToolArgs=false`、`bridgeCallRecovered=false`）。**方向完全一致。**
⚠️ 纪律：**A 复述 token 不算 B 自发**；**Lead 代发不算成员自发** —— 两条都在新判据里显式编码。

---

## 4. A→B：真实传送链 + 「桥接日志漏采」的**补证**（确证）

补证方式**不是再跑一轮**，而是**在同一份历史数据上**证明那些行**本来就存在**：

| 环 | 历史报告里那一格 | 新判据从同一份桥接日志恢复出的行 |
|---|---|---|
| CLI 自己记的工具参数 | `tool_name="mcp__dsh_bridge__send_message"`，`args={"message":"Token HPM2B-FROM-A-X49KE…","target":"ft-b-x49ke"}` | 同（未变） |
| 桥接 `mcp.tool/call` | **`[]`（空）** | `seq 32 @16:53:14.015Z, tool=send_message, callId=2cb3c0b7…` |
| 桥接 `mcp.tool/result` | **`[]`（空）** | `seq 34 @16:53:15.790Z, isError=false, resultIdTokens=["team-message-09329b7f-aa67-4a77-8e22-cf04567cd757"]` |
| `pipeline.execute` | **不存在**（旧判据永远看不到） | `seq 33 @16:53:14.016Z, bridgeIds=["b5681d9e0704"], **无 sessionId**` |
| Lead mailbox `queued` / `delivered` | `senderId=A 会话, targetId=B 会话` / `delivered=true` | 同 |
| B 自己的会话回执 | 同一条 `messageId`，`senderName=ft-a-x49ke` | 同 |
| 影响行为 | B 的回复正文 = **`ACK-HPM2B-FROM-A-X49KE`** | 同 |

⇒ 重算 `5a-链（历史数据·新判据重算）= PASS`（7 环全真）。**历史 5a 的 `FAIL` 不改写。**

> ⚠️ **推断（不是确证）**：那两行**为什么**在旧报告里为空，本文**不作单一断言**。
> 可确证的是：它们与旧报告认领的入口**是同一个 `bridgeId`**。另一路验收的复核
> （`probe/out/bridge-attribution-history.json`，三种认领规则对照）指向「时间窗上界取早」；
> 本文件注释里也记过同一处上界的修正 ⇒ 两种机制（上界取早 / 按 sessionId 过滤）**都可能**参与，
> 留待后续复核。

---

## 5. stdin 的「既有父进程见证」（引用，**不是**本轮重测）

`C:\Users\Administrator\.dsh\harness-accounts\qoder-cn-a\logs\runs\2026-10-14T00-23-28-887+08-00-37k216-p45072`

| 字段 | 值 |
|---|---|
| `manifest.argv` | `["bun","B:/~BUN/root/index.js","--config-dir","C:/Users/Administrator/.dsh/harness-accounts/qoder-cn-a","--tools","","--no-session-persistence","--max-model-request-retries","0","-p"]` |
| 命令行总长 | **161** 字符（**没有** prompt） |
| `input.prompt.received` 的 `text_preview` 开头 | `BEGIN_STDIN_WITNESS` |
| `input.prompt.received text_length` / `turn.started prompt_length` | **40 092** / **40 092** |
| Windows `CreateProcess` 上限（实测 32,763 成功 / 32,773 失败） | **32 768** |

⇒ **40 092 > 32 768**：那 40 092 个字符**不可能**经命令行送达 ⇒ 只能走 stdin（**确证**）。
⚠️ 那次运行的**构造脚本已不在仓库里**，所以本文**只引用它落盘的产物**，**不说**「本轮重测过」。
逐轮精确证据另见 §2.5（历史数据上 8/8 普通轮成立）。

---

## 6. 新跑一轮（新契约）的实际结果

- 报告：`probe/out/team-final-acceptance-v2-review6.json`
- 运行器：`probe/_review6-run-when-idle.ps1`（**礼貌版**：只在另一路验收空闲时才开跑；
  被顶掉 ⇒ 脚本自己以退出码 4 中止并写 `aborted` 报告，**不产出**会被误读的结论）
- 日志：`probe/out/_review6-runner.log`、逐次尝试 `probe/out/_review6-run-d*.log`
- 报告自带 `scriptSha256`（本次实际加载的脚本指纹）、`runLock`、`stdinWitness`、`roundDuplicates`、
  `perRound`、`invalid`（`INVALID-TEST` 单列）、`chain`（5a/5b 传送链子判据）

<!-- LIVE-RUN-RESULTS:BEGIN -->
### 6.1 结论：**新跑一轮未能取得可采信的完整结论**（如实留档，不拿半截数据充数）

| 尝试 | 时间 | 结果 | 证据 |
|---|---|---|---|
| `YM7C2` | 01:33–01:34 | **停跑**（本路自查出 ISO `time` 缺陷，见 §9.1） | `probe/out/_review6-run-b0.log` |
| `YS9KE` | 01:38–01:43 | **停跑**（另一路 `freshLead` 顶掉 lead ⇒ `send.a2` 500） | `probe/out/_review6-run-c0.log` |
| `YJX0T` | 01:31 | 被另一路**误杀**（对方已在 `docs/00-verified-status-report.md` §28.4 报备） | `probe/out/_review6-run-a6.log` |
| `ZEYFV` | 01:55:43–01:59:43 | **整轮中止（退出码 4）**：`send.b3.retry1` 返回 500 `active teammate "ft-b-zeyfv" not found`，且 `leadSessionId` 已被顶掉（`86bf8360…` → `93554adb…`）⇒ 新加的并发检测判定「证据已污染」，**不产出**会被误读成产品结论的报告 | `probe/out/team-final-acceptance-v2-review6.json`（`aborted` 字段）、`probe/out/_review6-run-d10.log` |

⇒ 根因是**跨脚本并发**：另一路跑的是它**自己的** `probe/verify-team-final-acceptance-v2.mjs`（不读共享脚本里的运行锁），
它每次 `spawn(freshLead: true)` 都会替换全局 lead 会话，而它的运行节奏（每 5–10 分钟一轮、每轮 7–10 分钟）
与本套件所需窗口（≥10 分钟）**不重叠**。本路已两次请求 Lead 串行化（见 `probe/out/_review6-runner.log` 的等待记录）。

### 6.2 中止前**已取得**的部分实测（可采信，但**不构成完整判定**）

`ZEYFV` 那一轮在中止前已完成 ①②③ 与 A 方向的三次桥接尝试：

| 观测 | 值 |
|---|---|
| ① 真实外部 CLI 调用 | **PASS**（A/B 都是 `entryClaim=unique`、`runClaim=unique`、OS 层 pid join 命中、回复含本轮票据） |
| ② 不同账号身份互不串号 | **PASS**（`--config-dir` 两条来源都各自归位；无串号） |
| ③ actual 供应商与模型 | **PASS**（CLI 自己写 `model="auto"` + `operation=sendRemoteChatAsk url=https://gateway.qoder.com.cn`；请求值 `model=qoder-cn-acct-a/-b` ≠ 实际值） |
| A 方向三次尝试的**轮次定位** | `send.a2 → locatedByReceipt{turnIndex:2}`（基线 1）、`retry1 → 3`（基线 2）、`retry2 → 4`（基线 3）⇒ **每一轮都按 `messageId` 的回执定位，且与冻结基线一致**（旧判据在这里会整体错位一轮） |
| A 方向三次尝试的**桥接证据** | attempt1：入口 `50b64b7df2cc`、`bridgeInit=false`、`bridgeCalls=[]`；attempt2：入口 `27ed54832ac0`、`bridgeInit=true`、`tools/list=6`、`bridgeCalls=[]`；attempt3：CLI 侧 `tool.requested` **1 条**（`mcp__dsh_bridge__send_message`），桥接侧该轮认领到的入口**没有** `mcp.tool/call` ⇒ 这一轮的传送链**不完整**（如实判 FAIL，不放过） |
| B 方向那一轮 | `entryClaim=ambiguous`（该轮真实区间内 ≥2 个 `bridge.open`）⇒ 按新判据**判 `INVALID-TEST`**，**不挑一个候选** |
| 并发检测 | `aborted` 字段记下了两端的 lead 会话 id 与 500 的原文 ⇒ **探针拒绝把被污染的一轮当成结论** |

### 6.3 因此，「新契约下的实际结果」以 **§1.2 的只读重算**为准

理由：它是**同一份历史数据**（独立审查看的那一份）在新判据下的**逐项**结果，可复算、无并发污染；
而新跑一轮目前只能给出**部分**观测（§6.2），**不足以**支撑 ④⑥⑦ 的判定 —— **不拿它冒充完整结论**。
一旦另一路停止真实运行（≥15 分钟窗口），可再次运行
`pwsh -NoProfile -File probe/_review6-run-when-idle.ps1`：它会（只在空闲时才开跑）把**完整一轮**写完到
`probe/out/team-final-acceptance-v2-review6.json`（该脚本内含空闲判定 + 被顶掉即中止）；
届时本节按那份报告回填 —— **本轮没有等到这个窗口**（见 §6.1）。
<!-- LIVE-RUN-RESULTS:END -->

---

## 7. 未确定 / 不得外推

1. **模型「这一轮到底调不调工具」不稳定**（**确证**）：同一句措辞在成员路由上有时调、有时不调；
   不调的那几次，成员回复逐字引用了 prompt 末尾那句「本通道没有工具协议……不要把它们当作可调用的函数」。
   ⚠️ **免责声明单独并不能解释它**（受控实验 6/6 都调用了工具）⇒ **不把它写成原因**。
2. **上游最终具体型号没有取到**（**未查**）：CLI 只写 `model="auto"`，上游最终型号 **CLI 不披露** ⇒ 不得外推。
3. **取消杀不掉目标系统里的副作用**（**未查**）：只证明「该轮以取消语义结束」。
4. **本项结论只覆盖声明了 `promptViaStdin: true` 的目标**；对仍把 prompt 拼进 argv 的目标**不适用**。
5. **历史报告的绑定字段只留档 3 个** ⇒ 「完整绑定字段一致」在历史数据上**重算不了**（§2.6）。
6. **外部 CLI 被换过版本**（**确证**，只读统计）：同一二进制自报 `cli_version` 从 **1.1.41**（≤00:54:31）
   变成 **1.1.13**（≥00:54:41）；`model.response.completed` 里的 `provider="qoder"` 字段在 1.1.13 的 run 里
   **一次都没出现** ⇒ ③ 的判据必须改读该版本真的会写的字段（这是**产品/环境变**，不是产品变差）。

---

## 8. 证据文件与复算方法

| 文件 | 内容 | 怎么复算 |
|---|---|---|
| `probe/out/team-final-acceptance.historical-005555.json` | **历史失败报告**（00:55:55，stamp X49KE），**未改动** | 直接读 `verdicts` |
| `probe/out/team-final-acceptance-v2-review6.json` | 新跑一轮（新契约） | `node probe/verify-team-final-acceptance.mjs`（输出路径由 `HP_TEAM_FINAL_OUT` 指定） |
| `probe/out/team-final-acceptance-v2-review6-reanalysis.json` | **历史数据 + 新判据的只读重算** | `node probe/_review6-reanalysis.mjs`（只读；不 spawn、不调模型、不写会话日志） |
| `probe/out/team-final-argv-*.jsonl` | OS 层真 argv 采样（`Get-CimInstance Win32_Process`） | 与 `manifest.json` 的 `pid` 做 join key |
| `…\.dsh\plugins\harness-pilot\mcp\bridge-events.jsonl` | 桥接事件（插件自己写） | 按 `bridgeId`/`callId` 关联；**不要**先按 `sessionId` 过滤 |
| `…\.dsh\harness-accounts\<档案>\logs\runs\<run>\{manifest.json,qodercli.log}` | CLI 自己写的运行记录 | `text_length` / `prompt_length` / `tool.requested` |

---

## 9. 探针自身在本轮暴露/修掉的三处缺陷（**如实留档**）

1. **桥接日志的 `time` 是 ISO 字符串，转录事件的 `time` 是数字**：第一版 `eventMs` 只认数字 ⇒
   桥接行时间全成 `NaN`。后果两副面孔：**轻**则「同一会话的**全部**入口都成候选」
   （实测：A 的第 2 轮判 `ambiguous`，整轮 `INVALID-TEST`），**重**则一个候选都取不到。
   修法：两种形状都解析；**解析不出来就 fail-closed**。
   ⚠️ 这是**本轮自查出来的**（先用「历史数据只读重算」当离线压测台跑了一遍），
   代价是**一次真实运行被中途停掉**（已停，未产生被采信的结论）。
2. **投递失败不许空等**：`/probe/team/send` 可能返回 500（实测：并发运行顶掉 lead 会话，
   成员名不在新 lead 花名册里）⇒ 没有 `messageId` 就**没有可定位的接收轮**：不等待、不猜轮次，如实记「未发生」。
3. **并发闸（锁 + 心跳）**：两个实例同时跑会交叉污染证据（实测发生过：两路验收互相 `clear` 掉对方的探针日志）。
   现在：拿不到锁**不跑**（退出码 3，**不写报告**）；锁带 pid + 时间戳 + **心跳**（每 60s 刷新 mtime，
   5 分钟无心跳视为陈旧 ⇒ 接管）—— 只靠 pid 不够：Windows 上被强杀的进程在一段时间内 pid 仍算「存在」。
   ⚠️ **已知局限**：另一路验收跑的是**它自己的脚本**（`verify-team-final-acceptance-v2.mjs`），
   **不读这把锁** ⇒ 该锁只能防「同一个脚本」的并发，防不住跨脚本并发；跨脚本的现场特征由
   §9.2 的「lead 会话被顶掉」检测兜住（整轮中止，不产出误导性结论）。
4. **重写 `argvJoin` 时漏掉两格**：`sentinelInArgv` / `promptPhraseInArgv` 被删掉后，`stdinEvidence` 读到
   `undefined` ⇒ `stdinPrecise` **恒为 false** ⇒ ④ 会**永远 FAIL**（探针自伤，不是产品问题）。已补回（并写明「必须留着」）。
   ⚠️ **诚实标注**：这一处、以及「无取消轮时该腿判不适用」「恢复轮投递失败判 `INVALID-TEST`」三处，
   是在最后一次真实运行（`ZEYFV`，01:59:43 中止）**之后**改的 ⇒ **只做了语法检查 + 离线重算对照**，
   **没有**经过真实运行验证。当前脚本指纹：`3AEB685B729620B3FE3AAF62B68268846467F7BD5BD4E8DE54C73F27A510B2FE`。
