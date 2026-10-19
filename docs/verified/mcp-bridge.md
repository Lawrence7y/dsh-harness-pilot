# 团队成员的工具通道：**最小可执行 MCP 桥接**（实现 + 实机验收）

> **本文档回答的问题**：怎样让**被改道的真实团队子会话**用**真实工具通道**调回 DSH 工具 ——
> 把「工具只写进 prompt」变成「外部 CLI 真的发起 MCP 调用」，并让原生 `team/message` 事件真的出现。
>
> **方法**：实现落在 `src/mcp-bridge.ts`（新建）+ `src/index.ts`（**只做加法**）；
> 契约全部从**运行版**读取（`app.asar` 抽出的 `D:\Project\_dsh-host-0.2.0-rc.2\node_modules\@deepseek-ai\`，
> 以及 `cordis_inspect_query(platform=host)` 查**运行中**的 loader/服务/事件面）；
> 验收分三份探针，其中实机那份**真的调用外部 CLI**。
>
> **标签**：**确证** = 有 file:line 或可复核产物；**推断** = 写清依据；**未验证** = 没做，明确说。
> **不给百分比。**

---

## 0. 一句话结论

**桥接已实现并在实机上跑通。** 最强的一条证据是一条可以机器校验的**因果链**：

| # | 证据（各自独立、可复核） | 值 |
|---|---|---|
| 1 | 插件自己的桥接事件日志：CLI 发起的 `tools/call` | `seq=23`、`tool=send_message`、`callId=8f46a0cf-fce5-46ea-b8bf-b98eb58b7b31`（`args.fields.message=string(11)`） |
| 2 | 同一次调用的结果 | `seq=25`、`isError=false`、`contentBlocks=1`、`ms=79`、**`resultIdTokens=["team-message-bf59a7c3-d84c-4a08-a4df-3937c97e7802"]`** |
| 3 | 宿主**原生**持久化事件（Lead 会话日志） | `team/message/queued`、`senderId=93ab0090-c8f7-4f73-a0fe-89dc1b4f19b1`（= 该成员子会话）、**`messageId=team-message-bf59a7c3-d84c-4a08-a4df-3937c97e7802`** |

第 2 条的 `resultIdTokens` 是桥接**从工具返回值里摘出来的**消息 id，第 3 条是宿主 mailbox 服务
**自己生成并落盘**的消息 id —— **两者是同一个 id**。而成员在这一轮里的产出**只有文本**
（适配器的 `block-start` 只产 `text`，`src/llm-adapter.ts:302`、`:332-344`），
所以它**只能**是从工具返回值里读到的。

⇒ **外部 CLI 自己发起了 MCP 调用，随后原生 `team/message` 事件出现**（上级指定判据，成立）。

产物：`probe/out/mcp-bridge-live.json`（实机 26/26 PASS）、
`probe/out/mcp-bridge-protocol.json`（离线 45/45 PASS）、
`probe/out/mcp-bridge-scope-live.json`（实机作用域 4/4 PASS）、
`probe/out/mcp-cli-direct-{base,allowed}.json`（定位为什么第一版 prompt 没被调用）。

---

## 1. 它补的是哪一个洞（**确证**）

| 事实 | 位置 |
|---|---|
| 适配器只产 `text` 块（`blockType` 唯一的取值就是 `'text'`），**从不产 `tool-call`** | `src/llm-adapter.ts:302`、`:332-344` |
| 工具执行由「assembled assistant 消息里**存在 `tool-call` 块**」触发，与 `finish.reason` 无关 | 运行版 `dsh-agent-loop/lib/index.js:1151-1155` |
| 因此改道轮次里 `executeToolCalls` **永不执行**，DSH 工具 schema 只是被渲染进 prompt 文本 | `src/llm-adapter.ts:276-278`；实测 `request/header.tools` = 45 |

⇒ 2.2-④ FAIL（改道成员 0 tool-call 块、0 工具事件、0 条自己发出的 `team/message`）
是**这条路由**的性质，**不是**团队机制的性质（`docs/verified/team-member-acceptance.md` §4④）。

**本模块不去解析 CLI 的自由文本**（那是被明令禁止的「解析任意文本冒充 tool-call」）。
它走的是**外部 CLI 原生支持的 MCP 客户端**那条路：把桥接的工具作为 **MCP server 的 tools**
交给 CLI，由 **CLI 自己**发起 `tools/call`。

---

## 2. 用到的**运行版**契约（逐条指到出处）

| # | 契约 | 出处 |
|---|---|---|
| C1 | `ctx.tools.execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>`；管线 = "pre-policy, guards, around-dispatch, post-policy, definition-owned content finalization, and final notification" | `cordis_inspect_query(host, Service, listService{service:"tools"})`（运行中实例） |
| C2 | `ctx.tools.get(name, scope?): ToolDefinition \| undefined` —— "the definition the scope resolves"；**作用域内注册 shadow 全局**（"Scoped tools shadow globals"） | 同上（`register` / `get` 描述） |
| C3 | `ctx.tools.schemas(scope?): ToolSchema[]` —— 只回**该作用域可见**的、model-facing 的 schema | 同上 |
| C4 | `ToolExecutionInput = { callId, rootCallId?, name, schema?, arguments, agent?, parent?, signal }` | 同上（`referencedTypes`） |
| C5 | `ctx.agents.get(id: SessionId): Agent \| undefined` —— "Look up a live agent." | `cordis_inspect_query(host, Service, listService{service:"agents"})` |
| C6 | `tools/execute` 是 **waterfall**：`(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>`；**scope-filtered dispatch**（agent-scoped listener 只收该 agent 的调用） | `cordis_inspect_query(host, Event, listEvents{event:"tools/execute"})` |
| C7 | 工具 schema 是**已经编译成 JSON Schema** 的（`parameters` 里已有 `properties` / `required`）—— MCP 的 `inputSchema` 可以直接用它 | `dsh-tools/lib/index.js:609`（property-map → `{properties:{}}` + `required`） |
| C8 | `team/message/queued` 写在 **Lead 的会话日志**里，形状含 `message.senderId` / `message.id` | `dsh-experimental-agent-team/lib/types/mailbox.js:102-129`；实测产物见 §5 |
| C9 | CLI 侧 `--mcp-config <config>` = "Load MCP servers from JSON file(s) or inline JSON"；server `type` 取值 `stdio / sse / http / ws / sse-ide`（`streamable-http` 归一化成 `http`） | **CLI 自己的 `--help`**（`C:\Users\Administrator\.qodersec\bin\qoderclicn.exe --help`，本机 1.1.41）＋ 该二进制内 `LdB=new Set(["stdio","sse","http","ws","streamable-http","sdk"])`、`cdB={"streamable-http":"http"}` |
| C10 | CLI 把 MCP 工具名拼成 `mcp__<server>__<tool>`（`F9(A){return A.startsWith("mcp__")}`，server 段会被 `[^a-zA-Z0-9_-]→_` 清洗） | 同一二进制的字符串取证 |
| C11 | ACP `session/new` 的 `mcpServers` 形状（**zod 校验**）：`{type:'http', name, url, headers:[{name,value}]}`；非法项被 `vecSkipError` **跳过**（不是整条请求失败） | `@agentclientprotocol/sdk/dist/schema/zod.gen.js:2347-2360`、`:2405-2416`、`:2422-2425` |
| C12 | `DispatchSpec.extraArgs` 已经存在，headless 通道把它拼进 argv | `src/types.ts:169-170`；`src/transports/headless.ts:32-41` |
| C13 | 取消链：`interrupt_agent` → `subagents.interrupt` → `Agent.cancel`；headless 通道在 abort 时 `killTree(pid)` 并 `finish('aborted')` | `docs/verified/team-member-acceptance.md` E15；`src/transports/headless.ts:102-110` |

> ⚠️ **不许从源码 checkout 推断宿主行为**。本轮所有宿主事实都取自**运行版**
> （asar 抽出的模块树 / `cordis_inspect_*` 查运行中实例），
> 这条纪律的由来见 `docs/verified/team-member-acceptance.md` §2.1。

---

## 3. 实现（`src/mcp-bridge.ts` + `src/index.ts` 的加法）

### 3.1 一个子会话 = 一个**短寿命 · loopback 限定 · 逐入口鉴权**的 MCP 入口

```
外部 CLI ──HTTP(JSON-RPC)──▶ http://127.0.0.1:<临时端口>/mcp/<12位随机路径段>
                              Authorization: Bearer <32 字节随机令牌>
                                        │
                              桥接入口（TTL ≤ 10 分钟，默认 3 分钟）
                                        │  绑定的**活 Agent**（ctx.agents.get(sessionId)）
                                        ▼
                       ctx.tools.get(name, agent)   ← 作用域可见性判定（拒绝的第二次机会）
                                        ▼
                       ctx.tools.execute({ callId, name, arguments, agent, signal })
                                        ▼
                    原生管线：tools/pre-execute → guards → tools/execute → tools/post-execute
```

- **每个入口一个独立的 `http.Server`**，`listen(0, '127.0.0.1')`（不是 0.0.0.0）——
  端口只在**该会话这一轮**存在；关闭即删 `--mcp-config` 文件并 `closeAllConnections()`。
- **入口 = 一次性 32 字节令牌 + 一次性随机路径段 + 绑定的子会话 + 绑定的活 Agent + TTL**。
  令牌与入口**一一对应**：拿 A 的令牌打 B 的入口是 401（实机验证，§5 L9c）。
- **先鉴权、再看方法**：连 `DELETE`（关入口）都要凭据 —— 没有任何「无凭据可改状态」的路径。
- **loopback 逐条复核**：即便 socket 已经只绑 127.0.0.1，仍在每个请求上校验
  `socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}`，非 loopback 回 403 并留痕。
- **令牌不进日志**：日志里只有 `tokenFingerprint`（sha256 前 8 位）。令牌只出现在两处：
  进程内存、以及**每次 spawn 独立**的 CLI 子进程环境（`MCP_BRIDGE_HANDOFF*`）。

  > ⚠️ **2026-10-13 安全修复（见 §11）**：这一条**原先是**「进程内存 + `0600` 的 `--mcp-config` 文件」。
  > `mode: 0o600` 在 **Windows 上不是强制 ACL** ⇒ 那不是有效保护。现在**落盘的配置文件里没有任何凭据**：
  > 凭据只经子进程环境交给本插件的 stdio 代理，代理再转发到本机入口。

### 3.2 作用域：客户端**连「用谁的权限」都表达不出来**

桥接入口的参数表里**没有** scope / agent / sessionId —— 唯一的 caller 是**入口自己绑定的那个活 Agent**
（`ctx.agents.get(sessionId)`，C5）。所以「伪造 caller」在协议层就没有表达方式。在此之上还有两道闸：

1. **白名单**：只桥接首期最小集合 6 个工具（上级指定）——
   团队 `list_agents` / `send_message` / `wait_agent`，harness 任务
   `harness_task_start` / `harness_task_status` / `harness_task_cancel`。
   集合外的名字 → JSON-RPC `-32602` + `data.reason="BRIDGE_TOOL_NOT_ALLOWED"`，**且不落到 `tools.execute`**。
2. **作用域可见性**：`ctx.tools.get(name, boundAgent)` 返回 `undefined` ⇒
   `-32602` + `data.reason="BRIDGE_TOOL_NOT_IN_MEMBER_SCOPE"`，同样**不执行**。
   （`tools.get` / `tools.schemas` 在运行版缺失或抛错时**一律 fail closed**，不猜。）

`tools/list` 也遵守第 2 条：**只列该作用域里真的可见的**桥接工具
（实测：团队成员的可见面里 6 个都在；某个子代理会话的作用域里少 `wait_agent` ⇒ 只列 5 个）。

### 3.3 权限与取消语义**继承原生**

- **权限**：执行走的是 `ctx.tools.execute`，也就是**完整的原生管线**（C1），因此
  `tools/pre-execute` 的策略闸、`ctx.tools.guard` 的单调守卫、`tools/post-execute` 都会经过。
  桥接**自己不做**权限判定，也**不**绕过任何一层。
- **取消**：入口关闭会 `AbortController.abort()`，在飞工具调用的 `signal` 立刻 aborted
  （离线探针 P6a 正向验证：`before=false → after=true`）。调用链上：
  取消成员 → headless 通道 `killTree` + `finish('aborted')`（C13）→ 本轮派发 settle →
  `finally` 关入口 → 端口停监听、配置文件删除（实机 L12a/L12b/L12c）。
- **超时**：入口 TTL 到期自动走同一条关闭路径（离线 P7a/P7b）。

### 3.4 工具事件：**原生管线事件真的会响**（附「会话级 `tool/call` 不写」的确切理由）

本模块在 `tools/execute`（C6）上装了一个观察器，把「这一次调用真的过了宿主工具管线」
记成独立证据（`event: "pipeline.execute"`，含**原生管线报的** `agentId`）。
纪律：**任何出口都 `return next()`** —— 观察器绝不吞管线（离线 P9a 用 `Symbol` 返回值正向验证）。

**它不写会话级 `tool/call` / `tool/result`**，而这是刻意的：

- 这两个事件**只**由 `dsh-agent-loop` 的 `executeToolCalls` append
  （运行版 `dsh-agent-loop/lib/index.js:682`（`tool/call`）、`:697`（`tool/result`）；
  结果消息形状 = `{role:'tool', source:{kind:'tool',callId}, toolCallId, content, isError}`
  —— `dsh-llm/lib/types/message.js:92-100`）。
- `ctx.tools.execute` 这条路径**不** append 它们（`dsh-tools` 全模块零处 `tool/call`）。
- 成员是**进程内 DSH Agent**，它的下一轮请求**由会话日志推导**。补写一条没有对应
  assistant `tool-call` 块的孤立 `tool` 消息 = 往那段历史里塞一条不该存在的消息。
  `SessionEvent.ignorable` 也救不了：只有**未知**类型 + `ignorable:true` 才会被表面投影丢弃
  （`dsh-session/lib/index.js:298`），`tool/call` / `tool/result` 都是已知类型。
- ⇒ **在拿到独立验证（例如一个只读投影的端到端实验）之前不许实现它**，否则就是把未验证的推断写成能力。
  这条限制以常量形式写在代码里：`MCP_BRIDGE_SESSION_EVENT_NOTE`。

**真正会响的原生事件**：`tools/pre-execute` / `tools/execute` / `tools/post-execute`（管线），
以及工具自身的原生持久化副作用 —— `send_message` → Lead 日志的
`team/message/queued`（C8；实机 L7，带 mailbox 生成的消息 id）。

### 3.5 注入：headless `--mcp-config`（**已实现**）／ ACP `mcpServers`（**已实现，见 §10**）

> **2026-10-14 更新**：ACP 那条通道**已经接上并验收**（集成记录见 **§10**）。
> §7 的补丁文本**已经应用**，但其中两处**形状描述是错的**（`headers` / `args`+`env` 在 schema 里
> 是**必填**；stdio 分支**没有 `type` 判别字段**）——已在 §7 就地更正，逐字依据见 §10.2。
>
> ⚠️ **2026-10-13 安全修复（见 §11）**：下面这段 argv 里现在多了 `--strict-mcp-config`，
> 且 `--mcp-config` 文件里**不再有令牌**（改为不含凭据的 stdio 代理配置 + 子进程环境手递凭据）。

**已实现（不需要改 `src/transports/**`）**：`src/index.ts` 的 `registerPilotCli({ dispatch })`
闭包在每次改道派发前 `await mcpBridge.openForTurn({ sessionId, command, origin:'pilot-cli-redirect' })`，
把句柄给出的 `extraArgs` 放进 `DispatchSpec`，把 `handoffEnv` 放进 `DispatchSpec.extraEnv`：

```ts
extraArgs  = ['--mcp-config', '<pluginHome>/mcp/configs/cfg-<id>.json',
              '--strict-mcp-config',
              '--allowed-tools', 'mcp__dsh_bridge__send_message']
extraEnv   = { DSH_BRIDGE_HANDOFF: 'http://127.0.0.1:<port>/mcp/<id>',   // 令牌**不经** argv / 文件
               DSH_BRIDGE_HANDOFF_PAT: '<32 字节一次性令牌>',
               DSH_BRIDGE_PROXY_LOG: '<代理事件 JSONL>',
               ELECTRON_RUN_AS_NODE: '1' }
```

`DispatchSpec.extraArgs` 本来就是既有字段（C12），headless 通道会把它拼进 argv；
`extraEnv` 是 §11 修复**新增**的可选字段（未设时行为逐字不变）。
实测注入的 argv：
`<qoderclicn.exe> --config-dir <acct-a> -p --mcp-config <path> --strict-mcp-config --allowed-tools mcp__dsh_bridge__send_message <prompt>`。

`--allowed-tools` 不是装饰：**没有它，CLI 侧会弹权限确认，`-p` 模式下这次工具调用被拒**
（`probe/out/mcp-cli-direct-base.json`：CLI 自述
"The tool call was blocked by a permission prompt asking for approval to use the
`dsh_bridge/send_message` MCP tool"）。加上它之后同一条路直接成功
（`mcp-cli-direct-allowed.json`：`toolCalls=1`，CLI 原样回显了 stub 的返回值）。
它是**最小授权**：只预授权被桥接的那一个工具名，CLI 自己的其它工具一概不放行。

**⚠️ 但它是「按工具名」的**：被预授权的那个名字之外的桥接工具（例如 `list_agents`），
CLI 侧仍会弹权限确认并在 `-p` 下失败（§11.5 实测）。所以「哪个桥接工具这一轮要能被调用」
必须与 `--allowed-tools` 对齐 —— 这是**调用方**（`src/index.ts`）的选择，不是桥接模块的。

---

## 4. 环境与版本（必须一起读）

| 项 | 值 |
|---|---|
| 宿主 | `D:\DeepSeek\resources\app.asar`（rc.2 打包运行版），WebUI `http://127.0.0.1:4200` |
| 插件 | `D:\Project\dsh-harness-pilot`（经 junction 挂到 profile 的 `@dsh-external/dsh-harness-pilot`） |
| 被改道成员的目标 | `qoder-cn-acct-a`（`C:\Users\Administrator\.qodersec\bin\qoderclicn.exe`，`--config-dir …\harness-accounts\qoder-cn-a`，1.1.41） |
| 桥接事件日志 | `C:\Users\Administrator\.dsh\plugins\harness-pilot\mcp\bridge-events.jsonl` |
| `--mcp-config` 目录 | `C:\Users\Administrator\.dsh\plugins\harness-pilot\mcp\configs\`（**运行间必须为空**） |
| API | `GET /harness-pilot/api/mcp-bridge`（入口脱敏视图 + 事件）、`POST …/mcp-bridge/open`、`POST …/mcp-bridge/close` |

`GET /harness-pilot/api/diag/loaded` 在三次实机测量时均为 `anyStale=false`
（`index.js` `10458f47e82f`、`sessions.js` `9a9153574af9`、`llm-adapter.js` `b961fb5d6adc`）。

> ⚠️ `diag/loaded` **不跟踪** `mcp-bridge.js`（它只列 index/tasks/sessions/tools/llm-adapter 五个模块）。
> 因此「`mcp-bridge.js` 的新版真被加载」不是靠这个接口断言的，而是靠**新字段真的出现在事件日志里**
> （`resultIdTokens` 是最后一轮才加的，它在实机 L7c 里被读到 ⇒ 那一版确实在跑）。

---

## 5. 验收（三份探针，判据全是行为）

### 5.1 离线协议/鉴权/作用域/取消 —— **45/45 PASS**（零额度）

`node probe/verify-mcp-bridge-protocol.mjs` → `probe/out/mcp-bridge-protocol.json`

直接 import **构建产物** `lib/mcp-bridge.js`（宿主跑的就是这一份），配假 ctx（假 `tools` / 假 `agents`），
用**真实 HTTP JSON-RPC** 打进去。要点：

| 项 | 结果 |
|---|---|
| P1 只在「CLI 有已验证注入 + 会话有活 Agent」时才开 | 两种情况都返回 `undefined`，都留 `bridge.skip`，**一个端口都没开** |
| P2 loopback | 入口 URL `http://127.0.0.1:<port>/…`；从本机**非 loopback** 网卡地址连 → `ECONNREFUSED` |
| P3 鉴权 | 无令牌 401 / 错令牌 401 / **B 的令牌打 A 的入口 401** / 无令牌 `DELETE` 401 / 未知路径 404，四种拒绝全部留痕 |
| P4 MCP 协议 | `initialize` 回客户端请求的版本（`2025-11-25`）、不认识的版本回落 `2025-06-18`、`notifications/initialized` → 202、`tools/list` 只列可见的、`tools/call` 真执行 |
| P4g | **执行时的 scope 就是入口绑定的那个 Agent**（假 `tools.execute` 记录到的就是它） |
| P5 隔离 | 白名单外 → `BRIDGE_TOOL_NOT_ALLOWED`；作用域不可见 → `BRIDGE_TOOL_NOT_IN_MEMBER_SCOPE`；**两者都断言「没有落到 `tools.execute`」**；同一工具名在 lead 入口上可见且执行于 lead 作用域（说明 P5c 拒的是作用域） |
| P6 取消 | 入口一关，在飞工具调用的 `signal` 立刻 aborted；端口 `ECONNREFUSED`；配置文件被删 |
| P7 短寿命 | TTL 下限钳制 5000 ms（更短的请求被夹住并如实记账，不静默忽略）；到点自动关 |
| P8 令牌卫生 | 日志里 **0** 个令牌本体，只有 8 位指纹 |
| P9 观察器 | 永远 `return next()`；只对「有开入口的 agent」记账；记的是原生管线报的 `agentId` |

### 5.2 实机（**真的调用外部 CLI**）—— **26/26 PASS**

`node probe/verify-mcp-bridge-live.mjs` → `probe/out/mcp-bridge-live.json`
（成员 `93ab0090-c8f7-4f73-a0fe-89dc1b4f19b1`，Lead `session-hp-teamlead-721ffb27-…`，令牌 `HPMCP-VDS64`）

| 判据 | 证据 |
|---|---|
| L1/L1b 为本轮开了入口、只在 127.0.0.1 | `bridgeId=4f61bba2e440`、`port=57054`、`bindAddress=127.0.0.1`、`note.target=qoder-cn-acct-a` |
| L2 **外部 CLI 真的按 MCP 协议连上来了** | `mcp.http{rpcMethod:"initialize", remoteAddress:"127.0.0.1"}` |
| L3 CLI 走了 `tools/list` | `count=6`、`missingInScope=[]` |
| L4 **CLI 真的发起了 `tools/call`** | `tool=send_message`、`callId=8f46a0cf-…`、`args.fields={message:"string(11)", target:"string(4)"}` |
| L5 结果 | `isError=false`、`contentBlocks=1`、`ms=79` |
| L6 原生管线 | `pipeline.execute{agentId:93ab0090-…, tool:harness_task_status}`（同一 bridgeIds 集合） |
| L7 **原生 `team/message` 出现** | Lead 日志 `team/message/queued`、`senderId=93ab0090-…`、`messageId=team-message-bf59a7c3-…` |
| L7b 内容含本轮唯一令牌 | `inContent=true`、`chars=253` |
| L7c **因果闭环** | `toolResultIds == [journalMessageId]`（同一个 id） |
| L8 路由 | 宿主转录 `request/header.config = {provider:"pilot-cli", model:"qoder-cn-acct-a"}` |
| L9 实机鉴权 | 无令牌 401 / 错令牌 401 / 换入口令牌 401 / 各自令牌 200 / 日志无令牌本体 |
| L10 实机白名单 | `spawn_teammate`（Lead 专属）→ `-32602 BRIDGE_TOOL_NOT_ALLOWED`，`mcp.tool/call` 计数不变 |
| L11 实机作用域 | 经入口调 `harness_task_status`，原生管线报的 `agentId` = 入口绑定的成员会话 |
| L12 取消 ⇒ 入口同步失效 | 中断时 `previousStatus="running"`；`bridge.close{reason:"turn-settled"}`；端口 `ECONNREFUSED`；配置文件已删 |
| L13/L14 收尾 | 本次运行开的入口一个不剩；配置目录无残留 |

### 5.3 实机作用域隔离（补上「非成员作用域」那一侧）—— **4/4 PASS**（零额度、零副作用）

`node probe/verify-mcp-bridge-scope-live.mjs` → `probe/out/mcp-bridge-scope-live.json`

做法：从 `~/.dsh/sessions/**` 取最近活跃的会话 id 当候选，逐个开入口 →
`tools/list` 看**哪个桥接工具名在这个作用域里缺席** → 对缺席的那个名字打一次 `tools/call`
（**必然被拒**，所以不会真的执行任何东西）。

- S2 实测：`b7458710-5587-4213-8260-790ae098cddd` 的可见面是 5 个（少 `wait_agent`）⇒
  打 `wait_agent` 得到 `-32602` + `BRIDGE_TOOL_NOT_IN_MEMBER_SCOPE`（`boundSessionId` 就是该会话）。
- S3 对照：另一个会话 6 个都在 ⇒ 拒的是**作用域**，不是「工具名不存在」。

> ⚠️ **顺带确证的一条容易踩坑的事实**：`send_message` 这个名字**同时**被
> `dsh-tool-subagent-control` 作为**全局**工具注册（全树 grep `"send_message"`：该包 2 处）。
> 团队成员作用域里，团队那份**作用域内**注册会 **shadow** 全局那份（C2 的 "Scoped tools shadow globals"），
> 所以成员的 `send_message` 落到**团队**工具上 —— L7 那条 `team/message/queued` 就是这条的证据。
> 本探针因此**不**拿 `send_message` 当「缺席名」（它在任何作用域里都在）。

### 5.4 **外部 CLI 自己写的日志**（第五条、也是最独立的一条证据链）

外部 CLI 进程自己往
`C:\Users\Administrator\.dsh\harness-accounts\qoder-cn-a\logs\runs\<run>\{manifest.json, qodercli.log}`
写运行记录。这两份**不是本插件的自报**，而是 CLI 侧的原始产物：

**`manifest.json`（CLI 自己记的 argv，`cli_version=1.1.41`）**

| run | argv（CLI 自己记的） |
|---|---|
| `2026-10-14T00-00-45-926+08-00-yqw0ab-p48084`（实机 take 3） | `…qoderclicn.exe --config-dir …\qoder-cn-a -p --mcp-config C:\…\configs\cfg-f5733cf68d55.json --allowed-tools mcp__dsh_bridge__send_message` |
| `2026-10-14T00-02-52-467+08-00-vlfivv-p30892`（实机 take 4） | `… -p --mcp-config C:\…\configs\cfg-4f61bba2e440.json --allowed-tools mcp__dsh_bridge__send_message` |

`cfg-f5733cf68d55` / `cfg-4f61bba2e440` **正是那两轮桥接入口的 id**（`probe/out/mcp-bridge-live.json` 的
`opened.id`）⇒ **CLI 进程确实被启动带上了我们的 MCP 配置与最小授权**。

**`qodercli.log`（CLI 自己的日志，51958 字节）** —— 它引用的是**我方服务端发出的字节**：

```
Registering notification handlers for server 'dsh_bridge'. Capabilities: { tools: { listChanged: false } }
Server 'dsh_bridge' has tools but did not declare 'listChanged' capability. Listening anyway for robustness...
[MCP] Server 'dsh_bridge' provided instructions (250 chars):
      "DSH tool bridge for session 93ab0090-c8f7-4f73-a0fe-89dc1b4f19b1 (short-lived). Every tool listed he..."
[MCP InstructionsDelta] Delta emitted — added: [dsh_bridge], removed: [], announced after update: [dsh_bridge]
[mcp-check-sync] checker installed for mcp__dsh_bridge__list_agents
[mcp-check-sync] checker installed for mcp__dsh_bridge__send_message
[mcp-check-sync] checker installed for mcp__dsh_bridge__wait_agent
[mcp-check-sync] checker installed for mcp__dsh_bridge__harness_task_start
[mcp-check-sync] checker installed for mcp__dsh_bridge__harness_task_status
[mcp-check-sync] checker installed for mcp__dsh_bridge__harness_task_cancel
tool.requested            tool_name="mcp__dsh_bridge__send_message"  (id=call_f70e5f8271234347b95740dc)
[AgentLoop] Streaming: enqueued tool_use block "mcp__dsh_bridge__send_message"
[permission-check] options tool=mcp__dsh_bridge__send_message callId=call_f70e5f8271234347b95740dc agentId=- override=undefined
[permission-check] mcp mcp__dsh_bridge__send_message mode=default → allow point=mcp.rule.allow
permission.resolved       tool_name="mcp__dsh_bridge__send_message" source="policy" allowed=true
[STE] Tool "mcp__dsh_bridge__send_message": newMessages=0, contextModifier=false, endsTurn=false, resultMessages=1 (types: tool_result)
tool.execution.finished   tool_name="mcp__dsh_bridge__send_message"
loop.iteration.finished   request_index=1 reason="continue_after_tool_results"
```

逐条对上：

- `Capabilities: { tools: { listChanged: false } }` = 本模块 `initialize` 回的那个对象（逐字）；
- `instructions (250 chars)` 且内容里带着 **`session 93ab0090-…`**（该成员子会话 id）= 本模块
  动态拼的那段 `instructions`；**这证明 CLI 收到的是这一轮那个入口的字节**；
- 六个 `mcp__dsh_bridge__<tool>` 的 checker 全装上 = 与桥接 `mcp.tools/list` 的 6 个逐字一致；
- `permission-check … → allow point=mcp.rule.allow` = `--allowed-tools mcp__dsh_bridge__send_message`
  **确实按预期只是「给这一个工具放行」**（不是 `bypass_permissions`，CLI 侧其余工具仍走默认权限）；
- `tool.requested` / `tool.execution.finished` / `loop.iteration.finished reason="continue_after_tool_results"`
  = **CLI 自己的循环确实为这次工具调用暂停并等到了结果**。

> 这一条比任何「配置里注入了 mcpServers」的说法都硬：它是**对端进程自己**记下来的、引用**我方服务端字节**的记录。

### 5.5 定位过程（为什么第一版 prompt 没被调用）——**如实留档**
第一版实机运行：CLI 连上了、`tools/list` 也回来了（6 个），但 **0 次 `tools/call`**。
没有把它写成「上游限制」，而是做了两个更便宜的实验：

1. **直接驱动 CLI**（`probe/verify-mcp-cli-direct.mjs`，不经成员路由，桩工具）：
   - `base`（只有 `--mcp-config`）：CLI 侧模型**想调**，但被**权限确认**挡住 ——
     CLI 原话："The tool call was blocked by a permission prompt asking for approval to use
     the `dsh_bridge/send_message` MCP tool."（`toolCalls=0`）
   - `allowed`（加 `--allowed-tools mcp__dsh_bridge__send_message`）：**`toolCalls=1`**，
     CLI 原样回显了桩工具的返回值。⇒ **机制没问题，缺的是最小授权**。
2. **成员那一轮的 prompt 措辞**（读宿主转录）：模型把第一版 prompt（"环境自检（请直接执行，不要写代码）"）
   当成了 **prompt injection** 并拒绝执行。改成一件普通任务（"Please deliver this one-line status
   to the team lead: …"）后，同一套 argv 立刻成功。
   ⇒ **这一条是 prompt 措辞的性质，不是桥接的性质** —— 必须写清楚，否则会被误读成「桥接不稳」。

---

## 6. 回归与 profile

- `node probe/_regression-suite.mjs` → **10/10 PASS**（`probe/out/regression-suite.json`）。
  含 `verify-federation-{registry,providers,accounts,identity}`、`verify-ledger-prune`、
  `verify-quota-pool`、`verify-ui-smoke`、`verify-llm-adapter-unit`、
  `verify-team-observer-waterfall`、`verify-headless-exit-honesty`。
- profile **未被改写**：
  `cordis.yml = 33B0735DD8756CAF6D5ECB55ED482FB485AB950EA86794002FD08959BC2ACF42`、
  `cordis.patch.yml = 2D0C57810C6083EBEB78F3D750481B725CBD75B3FB15BAE84CCA954A4C688F6E`（与预期一致）。
- client 三个工件**同哈希**（构建成功时的收尾步骤已跑）：
  `client/client.js = client.js = lib/client.js = 8C35D867649AC4D28508032716A19C30DB0D335817E6ACEDB7C4E41AC5FA572A`。
  （更早一次构建因**别人的** `src/processpool.ts` 类型错误退出非 0，那一轮的拷贝步骤没跑；
  该错误随后由对方修好，重跑后三件一致。**没有**回滚任何人的改动。）

---

## 7. 交给 Lead 串行集成的 `src/transports/**` 补丁（**精确到锚点**）

> **状态（2026-10-14）**：**已应用**（集成与验收记录见 §10）。两处**修正**（补丁原文写错了形状）：
>
> 1. **`headers` 是必填**：`zMcpServerHttp`/`zMcpServerSse` 是 `{name, url, headers: z.array(zHttpHeader)}`
>    （`zod.gen.js:2355-2369`；`schema/schema.json` 的 `required:["name","url","headers"]`）**没有 `.optional()`**。
> 2. **stdio 分支没有 `type`**：`zMcpServerStdio`（`:2390-2396`）是 `{name, command, args, env}`，
>    在 `zMcpServer` 里**裸用**（`:2415`），没有 `.and({type: literal('stdio')})`；
>    `schema.json` 的 stdio 变体也没有 `type` 属性。且 `args` / `env` 同样是**必填**。
>
> ⇒ 所以类型上可以把 `headers`/`args`/`env` 标成可选（**调用方可以不给**），但**上线对象必须补齐**
> （`src/transports/acp.ts` 会补空数组、且 stdio **不带** `type`）。这**不是**风格问题：
> `vecSkipError`（`:2425`）会把形状错的条目**静默丢掉**，而整条 `session/new` 照常成功。

下面这段**我没有直接改**（`src/transports/**` 另有子代理拥有写入权），
它是「让 **ACP 通道**也能注入 MCP」所需的**全部**改动。headless 通道**不需要**改（§3.5 已生效）。

### 补丁 1 —— `src/types.ts`：`DispatchSpec` 增加一个可选字段

锚点：`export interface DispatchSpec {`（`src/types.ts:158`）里，紧跟
`readonly extraArgs?: readonly string[]`（`:169-170`）之后插入：

```ts
  /**
   * **ACP 通道**的 `session/new` 里要带的 MCP server（只有 `acp` 用得上）。
   *
   * 形状**必须**逐字匹配 ACP SDK 的 zod schema（`@agentclientprotocol/sdk/dist/schema/zod.gen.js:2347-2416`）：
   * `{type:'http'|'sse', name, url, headers:[{name,value}]}` / `{type:'stdio', name, command, args, env:[{name,value}]}`。
   * ⚠️ 该 zod 用的是 `vecSkipError`（`:2425`）—— **形状错的条目会被静默跳过**，所以字段名不许改。
   * 令牌等敏感值**只**能从这里流到 CLI，不许进 `facts` / `diagnostic` / 任何日志。
   */
  readonly mcpServers?: readonly (
    | { readonly type: 'http'; readonly name: string; readonly url: string; readonly headers?: readonly { readonly name: string; readonly value: string }[] }
    | { readonly type: 'sse'; readonly name: string; readonly url: string; readonly headers?: readonly { readonly name: string; readonly value: string }[] }
    | { readonly type: 'stdio'; readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: readonly { readonly name: string; readonly value: string }[] }
  )[]
