# 团队成员最终验收（v2）—— 正确契约 + 正负对照

- 探针：`probe/verify-team-final-acceptance-v2.mjs`（**新文件**；每处判据修正都在脚本里带注释与理由）
- 本轮 v2 报告：`probe/out/team-final-acceptance-v2.json` —— **stamp `17L8S`**（副本 `probe/out/team-final-acceptance-v2-run8.json`）
- 同版历史运行（**都保留**，用于交叉对照，理由见 §E.2）：
  - `probe/out/team-final-acceptance-v2-run1.json`（Y92R5，完整）
  - `probe/out/team-final-acceptance-v2-run6.json`（0ILHM，完整）
  - `probe/out/team-final-acceptance-v2-run7.json`（0SUCI，完整）
  - `probe/out/_v2-run3-console.log`（YSBZX，控制台全文；JSON 因探针自身笔误丢失，见 §E.2）
  - `probe/out/_v2-run5-console.log`（ZJEWN，控制台部分：两个方向都拿到完整链路后被环境卡住）

### 本轮（17L8S）判定一览

| 项 | 判定 |
|---|---|
| 1 真实外部 CLI 调用 | **PASS** |
| 2 不同账号身份互不串号 | **PASS** |
| 3 actual 供应商与模型 | **未验证(CLI未记provider)**（CLI 1.1.7 不写该字段，见 §D） |
| **5a A→B** | **PASS-WITH-CAVEAT**（L1+L2 齐；接收方未回显 token） |
| **5b B→A** | **PASS-WITH-CAVEAT**（L1+L2 齐；接收方未回显；**Lead 代发的那条被点名排除**：`非 B 发送者=["lead"]`） |
| 5c 正对照 | **PASS** |
| 5d 负对照（作用域） | FAIL —— **取不到样本**（20 个候选全部 409 `no live Agent for that session id`，逐次尝试写进报告） |
| **5e 负对照（新增）** | **PASS** |
| **5f 产品缺陷（新增）** | **PASS**（源码里那句无条件声明已消失） |
| 6 取消 | **PASS** |
| **7 冷恢复** | **PASS**（逐 messageId：既有 id Δ 全 0；新增 `…e0fd4af4:0→1` 是恢复消息本身） |
| **4 每成员至少 3 轮** | **PASS**（A 6 个真实轮次 / B 4 个；按设计取消的 R5 只要求 aborted；每轮 OS argv 无 prompt 哨兵） |
- 历史那一版（**未被改写**，只读副本）：`probe/out/team-final-acceptance.historical-005555.json`（00:55:55）
- 历史 5a 归因复核（只读、离线）：`probe/out/bridge-attribution-history.json`
- 产品缺陷补丁（已由另一路集成，见 §A.6）：`probe/patch-llm-adapter-bridge-disclaimer.md`

> 纪律：不写百分比；不把推断写成确证；拿不到证据的格子写「未验证」；**历史文件与历史证据一律不改**。

---

## A. 5a/5b：关联采样缺陷 vs 产品缺陷（含正负对照）

### A.1 结论先行

