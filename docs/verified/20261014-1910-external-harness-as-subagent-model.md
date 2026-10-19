# 2026-10-14 18:3x–19:1x · 第六轮：外部 harness 真正成为「可选模型的 DSH 子代理」

> 用户指令：「把这个插件的功能做成**真正**能把外部 harness 作为 DeepSeek harness 的子代理，并且可以选择模型」。
> 判据纪律：**回复非空 ≠ 走对了通道**。本轮正是被这条抓出来的 —— 子代理回复逐字正确，
> 实际却跑在**宿主模型**上（`opencode-go/deepseek-v4.1-flash`），外部 harness 一行都没跑。

## 1. 结论：两处实测缺口，都已修 + 已 live 验收

| # | 缺口（**修前实测**） | 修法 | 修后验收（live） |
|---|---|---|---|
| ① | 宿主标准 `subagent(provider="pilot-cli", model="qoder-cn-acct-a::Qwen3.8-Flash")` 的回复是**宿主模型**打的：子会话 `request/header.config = opencode-go/deepseek-v4.1-flash` | 请求层判定新增「**子代理会话显式委托**」判据（`session.header.origin === 'subagent'` ⇒ **保持**，不算残留恢复） | 子会话 `request/header.config` 与 `assistant/message.source` 都是 `pilot-cli/qoder-cn-acct-a::Qwen3.8-Flash`；CLI argv 含 `-m Qwen3.8-Flash` |
| ② | `harness_agent` 只能「账号 **XOR** 模型」：`accountId+model` 显式拒绝；只给 `model` 时**绕过 provider** 直接派发（没有 runId / 账本 / 身份行，输出自称 `mode=direct`） | provider 声明 `capabilities.agentOptions = true` 并**真的兑现**（`childAgentOptionsDecision()` → `sessions.dispatch({model})` → 目标 `modelArgs`）；`harness_agent` 两条路合并成一条 provider 路 | `runId` 有、账本 `requested model=Qwen3.8-Flash`、CLI argv 含 `-m Qwen3.8-Flash`；**账号 + 模型可以同选**，两条都在 provider 上 |

## 2. 根因①：请求层的「残留恢复」把子代理**点名**的路由改回了部署默认

机制在 `src/llm-adapter.ts` 的 `requestRouteDecisionFor()`（改前 `:726-761`）：请求已经在
`pilot-cli` 路由上、且该会话**没有**外部绑定、会话日志里**没有** `model/selection` 事件
⇒ 判定为「本插件上一轮改道留下的残留」，改回部署默认模型。

子代理的委托长成了**一模一样**的形状，于是被误判：

- 宿主 `subagent` 工具的 `provider`/`model` 写进 `AgentOptions`（`dsh-tool-subagent/lib/index.js:509-520`），
  子代理一轮的 config 就是 `pilot-cli/<目标>::<模型>`；
- 但委托**不写** `model/selection` 事件 —— 那条只由 GUI 选择器（`selectForNextRequest`）写；
- 子会话也没有绑定（绑定是给聊天会话用的）。

⇒ 唯一能区分两者的持久证据是**会话归属**：

| 契约 | 出处 |
|---|---|
| `origin: 'subagent'` 由宿主在创建子会话时盖章 | `dsh-subagent/lib/types/child-agent.js:121` |
| 落进 session header（且是 header 校验字段） | `dsh-session/lib/types/index.js:868`、`:58-60` |
| 可经 `ctx.sessions.get(id).header` 读到（宿主自己也这么读） | `dsh-session/lib/types/index.js:1042-1043`、`:445`；`dsh-tool-subagent/lib/index.js:592-597` |

**对照实验（这一条是判据的关键）**：同一次 `subagent` 调用把 `provider` 换成宿主原生 `step`
⇒ 子会话 `request/header.config = {provider:"step", model:"step-5-preview"}`
（那次 run 因上游「实名认证」403 失败，与路由无关）。**宿主机制没坏，问题在本插件的改写。**

## 3. 根因②：provider 的能力广告在 `start()` **之前**就把「本次换模型」挡掉了

旧实现声明 `capabilities = NO_START_CAPABILITIES`（`agentOptions: false`），而宿主
`subagents.start()` 只做一条 gate：**请求里 `agentOptions` 有值 ⇒ 该能力必须为真**，
否则在 `provider.start()` 之前抛 `UNSUPPORTED_CAPABILITY`
（`dsh-subagent/lib/types/index.js:457-470`；宿主注释原文：*never accepted-then-ignored*）。
`dsh-tool-subagent` 挂载时对 `modelSelectionSettings` / `config.agentOptions` 的行**硬校验**同一能力
（`dsh-tool-subagent/lib/index.js:376-386`）。

⇒ 外部 harness 在 provider 路径上**永远**承载不了「本次换模型」，旧实现只能二选一/绕开 provider。

**修法与纪律**：只把 `agentOptions` 打开（`outputSchema` / `depthLimit` / `toolFilter` / `persona`
保持 false —— 外部 CLI 兑现不了就不开），并且**声明了就必须兑现**：