```

### 补丁 2 —— `src/transports/acp.ts`：把 `mcpServers: []` 换成真实列表

锚点：`src/transports/acp.ts:346`

```ts
        const session = await context.buildSession({ cwd: spec.cwd, mcpServers: [] }).start()
```

改成：

```ts
        // MCP 注入：形状照 ACP SDK 的 zod schema（name/url/headers 三段；stdio 用 command/args/env）。
        // 逐条复制成**新对象**，不把调用方的对象引用交给 SDK。
        const mcpServers = (spec.mcpServers ?? []).map((server) => server.type === 'stdio'
          ? {
              type: 'stdio' as const,
              name: server.name,
              command: server.command,
              args: [...(server.args ?? [])],
              env: (server.env ?? []).map((row) => ({ name: row.name, value: row.value })),
            }
          : {
              type: server.type,
              name: server.name,
              url: server.url,
              headers: (server.headers ?? []).map((row) => ({ name: row.name, value: row.value })),
            })
        const session = await context.buildSession({ cwd: spec.cwd, mcpServers }).start()
```

### 补丁 3（可选，**建议**）—— `src/transports/acp.ts` 的 facts 里如实报「注入了几个 MCP server」

锚点：`src/transports/acp.ts:188-206` 的 `facts()` 对象里加一行（**只记个数与名字，不记 url / 令牌**）：

```ts
      ...(spec.mcpServers === undefined || spec.mcpServers.length === 0
        ? {}
        : { mcpServers: spec.mcpServers.map((server) => `${server.type}:${server.name}`).join(',') }),
