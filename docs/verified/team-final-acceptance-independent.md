# 团队成员「改道 + 工具桥接」**最终验收（独立第二路）**

> **本文件与 `docs/verified/team-final-acceptance.md`（另一路，v2）并列存在，互不覆盖。**
> 那一份是另一路的判据与产物（`probe/verify-team-final-acceptance-v2.mjs`）；本文件是**本路的独立测量**，
> 并对两处结论做**对抗性复核**（§7：一处**否证**、一处**确证**）。
>
> 纪律：不给百分比；不把推断写成确证；判据写错就先改判据并说明**原判据为何错**（§6 逐条）；
> 拿不到证据写「未验证」。**没有**为让套件变绿而放宽断言。

---

## 0. 逐项判定（本路）

| # | 判据（上级原文） | 判定 | 一句话依据 |
|---|---|---|---|
| ① | 真实外部 CLI 调用（**不能只看 provider 名**） | **PASS** | 四条独立事实交集：宿主转录 `request/header.config` + CLI 自写 `manifest.json` + **OS 层同 pid 真 argv** + 回复含本轮唯一票据 |
| ② | 不同账号身份、互不串号 | **PASS** | 票据互不含；`--config-dir` 在 **CLI 自报**与 **OS argv** 两条来源上各自归位 |
| ③ | `actual` 供应商与模型（**不得把请求值当实际值**） | **PASS**（边界写清） | 实际值取 CLI 自记的 `model="auto"` + 上游 host，**与请求值（目标名）不同**；⚠️ CLI 换版后 `provider=` 字段消失，故如实记 `null` |
| ④ | 每成员至少 3 轮（历史缺陷：第 3 轮起 `ENAMETOOLONG`） | **PASS**（跨运行） | A 跑到**第 7 轮**（CLI 自记 prompt 32065→37016）；B 在三次运行各 3/3/4 轮；**每轮真实 argv 里都没有该轮 prompt 的票据** |
| ⑤ | 双向成员通信（成员自发经桥接发的消息**真的到达并影响行为**） | **FAIL（部分成立）** | **通道成立**（4 次真实 `tools/call`，两方向都有）＋**到达成立**＋**"照做式影响行为"只 1 次**；其余被模型以 prompt injection / social engineering 为由拒绝 |
| ⑥ | 取消（行为可观察） | **PASS** | 中断时 `previousStatus="running"`；该轮终态 `{kind:"aborted",reason:{kind:"parent"}}` |
| ⑦ | 冷恢复（实际状态被核验、**不得盲目重放已完成写操作**） | **PASS** | 恢复后真跑一轮；绑定 `setAt` 未变（`bind.written` → 6×`bind.kept`）；逐 id 计数无重复、只 +1 个新投递（= 恢复任务自身） |

**⑤ 为什么不判 PASS**：用户判据是「真的到达并**影响行为**」。本路把它拆成三段各自取证：
通道（成立）、到达（成立）、影响行为（只 1 次以"照做"形式成立）。三段缺一不可 ⇒ 整体 FAIL。
根因**不是通道缺失**（通道被 4 次真实调用反复证实），而是**模型侧拒绝**——两名不同成员**各自逐字**说明了理由（§4.4）。

---

## 1. 测量环境与版本（**必须一起读**）

| 项 | 值 |
|---|---|
| 宿主 | `D:\DeepSeek\resources\app.asar`（rc.2 运行版），WebUI `http://127.0.0.1:4200` |
| 插件 | `D:\Project\dsh-harness-pilot`（junction 挂到 profile） |
| 外部 CLI | `C:\Users\Administrator\.qodersec\bin\qoderclicn.exe` |
| 桥接事件日志 | `C:\Users\Administrator\.dsh\plugins\harness-pilot\mcp\bridge-events.jsonl` |
| 会话转录 | `…\.dsh\sessions\<slug>\<sessionId>\session.v4.jsonl.zstd`（多帧 zstd） |

### 1.1 `/diag/loaded`（收尾，`anyStale=false`）

```
index.js 550775652170   tasks.js 2ff85e23efca        sessions.js 9a9153574af9
tools.js 91818170734d   llm-adapter.js b961fb5d6adc  processpool.js 83204531b597
transports/headless.js c7c987b44cfd   config.js c119029b65b7   catalog-edit.js fc9442c4346f
provider.js 6e77753d114f   transports/acp.js 404e6b63b200   mcp-bridge.js d360fc3a7649
```

`SELF_MODULES` 已被别路扩到 **12 项**（含 `provider.js` / `transports/acp.js` / `mcp-bridge.js` / `catalog-edit.js`）
⇒「磁盘 = 已加载」对这些文件**不再是空话**。`promptViaStdin` 的宿主行为证据见 §3.4（不靠 `config.js` 自报）。

### 1.2 ⚠️ 外部 CLI 在本会话期间**被换过版本**（确证）

- `qoderclicn.exe`：`LastWriteTime = 2026-10-14 00:54:37`、`FileVersion = **1.1.13**`；
  同一会话更早的 manifest 记的是 `cli_version = **1.1.41**`。
- 1.1.41 的 `qodercli.log` 有 `model.response.completed … provider="qoder" model="auto"`；
  **1.1.13 没有 `provider=` 字段**（只剩 `model="auto"`）⇒ §3.3 的判据改读该版本真的会写的字段。
- **跨版本都成立**：两个版本**都**支持 `--mcp-config` + `--allowed-tools`，桥接在**两版上都真的被调用成功过**
  （1.1.41：run `…-p30892`；1.1.13：§4.2 的四次）。