| 输入（`AgentOptions`） | 判定 |
|---|---|
| `model: 'Qwen3.8-Flash'` | ✅ 注入 `-m Qwen3.8-Flash` |
| `model: 'qoder-cn-acct-a::Qwen3.8-Flash'`（前缀 = 本 provider 的目标） | ✅ 剥前缀 ⇒ `Qwen3.8-Flash` |
| `model: 'agy::…'`（前缀是**别的**目标） | ❌ 显式拒绝（绝不悄悄换 harness） |
| `provider: 'opencode-go'`（宿主供应商） | ❌ 显式拒绝（这条通道每轮由外部 CLI 产生） |
| `reasoningEffort` / `maxTokens` | ❌ 显式拒绝（不是外部 CLI 的概念，不替它编映射） |
| 目标没有 `modelArgs` | ❌ 显式拒绝（接受但不注入 = 静默丢弃） |
| `subagentDepth` | ➖ 接收不解释（宿主自己的递归记账） |

## 4. 实测证据

| # | 输入 | 观测 | 证据 |
|---|---|---|---|
| E1 | **修前**：`subagent(provider=pilot-cli, model=qoder-cn-acct-a::Qwen3.8-Flash)`，回复逐字正确 | 子会话 `request/header.config`/`assistant.source` = `opencode-go/deepseek-v4.1-flash`；`pilot-cli` 的 run 一条都没有 | 子会话 `ddb299ec-773d-4c30-b434-367ec558465b` |
| E2 | 控制组：`subagent(provider=step, model=step-5-preview)` | 子会话 `provider/model = step/step-5-preview`（宿主机制正常） | 子会话 `c70e30e9-f098-4ab7-a3cb-a8d29d9df0ad` |
| E3 | **修后**：`subagent(provider=pilot-cli, model=qoder-cn-acct-a::Qwen3.8-Flash)` | `request/header.config = {"provider":"pilot-cli","model":"qoder-cn-acct-a::Qwen3.8-Flash"}`，`assistant.source` 同路由，正文 = 探针标记，`turn/end=completed` | 子会话 `3729ba1d-c635-4c41-bf64-90737414de87` |
| E3b | 同上，外部 CLI 侧 | argv = `… --config-dir …\harness-accounts\qoder-cn-a -m Qwen3.8-Flash -p`；CLI 自记 `model.response.completed model="qfmodel"` | `logs/runs/2026-10-14T18-49-52-894+08-00-51cx3s-p38340/manifest.json` + `qodercli.log` |
| E3c | **最终构建后复跑**（证据必须对应现网产物）：`subagent(provider=pilot-cli, model=qoder-cn-acct-a::Qwen3.8-Flash)` | `requestLayer.subagentKept=1`、`restores=0`；子会话 `request/header.config = {"provider":"pilot-cli","model":"qoder-cn-acct-a::Qwen3.8-Flash"}`、正文 = 标记、`turn/end=completed`；CLI argv 含 `-m Qwen3.8-Flash` | 子会话 `c6c519f3-9d15-4cbe-885c-233885029a7d`；CLI run `2026-10-14T19-04-22-953+08-00-f3yr38-p42948` |
| E4 | `harness_agent(target=qoder-cn-acct-a, model=Qwen3.8-Flash)` | `provider=harness-qoder-cn-acct-a runId=57531634-…`（真 provider run + 账本）；argv 含 `-m Qwen3.8-Flash` | run `2026-10-14T18-56-34-624+08-00-d0tkei-p29380` |
| E5 | `harness_agent(target=qoderclicn, accountId=qoder-cn-a, model=Qwen3.8-Flash)`（**旧行为是拒绝**） | `provider=harness-qoderclicn-acct-‹acct:…-aa› runId=c282fa8c-…`；argv 同时含 `--config-dir …qoder-cn-a` 与 `-m Qwen3.8-Flash` | run `2026-10-14T18-57-01-090+08-00-d02fl4-p34468` |
| E6 | `harness_agent(target=command-code, model=some-model-xyz)`（目标无 `modelArgs`） | 显式拒绝、**没有** run、**没有** spawn | 工具返回原文（见 §6 探针/日志） |
| E7 | 模型下发的**反证**：`qoder-cn-acct-a` + `-m definitely-not-a-model-xyz` | `exitCode=42`、stdout 空、CLI 原文列出 14 个可用模型（含 `Qwen3.8-Flash`）⇒ `-m` 真的被校验并生效 | 早前 dispatch 运行记录 |
| E8 | 回归：默认 `subagent`（不给 provider/model） | 照常走宿主路由并正常回复 | 本会话内联结果 |

> 说明：E4/E5 的账本里 `actual.model` 仍是「**未回报**」—— headless 通道不提取 CLI 自记的
> `model.response.completed model="…"`，所以插件**不拿请求值冒充实际值**。独立证据是
> CLI 自己写的 `manifest.argv` 与它自己的日志（E3b/E4/E5 都给到了）。