```

### 接线（**2026-10-14 更新：接口已由桥接自己提供，接线仍待 Lead 写进 `src/index.ts`**）

*现成可用的钩子*：`src/index.ts` 里 `registerPilotCli({ dispatch })` 的闭包里已经有
`mcpBridge.openForTurn(...)` 的完整用法（含 `finally` 关闭）。**ACP 路径的接法（已实现的接口）**：

```ts
const bridge = await mcpBridge.openForTurn({
  sessionId,                       // 该成员的子会话（必须有活 Agent）
  command: target.command,
  channel: 'acp-mcp-servers',      // ← 新增：这条通道的注入向量是 ACP 协议字段，不是 argv
  origin: 'pilot-cli-redirect',
})
// …
const spec: DispatchSpec = {
  …,
  extraArgs: bridge?.extraArgs,     // headless 用（ACP 通道下为空数组）
  mcpServers: bridge?.mcpServers,   // ← ACP 用（令牌已由桥接模块拼进 Authorization header）
}
```

**令牌不经过调用方**：`handle.mcpServers` 返回的是**已经拼好**的条目（`{type:'http',name,url,headers}`），
桥接句柄**没有**任何「把令牌取出来」的方法；`view()` / `list()` / 事件日志里只有 8 位指纹。
这条接口变更**没有**给句柄加 `mcpServerDescriptor()` 之类的取令牌方法（见 §10.1）。
`channel` 缺省 = `argv-mcp-config`，**行为与补丁前逐字一致**（未验证 `--mcp-config` 的 CLI 仍然一个端口都不开）。

---

## 8. 诚实分级

### 8.1 确证（本轮直接实测，或有 file:line 依据）

| # | 结论 | 证据 |
|---|---|---|
| M1 | **外部 CLI 真的发起了 MCP 的 `tools/call`**（成员路由上，工具 `send_message`） | `probe/out/mcp-bridge-live.json` 的 `saw.toolCall`（`mcp.tool/call`，`callId=8f46a0cf-…`） |
| M2 | **随后出现原生 `team/message` 事件**，且与工具返回值是**同一个消息 id** | 同上 `saw.leadTeamMessage` + `saw.toolResult.resultIdTokens` + `causalLoop` |
| M3 | 入口只在 `127.0.0.1` 上监听；非 loopback 网卡地址连不上 | L1b；离线 P2a（`ECONNREFUSED`） |
| M4 | 入口**逐入口鉴权**：无/错/换入口令牌一律 401；`DELETE` 也要令牌；两者都在实机与离线各验一遍 | 离线 P3a–P3d；实机 L9a–L9d |
| M5 | **桥接不暴露全量工具面**：白名单外 → 响亮拒绝且不执行 | 离线 P5a/P5b；实机 L10a/L10b |
| M6 | **作用域隔离在实机上成立**：某个作用域里缺席的桥接工具名经桥接打进来被拒 | `probe/out/mcp-bridge-scope-live.json` S2 |
| M7 | 执行走原生管线（`tools/execute` 真的响），观察器永不吞流 | 离线 P9a–P9d；实机 L6/L11 |
| M8 | 取消 ⇒ 入口同步失效（关监听 + 删配置 + abort 在飞调用） | 离线 P6a–P6c；实机 L12a–L12c |
| M9 | TTL 短寿命（默认 3 min，上限 10 min，下限钳 5 s），到点自动关 | 离线 P7a–P7d；实机 L12 前提（每轮一个新入口） |
| M10 | 令牌不进日志（只有 8 位指纹），配置文件关闭即删 | 离线 P8a/P8b；实机 L9e / L14 |
| M11 | CLI 侧 `--mcp-config` 的可用性有**直接证据**（1.1.41 自己的 `--help`），且 `type` 取值集合来自二进制字符串 | §2 C9/C10 |
| M12 | **没有** `--allowed-tools` 时，CLI 侧会因权限确认而**拒绝**这次 MCP 调用 | `probe/out/mcp-cli-direct-base.json` 的 CLI 原文 |
| M13 | 加上 `--allowed-tools mcp__dsh_bridge__send_message` 后，CLI 真的调用并回显工具返回值 | `probe/out/mcp-cli-direct-allowed.json`（`toolCalls=1`） |
| M14 | 会话级 `tool/call` / `tool/result` **只**由 `dsh-agent-loop` append；`ctx.tools.execute` 不 append | `dsh-agent-loop/lib/index.js:682`、`:697`；`dsh-tools` 全模块 0 处 |
| M15 | Node 端 Streamable HTTP 用 **JSON 响应形态**即可被该 CLI 接受（它自己发 `notifications/initialized`、带 `mcp-protocol-version` 头，请求 202） | 实机 L2/L3 与 `mcp.http` 记录（`protocolHeader:"2025-11-25"`） |
| M16 | 回归 10/10 PASS；profile 两个哈希与预期一致 | §6 |
| M17 | **CLI 进程自己记下**被带上 `--mcp-config <本轮入口配置文件> --allowed-tools mcp__dsh_bridge__send_message` | `harness-accounts\qoder-cn-a\logs\runs\…-p48084\manifest.json`、`…-p30892\manifest.json`（`cli_version=1.1.41`） |
| M18 | **CLI 自己的日志引用我方服务端的字节**：`Capabilities: { tools: { listChanged: false } }`、`instructions (250 chars)` 里带该成员会话 id、六个 `mcp__dsh_bridge__<tool>` checker 全装、`permission-check … allow point=mcp.rule.allow`、`tool.requested`/`tool.execution.finished`/`loop.iteration.finished reason="continue_after_tool_results"` | `harness-accounts\qoder-cn-a\logs\runs\…-p30892\qodercli.log:95-97,145-150,188,193-207` |

### 8.2 推断（写清依据）

| # | 推断 | 依据 |
|---|---|---|
| N1 | 这条桥接对**其它** Claude-Code 系 CLI 也可用（它们同样有 `--mcp-config` + `mcp__<server>__<tool>`） | M11/M13 + C10；**但我只在 qoderclicn 1.1.41 上验过**，故只对**已验证基名**（`qodercli*`）自动注入，其它一律不注入 |
| N2 | 桥接同样适用于 **ACP 通道** | **2026-10-14 已从「推断」升级为「确证（传输层）」**：见 §10.3 的证据链（真机上 opencode 2.0.14 / mimo 0.1.4 按 ACP 注入的 url+令牌连上桥接入口并走了 `tools/list`） |
| N3 | 成员多跑几轮会更早撞上 argv 上限 | **这条在本轮期间已被别的改动大幅缓解**：并发写者把 `qoder-cn-acct-a/-b` 改成了 `promptViaStdin: true`（`src/config.ts:361`、`:371`），prompt 不再进 argv。本桥接每轮往 argv 里加 **142 字符**（实测：`['--mcp-config', <83 字符路径>, '--allowed-tools', 'mcp__dsh_bridge__send_message']` join 后 142），在「prompt 走 stdin」的目标上**不再**逼近 `ENAMETOOLONG`。**仍然没有**测「prompt 走 argv 的目标」上这 142 字符把边界推前了多少 |

### 8.3 未验证 / 未做（**不得**当作结论）

| # | 项 | 说明 |
|---|---|---|
| U1 | ~~**ACP `mcpServers` 注入**~~ | **2026-10-14 已实现并验收**（§10）：`src/types.ts` + `src/transports/acp.ts` + `src/mcp-bridge.ts`。**仍未做**的是**宿主级端到端**（`src/index.ts` 的接线，见 §7「接线」）与**真机 ACP `tools/call`**（§10.5 如实记为未验证） |
| U2 | **`Tool` 观察面之外的会话级工具事件** | 见 §3.4：会话日志里的 `tool/call` / `tool/result` **本轮没有产生**，并给了确切理由；「补写会不会真的污染下一轮请求」**没有**做端到端实验 |
| U3 | 其它 CLI（`opencode` / `claude` / `codex` / WorkBuddy …）的 MCP 注入 | 只对 `qodercli*` 做了（`--help` 级证据 + 实机）。WorkBuddy 的 **ACP `mcpServers`** 未跑 |
| U4 | `--allowed-tools` 是否会把 CLI 自己的工具面**收窄到只剩它** | 只确证「加了它这次调用成功」；**没有**测它对 CLI 内建工具的影响。因此这是**最小授权**的取舍，不是已量化的性质。**另有一条已实测的约束**（§11.5）：预授权是**按工具名**的，名字之外的桥接工具在 `-p` 下会被权限确认挡住 |
| U5 | 多成员并发时的入口数量与端口占用 | 本轮实机只跑 1 个成员；离线并发开过 3 个入口。**没有**做 N 成员并发压测 |
| U6 | `tools.get` / `tools.schemas` 在**别的 profile**（非 desktop）下的可用性 | 只在 desktop 这个运行实例上验过；缺失时按 fail closed 处理，但那条分支**没有**实机触发过 |
| U7 | 「客户端断开 ⇒ `wait_agent` 立刻取消」的实机路径 | 离线验过（P6a 的 signal 语义）；`wait_agent` 在实机里**没有**被调用过（本轮只用 `send_message` / `harness_task_status`） |
| U8 | PTY / CDP / 窗口三档通道的桥接 | 结构上不可能注入（它们不是一次性 CLI 调用）；**没有**做任何实验 |
| U9 | **真机 ACP `tools/call`（C1f）** | **2026-10-13 用强制式 prompt 复测，仍然拿不到**（§12）。ACP 上的工具执行目前只有**桩 agent** 覆盖 ⇒ **这一格未验收**，不得说「ACP 真机工具执行验收完成」 |
| U10 | `env` 名 deny-list 对 **`qoderclicn` 以外**的 CLI | 只对 1.1.13 实测。别的 CLI 若也丢 `…_PAT`，代理会 `exit 2`（fail closed），**那条 CLI 上桥接不可用** —— 需要重新实测命名（§11.6） |

---

## 9. 复现命令

```powershell
# 前置：确认跑的是当前源码（anyStale 必须为 false）
(Invoke-WebRequest 'http://127.0.0.1:4200/harness-pilot/api/diag/loaded' -UseBasicParsing).Content