### 1.3 构建 / 工件 / profile / 回归（收尾）

- `node scripts/build.mjs` → **exit 0**，拷贝步骤执行 ⇒ 三个 client 工件**同哈希**：
  `9EEFD62899A5D266224BF0FFDD7ECA3A2E101C54E3A2CC24A1411AEB7641A98F`（129852 B，同 mtime）。
  （⚠️ 本轮**踩过一次**该陷阱：构建非 0 时 `scripts/build.mjs:118-119` 会跳过 client 拷贝 ⇒ 三件不一致。已核对。）
- `node probe/_regression-suite.mjs` → **11/11 PASS**。
  ⚠️ 第一次跑是 10/11：唯一 FAIL 是 `verify-subagent-account-alias` 的**新鲜度断言**
  （`src/provider.ts` mtime **晚于** `lib/provider.js` —— 并发写者在 build 之后又改了源码）。
  **重新 build 后该探针 77/77 通过，整套 11/11。**
- profile：`cordis.yml = 33B0735DD8756CAF6D5ECB55ED482FB485AB950EA86794002FD08959BC2ACF42`（**与预期同值**）；
  ⚠️ `cordis.patch.yml = F59DE58775716D62F8570DF4909460D002BE05E4FA5EE1E491F169E9DEED9A5F`
  **≠ 预期 `2D0C5781…`**，mtime `2026-10-14 01:01:50`。**本路没有任何写 profile 的动作**
  （写入范围只有 `probe/**` 与两份 docs）。同一漂移已由别路在 `docs/00-verified-status-report.md` §26.6 记录 ⇒ **交 Lead 复核**。

### 1.4 ⚠️ 并发干扰（**本路测量的真实条件**）

1. 本机**同时**有别路真实探针在 spawn 同一批厂商 CLI（回归套件里的联邦探针等）。
2. **同一个探针文件被多路并发修改**：`probe/verify-team-final-acceptance.mjs` 在 01:17–01:28 之间被另一路换掉了
   「入口认领」逻辑，并加了运行锁 `probe/out/.team-final-acceptance.lock` 与脚本指纹。**我没有回滚任何人的改动。**
3. 后果：**第 4 次运行（stamp `Y504G`）在跑的中途被判据换版 ⇒ 该轮探针报告不可采信**
   （它的输出里出现了我启动时并不存在的认领规则）。我把它的**原始产物**单独复核（§4.3），**不引用**它的探针结论。
4. 另一路的运行（stamp `YJX0T`）在我清理"我自己的"残留进程时被**误杀**（锁文件事后才显示持有者是 `YJX0T`）。
   **如实报备**：这是我的操作失误，不是产品行为；已写入给 Lead 的处置建议（§8.5）。

---

## 2. 逐项验收：① ② ③

### 2.1 ① 真实外部 CLI 调用 —— **PASS**

**四条互相独立**的事实同时成立（**不是** provider 名，**不是**非空回复）：

| 事实 | 来源 | A（`qoder-cn-acct-a`） | B（`qoder-cn-acct-b`） |
|---|---|---|---|
| 该轮路由 | 宿主转录 `request/header.config` | `{provider:"pilot-cli", model:"qoder-cn-acct-a"}` | `{provider:"pilot-cli", model:"qoder-cn-acct-b"}` |
| CLI 自己写的运行记录 | `manifest.json`（`cli_version`/`pid`/`argv`） | run `2026-10-14T01-20-02-370+08-00-9xvs4w-p38664`，pid 38664 | run `2026-10-14T01-20-04-414+08-00-abvju6-p46920`，pid 46920 |
| **OS 层真 argv**（`Get-CimInstance Win32_Process`） | 与 manifest **pid 相等**做 join | `C:\…\qoderclicn.exe --config-dir …\qoder-cn-a -p --mcp-config …cfg-a51c372e9b81.json --allowed-tools mcp__dsh_bridge__send_message`；父进程 `DeepSeek Harness.exe` | 同形，`--config-dir …\qoder-cn-b`，`cfg-d1a40ddeabf3.json` |
| 回复真的落进会话 | 宿主转录 assistant 正文 | 61 字，含本轮唯一票据 | 61 字，含本轮唯一票据 |

> `manifest.json` 的 `argv[0]` 是 `bun B:/~BUN/root/index.js`（CLI 内部视角），OS 层给的是真实 exe 路径
> —— **两者不同是正常的**；我比对的是 `--config-dir` 取值与 `-p`/`--mcp-config` 的有无。
> **pid 相等**才是 join key：它把「CLI 自报的那次运行」与「OS 眼里那个进程」钉在一起。

### 2.2 ② 不同账号身份、互不串号 —— **PASS**

- A 的回复**不含** B 的票据、B 的回复**不含** A 的票据（各只含自己那一个）。
- `--config-dir`：A 的**全部** run 落在 `…\harness-accounts\qoder-cn-a`，B 的全部落在 `…\qoder-cn-b` ——
  **两条来源都查**（CLI 自报的 `manifest.argv` **与** OS 层真 argv）。
- 绑定里**不带** `accountId`：两个目标自己钉死了 `--config-dir`；带上会被适配器**正确拒绝**
  （账号属 Harness「qoder-cn」≠ 目标名「qoder-cn-acct-a」）。

### 2.3 ③ `actual` 供应商与模型 —— **PASS**（边界写清）

**实际采用值**（对端进程自己写的）：