| 项 | 历史（00:55:55，X49KE） | v2 结论 | 性质 |
|---|---|---|---|
| **5a A→B** | FAIL（`tools/call=[]`） | **通过**：run8/run5/run3 = PASS-WITH-CAVEAT 或 PASS（**L1+L2 完整链**）；run6/run7 的 FAIL 各有**并发/环境**原因（§E.2） | 历史失败 = **探针关联采样缺陷**（产品侧真的执行了那次调用，见 §A.2） |
| **5b B→A** | FAIL（`tools/call=[]`、`queued(senderId=B)=false`） | **通过**：run7 = PASS（含接收方回显）、run1 = PASS、run3/5/6/8 = PASS-WITH-CAVEAT（到达有据、仅缺回显） | 历史失败**成立**：B 那轮真的没调工具，A 说出 token 是 **Lead 代发**（§A.4）；**不得**据此判双向自发通过 |
| 5c 正对照 | PASS | PASS（各轮一致） | 原生（从未绑定）成员 tool-call 块=2、工具事件真实、自己发出 team/message |
| 5d 负对照 | PASS | run1/run3 PASS；run6/run7 FAIL = **取不到样本**（`/mcp-bridge/open` 返回 409 `no live Agent for that session id`，逐次尝试已写进报告） | 判据没错，样本获取依赖「环境里有活 Agent 的会话」 |
| **5e 负对照（v2 新增）** | —— | **PASS**（各轮一致） | N1 未绑定成员会话在桥接日志里 **0 条事件**；N2 已注入桥接但任务不调工具 ⇒ **0 `tools/call`、0 CLI `tool.requested`、0 副作用** |
| **5f 产品缺陷（v2 新增）** | —— | run1/run3 FAIL → run6/run7 **PASS**（缺陷已被另一路修掉，源码行已变，见 §A.6） | 适配器提示词曾无条件声明「本通道没有工具协议…不要把它们当作可调用的函数」，与桥接注入的**真** MCP 通道矛盾 |

### A.2 修前 / 修后：同一条 messageId 的完整因果链

历史那一轮（A 的第 2 轮）的 messageId = `team-message-09329b7f-aa67-4a77-8e22-cf04567cd757`。

| 环节 | 来源 | 值 |
|---|---|---|
| ① CLI 自己请求工具 | `qodercli.log`（对端进程自己写） | `tool.requested tool_name="mcp__dsh_bridge__send_message" args={"message":"Token HPM2B-FROM-A-X49KE…","target":"ft-b-x49ke"}` |
| ② 桥接收到调用 | `bridge-events.jsonl` seq 31/32（`mcp.http tools/call` / `mcp.tool/call`） | `tool=send_message`、`callId=2cb3c0b7-46e7-4b63-aabc-ed7780a6f956`、`bridgeId=b5681d9e0704` |
| ③ 落到执行管线 | 同上 seq 33 `pipeline.execute` | `bridgeIds=["b5681d9e0704"]` |
| ④ 工具结果（带 messageId） | 同上 seq 34 `mcp.tool/result` | `isError=false`、`resultIdTokens=["team-message-09329b7f-aa67-4a77-8e22-cf04567cd757"]` |
| ⑤ 宿主 mailbox | Lead 会话转录 | `team/message/queued`（senderId=**A 会话**、targetId=**B 会话**）→ `team/message/delivered` |
| ⑥ 对端收到 | **B 自己的会话转录** | `user/message`（`source.kind="team-message"`）同一条 messageId，`senderName=ft-a-x49ke` |

**修前**（历史报告的记录）：`5a … CLI 发起的 tools/call=[]，结果 isError=[]，结果里的消息 id=[]`。
**修后**（同一份日志、按 join key 认领）：`tools/call=["send_message"]`、`resultIdTokens=["team-message-09329b7f-…"]`。

> 复核脚本：`node probe/_recheck-bridge-attribution-history.mjs` → `probe/out/bridge-attribution-history.json`
> （只读；不跑任何真实调用、不写任何会话事件）。

### A.3 为什么是「关联采样」错，而不是产品错

`collectRound()` 的历史第一版**用时间窗认领桥接事件**，窗口上界取「调用 `collectRound` 那一刻」
（≈ `send` 返回时刻 16:51:46.080Z），而那一轮真正的 `tools/call` 在 **16:53:14.015Z**（落后 88 秒）。
在同一份日志上跑三种认领规则：

| 认领规则 | 认到的入口 | 认到的 `tools/call` |
|---|---|---|
| 时间窗，上界 = `send` 时刻 + 20s（≈ 历史第一版） | `b5681d9e0704` | **`[]`**（与历史报告一致，复现假阴性） |
| 时间窗，上界 = 该轮 `turn/end` 之后 | `b5681d9e0704` | `["send_message"]` |
| **join key**：CLI 自己 argv 里的 `--mcp-config` 尾名 `cfg-<bridgeId>.json`，全量日志按 id 命中 | `b5681d9e0704` | `["send_message"]` |