# ① 离线：协议 / 鉴权 / loopback / 白名单 / 作用域 / TTL / 取消（零额度）
node probe/verify-mcp-bridge-protocol.mjs

# ② 实机：CLI 真发 tools/call → 原生 team/message（**会真的调用外部 CLI，消耗少量额度**）
node probe/verify-mcp-bridge-live.mjs

# ③ 实机作用域隔离（零额度、零副作用）
node probe/verify-mcp-bridge-scope-live.mjs

# ④ 定位用：直接驱动 CLI 的 argv 变体（**会真的调用外部 CLI**）
node probe/verify-mcp-cli-direct.mjs base      # 预期 toolCalls=0（权限确认挡住）
node probe/verify-mcp-cli-direct.mjs allowed   # 预期 toolCalls=1

# ⑤ 回归
node probe/_regression-suite.mjs

# ⑥ ACP 通道（§10）：A/B 段零额度；C 段真机段最多 3 次最小 prompt（--no-live 则完全不发 prompt）
node probe/verify-mcp-bridge-acp.mjs
node probe/verify-mcp-bridge-acp.mjs --no-live
```

---

## 10. **ACP 通道的 MCP 注入**（2026-10-14 集成 + 验收）

> **本文档为什么有这一节**：§7 的补丁是**别人写的文本**，本轮由集成方**逐条核对后落地**，
> 并把「注入了」证成「**生效了**」。这里记的是**落地后的实际代码**与**实际行为**，
> 与 §7 的补丁文本不一致处以本节为准（两处形状修正在 §7 就地标注）。

### 10.1 落地的三处改动（+ 一处接口裁定）

| 文件 | 改动 | 关键点 |
|---|---|---|
| `src/types.ts` | `DispatchSpec.mcpServers?: readonly McpServerSpec[]`（新增 `export type McpServerSpec`） | 只描述**注入意图**；`headers`/`args`/`env` 标成可选 = 「调用方可以不给」，**上线对象由 acp 通道补齐** |
| `src/mcp-bridge.ts` | `McpBridgeChannel`（`argv-mcp-config` \| `acp-mcp-servers`）、`mcpServerDescriptors(url, token)`、句柄新增 `mcpServers`（**每次读都是新对象**）、`openForTurn({channel})` 按通道分流门槛 | **令牌只在桥接模块内部拼进 `Authorization` header**；句柄**没有**取令牌的方法；ACP 通道**不落盘**任何含令牌的文件 |
| `src/transports/acp.ts` | `buildSession({ cwd, mcpServers })`：逐条**复制成新对象**并**补齐必填键**；`facts` 只记 `type:name`；新增 `mcpAgentCaps` / `mcpUnsupportedTransports` | stdio **不带 `type`**；http/sse 的 `headers` 一定存在（可为空数组） |

**接口裁定（不是加方法取令牌）**：桥接句柄直接给出**已经拼好**的 `session/new.mcpServers` 条目
（`handle.mcpServers`）。这样「令牌可被任意调用方取出」**没有**变成常规路径：句柄上仍然只有
`tokenFingerprint`（8 位 sha256），`view()` / `list()` / 事件日志三者都**不含**令牌（§10.4 有断言）。

`channel` 缺省 = `argv-mcp-config` ⇒ **headless 那条路的行为逐字不变**（未验证 `--mcp-config` 的 CLI
仍然**一个端口都不开**，§10.4 的 P14a/A1a 都在测这一点）。

### 10.2 形状是怎么**核对**的（不是猜的）

三处**互不依赖**的原文，逐字读出同一个结论：

| 出处 | 事实 |
|---|---|
| `@agentclientprotocol/sdk/dist/schema/zod.gen.js:2347-2351` | `zHttpHeader = {name, value}` |
| 同上 `:2355-2360` / `:2364-2369` | `zMcpServerHttp` / `zMcpServerSse` = `{name, url, headers: z.array(zHttpHeader)}` —— **`headers` 无 `.optional()`** |
| 同上 `:2390-2396` | `zMcpServerStdio = {name, command, args: array(string), env: array(EnvVariable)}` —— **`args`/`env` 必填、无 `type`** |
| 同上 `:2405-2416` | `zMcpServer` = union[ http+`type:'http'` , sse+`type:'sse'` , acp+`type:'acp'` , **裸 `zMcpServerStdio`** ] |
| 同上 `:2422-2427` | `zNewSessionRequest.mcpServers = requiredDefaultOnError(vecSkipError(zMcpServer), () => [])` |
| `dist/schema-deserialize.js:93-97` | `vecSkipError = z.array(item.catch(skippedItem)).transform(items => items.filter(i => i !== skippedItem))` ⇒ **形状错 ⇒ 静默丢掉，整条请求照常成功** |
| `schema/schema.json` 的 `$defs` | `McpServerHttp`/`Sse`：`required:["name","url","headers"]`；`McpServerStdio`：`required:["name","command","args","env"]`；stdio 变体**没有 `type` 属性**（`additionalProperties` 未禁止，故多带 `type` 也被规范容忍——但**我们不发**） |

**行为级核对（不是只读源码）**：探针把**真的发出去的** `session/new` 帧喂回**SDK 自己的**
`zNewSessionRequest`，并配了**反面对照**：

| 断言 | 实测 |
|---|---|
| 我们发的 http 条目 → `safeParse` 成功、`mcpServers.length = 1`（**没被跳过**） | `kept=1` |
| 解析后 `type/name/url/headers` 逐字保留（url 与 header 值与入口一致） | `urlSame=true`、`headerSame=true` |
| **反面**：同一条目去掉 `headers` → 请求**照样成功**、条目**被静默丢掉** | `success=true, kept=0` |
| stdio：`{name,command,args,env}`（无 `type`）被保留；缺 `args`/`env` 被丢掉 | `keptStdio=1, keptMissing=0` |

⇒ 「形状错会被静默丢掉」这件事在本机是**可复现的**，所以 `headers`/`args`/`env` 一律补齐、
stdio 一律**不带** `type`（`acp.ts` 里就是这两个动作）。

### 10.3 「ACP 上真的生效」的证据链（每段各自独立、可复核）

产物：`probe/out/mcp-bridge-acp.json`（**52 项：51 PASS / 0 FAIL / 1 SKIP**）、
`probe/out/mcp-bridge-acp/stub-http.json`（桩产物）、`probe/out/mcp-bridge-acp/bridge-events*.jsonl`。

| # | 证据 | 值 |
|---|---|---|
| A1 | 桥接侧：ACP 通道开得出入口、**不动 argv**、**不落盘**配置文件、条目的键**恰好** `type,name,url,headers` | `channel=acp-mcp-servers`、`extraArgs=[]`、`configPath=''`、`configDir` 前后同为 2 个文件（别人的 headless 入口） |
| B1 | **线上帧**：把真实 `lib/transports/acp.js` 的 `dispatchAcp` 打到一个**桩 ACP agent**（用 SDK 的 agent 侧 API 实现，stdin 被 tee 落盘）——`session/new` 的**原始 JSON-RPC 行**里 `mcpServers[0]` = `{type:'http',name:'dsh_bridge',url:<本轮入口 url>,headers:[{name:'Authorization',value:'Bearer <令牌>'}]}` | `urlMatchesHandle=true`、`bearerMatches=true` |
| B2 | **SDK zod 解析后**桩看到的是 1 条、键 `headers,name,type,url`（没被 `vecSkipError` 丢掉） | `count=1` |
| B3 | **MCP 服务端真的收到了请求**：桩用它从 schema 拿到的 `url` + `headers` 打回来 | `initialize:200`、`notifications/initialized:202`、`tools/list:200`（6 个工具）、`tools/call:200`；桥接事件 `mcp.http/initialize`、`mcp.tools/list{count:6}`、`mcp.tool/call{tool:send_message,agentId=入口绑定的会话}`、`mcp.tool/result{isError:false}` |
| B4 | 这次 `tools/call` **真的落到 `tools.execute`**（假 ctx 记录到 scope = 入口绑定的 Agent） | `executed=[{name:send_message,scopeId:session-acp-probe}]` |
| B5 | stdio 分支上线对象**逐字**是 `{name,command,args:[],env:[]}`（补齐、无 `type`），桩**没有**为它启动任何进程 | `sentKeys=[name,command,args,env]`、`mcpRequests=0` |
| C1 | **真机**：三个候选先只做 `initialize` 读自报能力（**零额度**） | opencode 2.0.14 `http=true`；mimo 0.1.4 `http+sse=true`；kimi 0.26.0 `http+sse=true` |
| C2 | **真机按 ACP 给的 url+令牌连上了桥接入口并走了 `tools/list`** | `opencode`：`initialize → notifications/initialized → tools/list`；`mimo-cli`：同样三步；两次 `stopReason` 分别 `error`（模型路由拒绝工具）与 `completed` |
| C3 | 真机这两次的令牌**都不在**日志里；`facts` 里只有 `mcpServers=http:dsh_bridge`、没有 `Bearer` | `tokenInLog=[false,false,false]`、`facts.mcpAgentCaps='http=true sse=false acp=false'` |
| C4 | kimi 的**自己的**错误输出里原样引用了我们发的参数 | `session/new, params: { cwd: 'D:\\Project\\dsh-harness-pilot', mcpServers: [ [Object] ] }`（该轮因 `Authentication required` 未跑到 MCP 连接） |
| D | 关闭 ⇒ 入口同步失效（端口 `ECONNREFUSED`、登记清空、无残留文件） | `D1a–D1d` 全 PASS |

**A 段（离线）**另用 SDK 的 `zNewSessionRequest` 直接解析 `handle.mcpServers`（A4a–A4d，见 §10.2）。

> **产物卫生（如实披露一处后处理）**：桩落盘的**原始帧**里带着那一轮的 `Bearer` 令牌值
> （那是证据本身：B1 的「逐字一致」就是拿它与入口令牌比出来的，运行期断言结果 `bearerMatches=true`
> 已记进报告）。**落盘产物**在运行结束后做过一次后处理：把 `Bearer <令牌>` 的值替换成
> `<redacted:probe-artifact>`（2 处），**只保留 `headers[0].name='Authorization'` 与断言结论**。
> 该令牌随入口关闭+TTL 到期**早已失效**；替换只为守住「令牌不留在盘上」这条纪律
> （复核：`probe/out/**` 里已无 `Bearer <20+ 字符>` 的活值）。

### 10.4 既有性质**逐条回归**（零额度，`probe/verify-mcp-bridge-protocol.mjs` = **56/56 PASS**）

原 45 项**全部保持 PASS**（含 P1a「未验证 `--mcp-config` 的 CLI 不开入口」、P2 loopback、
P3 逐入口鉴权、P6 取消⇒入口失效、P7 TTL、P8 令牌卫生、P9 观察器不吞流），新增 11 项 P14：

| 项 | 结论 |
|---|---|
| P14a/P14b/P14c | 只有**显式声明** ACP 通道才跳过 argv 门槛；不动 argv；**ACP 通道不新增任何配置文件**（`configPath=''`，目录文件数前后相同） |
| P14d/P14e | 条目键**恰好** `type,name,url,headers`；loopback url = 本入口 url；`Authorization: Bearer <令牌>` 在 `headers` 数组里 |
| P14f | 令牌**不进**事件日志 / `list()` / `view()`（只有指纹） |
| P14g/P14h | 用条目里的 url+令牌真的打得通（`ping 200`、`tools/list 200`、5 个工具）；**无令牌 401、无令牌 DELETE 401**（鉴权不因通道放宽） |
| P14i | `mcpServers` 每次读都是新对象（改副本不影响入口） |
| P14j/P14k | 关闭 ⇒ 登记移除 + 端口不再接受连接 + 如实记账 |

**没被削弱的安全语义（逐条）**：loopback 限定（P2a/P14e）、一次性 32 字节令牌（P3a–P3d）、
逐入口令牌一一对应（P3c）、`DELETE` 也要凭据（P3d/P14h）、TTL（P7a–P7d）、
作用域白名单 + 作用域可见性（P5a–P5e）、取消⇒入口失效（P6a–P6d、P14j）、
令牌不进日志/视图/报告（P8a/P8b、P14f、A2e/A2f、D1d）、观察器永不吞流（P9a）。
**ACP 通道还更严一处**：它**根本不落盘**含令牌的文件（headless 那条是 0600 + 关闭即删）。

### 10.5 **仍未验证 / 未做**（不得当作结论）

| # | 项 | 说明 |
|---|---|---|
| V1 | **真机 CLI 在 ACP 路由上自己发起 `tools/call`** | 已试 3 次最小 prompt（每个自报支持 http 的候选各一次），只观察到 `initialize / notifications/initialized / tools/list`，**没有** `tools/call`。原因各异且都记了原文：opencode 的模型路由报 "No endpoints found that support tool use"；mimo `end_turn` 但没调工具；kimi `session/new` 就被 `Authentication required` 拒了。⇒ 探针里如实记为 **SKIP**（`C1f`）。`tools/call` 这一段由 **B 段**（同一份被测代码 + 桩 agent）覆盖 |
| V2 | **宿主级端到端**（插件自己的派发路径） | 需要 `src/index.ts` 的接线（§7「接线」）。本轮**没有**改 `src/index.ts`（写入范围外），所以「`/api/dispatch` 走 ACP 时也带上 `mcpServers`」**没有**跑过 |
| V3 | opencode 的 `acpModel` 切换 | 实测 `session/set_config_option(model=opencode-go/deepseek-v4.1-flash)` 被 opencode 2.0.14 拒（`model not found`）⇒ 这一轮的 `acpModelApplied=false` + `mismatch` 是**既有机制**如实报出来的，与本改动无关 |
| V4 | ACP 通道的并发/多入口 | 同一套 `entries` 结构与 headless 相同，但**没有**做 N 成员并发压测 |
| V5 | WorkBuddy 系 ACP 目标（`wb-managed-a/-ai-b`） | 本轮真机只跑了 opencode / mimo / kimi 三个候选，**没有**动 WorkBuddy |

### 10.6 环境事实（**与源码无关**，但会绊住任何纯 node 的 ACP 探针）

`node_modules/@agentclientprotocol/sdk` 是指向「从运行中 asar 抽出的 rc.2 树」的 junction，
该 SDK 的 `dist/acp.js` 会 import `./schema/zod.gen.js`，后者第一行 `import * as z from "zod/v4"` ——
**而 `scripts/build.mjs` 没有 link `zod`（抽取树里也没有）**：

```
$ node -e "import('@agentclientprotocol/sdk')"
ERR_MODULE_NOT_FOUND Cannot find package 'zod' imported from
  D:\Project\_dsh-host-0.2.0-rc.2\node_modules\@agentclientprotocol\sdk\dist\schema\zod.gen.js
```

**宿主进程不受影响**（确证：`GET /harness-pilot/api/probe?target=opencode` 回
`acp: available=true` + 真实 probe 文本 ⇒ 宿主内该模块加载成功）。探针侧的办法是
`probe/_acp-zod-hook.mjs`：**只在默认解析失败时**、且只对 `zod`/`zod/*`，用
`codex-plugin/node_modules/zod`（**4.6.5**，与 peer 范围 `^4.0.0` 相容）那棵树重试一次；
**不改任何文件、不写 node_modules、不改 `package.json`**。SDK 本体仍然用宿主同一份（1.4.0）。

### 10.7 收尾核对（本次集成）

- `node scripts/build.mjs` → **exit 0** 且出现 `=== copied client/client.js -> client.js + lib/client.js ===`
  （没有踩「构建非 0 跳过 client 拷贝」那个坑）。
- 三个 client 工件**同一时刻同值**：`client/client.js` = `client.js` = `lib/client.js`
  = `D860D873C867C7776CA578F39A55094F0F7223140F1F497C5B2FBEA8E48516C7`（129049 bytes）。
  ⚠️ 本会话早先一次核对时是 `8C35D867…`；变化来自 `client/client.js` 的 mtime 更新
  （`2026/10/14 0:39:45`，**另一个写入方**改的，不是本次改动；本次只改了 `src/{types,mcp-bridge,transports/acp}.ts` 与 `probe/**`）。
- `GET /harness-pilot/api/diag/loaded` → **`anyStale=false`**（8 个被跟踪模块 loaded=disk，本次核对）。
  ⚠️ 该接口**不跟踪** `mcp-bridge.js` / `transports/acp.js`；这两份的「宿主真的跑了新版」用**行为**证明：
  ① `POST /api/mcp-bridge/open` 回的 `entry` 里出现 **`channel:"argv-mcp-config"`**（该字段只存在于新版视图）
  且 `extraArgs` 仍是 `--mcp-config … --allowed-tools mcp__dsh_bridge__send_message`；
  ② `GET /api/probe?target=opencode` 的 `acp` 档由**新版** `probeAcp` 回答（`available=true`）。
  两次探测后 `entries=0`、`mcp/configs/` **为空**（运行间必须为空）。
- profile **未被改写**（`profiles\desktop\`）：
  `cordis.yml = 33B0735DD8756CAF6D5ECB55ED482FB485AB950EA86794002FD08959BC2ACF42`、
  `cordis.patch.yml = 2D0C57810C6083EBEB78F3D750481B725CBD75B3FB15BAE84CCA954A4C688F6E`（与预期同值）。
- `node probe/_regression-suite.mjs` → **10/10 PASS**（exit 0）。
- 本路产物哈希（sha256 前 16）：`src/types.ts`、`src/mcp-bridge.ts`、`src/transports/acp.ts`、
  `probe/verify-mcp-bridge-acp.mjs`、`probe/verify-mcp-bridge-protocol.mjs`
  —— 见 `docs/00-verified-status-report.md` 末尾那一节。

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- 2026-10-13 / 2026-10-14：headless 通道**明文令牌落盘**的安全修复 + 契约实测  -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

## 11. headless `--mcp-config` 的**明文令牌落盘**修复（2026-10-13）

### 11.1 被修的洞（确证，不是推断）

修复前 `src/mcp-bridge.ts` 的 `argv-mcp-config` 分支把**令牌明文写进落盘的 `--mcp-config` 文件**：

```jsonc
// 修复前：cfg-<id>.json（mode 0o600）
{ "mcpServers": { "dsh_bridge": { "type": "http", "url": "http://127.0.0.1:<port>/mcp/<id>",
                                  "headers": { "Authorization": "Bearer <32 字节令牌>" } } } }
```

- `mode: 0o600` 在 POSIX 上有意义，**在 Windows 上不是强制 ACL** ⇒ **不构成有效保护**。
- ACP 通道（§10）**不落盘**令牌，**但这不代表** headless 这条持久化路径也安全
  —— 两条通道的注入向量不同，一条修好不能推出另一条修好。

### 11.2 修复后的送达链

```
真 CLI（子进程）                       本插件 stdio 代理（lib/mcp-bridge-proxy.js）
  │  ① spawn 配置里的 command                │
  ├────────────────────────────────────────▶│  从**自己的子进程环境**取
  │  ② stdio NDJSON（MCP 2025-11-25）        │  DSH_BRIDGE_HANDOFF / DSH_BRIDGE_HANDOFF_PAT
  │◀────────────────────────────────────────┤  （**每次 spawn 独立一份**，任务结束即随进程消失）
  │                                          │  ③ 转发（Authorization: Bearer）
  │                                          ├──────────────▶ 桥接入口 http://127.0.0.1:<port>/mcp/<id>
```

落盘的 `--mcp-config` 里**只有**：

```jsonc
{ "mcpServers": { "dsh_bridge": { "command": "<宿主 process.execPath>",
                                  "args": ["<插件目录>/lib/mcp-bridge-proxy.js"],
                                  "env": {}, "timeout": 120000, "description": "…" } } }
```

**没有 `url`、没有 `headers`、没有 `Authorization`、没有令牌。**
另外 argv 增加 `--strict-mcp-config`：本轮**只**加载我们给的这一个 server（可核对的安全边界）。

### 11.3 CLI 侧 stdio 契约：**全部实测**（不许猜）

`probe/_mcp-stdio-contract-probe.mjs` ＋ `probe/_mcp-env-semantics-matrix.mjs`
＋ `probe/_mcp-key-decisive.mjs`（真机 `qoderclicn 1.1.13`）：

| # | 实测结论 | 判据/产物 |
|---|---|---|
| S1 | `mcp list` / `mcp get` **不读** `--mcp-config`（只看 settings 文件）⇒ 不能拿它当「条目被接受」的证据 | 契约探针 C0a/C0b |
| S2 | 配置里 stdio 条目形状 `{command,args,env}`；`type` **可省**、`env` **可省**（`env` 必须是**对象**） | C1b/C1c、C2b |
| S3 | CLI **真的 spawn** 该 command，并完成 `initialize` + `tools/list` + **`tools/call`** | C1c/C1d/C2d |
| S4 | stdio 传输是 **NDJSON**（一行一个 JSON，LF 结尾），协议版本 **`2025-11-25`**；**不是** `Content-Length` 头 | C1e/C1f（原始字节 `.stdin.hex`） |
| S5 | CLI 把它**自己进程的环境深拷贝**给 MCP 子进程 —— 条目里的 `env` 写不写都一样 | `_mcp-env-semantics-matrix.mjs` 三个变体（env 缺席／`{}`／非空）结果**逐字相同** |
| S6 | 但它**按名字丢掉**含 `TOKEN` / `SECRET` / `KEY` / `AUTH` / `PASSWORD` / `CREDENTIAL` 的键（大小写不敏感子串） | 同上 + `_mcp-key-decisive.mjs`（值长 18/20 与 43/47 两档都测） |
| S7 | 实测**透传**的名字：`DSH_BRIDGE_HANDOFF`、`…_PAT`、`…_BEARER`、`CANARY_SENTINEL`、`API_FOO`；实测**被丢**：`…_TOKEN`、`…_KEY`、`…_SECRET`、`…_AUTH`、`…_PASSWORD`、`…_CREDENTIAL`、`API_KEY`、`TOKEN` | S6 两个脚本 |
| S8 | 真 CLI 在 stdio 通道上**自己发起 `tools/call`**（不是「prompt 里写了工具名」） | 契约探针 C1d/C1j（工具返回值出现在 CLI 输出里） |

> **S6/S7 的由来（如实留档）**：第一版把凭据变量命名为 `DSH_BRIDGE_HANDOFF_KEY`，
> 真机链路上代理报 `missing DSH_BRIDGE_HANDOFF_KEY` **exit 2** —— 凭据被 CLI **静默丢掉**。
> 当时我手上那份命名矩阵探针**自身有 bug**（把「值的列表」写进了 `CANARY_ENV_KEYS`），
> 一度把 `…_KEY` 误判为「透传」。改用 `probe/_mcp-key-decisive.mjs` 单变量重测后，
> 三轮**一致**判定 `…_KEY` 被丢、`…_PAT` / `…_BEARER` 透传。
> ⇒ 现在变量名是 `DSH_BRIDGE_HANDOFF_PAT`，并且 `handoffEnv()` 会**逐名核对**
> 这张 deny-list：名字一旦落进去就**开入口时抛错**（fail closed，不交付注定被丢掉的凭据信封）。

### 11.4 四处零明文令牌的扫描证据

`probe/verify-mcp-bridge-stdio-proxy.mjs`（探针自开入口，含**正对照**）
＋ `probe/verify-mcp-bridge-live-token-scan.mjs`（**活部署**）：

| 处 | 判据 | 结果 |
|---|---|---|
| ① 配置文件 | `--mcp-config` 目录**每个文件**逐字节搜令牌本体；且条目键里**不许**有 `url`/`headers`；连 `Bearer` 这个词都不许出现 | 0 命中（探针 F1a–F1h、T3a；活部署 ①a–①d） |
| ② argv | 桥接追加的参数、以及**真机那一轮的完整命令行**里搜令牌本体 | 0 命中（F1j、T3b、T3b2） |
| ③ 日志 | 桥接事件日志 + 代理事件日志 + **活部署 42 MB / 202,227 行的 `bridge-events.jsonl`** 流式扫描 | 0 命中（T3c、活部署 ③a/③a2；且日志里**有** 8 位指纹可用于对账） |
| ④ API 响应 | `entries` + `events` 的序列化结果、以及 `GET /api/mcp-bridge` 的真实响应（83 KB） | 0 命中（T3d、活部署 ④a–④d） |
| **正对照** | 手递环境里令牌**确实**与入口令牌逐字相同（否则「扫不到」可能只是「没送出去」） | T3e：`43:same` |

> 判据用**形状**（43 字符 base64url ＝ `randomBytes(32).toString('base64url')`）＋**结构**
> （条目键集合）双管，且**大文件必须流式扫**：第一版扫描脚本用「4 MB 以下才算文本」
> 把 34 MB 的活日志整份跳过，报了 PASS 而**真正的证据文件根本没被看过** —— 已修。
>
> **活宿主跑的是新版**（不靠 `anyStale`，它现在已覆盖这两个文件，但纪律上仍要行为取证）：
> 活宿主写下的 `bridge.open` 事件里出现**只存在于新版**的字段
> `configHasCredential:false` / `handoffEnvKeys:["DSH_BRIDGE_HANDOFF","DSH_BRIDGE_HANDOFF_PAT"]` /
> `stdioProxyConfigShape:["args","command","description","env","timeout"]` / `configType:"stdio-proxy"`，
> 且 `extraArgs` 里已带 `--strict-mcp-config`；全文件扫描这三个字段各 **41** 次
> （`bridge.open` 共 191 次），**没有一次**携带 `url`/`headers`。
> 例：`2026-10-13T18:00:49.513Z`（`channel=argv-mcp-config`）。
> ⚠️ 该例来自**另一条独立路径**的 `api-probe` 入口；本路自己在 17:5x 也打通过同一接口
> ⇒ 「活宿主 = 新版」有**两份互相印证**的行为证据。

### 11.5 真调用回归（真 CLI → stdio 代理 → 桥接 → 原生管线）

`node probe/verify-mcp-bridge-stdio-proxy.mjs --live` → **PASS（无 FAIL）**：

- T2b 桥接入口收到 `initialize` —— **真 `qoderclicn` 经本插件 stdio 代理**连上来；
- T2c `tools/list`；
- T2d **真机 CLI 自己发起 `tools/call`**（`list_agents`，经 stdio 代理）；
- T2e **原生管线真的执行**（`tools.execute` 收到 `callId` + 作用域 = 入口绑定的那个 Agent）；
- T2f CLI 自己的 stderr 里搜不到令牌；
- T1e/T1f：**没有**手递凭据时代理 `exit 2` 并报错、**非 loopback** 目标被显式拒绝
  （绝无「回退到别的凭据 / 直连」这条路）。

**⚠️ 一条实测出来的前置条件（会影响以后所有类似的真机验证）**：CLI 侧的权限闸要求
**被调用的那个工具名**出现在 `--allowed-tools` 里，否则本轮以
`Error: Permission confirmation required but no interactive handler is available.` 结束
—— CLI **只发 `initialize`/`tools/list`，从不发 `tools/call`**。
桥接默认只预授权 `mcp__<server>__send_message`；本项要调 `list_agents`，所以探针显式把
`list_agents` 也加进预授权（**这不放宽桥接自身的闸**：服务端白名单与作用域判定照旧）。

### 11.6 这一节**没有**做什么 / 仍未确定

- **没有**改 `client/client.js`、`package.json`、profile 配置；**没有**重启/升级宿主；
  **没有**用宿主模型走 `selectModel`；**没有**导出任何凭据。
- **`env` 的 deny-list 只对 `qoderclicn 1.1.13` 实测过**。其它 CLI 的过滤规则**未知**：
  若某个 CLI 把 `…_PAT` 也丢掉，代理会 `exit 2`（fail closed）而**不会**回退到明文 ——
  但那意味着**那条 CLI 上桥接不可用**，需要重新实测命名。
- **没有**测「CLI 自己 settings 文件里的 MCP server 与本轮 `--mcp-config` 同时存在」的场景
  （`--strict-mcp-config` 的目的正是排除它；它是否在所有 Claude-Code 系 CLI 上都存在**未验证**）。
- `handoffEnv` 里的 `ELECTRON_RUN_AS_NODE=1` 是**防御性**的（宿主跑在 Electron 里时，
  少了它代理会开出 GUI 窗口而不是跑脚本）。本机实测 `process.execPath` 就是
  `…\node\versions\22.22.2\node.exe`，**没有**在 Electron 宿主下实测过这一格。

### 11.7 第 11 节的复现命令

```bash
node probe/verify-mcp-bridge-stdio-proxy.mjs          # 零额度：落盘凭据面 + 代理转发 + 四处扫描
node probe/verify-mcp-bridge-stdio-proxy.mjs --live   # 追加真机（花一次最小额度）
node probe/verify-mcp-bridge-live-token-scan.mjs      # 活部署四处扫描（流式，会读 30 MB+ 日志）
node probe/_mcp-stdio-canary-selftest.mjs             # canary 自检（先证明判据本身可用）
node probe/_mcp-stdio-contract-probe.mjs              # CLI stdio 契约实测（会花额度；--offline 零额度）
node probe/_mcp-env-semantics-matrix.mjs              # env 合并语义 / deny-list 名字矩阵（会花额度）
node probe/_mcp-key-decisive.mjs                      # 单变量判定 `…_KEY` 是否被丢（会花额度）
```

---

## 12. ACP C1f（真机主动 `tools/call`）：**仍然未验收**（2026-10-13 复测）

§10.3 把 C1f 记为 **SKIP**。本轮用**强制式 prompt** 复测了一遍
（`probe/verify-mcp-bridge-acp-c1f.mjs`，产物 `probe/out/mcp-bridge-acp-c1f/report.json`），
**结论未变**：

| 候选 | 自报能力 | 实际行为 | 有没有 `tools/call` |
|---|---|---|---|
| opencode 2.0.14 | `mcpCapabilities.http=true` | ACP 侧直接报 `Internal error: No endpoints found that support tool use`（同一轮模型切换也失败） | **没有**（这一轮**没跑到**「模型决定用不用工具」那一步） |
| mimo-cli 0.1.4 | `mcpCapabilities.http=true` | `stopReason=completed`；服务端确实收到 `initialize`/`notifications/initialized`/`tools/list` | **没有** |

⇒ **ACP 真机工具执行这一格维持「未验收」**（不是「试过一次就算了」，而是「又试了、仍然拿不到」）。
`probe/out/mcp-bridge-acp.json` 里 C1f 的 `verdict` **保持 `SKIP`**，
只在 `detail` **末尾追加**复测说明并新增 `c1fRetest` 字段（历史结论**未被改写**）。

**它能证明到哪一步**：真机 CLI 在 ACP 路由上**真的按我们给的 url+令牌连上了入口、也读了工具面**
（C1a/C1b PASS）。**它不能证明**：真机会不会**执行**桥接工具。ACP 上的 `tools/call` 目前
只有**桩 agent**（§10.3 B 段）覆盖过 —— 桩证明的是「协议与桥接这一侧正确」，
**不是**「真机会调」。

---

## 13. `bridge.skip` tight-loop 资源泄漏：真因 · 最小修复 · 实测（2026-10-14 追加）

> 一句话：**循环在调用方**（`verify-team-final-acceptance-v2.mjs` 的负例扫描在 `for...of` 里
> 往同一个数组 `push`），**插件只是"忠实"地每次调用写一条** —— 于是一个探针的 bug 变成
> 137 MB 的磁盘泄漏 + 探针自己被拖垮。修复落在插件侧：**skip 的写盘速率有上界，诊断一条不删**。

### 13.1 现场（只读实测，非推断）

文件 `C:\Users\Administrator\.dsh\plugins\harness-pilot\mcp\bridge-events.jsonl`：

| 时刻（本地） | 字节 | 行数 | 其中 `bridge.skip` | 非 skip |
|---|---|---|---|---|
| 02:33（scanA） | 137,021,842 | 658,880 | **657,679** | 1,201 |
| 02:38（scanB） | 142,407,623 | 684,957 | 683,532 | 1,425 |

- 657,679 条 skip **全部**是 `reason:"no-live-agent-for-session"`、`origin:"api-probe"`、
  `channel:"argv-mcp-config"`（唯一例外 1 条 `api-dispatch-acp`）。
- 刷屏集中在 **7 个会话**：
  - 第一段：`4ed5b51f` / `5a357bee` / `4ce8b6b3` / `00428123` **各 32,083 条**，
    17:49:54.025Z → 17:55:42.775Z（**348.8 s**）；
  - 第二段：`613ea796` / `6cd9f0cd` / `c9907c67` = **176,448 / 176,448 / 176,447 条**，
    18:00:49.469Z → 18:25:46.253Z（**1,496.8 s**）。
- 平均 ≈ **356 条/秒**（657,675 ÷ 1,845.6 s）；峰值分钟 18:21 = **23,641 条**。
- 单行实测 **206.2 B** ⇒ 356 × 206.2 ≈ **73.4 KB/s ≈ 4.4 MB/分钟**（与简报「约 4 MB/分钟」一致）。

**两条推断被实测否证**（必须写清楚，否则会继续误导后来人）：

1. **「同一毫秒内多条」= 否证**。657,679 条 skip 对应 **657,679 个互不相同的毫秒时间戳**，
   `maxLinesInOneMillisecond = 1`。速率是 ~353 条/秒 ⇒ 平均每 2.8 ms 一条 ——
   这是**严格串行的 `await` 循环**，不是"同步风暴"。
2. **「kill 探针后循环没有停」= 在可观测范围内否证**。最后一条 skip 是
   `2026-10-13T18:25:46.253Z`（= 本地 02:25:46，正是简报取样那一刻）。我 02:26:47 起做 12 s
   采样：文件只涨 **4,727 B（393 B/s）**，且新增**全是正常桥接事件**；
   之后再采样 20 s 为 **0 B**。刷屏在此后**没有恢复**。

### 13.2 真因：那个循环

`probe/verify-team-final-acceptance-v2.mjs:1069-1072`：

```js
for (const cand of neg.candidates) {                  // ← 遍历的数组
  if (Date.now() > negDeadline) { … break }
  const opened = await post('/mcp-bridge/open', { sessionId: cand.id, ttlMs: 20_000 })
  if (opened.status !== 200) { neg.candidates.push({ id: cand.id, opened: false, status: opened.status }); continue }
  //                          ^^^^^^^^^^^^^^^^^^ ← 循环体里往**同一个数组** push
```

`for...of` 每一步都重新读 `array.length`；循环体**每次恰好 push 一条** ⇒ 数组永不耗尽
⇒ **循环永不终止**。而 push 分支的条件正是 `status !== 200`，即
**`POST /mcp-bridge/open` 返回 409（该会话没有活 Agent）** —— 与「对没有活 Agent 的会话调 open
之后开始刷屏」逐字吻合。三条独立指纹都指向它：

- **每候选等量**（4×32,083；3×176,448）⇒ 是**轮转**，不是"某一条会话被重试"；
- 第二段末轮**少 1 条**（529,343 = 3×176,447 + 2）⇒ 循环被**从中间掐断**（进程被杀）；
- run 6（02:26:33 启动、02:33:27 结束）在同一段代码上刷了 **25,853 条 / 119.903 s**，
  时长**恰好等于调用方自己新加的 `HP_NEG_BUDGET_MS=120000` 预算 ⇒ 那个补丁只把死循环**限时**，
  **没有修掉死循环**。

**插件侧没有重试循环**（这一条是"证实/否证"里被要求判定的）：
`lib/mcp-bridge.js` 与"当时 `src` 的新编译"**逐字节相同**（去 sourcemap 后 51,654 B ≡ 51,654 B），
`mcp-bridge.js` 里 `bridge.skip` 只有 3 个调用点、模块内**没有** retry / setInterval / 自调用；
`openForTurn` 是**一次调用一条 skip** 的单发函数。⇒ **不是插件自身重试，也不是宿主对某事件
的重复调用**：是外部调用方无节流地反复请求那条 API 路由（`index.ts:2572`），
每次请求都**合法地**走到 `openForTurn` 的 ② 门槛并被如实记一条 skip。

### 13.3 修法：给"写盘"加上界，而不是删诊断

新增 `logSkip()`（`src/mcp-bridge.ts`）替换 3 个 `log('bridge.skip', …)` 调用点，
**其余事件一律仍走原 `log()` 逐条落盘**：

| 机制 | 值 | 作用 |
|---|---|---|
| 按键去重窗口 | `reason\|channel\|sessionId` 键，默认 **60 s**（`DSH_BRIDGE_SKIP_DEDUPE_MS`，**硬下限 5,000 ms**） | 同键同窗口**只落一条盘**，其余只进内存计数 |
| 全实例写盘上限 | 每窗口 ≤ **120** 行 | **与键的数量无关**：调用方"每次换个 sessionId"也封顶 |
| 键表上限 | 512 | 防止"每次换 sessionId"把内存顶爆 |
| 读数面 | `paths.skipLog`（`GET /harness-pilot/api/mcp-bridge` 直接可读） | `calls / written / suppressedByDedupe / suppressedByCap / distinctKeys / accountingHolds` |

**可审计性怎么保住的**（这是"不许简单删掉诊断"的落点）：

- 每个键在窗口内的**第一条永远立即落盘**，并在**新窗口的第一条**上带
  `suppressedInPreviousWindow`（以及被全实例上限压掉时的 `suppressedByGlobalCap`）
  ⇒「被压掉多少」写在盘上，**不是静默丢弃**；
- 内存环形缓冲（`events(limit)`）仍照记落盘的 skip；
- **为什么不去掉事件**：已有判据**要求**它存在 —— `probe/verify-mcp-bridge-protocol.mjs:165-170`
  的 **P1c** 断言就是「`bridge.skip` 里必须有一条 `reason === 'no-live-agent-for-session'`」。
  删掉事件会让一条**已验收的判据变假**；去重保留"每键第一条"，所以 P1c 依然成立。
- **为什么不在代码里自动轮转**：验收探针按 `bridgeId` / `sessionId` 从**最后 12 MB**
  （`BRIDGE_TAIL_BYTES = 12_000_000`）里 join，并按 `size+mtime` 缓存 —— 自动轮转会在
  **运行中**把文件从探针脚下换走。轮转改成一次性人工动作 + **全文归档**（§13.6）。

### 13.4 实测增长数字（修复前 / 修复后）

**（a）隔离复现**（把 `src/mcp-bridge.ts` 单独编译到临时目录，用临时日志；
`probe/verify-bridge-skip-throttle.mjs`，12 s 时间盒，窗口设到硬下限 5 s）：

| | 调用次数 | 落盘 skip 行 | 每调用行数 | 写入字节 | 速率 |
|---|---|---|---|---|---|
| **修复前**（`before/`） | 28,152（12,000 ms，2,346/s） | **28,152** | **1.000000** | 5,816,358 | **484,694 B/s ≈ 29.1 MB/min** |
| **修复后**（`after/`） | 15,840,616（12,000 ms，1,320,044/s） | **3** | 0.0000002 | 780 | **65 B/s** |
| 对抗用例（每次换 sessionId，5,000 次） | 前：5,000 行 / 后：**116 行**（上限 120） | | | | |

修复后计数对账（live 读数）：`calls 15,845,619 = written 122 + suppressedByDedupe 15,840,613
+ suppressedByCap 4,884`（`accountingHolds: true`）。**3 行 = 3 个 5 s 窗口各一条**。
（副产物：修复前那个循环被磁盘写绑在 2,346 次/秒，修复后 CPU 能跑到 1,320,044 次/秒。）

**（b）真实 HTTP 路由**（打到运行中的宿主，`probe/verify-bridge-skip-live-rate.mjs`）：

| | 调用 | 时长 | 日志增量 | 其中 skip 行 |
|---|---|---|---|---|
| **修复前·现场刷屏 1** | 657,675 | 1,845.6 s | 137 MB（累计） | 657,675 |
| **修复前·现场刷屏 2**（run 6） | 25,853 | 119.9 s | +5,385,781 B（含 224 条正常行） | **25,853** |
| **修复后**（300 次） | 300 | 1.4 s | +258 B | **1** |
| **修复后**（跨窗口：25,000 次） | 25,000 | 115,102 ms（217/s） | +11,084 B（含 22 条正常行） | **4** |
| **修复后**（截断后再打 500 次） | 500 | 2.2 s | +259 B | **1** |

修复后 run 7 自己那段负例循环被**就地**限流的 live 读数（`GET /mcp-bridge` 的 `paths.skipLog`）：
`calls=14,471, written=2, suppressedByDedupe=14,469, distinctKeys=1, accountingHolds=true`。
（其 `seq` 只有 16 ⇒ 该实例刚热重载过；计数是**每实例**累计，不是全局。）

### 13.5 "诊断仍在"的证据（不能只拿"日志不涨了"当证据）

- 隔离 after-run 里，**三个不同的键各自拿到了自己那一条**：
  换 sessionId（`no-live-agent-for-session`）、`no-session-id`、
  `target-cli-has-no-verified-mcp-config-injection` ⇒ 各 1 行，**一条不少**；
- 同一个 after-run 里，给一个**伪造的活 Agent** 真开了一个入口再关掉：
  `bridge.open` = 1 行、`bridge.close` = 1 行、`open-failed` = 0 ⇒ **正常诊断链没被限流误伤**；
- live：`GET /mcp-bridge` 的 `events` 尾部仍能看到 `bridge.skip(no-live-agent-for-session)`；
- 落盘的 skip 行现在自带 `dedupeWindowMs` + `suppressedInPreviousWindow`，
  **"被压掉多少"本身成为可读证据**。

### 13.6 磁盘处置（先归档、再截断，不是删）

| 步骤 | 结果 |
|---|---|
| ① 归档全文（gzip，**不删任何东西**） | `probe/out/bridge-events-archive-2026-10-13T18-44-38-430Z.jsonl.gz`，**4,772,572 B**（压缩前 **142,439,177 B**，29.8×），`sha256 = df8f91b5ce8ca7afb39cf945045bde6ddb4e6e7a4bb0812357e513626ce948c2`，685,023 行（683,540 skip + 1,483 非 skip） |
| （同一脚本干跑时另存了一份快照） | `…18-44-27-131Z.jsonl.gz`，4,772,437 B（142,436,251 B）——**两份都保留**，都在 `probe/out/` |
| ② 保留尾部 | 保留字节区间 `[126,439,027, 142,439,177)` = **16,000,300 B / 76,902 行**（保留窗口起点 `2026-10-13T18:23:28.282Z`） |
| ③ 原子替换 | 活文件 **142,439,177 B → 16,000,300 B** |
| 零丢失证明 | 归档尾部止于 `seq 44`（18:44:34.918Z）；新活文件里 `seq 42/43/44` **逐字仍在**，其后直接接 `seq 45`（18:44:40.621Z）、`seq 46` ⇒ **序号连续无缺口** |
| 报告 | `probe/out/skip-throttle/archive-report.json` |

- **保留窗口的硬保护**：脚本拒绝 `--keep-bytes ≤ 12,000,000`（运行中探针的尾部读窗口），
  所以截断**没有**挖掉探针正在读的那 12 MB；截断后 run 8（02:45:59 启动）**在截断后的日志上
  成功 join** 到了自己的 `bridge.open`（`joinKey.hitInLog` / `eventsForEntry` seq 48–60）——
  这是"截断没有破坏取证"的独立证据。
- 脚本首次执行时把"尾部最后一行是否仍在"写成了**字典序比较**，在"替换后宿主又追加了新行"
  时给出假 `false`；已改成逐字 `includes` 判定（`probe/archive-bridge-events.mjs`），
  上面第 ④ 行的结论是**事后逐行比对**得出的，不是那次假 `false`。

### 13.7 复现命令

```powershell
# ① 隔离 before/after（不碰运行中的宿主、不碰 lib/）
node <tsc> --ignoreConfig src/mcp-bridge.ts src/mcp-bridge-proxy.ts --outDir probe/out/skip-throttle/before `
  --target ES2023 --lib ES2023 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop `
  --skipLibCheck --types node --sourceMap false --declaration false
node probe/verify-bridge-skip-throttle.mjs --module probe/out/skip-throttle/before --label before --flood-ms 12000 --flood-max 20000000 --dedupe-ms 5000 --adversarial-calls 5000
node probe/verify-bridge-skip-throttle.mjs --module probe/out/skip-throttle/after  --label after  --flood-ms 12000 --flood-max 20000000 --dedupe-ms 5000 --adversarial-calls 5000
# ② 真实 HTTP 路由（对运行中的宿主；300 次 / 25000 次）
node probe/verify-bridge-skip-live-rate.mjs --label live-after --calls 300
node probe/verify-bridge-skip-live-rate.mjs --label live-after-sustained --calls 25000
# ③ 归档 + 保留尾部截断（默认干跑；--apply 才动活文件）
node probe/archive-bridge-events.mjs --keep-bytes 16000000            # 干跑
node probe/archive-bridge-events.mjs --keep-bytes 16000000 --apply
```

### 13.8 仍未确定 / 未验证（不得外推）

| # | 项 |
|---|---|
| U1 | **调用方那个 `for...of` + `push` 的死循环本身我没有改**（`probe/verify-team-final-acceptance-v2.mjs` 是**他人正在跑的验收工件**，改它会动到别人那一轮的脚本哈希）。⇒ 循环**还会**转满 `HP_NEG_BUDGET_MS`（默认 120 s）；只是**磁盘不再被写爆**。修法建议见 §13.9 末 |
| U2 | `DSH_BRIDGE_SKIP_DEDUPE_MS` 只在本机用 5,000 ms 实测过；**默认 60,000 ms 下的实际写盘行数**只在"25,000 次 / 115 s"这一格里量到 **4 行**，更长时段（数小时）未测 |
| U3 | 全实例上限 120 行/窗口只在 5,000 次对抗用例里触及（116/120）；**没有**做过"24 小时持续换键"的压测 |
| U4 | 本次修复**没有**验证其它事件类型（`mcp.*` / `pipeline.execute`）在高频下的行为 —— 它们**没有**限流（刻意保留逐条落盘），若某天它们被高频触发，磁盘仍会涨；这一点**没有**实测过上限 |
| U5 | 归档两份 gz 的**解压可读性只抽查了尾部**（用于零丢失比对）；没有做全量解压校验 |
| U6 | run 6 的**退出时刻**只能夹在"02:31:28 存活、02:33:27 写完报告"之间 ⇒ 它是否跨过任何热重载**未验证** |
| U7 | 去重键是 `reason\|channel\|sessionId`，**不含 `commandBase`**。`index.ts:4558` 那条派发路径允许 `sessionId` 缺席（`input.sessionId === undefined`）而 `command` 必有 ⇒ 此时**不同 CLI** 的 CLI 门槛 skip（`target-cli-has-no-verified-mcp-config-injection`）会在同一窗口里**共用一个键**，只留下先到的那一个 `commandBase`。这是**刻意的**（键要与"会话+原因"这条要求一致），但也确实是**一处可审计性损失**；若要收紧，把 `commandBase` 并进键即可（本路**没有**改，因为改完必须重新构建+热重载，而当时有验收轮在跑） |

### 13.9 污染披露（必须读）

- **构建不是我发的**：`lib/mcp-bridge.js` 在 **02:38:44** 被**另一路的 `build.mjs`** 重建，
  内容**就是我的修复**（`lib/mcp-bridge.js` 与"我对当前 `src` 的编译"逐字节相同，
  58,108 B ≡ 58,108 B），宿主随后热重载（`loadedHash == diskHash == b93d37831c42`，`stale=false`）。
  ⇒ **我没有运行 `build.mjs`**（再构建只会多一次热重载、多污染一轮）；本次交付依赖的是**那一次**构建。
- **被污染的轮次**：`verify-team-final-acceptance-v2` **run 7**（PID 1752，02:34:31 → 02:44:42）
  **跨越了 02:38:44 的热重载** ⇒ 它后半程跑在**含本修复**的桥接代码上。
  （run 6：02:26:33 → **02:33:27** 结束，**早于**我第一次改 `src`（最后一次编辑在 02:37:20）
  ⇒ **未被**本修复污染。）
- **我自己的动作对 run 7 的影响**：(a) live 测量共向宿主 API 打了 ≈25,800 次
  `POST /mcp-bridge/open`（全部 409、**不建任何入口、不改任何状态**，仅增加 CPU/日志）；
  (b) **02:44:39 的截断落在 run 7 写报告（02:44:42）前 3 秒** —— run 7 报告里的
  `bridgeLogStats = {fileBytes: 16,000,795, tailBytes: 12,000,000, parsedEvents: 57,670,
  truncatedHead: true}` 反映的是**截断后**的文件。**判据不受影响**：`bridgeLogStats` 只在
  `verify-team-final-acceptance-v2.mjs:1556` 被写进报告，**没有任何 verdict 读它**；
  且该脚本全文除了注释外**不读 `bridge.skip`**（唯一匹配在 `:95` 的注释里）。
- **零模型调用**：本次全程**没有**调用任何宿主模型 / 账号（没有派发任务、没有 `selectModel`），
  没有读取或打印凭据，没有输出原始 `accountId`，没有重启/升级宿主，没有改 profile 配置。
- **写入范围**：`src/mcp-bridge.ts`（独占，唯一被改的 src 文件）、`probe/verify-bridge-skip-throttle.mjs`（新）、
  `probe/verify-bridge-skip-live-rate.mjs`（新）、`probe/archive-bridge-events.mjs`（新）、`probe/out/**`（产物）、
  本文件（**文末追加**）、`docs/00-verified-status-report.md`（**文末追加**）。
  `src/index.ts` / `src/sessions.ts` / `src/provider.ts` / `src/tools.ts` / `src/transports/**` /
  `client/client.js` / `package.json` / profile 配置 **一字未动**。

> **给调用方那条死循环的精确补丁（交给它的所有者，不由本路改）**：把
> `if (opened.status !== 200) { neg.candidates.push({ id: cand.id, opened: false, status: opened.status }); continue }`
> 改成往**另一个**数组里记（例如 `neg.rejected.push({...})`），或把 `for...of` 换成
> `for (const cand of [...neg.candidates])`（先快照再遍历）。两者都保持原判据语义。