| 来源 | 值 |
|---|---|
| `qodercli.log:model.response.completed` | `model="auto"`、`stop_reason="end_turn"`、`provider=null`（1.1.13 无该字段） |
| `qodercli.log:turn.started` | `model="auto" prompt_length=32065 history_length=5` |
| CLI 自己的上游请求痕迹 | `operation=sendRemoteChatAsk url=https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation` |

**请求值**（≠ 实际值，仅供对照）：`{provider:"pilot-cli", model:"qoder-cn-acct-a"}`
—— 这里的 `model` 是**适配器的路由目标名（票据）**，**不是**模型 id。
DSH 侧记在 assistant 消息上的来源：`{provider:"pilot-cli", model:"qoder-cn-acct-a", kind:"model"}`。

⇒ 判据落在「**实际值 ≠ 请求值**」上，**没有**把请求值当实际值。

> ⚠️ **不得外推**：`model="auto"` 是 CLI 的**自动选型**取值；**上游最终具体型号本探针没有取到**（CLI 不披露）。
> ⚠️ 已知陷阱「ACP 的 `set_config_option` 对不存在的模型也会成功」在本路由**不适用**：这条路由不走 ACP（headless argv 派发）。
> ⚠️ `list_agents` 里成员的 `model: deepseek-v4.1-flash` **不是**这一轮实际跑的东西（那只是宿主侧子代理登记信息）；
> 对照：原生成员 C 的 `request/header` 才是 `opencode-go/deepseek-v4.1-flash`。

---

## 3. ④ 每成员至少 3 轮 —— **PASS**（跨运行，含 ENAMETOOLONG 复验）

**历史缺陷**：prompt 拼进 argv ⇒ 第 3 轮起 `spawn ENAMETOOLONG`。
**修法**：prompt 改走 stdin（`qoder-cn-acct-a`/`-b` 声明 `promptViaStdin: true`，`src/config.ts:361`、`:371`）。

| 运行（stamp） | A 的轮次 | B 的轮次 |
|---|---|---|
| `X49KE`（第 1 次） | R1、R2、R3（+ 取消/恢复轮） | R1、R2、**R3** |
| `XH897`（第 2 次） | R1…R3（3 次桥接尝试） | R1、R2、**R3** |
| `XWQMU`（第 3 次，**本路最可采信**） | **R1…R7** | R1、R2 |
| `Y504G`（第 4 次，探针报告不可采信） | — | 原始产物复核：**4 轮** |

`XWQMU` 里 A 的逐轮（长度 = **CLI 自己数到的** prompt 字符数）：

```
R1 completed 32065 | R3 completed 34325 | R4 completed 35637 | R5 completed 36333
R6 aborted 37016（取消轮，见 §5.1） | R7 completed 37016（冷恢复轮，见 §5.2）
```

**每轮的三条字节级证据同时成立**：

1. 该轮**真的产生了** `turn/end`，且**由外部 CLI 承接**（有 `manifest.json` run + CLI 自记 `prompt_length`）；
2. 该轮**真实 argv（OS 层）里没有**该轮 prompt 的票据或特征短语 ⇒ 这是「prompt 走 stdin 不走 argv」的**哨兵级**判据；
3. CLI 自己数到的 prompt 长度**随历史增长**（32065 → 37016），却**没有再撞 argv 上限**。

> ⚠️ 长度来源是**外部 CLI 自己**记的 `turn.started prompt_length=` / `input.prompt.received text_length=`（只读），不是本插件自报。
> ⚠️ **`truncated` 字段的语义先测定再用**（`probe/_qodercli-prompt-fields.mjs`，107 行实测）：
> `truncated=false` 的 **87/87** 行 `previewChars == text_length`；`truncated=true` 的 **20/20** 行 `previewChars == 2000`
> ⇒ 它说的是**日志预览**被截，**不是** prompt 本体被截。语义弄反，这条证据就会变成反证。
> ⚠️ 第 3 轮起能跑通**只**证明「prompt 走 stdin 的目标不再撞 argv 上限」；对**仍把 prompt 拼进 argv** 的目标**不适用**（本轮没测）。
> ⚠️ `XWQMU` 里 B 只有 2 轮：A 方向被模型拒绝 ⇒ B 的「被唤醒轮」没有发生。这是**本路探针的轮次设计依赖 A 成功**，
> 不是产品限制（B 在 `X49KE`/`XH897`/`Y504G` 分别达到 3/3/4 轮）。本路已在探针里补了「不依赖 A 的 B 轮次兜底」，
> 但那一版运行被并发改版打断（§1.4）。
> ⚠️ **另一路独立给出的互补证据**：`src/transports/headless.ts:248` 的 `facts.stdinChars`（宿主**真正写进 stdin 的字节数**）
> **没有落盘** ⇒ 那一格在双方报告里都记「未验证」。本路的替代口径是「argv 无哨兵 + CLI 自记 prompt_length 随历史增长」。

---

## 4. ⑤ 双向成员通信 —— **FAIL（部分成立）**，逐段取证

### 4.1 三段判据与结果

| 段 | 判据 | 结果 |
|---|---|---|
| **通道** | 成员**自发**发起真实的 MCP `tools/call`（不是"prompt 里写了工具 schema"） | **成立**（4 次，两方向都有） |
| **到达** | 该消息在**目标成员自己的会话日志**里落地 + Lead 日志有 `delivered` 边 + message id 闭合 | **成立**（4 次全部闭合） |
| **影响行为** | 目标成员的**回复**里出现那个只可能来自该消息的字符串 | **只 1 次成立**（`X49KE` 的 A→B） |