历史报告自身还有两处**内证**（不必复原旧代码即可看出归属不一致）：

- `rounds.a2.bridge.closes` 记的是 **上一轮入口** `59786a6c5d2c` 的 close（seq 24），不是本轮入口；
- `rounds.a4.bridge.closes` 同时记了 **下一轮入口** `b5e5fcf093fb` 的 close（seq 81）。

⇒ 当时进入 `scoped` 的集合**不是**按单一 bridgeId 取的。**未验证**：历史那版脚本文件没留档（被后续编辑覆盖），
「当年到底用哪个过滤式」无法逐字复原；能确证的是**结论** —— 它的 `tools/call=[]` 与四条独立来源
（CLI 日志、桥接审计流、宿主 mailbox、对端会话回执）同时矛盾 ⇒ **探针的关联采样缺陷**，不是产品缺陷。

**v2 的修法**（`collectRound`）：
1. 入口认领 = **join key**（CLI manifest 的 `--mcp-config` 尾名 → `cfg-<bridgeId>.json`），在**全量日志**里按 id 命中；
2. 多个候选取「**本轮开始之后才打开**」的最新一个（run1 实测过：窗口里会残留**上一轮**的 run/入口）；
3. 若 CLI 自己说调了工具而桥接日志还没出现对应 call ⇒ 重读（最多 4 次 ×1.5 s），并把重读次数记进报告；
4. 顺带把「若按时间窗认领会漏掉哪些 seq」**量化**留档（`bridge.attribution.missedIfAttributedByTimeWindow`）。

### A.4 5b 的历史失败**成立**（不得用 Lead 转发冒充 B 自发）

- CLI 自己的日志：那一轮 `tool.requested` = **0 条**；
- 桥接侧：该轮入口 `406270d9984d` 只有 `initialize / notifications/initialized / tools/list / close`，**0 个 `tools/call`**；
- 宿主 mailbox：`queued(senderId=B 会话)=false`；
- A 确实说出了 token，但那条消息的 `senderId` 是 **Lead 会话**（`team-message-73fc853b-…`，`senderName=lead`）。

⇒ 历史 5b = FAIL **正确**；用户契约 ③ 说的正是这件事。v2 判据把 `queued.senderId === 发送方会话` 当硬条件，
并把「含同 token 的**全部**回执发送者」写进证据（run6 就抓到过 `非 A 发送者=["lead","lead"]`）。

### A.5 三层判据（v2 的判法，避免「一个布尔」）

| 层 | 内容 |
|---|---|
| **L1 桥接侧** | `mcp.tool/call`（tool=send_message，带 `callId`）+ `mcp.tool/result`（`isError=false`，`resultIdTokens` 带 messageId）+ **CLI 自己的** `tool.requested` |
| **L2 宿主侧** | `team/message/queued` 的 `senderId === **发送方会话**` + `delivered` + **接收方自己的会话日志**里出现**同一个 messageId** 的回执 |
| **L3 行为侧** | 接收方这一轮正文说出该 token（echo）／或该 token **只经那条回执进入本轮上下文**（delivered-into-context） |

判定：L1+L2 齐且 echo ⇒ **PASS**；L1+L2 齐但只有「进入上下文」⇒ **PASS-WITH-CAVEAT**；缺 L1 或 L2 ⇒ **FAIL**。

### A.6 5f：产品缺陷（v2 发现）与其修复