## 5. 探针与回归

| 探针 | 口径 | 结果 |
|---|---|---|
| `probe/verify-subagent-model-options.mjs`（**本轮新增**） | `childAgentOptionsDecision` 15 例（9 例拒绝）+ 能力广告「只开 agentOptions」 | **PASS** |
| `probe/verify-llm-adapter-unit.mjs` | 请求层判定 16 → **21** 例（新增：subagent 豁免、归属不覆盖绑定、非 subagent 归属仍恢复） | **PASS** |
| `probe/verify-llm-adapter-request-layer.mjs` | 真实转录里「绑定改道 → 解除绑定回到宿主」 | **PASS 9/9** |
| `probe/verify-harness-agent-account-alias.mjs` | A1/A5 口径按新行为改写（账号+模型同选、模型经 `agentOptions`、不再有 `mode=direct`） | **PASS 25/25** |
| `probe/_regression-suite.mjs` | 12 项串行（本轮把 `verify-subagent-model-options` 加入队列） | **11/12 PASS**，见下 |

**构建影响范围（自证，不是声称）**：本次 `node scripts/build.mjs` 之前（18:46）已记录过
`/diag/loaded` 的 44 个模块哈希；构建后逐个比对，**只有 3 个模块变了**：
`llm-adapter.js`、`provider.js`、`tools.js` —— 正好是本轮编辑的三个源文件。
`federation/*`、`config.js`、`index.js` 等**逐字未变**。

**唯一那条 FAIL 是既有的、与本轮无关**：`verify-federation-accounts` 的 4 条断言
（`workbuddy-a` / `workbuddy-ai-b` 的 `identity.state` 期望 `model-request-authorized`、
`identity.detail` 期望含「非本插件本次重测」）。原因不在本轮改动：它读的
`lib/federation/accounts.js` 哈希在构建前后**都是 `aa794baade01`**，而该模块里已经是
「原生加密独立账号快照」+ `snapshotAuthorized`（`stored.authenticatedAt`）的那套新语义
（更早一轮的 WorkBuddy 改动已 build 并热重载）—— 该探针的期望没跟着更新。
**本轮未改它**（属于另一个写入方的进行中改动 + 探针口径，动它会越界）；如实记为待办。

## 6. 三态清单

- **已完成**：请求层「子代理显式委托」判据 + live 验收；provider `agentOptions` 能力与**兑现**
  （含 4 类显式拒绝）+ live 验收；`harness_agent` 账号与模型同选；模型真的落到 CLI 命令行
  （argv 逐字）；离线/活体探针与串行回归；`cordis.patch.yml` 的 `tool-subagent` 模板更新为**可照抄**形态。
- **待办（他人进行中，本轮未动）**：`verify-federation-accounts` 的 4 条 WorkBuddy 断言与
  已上线的「原生加密快照」语义不一致（见 §5 末）；需要那一轮的写入方把探针口径一起更新。
- **未验证**：
  1. **宿主 `tool-subagent` 实例路径**：模板已按契约写全（`maxDepth: provider-managed` +
     `modelSelectionSettings: true` + provider 名），但**本机 profile 没有插这一行** ⇒ 没有 live 验收。
     它需要改 composition 并重启宿主，属于用户配置面，本轮**不改**。
  2. **实际模型值**：头显通道仍不回报（见 §4 说明）。「3.8 而非 3.7」这一步的证据是 argv 逐字 +
     非法模型被 CLI 响亮拒绝，**不是**通道回报。
  3. 团队路径（continuable）：本 provider 仍**不**实现 `prepareContinuable`，团队成员的模型冻结不受本次改动影响。
- **上游限制**：跨进程 provider 拿不到 `localAgent` ⇒ 宿主不登记目录子会话（子会话血缘 / 策略继承
  这两条机制在外部 CLI 上不可用；工具本身、runId、stopReason、模型下发不受影响）。

## 7. 复现

```powershell
# 构建（src → lib；运行中的宿主会热重载 lib）
node scripts/build.mjs

# 离线：per-child 选项判定 + 能力广告
node probe/verify-subagent-model-options.mjs

# 离线：请求层判定（含本轮新增的 subagent 豁免回归格）
node probe/verify-llm-adapter-unit.mjs

# 活体：宿主标准 subagent 工具 + 指定模型（额度：一次 Qwen3.8-Flash 短问答）
#   在会话里调用：subagent(provider="pilot-cli", model="qoder-cn-acct-a::Qwen3.8-Flash", prompt="…")
#   然后核对子会话转录：request/header.config 必须是 pilot-cli/qoder-cn-acct-a::Qwen3.8-Flash
#   证据读法见 probe/_session-store.mjs 的 readPersistedSession()

# 活体：provider 路径的账号 + 模型（额度：一次短问答）
#   harness_agent(target="qoderclicn", accountId="qoder-cn-a", model="Qwen3.8-Flash", prompt="…")
#   再核对 ~/.dsh/harness-accounts/qoder-cn-a/logs/runs/<最新>/manifest.json 的 argv
```