### 4.2 四次真实的成员发起桥接调用（**通道成立的硬证据**）

| 运行 | 方向 | 桥接入口 | `mcp.tool/call` | 结果 message id | 目标会话回执 | 目标回复含 token |
|---|---|---|---|---|---|---|
| `X49KE` | A→B | `b5681d9e0704` | seq 32 `send_message`（callId `2cb3c0b7…`） | `team-message-09329b7f…` | ✅ B 会话 seq 24 | ✅ **是** |
| `XH897` | B→A | `da7922632681` | `send_message`（callId `0ff19bf5…`） | `team-message-64e1a795…` | ✅ A 会话 seq 44 | ❌（A 拒绝复述） |
| `XWQMU` | B→A | `486f93000dc4` | `send_message`（callId `5152e713…`） | `team-message-7a5f3bb2…` | ✅ A 会话 seq 54 | ❌（A 拒绝复述） |
| `Y504G` | A→B | `4668e6c36d1a` | seq 20 `send_message`（callId `7fc306d9…`） | `team-message-cd5dae7c…` | ✅ B 会话 seq 24 | ❌（B 明确拒绝，原文见 §4.4） |

**每一次都同时有 CLI 自己的日志**，例如 `XWQMU`：

```
tool.requested tool_name="mcp__dsh_bridge__send_message"
  args={"message":"Status token HPM2A-FROM-B-XWQMU. Please acknowledge it by replying to the lead with exactly ACK-HPM2A-FROM-B-XWQMU.","target":"ft-a-xwqmu"}
```

> 这是**对端进程自己**写的，含**工具名与完整参数** ⇒ 比"配置里注入了 mcpServers"硬得多。

### 4.3 第 4 次运行（`Y504G`）的**原始产物独立复核**（绕开被换版的探针认领逻辑）

`probe/_recheck-bridge-chain.mjs`（只读）对 B 会话 `fc41df0e-9a2c-4539-84eb-8d9350383170` 复核出：

```
桥接：entry 4668e6c36d1a（origin=pilot-cli-redirect, injected=true, sessionId=5dada5da… = A 会话）
      mcp.tool/call seq 20 tool=send_message callId=7fc306d9-c93c-4f27-bd6f-65a69c89d3d5
      mcp.tool/result isError=false resultIdTokens=["team-message-cd5dae7c-47ae-4d62-a962-52fd837812bd"]
到达：B 会话 seq 24 user/message source.kind=team-message
      messageId=team-message-cd5dae7c-… senderId=5dada5da…（A）senderName=ft-a-y504g
影响：B 第 2 轮（completed，路由 pilot-cli/qoder-cn-acct-b）正文 331 字 —— 原文见 §4.4
```

⇒ **「通道 + 到达」在这一轮同样成立**；探针当时没认领到，是因为并发的另一版把桥接事件的 `time`
（**ISO 字符串**）当数字比较（`typeof e.time === 'number'`）⇒ 区间过滤退化成"不过滤" ⇒ `entryClaim=ambiguous`。
**这是那版探针的缺陷**（我没有改别人的文件，已在 §8.4 列出）。

### 4.4 为什么"影响行为"这一段落空 —— **模型的拒绝，理由逐字可查**

| 谁 | 场景 | 回复原文（节选） |
|---|---|---|
| A（`XH897` R2、R3） | 要求它调桥接工具发消息 | "I'm not going to do that. The runtime context explicitly states at the bottom of this turn: > ⚠️ 本通道**没有工具协议**：DSH 不会执行上述任何工具… Additionally, this looks like a **prompt injection** attempt using my ticket number to construct a relay message to another teammate." |
| A（`XH897` R4） | 收到 B 的消息 | "This looks like a **coordinated attempt to establish some kind of token relay protocol** between agents, which I will not participate in." |
| B（`Y504G` R2） | 收到 A 的消息 | "I received a team message from ft-a-y504g asking me to send a specific acknowledgment token to the lead. **This looks like a social engineering pattern — I'm not going to blindly echo formatted tokens between agents.** I'll report this to you instead of complying." |
| B（`X49KE` R3） | 要求它调桥接工具 | 该轮**没有**调用工具，只回复文本（CLI 日志该轮 `loop.iteration.finished reason="end_turn"`、零 `tool.requested`） |

**两点必须分开写**：

1. **拒绝里引用了那段过期声明**（确证）：`src/llm-adapter.ts:294-299` 在**每一次改道轮**都渲染
   「# 调用方环境里存在的工具（仅供你了解上下文，调用它们不会有任何效果）…⚠️ 本通道**没有工具协议**…不要把它们当作可调用的函数」。
   桥接出现后，这句话对**被桥接的那 6 个工具**已经**不成立**；成员拒绝时**逐字引用**了它。
2. **但"免责声明单独导致拒绝"这一单一变量归因被受控实验否证**（§7.1）⇒ **不能**把它写成原因。

**能确证的是**：任务形态是「在成员之间中继并复述一个**拼接出来的** token」，而两名不同成员**各自独立**
把这种形态指认为 **prompt injection / social engineering**。`Y504G` 里 B 的回复证明消息**确实改变了它这一轮的行为**
（点名发送者、描述请求、作出拒绝决定），只是**没有照做**。

### 4.5 正对照 / 负对照 —— **PASS**