- **发现**：`src/llm-adapter.ts` 的 `renderPrompt()` 只要请求带 tools 就**无条件**写
  「本通道**没有工具协议**：DSH 不会执行上述任何工具，你也不要把它们当作可调用的函数」（当时在 `:286-300`）。
  而改道成员的 CLI **真的**被 `--mcp-config` 注入了可用的 MCP server（桥接侧 `tools/list` 6 个、
  `mcp.tool/call` 真的投递了消息）⇒ 那句话对桥接工具是**假的**。
- **实测后果**：run1 里 A **连续 3 次**逐字引用它拒调（正文 342 字、三次同文）；run3 里 B 两次拒调后第 3 次才调；
  run6/run7 里 `refusalRounds=[]`（说明修好之后不再出现）。
- **修复**：另一路已按 `probe/patch-llm-adapter-bridge-disclaimer.md` 的方向改成
  「本通道**没有 DSH 的工具协议**：上面列出的是 **DSH 自己的工具**…」⇒ v2 的 5f 在 run6/run7 判 **PASS**
  （判据 = 「源码里不再有那句无条件声明」+「本轮有无拒调轮次」）。**探针自己没有改 `src/**`。**

### A.7 负对照（能区分「采样真假」的控制组）

| 控制组 | 内容 | 结果 |
|---|---|---|
| **N1** | **从未绑定**的成员 C：它的会话在桥接日志里必须**一条事件都没有** | run1/3/5/6/7 全部 **0 条**（`bridgeSessionCounts.c.total=0`）⇒ 桥接日志只记「注入路径」的真实流量 |
| **N2** | **已注入桥接**的成员 A 跑一轮「明确不要调工具」的任务 | 每一轮都：桥接 `tools/call=0`、**CLI 自己记的** `tool.requested=0`、**这一轮由 A 发出的 team/message=0** ⇒ 通道开着也不凭空产生调用 |
| **5d** | 缺 `wait_agent` 的作用域经桥接打该工具 | 拿到样本时：`-32602 BRIDGE_TOOL_NOT_IN_MEMBER_SCOPE`、`mcp.tool/call` 增量 **0**（run1/run3）；run6/run7 拿不到样本（409，见 §A.1） |
| **N3（跨轮污染检查）** | 每一轮按 join key 归属，报告里记「该入口的全部事件 seq」与 `callId` | 未出现把别的轮次调用算进本轮的记录 |

---

## B. 冷恢复（第 7 项）：逐 messageId 比较，容许新恢复消息

**判据为什么变**：历史第一版写成「恢复前后 id **列表完全相同**」——而恢复动作本身就是一条 Lead→A 的**新**消息
⇒ 任何一次正常恢复都会被判成「重放」。用户契约 B 要求：「对**恢复前既有**的 messageId 逐个比较**投递次数/副作用**，
**容许新恢复消息**」。v2 判据：

1. 逐 messageId 统计 **before → after 次数**（三张表：A 自己发出的 team/message、Lead 侧 delivered 边、A 会话收到的回执）；
2. **既有 id**（`before > 0`）的 Δ 必须为 0 ⇒ 没有二次投递；
3. **新增 id 单列**（= 恢复窗口里的新工作，**容许**）；
4. 恢复轮本身要能被核验：真的产生了新一轮、由外部 CLI 承接（CLI 自记 prompt 长度）、**桥接重新注入**、且它是最末一轮；
5. 绑定 `setAt` 前后一致（`bind.written` 只出现一次，其后是 `bind.kept`）。

**结果**：run3 PASS、run6 PASS、run7 PASS。逐 id 表的实例（run7，stamp 0SUCI）：

- A 自己发出的 team/message：`[]`（本轮 A 没经桥接发过消息）
- Lead 侧 delivered 边：`…438861aa:1→1`、`…86bab2ca:1→1`、`…9cc1c7aa:1→1`、`…913c8b55:1→1`、`…8518aab9:1→1`、`…395041da:1→1`、**`…d9bc63fc:0→1`（新增 = 恢复消息，容许）**
- A 会话收到的回执：同上（含 `…d9bc63fc:0→1`）
- ⇒ **既有 id 里出现次数变化的 = []**（没有重放）；A 的 `turn/end` 数 4→5（Δ=1）