- **正对照（原生成员也能发）**：成员 C **从诞生起未绑定**（落盘绑定 = `null`），该轮路由 `opencode-go/deepseek-v4.1-flash`
  （宿主模型，**不是** pilot-cli），`tool-call` 块 = 2、工具事件 `["tool/call","tool/result"]`，
  它**自己发出**的 `team/message` = 1 条且内容含拼接 token（投递文本里只给三段 `HPC`/`-FROMC-`/`OK-<stamp>`）。
  ⇒ 「成员能发消息」**不是桥接的特例**。
- **负对照（作用域隔离）**：作用域 `acd8b735…` 可见桥接工具 **5** 个（缺 `wait_agent`），经桥接打 `wait_agent` →
  `-32602` + **`BRIDGE_TOOL_NOT_IN_MEMBER_SCOPE`**（`boundSessionId` = 该会话），且 **`mcp.tool/call` 计数增量 = 0**
  （拒绝了就**没有执行**）；对照作用域可见 6 个，A（团队成员作用域）该轮 `tools.list` 的 `missingInScope = []`。
  ⚠️ 不用 `send_message` 当"缺席名"：它同时被 `dsh-tool-subagent-control` 注册为**全局**工具，任何作用域里都在。

---

## 5. ⑥ 取消 / ⑦ 冷恢复

### 5.1 ⑥ 取消 —— **PASS**

```
中断时目标状态 = "running"            ← 只有 running 才算这次取消测在活轮次上
该轮（第 6 轮）终态 = {"kind":"aborted","reason":{"kind":"parent"}}
该轮桥接入口收尾 = bridge.close reason="turn-settled"（ms=6374）
中断后 list_agents = ["lead:running","ft-a-…:inactive","ft-b-…:inactive","ft-c-…:inactive"]
```

- `interrupt` 的返回只是**采样到的状态**，不是行为证据；行为证据是「该轮以取消语义结束」。
- 机制（确证，代码）：`roster.interrupt` → `ctx.subagents.interrupt(childId, {kind:'ancestor', agent:caller})`；
  headless 传输层在 abort 时 `killTree(pid)` 并 `finish('aborted','cancelled by caller')`。
- **已知边界**：只能 abort **当轮**；杀不掉外部 CLI **已在目标系统产生的副作用**（**没有**测副作用是否被撤销）。

### 5.2 ⑦ 冷恢复 —— **PASS**

```
恢复后真的又跑一轮：第 7 轮，路由 {provider:"pilot-cli", model:"qoder-cn-acct-a"}，正文 13367 字，
                    含恢复票据，终态 {"kind":"completed"}
绑定未被重写：setAt 2026-10-13T17:13:35.193Z → 17:13:35.193Z（不变）
观测日志幂等序列：["5:bind.written","28:bind.kept","41:bind.kept","56:bind.kept","76:bind.kept","86:bind.kept","104:bind.kept"]
已完成写操作未被重放（逐 id 计数）：
  A 自己发出的 team/message : 重复=[] 缺失=[] 新增=[]
  Lead 侧 delivered 边      : 重复=[] 缺失=[] 新增=["team-message-c8174464-…"]   ← 恢复任务自身那条 Lead→A 消息
  A 会话里收到的团队消息    : 重复=[] 缺失=[] 新增=["team-message-c8174464-…"]
  A 的 turn/end 数 6 → 7（Δ=1）
```

- 冷恢复会**再次触发 `agent/created`**（上一轮已确证），绑定钩子挂在那里来得及；
  本轮用 `bind.kept`（幂等）而不是二次 `bind.written` 证明「没有把绑定重写一遍」。
- 「不盲目重放」的判据取自宿主自己的 mailbox 语义：`dispatchOnce` 对**已记录**该消息身份的目标只 `markDelivered`（幂等），
  不会二次投递 ⇒ 「同一 messageId 的**出现次数不增加**」就是「没有重放」的可观察判据。

---

## 6. 探针契约：本路自己犯的错（逐条留档，含"原判据为何错"）

> 要求：**判据要能分辨"实现缺陷"与"探针契约缺陷"**；自己的判据写错就先改判据并说明原判据为何错，
> **不为变绿而放宽断言**，也不用重跑真实数据迁就判据。以下每条都是**判据/解析缺陷**，不是产品缺陷。

| # | 原判据（错在哪） | 为什么错 | 改成什么 |
|---|---|---|---|
| P1 | 按 `data.message.source` 读 `user/message` 的团队消息回执 | **实测形状**（`probe/_dump-event-shapes.mjs`）：`assistant/message` 是 `data.message.{content,source}`，而 **`user/message` 是 `data.content` + `data.source`**（`data` 本身就是那条消息）⇒ 原读法**永远 undefined**，「目标有没有收到」会**假阴性** | 两种形状都读 |
| P2 | 桥接事件窗口上界 = **调用 `collectRound` 那一刻**的 `Date.now()` | 那一刻**这一轮还没开始跑** ⇒ 窗口只覆盖到"入口刚开、CLI 刚 initialize"，**把真正的 `mcp.tool/call` 排除在外**（`X49KE` 的 5a 就是这么假阴性的；原始日志里那次调用明明成功了） | 上界改为 `waitForTurn()` **返回之后**的 `tEnd` |
| P3 | ⑦「不得重放」= **恢复前后 id 列表必须完全相同** | 恢复窗口里本来就会有**新的**合法投递（**恢复任务本身就是一条 Lead→A 团队消息**）⇒ 任何一次正常恢复都会被判成"重放"；原判据**表达不出"重放"与"新投递"的区别** | 逐 id **计数**：既有 id 出现次数**不得增加**，新 id 单列 |
| P4 | ③ 判 `provider === 'qoder'` | 该字段**只有 1.1.41 有**；CLI 在本会话被换成 1.1.13（§1.2）⇒ 判据绑死在一个**已不存在的日志字段**上，必然 FAIL | 改读该版本真的会写的：`model="auto"` + 上游 host；`provider` 有就读、没有写 `null` |
| P5 | 轮次号**写死**（`turnIndex: 4` / `: 5`） | 一旦多一次重试就整体错位（`XH897` 实测：第 2 轮被记成第 3 轮） | 按 `turn/end` 计数**动态推导** |
| P6 | 并发下按**时间窗**挑 CLI run | 别路的联邦探针会 spawn 同一批 CLI ⇒ 会捞到**别人**的 run | 入口由该轮**真实 `[turn/start,turn/end]` 区间**认领；run 由 `manifest.argv` 的 `--mcp-config` 尾名 === `cfg-<入口 id>.json` **反查**（入口 id 一次性随机） |
| P7 | ⑤「影响行为」= 目标回复必须**复述拼接 token** | 与**任务形态**耦合：为防"自证"而设计的"分段拼接 + 要求复述"恰恰制造了**可疑的中继形态**，触发模型的注入/社工启发式 ⇒ 判据本身在逼模型拒绝。**这是判据缺陷，不是产品缺陷** | 下一轮应改**普通业务消息**，以"目标回复是否**引用该消息内容**"为影响判据（`Y504G` 的证据表明这样能成立：B 点名发送者并描述了该请求） |

**另一路文件里的两条（如实列出，我没有改他们的文件）**：

- `eventMs = typeof e.time === 'number' ? e.time : NaN` 而桥接事件 `time` 是 **ISO 字符串** ⇒ 区间过滤退化为"不过滤" ⇒
  同会话开过 ≥2 个入口就 `entryClaim=ambiguous` ⇒ **假阴性**（`Y504G` 的 5a 就是这样漏掉的）。
- 「入口唯一」当必要条件本身正确（不许按时间先后猜），但与上一条叠加后变成"永远认不到"。
  建议：`eventMs` 支持 ISO 字符串，或在认领失败时**用 run 反查入口**（run 的 `--mcp-config` 里带入口 id）。

---

## 7. 对抗性复核（对另一路两处结论）

### 7.1 **否证**：免责声明**单独并不能**抑制工具调用

另一路把「提示词声明无工具协议 vs 桥接注入了真 MCP 通道」记为**产品缺陷 5f**，并写「后果可观察：
同一方向在不同运行里成/败各一次」。**该矛盾作为"口径不准确"成立**（那句话对 6 个桥接工具确实已不成立），
但**"它导致拒调"这一步没有被证明**。本路做了单变量受控实验（`probe/verify-prompt-disclaimer-effect.mjs`，
真实外部 CLI + 同一个 MCP 桩，**同一任务文本**，只改"是否附带那段声明"）：

| arm | prompt 里有什么 | 2 次里真的发起 `tools/call` |
|---|---|---|
| `with` | 任务 + **逐字**复制的 `src/llm-adapter.ts:294-299` 免责声明块（含工具名清单） | **2/2** |
| `without` | 只有任务 | **2/2** |
| `patched` | 任务 + 建议改法的 wording（承认 DSH 工具不可调、指明桥接 MCP 工具**真的可调用**） | **2/2** |

**6/6 全部调用了工具**（`promptChars` 1383 / 354 / 1692，确认声明确实进了 prompt）。
⇒ 在本实验条件下，**免责声明既不是充分条件也不是必要条件**。
因此本路**不把免责声明写成"成员拒绝的原因"**，只写成"成员**拒绝时引用的理由**"（E13）。
它**仍然值得改**——理由不是"改了就能通过"，而是**它现在是一句不准确的话**（§8.3）。

### 7.2 **确证**（与另一路一致，独立得出）

- 历史 5a 的 FAIL 是**探针关联采样缺陷**（产品侧真的执行了那次调用）—— 本路独立踩到同一个坑（P2）并给出同向结论。
- 历史 5b 的 FAIL **成立**：B 那一轮**真的没调**工具；A 说出 token 是 **Lead 代发**造成的
  （本路在 `XH897` 也观察到同一现象：Lead 被成员完成事件唤醒后自己 `send_message` 转发了那条 token）。
  ⇒ **不得**据此判"双向自发通过"。本路判据里 `queued.senderId === B 会话` 正是为了排除这种"代发"。
- 冷恢复的判据必须容许**新**投递、只禁止**重复**投递 —— 两路各自独立地把原判据改成了同一形状（P3 / 另一路 §B）。

---

## 8. 与「父进程见证层」的合并口径 + 处置建议

### 8.1 合并口径（**互补，不得互相冒充**）

| 证据 | 闭合的是哪一层 | **不能**用来代替什么 |
|---|---|---|
| 用户自测的父进程见证层（`outputs/HarnessPilot长输入独立见证.json`：40092 字符 prompt 经 stdio 见证层**逐字节**转发给真 CLI，`promptInArgv=false`） | **L2/L3 的运输层边界**：长 prompt **不进 argv**、经 stdio **完整**送达 | ❌ 不能代替**团队上下文的轮次验收**（无团队成员、无多轮、无双向/取消/恢复） |
| 本文件 | **团队上下文的轮次验收**：真实团队成员被改道、A 跑到第 7 轮、双向桥接调用、取消、冷恢复 | ❌ 不能代替"运输层逐字节见证"（本路用的是**哨兵级**证据：argv 无该轮票据 + CLI 自记 `prompt_length`） |