---

## C. 「每成员至少 3 轮」+ 完整 stdin 传输

**判据为什么变**（都是判据缺陷，不是产品变差）：

1. **轮次身份 = 该轮 `turn/end` 事件的 seq（turnSeq）**，不是 turnIndex：同一轮被「重试」读第二遍不再算第二轮；
2. **跳过占位不计入**（如 `skipped:A 没有经桥接发出消息`），且**不能拿它的 turnIndex 去去重**
   —— v2 第一次运行里 B 的真实轮次 `b3` 就被 `b2` 占位挤掉过；
3. **按设计取消的那一轮只要求 `aborted`**；CLI 可能在写下 `input.prompt.received` 之前就被 kill
   ⇒ 对该轮只要求「有匹配的 manifest run」，不要求 CLI 侧 prompt 长度；
4. 「票据没出现在最终文字」**≠**「模型没调工具」：`票据出现在` 分四类 ——
   `reply` / `cli-tool-args`（票据在 **CLI 自己的工具调用参数**里）/ `receiver-receipt`（票据出现在**对端收到的回执**里）/ `none`；
5. `osArgvHasPromptSentinel === null`（**没采到** argv）按「未验证」处理，**不**写成「argv 里有票据」。

**完整 stdin 传输的证据（三条独立来源 + 一条独立探针）**：

| # | 来源 | 内容 |
|---|---|---|
| ① | **宿主**进程池自记的 spawn 事件（按 pid join） | 每轮 `argvChars`（改道成员 286、未注入 123、更早 266）**基本恒定**，而 ② 的长度在增长（32,065 → 42,746）⇒ prompt 不可能在 argv 里；若在 argv 里，命令行至少 42,746 字符 |
| ② | **CLI 自己**的 `qodercli.log` | `input.prompt.received text_length=<N>`（逐轮列出）；⚠️ 该行的 `truncated=` 说的是**预览**是否被截断（`previewChars=2000`），**不是** prompt 被截断 |
| ③ | **逐字节**送达（独立探针，假 CLI 读 stdin 后回报 hash） | `probe/out/prompt-stdin-transport.json`「B.逐字节送达(假CLI)」：宿主 `promptChars=108279`，假 CLI 读到 `stdinChars=108279`、`stdinBytes=108895`，**SHA256 一致** |
| ④ | OS 层真 argv（`Win32_Process.CommandLine`，独立采样） | 每轮都**没有**本轮 prompt 的票据/特征短语；`-p` 存在且不带位置参数 |

**未验证的格子**：宿主**真正写进 stdin 的字节数**（适配器事实 `facts.stdinChars`，`src/transports/headless.ts:248`）
**没有落盘**，探针读不到 ⇒ 本轮记「未验证」。（通道级的**逐字节**等价性由 ③ 单独覆盖，但那不是「本轮这条 prompt」的字节数。）

**轮次计数结果**：run3 里 A 7 轮 / B 4 轮；run7 里 A 5 轮 / B 2 轮（B 的第 3 轮依赖 A→B 真的发出消息，
而 run7 的 A 那一轮被环境拖过 5 分钟上限）⇒ **本项的 PASS 需要「A→B 成功」这一环**，见 §E。

---

## D. 历史失败 vs 新契约（并列）