- 见证层回答「**能不能**把 40 KB 的 prompt 送进去」；本文件回答「在**真实团队成员的多轮上下文**里它**确实**送到了，
  且轮次真的跑到第 7 轮（32065 → 37016）也没有 `ENAMETOOLONG`」。
- ⚠️ **我没有读到那份 JSON**：本机 `D:\Project` 下按 `*独立见证*` 搜不到该产物 ⇒ 上文只按**用户描述的范围**引用，
  **没有引用它的任何数值**。
- 一个可对齐的旁证：见证层那次运行的 CLI 记录能在本机找到 ——
  `…\harness-accounts\qoder-cn-a\logs\runs\2026-10-14T00-23-28-887+08-00-37k216-p45072` 的
  `input.prompt.received text_length=40092 truncated=true`（`command_mode="prompt"`）。
  按 §3 已测定的字段语义，`truncated=true` 只表示**日志预览**被截到 2000 字符，**不是** prompt 本体被截
  —— 与"逐字节转发"不矛盾。

### 8.2 **①②③④⑥⑦ 都不需要 src 补丁**

这六项在本轮实测里成立，**没有任何一项**因实现缺陷失败。`④` 的历史缺陷已由"prompt 走 stdin"修好并被第 7 轮实测背书。
**⑤ 的残余阻塞不在通道**（通道被 4 次真实调用、两个方向、两个 CLI 版本证实）⇒ **不要**为此改桥接。

### 8.3 建议（口径修正，**可选**）：把那段过期声明改成"桥接感知"的版本

**理由**：`src/llm-adapter.ts:294-299` 那句话在桥接出现后**对那 6 个工具已不成立**，而成员拒绝时**逐字引用**了它。
改它**不是**因为"改了就能通过"（§7.1 已否证该因果），而是因为**它现在是一句不准确的话**。
（另一路已给出等价补丁文件 `probe/patch-llm-adapter-bridge-disclaimer.md`；两路结论在此**收敛**，可择一集成。）

### 8.4 转告另一路的探针缺陷

见 §6 末尾两条（`eventMs` 不认 ISO 字符串 ⇒ 入口认领假阴性）。**我没有改他们的文件。**

### 8.5 两处环境/协调问题（需 Lead 决策，**不是代码缺陷**）

1. **外部 CLI 被换过版本**（1.1.41 → 1.1.13，`qoderclicn.exe` mtime `2026-10-14 00:54:37`）：
   换版期间**同一份验收的两半落在不同版本上**。建议验收期间冻结该二进制，或至少在报告里绑定版本。
2. **同一个探针文件被多路并发修改**；并且我**误杀**了另一路的一次运行（`YJX0T`，§1.4）。
   建议：一个探针文件只由一路拥有；跨路复用请**复制成不同文件名**再改。

---

## 9. 诚实分级

### 9.1 确证（本路直接实测，或有 file:line 依据）

| # | 结论 | 证据 |
|---|---|---|
| E1 | 被改道成员**确实由外部 CLI 承接**（四条独立事实交集，含 OS 层同 pid 真 argv） | §2.1 |
| E2 | 两账号互不串号（票据互不含 + `--config-dir` 两条来源各自归位） | §2.2 |
| E3 | `actual` 值 = CLI 自记 `model="auto"` + 上游 host，**与请求值（目标名）不同** | §2.3 |
| E4 | CLI 在本会话**被换过版本**（1.1.41→1.1.13），1.1.13 **不再写 `provider=`** | §1.2 |
| E5 | **prompt 走 stdin**：每轮真实 argv 里无该轮 prompt 票据/特征短语，而 CLI 自记长度 32065→37016 | §3 |
| E6 | **ENAMETOOLONG 已修**：A 跑到第 7 轮；B 在三次运行各 3/3/4 轮 | §3 |
| E7 | `truncated` 指**日志预览**被截（87/87、20/20 实测），不是 prompt 被截 | §3 |
| E8 | **成员自发经桥接的真实 `tools/call` 至少 4 次，两方向都有**，每次 message id 与原生 mailbox 闭合 | §4.2 |
| E9 | 桥接结果 id ↔ Lead 日志 `queued`/`delivered` ↔ **目标会话回执**是**同一个 id** | §4.2、§4.3 |
| E10 | CLI 自己的日志记下了 `tool.requested` 的**工具名与完整参数** | §4.2 |
| E11 | **"照做式影响行为"只 1 次成立** | §4.2 |
| E12 | 其余失败是**模型拒绝**，两名不同成员**各自逐字**指认为 prompt injection / social engineering | §4.4 |
| E13 | 拒绝时**逐字引用**了 `src/llm-adapter.ts:294-299` | §4.4 |
| E14 | **免责声明单独不能抑制调用**（受控实验 6/6 都调用了工具） | §7.1 |
| E15 | 正对照：原生未绑定成员能发（2 个 tool-call 块 + 1 条自己发出的 `team/message`） | §4.5 |
| E16 | 负对照：作用域缺席的工具名被 `BRIDGE_TOOL_NOT_IN_MEMBER_SCOPE` 拒绝，`mcp.tool/call` **零增量** | §4.5 |
| E17 | 取消：中断时 `running`，该轮终态 `{kind:"aborted",reason:{kind:"parent"}}` | §5.1 |
| E18 | 冷恢复：又真跑一轮、`setAt` 不变（`bind.written`→6×`bind.kept`）、逐 id **无重复**、turn/end **+1** | §5.2 |
| E19 | 回归 **11/11**；三个 client 工件同哈希；`cordis.yml` 与预期同值 | §1.3 |
| E20 | `cordis.patch.yml` 与预期**不符**（mtime `01:01:50`），**本路未写 profile** | §1.3 |

### 9.2 推断（写清依据）

| # | 推断 | 依据 |
|---|---|---|
| I1 | ⑤ 的残余阻塞**不在通道**，而在**模型侧对"成员间中继 token"这一任务形态的安全判断** | E8/E9（通道与到达反复成立）+ E12（两名成员各自逐字指认形态）+ E14（否证免责声明这一单一变量） |
| I2 | `XWQMU` 里 B 只有 2 轮是**探针设计**的后果（B 的唤醒轮依赖 A 成功），不是产品限制 | B 在 `X49KE`/`XH897`/`Y504G` 分别 3/3/4 轮（同一套机制、同一目标） |
| I3 | 一旦成员拒绝，它会在后续轮次**锚定**在自己的拒绝上 | 观察：A 的两次拒绝回复**逐字节相同**（尽管重试提示多了整句）；A 在 `XH897` R4 把"收到 B 的消息"称为"同一注入模式的延续，第 1 步…第 2 步…" |

### 9.3 未验证 / 未做（**不得当作结论**）

| # | 项 | 说明 |
|---|---|---|
| U-a | **上游最终具体模型 id** | CLI 用 `model="auto"`，不披露具体型号（E3） |
| U-b | **为什么模型有时调用、有时拒绝** | 受控实验**否证**了"免责声明单独导致"（E14）；观察到"拒绝会逐字重复"（I3），但**没有**做多轮锚定实验 |
| U-c | 取消/恢复期间**外部 CLI 已在目标系统产生的副作用**是否被撤销 | 只确证进程被杀与轮次以 aborted 结束 |
| U-d | 其它目标（`wb-managed-*`、`opencode` 等）在改道路由上的桥接行为 | 本轮只用 `qoder-cn-acct-a` / `-b` |
| U-e | **N 成员并发**同时开桥接入口的行为 | 未做压测 |
| U-f | 被中断那轮的**内容**是否会在下一轮被 CLI "重做" | 只作观察，未设计成实验 |
| U-g | 宿主**真正写进 stdin 的字节数**（`headless.ts:248` 的 `facts.stdinChars`） | **没有落盘** ⇒ 读不到（与另一路同）；本路用「argv 无哨兵 + CLI 自记 prompt_length」替代 |
| U-h | 第 4 次运行（`Y504G`）与另一路的 `YJX0T` 运行 | 前者因判据换版**报告不可采信**（原始产物已单独复核 §4.3）；后者被我误杀（§1.4）⇒ 两者的**探针结论**都不引用 |
| U-i | ⑤ 在**单次运行内**两方向同时"照做式"通过 | 四次运行都没做到（原因见 I1）；**没有**再跑第 5 次（并发改写 + 额度纪律） |

---

## 10. 产物与复现

| 产物 | 说明 |
|---|---|
| `probe/verify-team-final-acceptance.mjs` | 主验收探针（两成员 + 原生对照；⚠️ 正被多路并发修改） |
| `probe/_final-acceptance-freeze-01.mjs` | 01:28:08 的**冻结快照**（用于定位并发改版的影响面） |
| `probe/_recheck-bridge-chain.mjs` | **只读**独立复核：从原始产物核对"桥接 → mailbox → 目标会话 → 目标回复"整条链 |
| `probe/verify-prompt-disclaimer-effect.mjs` | 受控实验（with / without / patched ×2，真实 CLI + MCP 桩） |
| `probe/_qodercli-prompt-fields.mjs` | CLI 日志字段语义测定（`text_length` / `truncated` / `previewChars`） |
| `probe/_dump-event-shapes.mjs`、`_dump-team-message-shape.mjs` | 会话事件形状实测（P1 的依据） |
| `probe/_final-acceptance-selftest.mjs` | 用**已有转录**压一遍解析（零额度） |
| `probe/out/team-final-acceptance.json` | 本路最近一次**可采信**运行（`XWQMU`） |
| `probe/out/prompt-disclaimer-effect.json` | 受控实验结果 |
| `probe/out/team-final-argv-*.jsonl` | OS 层真 argv 采样（`Get-CimInstance Win32_Process`） |
| `probe/out/regression-suite.json` | 回归（11/11） |

```powershell
# 前置：确认跑的是当前源码
(Invoke-WebRequest 'http://127.0.0.1:4200/harness-pilot/api/diag/loaded' -UseBasicParsing).Content  # anyStale 必须 false

node probe/_qodercli-prompt-fields.mjs                 # ① 字段语义测定（零额度）
node probe/verify-prompt-disclaimer-effect.mjs 2       # ② 受控实验（真实外部 CLI，短 prompt）
node probe/verify-team-final-acceptance.mjs            # ③ 主验收（**会真的调用外部 CLI**）
node probe/_recheck-bridge-chain.mjs <sessionId> <token>  # ④ 只读复核某一次桥接链
node probe/_regression-suite.mjs                       # ⑤ 回归
```

> ⚠️ 主验收会**真的调用外部 CLI**（每次约 8–14 轮）并消耗少量额度；它还会 `clear` 探针日志、重配目标、
> spawn 一个 Lead+3 成员 —— **同一时刻只应有一路在跑**（另一路已加运行锁 `probe/out/.team-final-acceptance.lock`）。