| 项 | 历史判定 | 历史证据要点 | v2 判定 | **为什么变** |
|---|---|---|---|---|
| 5a A→B | FAIL | 桥接 `tools/call=[]`；CLI 日志却有 `tool.requested` | 跨运行通过（run3/run5 全链；run6/7 FAIL 因并发/环境） | **判据（关联采样）错**：事件按时间窗认领、上界早于真正的 `tools/call`；按 join key 认领即出现完整链路（§A.2/A.3） |
| 5b B→A | FAIL | `tools/call=[]`、CLI 零 `tool.requested`、`queued(senderId=B)=false` | 通过（run7 含回显；其余 PASS-WITH-CAVEAT） | **判据没错**：历史那轮模型确实没调工具，A 说出 token 来自 **Lead 代发**；v2 保留硬条件「发送方必须是 B 自己」 |
| 7 冷恢复 | FAIL | 「id 列表不同」→ 判重放 | **PASS**（run3/6/7/8） | **判据错**：列表里新增的是**恢复动作本身**带来的新投递；v2 改为逐 messageId 次数比较（既有 id Δ=0） |
| 4 每成员≥3轮 | FAIL | A 5 轮：R2 票据不在正文、R4 aborted、R5 prompt 长度 null | **PASS**（run8：A 6 轮 / B 4 轮） | **判据错**：① 把按设计取消的轮要求 completed；② 用 `promptLength=null` 判「没有外部 CLI 承接」；③ 重试计成额外轮次；④ 跳过占位挤掉真实轮次 |
| 3 actual 供应商 | PASS（历史） | CLI 日志行里有 `provider="qoder"` | `未验证(CLI未记provider)` | **CLI 侧字段可用性变了**（不是产品变差）：本机 CLI 自报 `cli_version` 依次变过 **1.1.41 → 1.1.13 → 1.1.7**，而 `provider=` **只在部分 1.1.41 run 里出现、1.1.13/1.1.7 的 run 里一次都没有**。v2 不再把该字段当硬门：缺席 ⇒ 判「未验证」，并把 CLI 原始行写进证据 |

---

## E. 仍未通过 / 仍未验证的项（逐条）

### E.1 仍未通过

见本轮报告 `failures`（17L8S：**只有两项**）。**逐条原因**：

1. **5d（作用域负对照）FAIL = 取不到样本**：20 个候选会话的 `POST /mcp-bridge/open` **全部返回 409**
   （`no entry was opened (no live Agent for that session id, or the target CLI has no verified --mcp-config injection)`），
   逐次尝试的 status/body 都写在报告 `scopeNegative.attempts` 里 ⇒ 本轮**没有**「缺 `wait_agent` 的作用域」可打。
   **该判据本身在 run1/run3 已 PASS**（`-32602 BRIDGE_TOOL_NOT_IN_MEMBER_SCOPE` + `mcp.tool/call` 增量 0）。
   样本获取依赖「环境里存在**有活 Agent** 的会话」——本轮环境里没有（探针自己的成员/Lead 被排除在候选之外）。
2. **3 = `未验证(CLI未记provider)`**：CLI 1.1.7 的 `model.response.completed` 行**不含** `provider=`（原始行已写进证据）；
   `model="auto"` / `stop_reason` 有。**不是产品变差**，是该字段的可用性随 CLI 版本变化（§D 最后一行）。

### E.2 为什么必须跨运行看（诚实交代，不掩盖）

同一份判据在多轮运行里出现方向性/样本性差异，原因**不是**判据在变，而是环境在变（都只读取材）：

| 干扰源 | 取才 | 影响 |
|---|---|---|
| 并发跑同一套验收 | 01:33:55 `lib/index.js`/`remedies.js` 被 build（热重载）；同期另有 `probe/verify-team-final-acceptance.mjs` 在跑 | 我的 run2 被 abort（`/probe/team/send` 返回 500）；run6 的成员被**另一路 Lead 的 roll-call** 同时驱动；run8 里也出现 Lead 转发同 token（被判据点名排除） |
| 插件 tight-loop | `bridge-events.jsonl`：01:00 = 426 行 / 172 KB → 01:57 = 129,411 行 / 27 MB → **02:25 = 137 MB** → 02:33 = 142 MB（内容：同一批**已死会话**的 `bridge.skip no-live-agent-for-session`，同一毫秒多条） | HTTP 请求无限期挂住（run5 卡在 5d）；被改道成员一轮 >5 分钟（run7 的 5a） |
| 注入通道形态在改 | 01:38 前 argv 266 字符；01:45 起 286（多了 `--strict-mcp-config`），期间出现过 stdio 形态的 `cfg-*.json`（`command`/`args`/`env`）；01:45–01:55 期间 CLI **完全不连桥接**（入口只有 open/close，无 `mcp.http`） | run4 的 5a/5b 全灭（**不是判据问题**） |
| CLI 本体被换 | `manifest.json` 自报 `cli_version`：1.1.41（≤00:54:31）→ 1.1.13（00:54:41 起）→ **1.1.7（02:34 起，run8 用的就是它）** | 3 的 `provider=` 字段消失（§D） |
| 探针自身的缺陷（已修，留档） | run1 的 7/4 FAIL、run3 的 JSON 丢失、run5 卡死 | ① 过期入口认领；② 重试重复计轮；③ 跳过占位挤掉真实轮次；④ 汇总行笔误（`grown`）导致整轮证据没落盘；⑤ 无 HTTP 超时；⑥ 全量读 27 MB 日志。**全部已修**，且从 run4 起「判据前先落盘一份」 |

---

## F. 环境、哈希与前置校验

- 前置校验：每次采集前 `GET /harness-pilot/api/diag/loaded` 的 `anyStale` 必须为 `false`（报告 `pluginBefore/pluginAfter` 各记一份；
  本轮 `modules` 已含 `mcp-bridge.js`/`provider.js`/`catalog-edit.js`/`transports/acp.js`，共 12 项）。
- profile 哈希（收尾核对）：
  - `profiles\desktop\cordis.yml` = `33B0735DD8756CAF6D5ECB55ED482FB485AB950EA86794002FD08959BC2ACF42` ✅ 与参照同值；
  - `profiles\desktop\cordis.patch.yml` = `F59DE58775716D62F8570DF4909460D002BE05E4FA5EE1E491F169E9DEED9A5F`，mtime **2026-10-14 01:01:50**
    —— **与文档里的参照 `2d0c5781…` 不同**；该改动**早于本子代理的全部写入**，且本子代理写入范围只有 `probe/**` 与 `docs/**`
    （`docs/00-verified-status-report.md` 仅文末追加）。
- 本子代理**没有**改 `client/client.js`、`package.json`、profile 配置；**没有**重启/升级宿主；**没有**改任何历史证据文件。

## G. 产物清单

| 文件 | 说明 |
|---|---|
| `probe/verify-team-final-acceptance-v2.mjs` | v2 验收脚本（判据修正全部带注释与理由） |
| `probe/out/team-final-acceptance-v2.json` | 本轮 v2 结果（**新文件**，不改历史文件） |
| `probe/out/team-final-acceptance-v2-run1.json` | Y92R5：5a 三次拒调现场 + 5b 完整链 |
| `probe/out/team-final-acceptance-v2-run6.json` | 0ILHM：5f 已修 + 7 PASS（并发干扰现场） |
| `probe/out/team-final-acceptance-v2-run7.json` | 0SUCI：5b PASS（含回显）+ 7 PASS |
| `probe/out/_v2-run3-console.log` | YSBZX：**5a PASS** 的完整控制台留档 |
| `probe/out/_v2-run5-console.log` | ZJEWN：两个方向都拿到完整链路（后段被环境卡住） |
| `probe/out/team-final-acceptance.historical-005555.json` | 历史那一版的**只读副本**（保留失败） |
| `probe/_recheck-bridge-attribution-history.mjs` + `probe/out/bridge-attribution-history.json` | 历史 5a/5b 归因复核：同一条 messageId 的 5 环因果链 + 三种认领规则对照 |
| `probe/patch-llm-adapter-bridge-disclaimer.md` | 产品缺陷 5f 的**精确补丁**（已由另一路集成） |
