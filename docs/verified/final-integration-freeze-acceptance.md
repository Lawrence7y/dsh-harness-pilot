# 最终集成 · 冻结修订 · 单进程验收（集成子代理交付）

> 采集与撰写：2026-10-14 02:0x–02:3x（本地）。**不给百分比**；拿不到证据的格子写「未验证」。
> 项目根：`D:\Project\dsh-harness-pilot`（**不是**会话工作目录）。

## ⚠️ 冻结状态更新（写在最前，晚于 §2 的采集时刻）

**§2 的冻结记录（02:30:06）在采集后 54 秒即被上游再次改动，因此「冻结」这一动作在本轮
客观上无法达成** —— 我把这条如实放在最前，而不是留在 §2 里让人误读成「已冻结」。

| 时刻 | 事件 | 影响 |
|---|---|---|
| 02:25:23 | `src/index.ts`（第三个写者） | 我 02:10 的冻结失效 → 已重取 |
| 02:25:35 | `lib/**` 全量构建 | — |
| **02:30:06** | **我重取冻结**（`lib/index.js` = `d5e1ea7135eb`，38 模块，`anyStale=false`） | 这是 §2 那份记录 |
| 02:31:00 | `src/team-routing.ts` 再改 | **冻结整体失效**（该模块变了） |
| 02:31:11 | `lib/**` 全量构建 | `lib/index.js` **仍是 `d5e1ea7135eb`**（逐字节相同）；`lib/team-routing.js` 等变了 |
| **02:34:08** | `src/llm-adapter.ts` 再改（**尚未构建**） | **冻结整体失效** |

⇒ **结论：本轮不存在「冻结修订」**。因此：
- A 组 9 项的复跑（02:27:49–02:30:0x）落在**02:25:35 构建的修订**上（`lib/index.js` = `d5e1ea7135eb`），
  该修订在复跑窗口内**没有变化**（已核对：无 src/lib 文件在 02:26–02:30 之间被写）—— 这一点是成立的；
- 但**不能**声称「A 组 = 最终冻结修订」：02:31 与 02:34 之后 `src/` 又变了；
- **B 组在「源码未齐」时跑完整团队长任务，正是用户明令禁止的那件事** ⇒ 我不跑。
- 我的集成标记在 02:34 之后**再次核对仍然全部在**（`catalogExtras`×3、`accountRuntimeGate`×1、
  `mcp-bridge-proxy.js`×2、`managedBootstrapRuntimeGate`×2、`accountGateDenied`×1、`accountGateChecked`×1、
  穷尽规则说明×2；`SELF_MODULES` = 38 项）。

## 0. 一句话结论

四项集成**全部落地并有行为证据**；冻结记录**已完成**（`anyStale=false`、38 模块、清单规则机械成立）；
A/C/D/E 有证据（C 的两次真实 WB 别名任务**跨修订**，已如实标注）；**B（真实团队单进程验收）本轮未完成** ——
原因不是失败，而是**上游并发**：`/probe/team`（全局 lead 会话）被**另一路的真实团队验收持续占用**，
且 `src/**` 在本轮被**第三个写者**改过并重新构建（「所有上游写域已释放」这一前提被推翻两次）。

---

## 1. 集成四项：逐项落地 + 证据

### ① 安全 stdio 代理及其 env / 生命周期接线 —— **落地**

| 接线点 | 现状（实测） |
|---|---|
| `src/mcp-bridge-proxy.ts`（新增） | 存在；`requireEnv('DSH_BRIDGE_HANDOFF')` + `requireEnv('DSH_BRIDGE_HANDOFF_PAT')`；非 loopback 目标**显式拒绝**；缺凭据 `exit 2`（绝不回退直连/别的凭据） |
| `src/mcp-bridge.ts` | `mcpConfigDocument(nodeExecutable, proxyScriptPath)` —— 明文 `url`/`headers.Authorization` 已消除；`handoffEnv()` **fail closed** 核对键名（落进实测 deny-list 就抛错） |
| `src/types.ts` 的 `extraEnv` | 存在，注释写明「只许流向 `spawn(env)`，不得进日志/诊断/API」 |
| `src/transports/{headless,acp}.ts` | `env: { ...process.env, ...spec.target.env, ...spec.extraEnv, NO_COLOR, TERM }` —— `extraEnv` 放**最后**（不被静态 env 覆盖） |
| `src/index.ts` | 一行 `...(bridge === undefined || Object.keys(bridge.handoffEnv).length === 0 ? {} : { extraEnv: bridge.handoffEnv })` |

**⚠️ 本轮修掉的一个真 bug（不是文档问题）**：01:53 我读到的代理要求 `DSH_BRIDGE_HANDOFF_KEY`，
而 `mcp-bridge.ts` 的 `MCP_BRIDGE_HANDOFF_ENV.token = 'DSH_BRIDGE_HANDOFF_PAT'` —— **键名不一致**。
01:47:15 的实测现场正是它的后果：`probe/out/mcp-stdio-diag/report.json` →
`proxy.exit code=2 "missing DSH_BRIDGE_HANDOFF_KEY"`。上游在 01:54:27 把它改成 `_PAT` 后复跑通过。

**证据（可观察）**：`probe/out/mcp-bridge-stdio-proxy/report.json` —— **37/37 PASS**，含：
- 真机 CLI **经 stdio 代理**发起 `tools/call`（`T2d`）且原生管线真的执行（`T2e`）；
- 四处零明文令牌：① 配置目录**每个文件** ② argv（桥接追加参数 + **真机完整命令行**）③ 桥接/代理事件日志 ④ API 响应序列化；
- **正对照**（`T3e`）：手递环境里的令牌与入口令牌**逐字一致** ⇒「扫不到」不等于「没送出去」；
- deny-list **正反两面**（`F1m`）：`…_KEY`/`…_TOKEN` 判被丢、`…_PAT` 判透传，与 CLI 实测一致；
- 回收：`Z1` 入口登记清空 / `Z2` 配置目录无残留 / `Z3` 关闭后端口不再接受连接。

另有 `probe/out/mcp-live-token-scan/report.json` → `verdict=PASS`、`failures=[]`、`findings=[]`。

### ② 真实 WorkBuddy 执行前 version/hash 门禁 —— **落地（新接线）+ 16/16 行为验收**

**接线（本轮新增，此前是死代码）**：`checkManagedBootstrapGate` / `checkAdapterIntegrity` 原本 **0 调用点**。现接在**两条**真实派发路径：
- `src/provider.ts`：`HarnessProvider.start()` 在**任何副作用之前**（未建 AbortController、未登记账本、未 spawn）
  `await this.alias.runtimeGate()`，失败即 `throw` ⇒ 宿主侧**连 run 都不会有**；
- `src/sessions.ts`：`registry.dispatch()` 的**启用门禁同级**位置 —— 那是 HTTP `/dispatch`、`/task/start`
  与 `harness_task_start` 的**唯一收口**，它们都不过子代理 provider，只在 provider 接线等于「门禁只对一半入口成立」；
- `src/types.ts`：`DispatchSpec.accountGateChecked` 幂等声明（避免一次任务起两个厂商子进程；**只有真测过才允许置 true**）。

**测量方式（真实，不是读配方）**：`ELECTRON_RUN_AS_NODE=1 <配方校验过的厂商 exe> <推导出的 codebuddy-headless.js> --version`，
白名单环境（不继承任何厂商凭据类变量）。实测两个 WB 安装均 `2.156.0`、exit 0、约 1.8 s、零额度。

**证据**：`probe/verify-managed-bootstrap-gate.mjs` → `probe/out/final-integration/managed-bootstrap-gate.json` —— **16/16 OK**：

| 分支 | 结果 |
|---|---|
| A 放行 | 适配器 sha256 == `3032e84f623d0644…`（可校验实体）；两个受管账号各实测 `2.156.0`；门禁返回 `undefined` |
| B1 版本前缀不匹配 | 拒绝（真测到 `2.156.0` 后按前缀判），文案含期望/实测/测量方式 |
| B2 测不到版本 | **fail closed** 拒绝（「不知道版本」≠「版本兼容」） |
| B3 适配器被改 1 字节 | 在**临时副本树**里导入**那份** `provider.js` ⇒ 真实代码路径拒绝；**冻结实体未被改动**（sha256 仍为常量） |
| C 派发接缝 | `SessionRegistry.dispatch` 真的返回**显式 outcome**：`stopReason=error`、`facts.accountGateDenied=true`、**不声明**任何实际身份 |
| D 负对照 | 非受管账号 ⇒ 门禁**不做任何测量**并放行（不给普通账号制造无理由失败） |

### ③ catalog/index 补丁合并（H1–H10）+ 去重 —— **落地**

- **H9 已由上游落地**（`src/models.ts` 委派 `parseModelListOutput`），我**未重复改**；四出口实测 **98/98/98/98**。
- 本轮落地：**H1**（import）、**H2**（`ApiExtras.catalog`）、**H3**（`entry.models` 类型）、**H4**（`GET /pool` 读回 `models`）、
  **H5**（`/pool/switch` 用账号池声明兜底）、**H6**（`catalogExtras` 数据面）、**H7**（`/catalog`、`/catalog/select`、`/catalog/edit` 三条路由）、**H8**（挂载）。
  全部**按锚点文本**定位（不按行号），落地后逐项复核命中数。
- **`federation/**` 纳入 `SELF_MODULES`**：我没有只加 `federation/**`，而是把它换成一条**可判定的穷尽规则** ——
  「`SELF_MODULES` = 本插件**服务端运行期**的全部构建产物 = `lib/` 下递归全部 `.js`（排除浏览器侧 `client.js`）」。
  于是「清单外还有相关模块」这类缺口在定义上不再存在。机械核对：**清单 == 磁盘**（本轮 38 项，成立）。
- **同步逐字清单说明**（避免制造新的滞后文案）：`src/processpool.ts` 顶部那段「逐字列出清单」**改成写规则**（并注明「故意不再重抄」），
  其 `describe().notes` 里的同一段也一并更新；`probe/verify-model-discovery-unify.mjs` 里那句
  「该文件**不在** SELF_MODULES 里」改成「现已进清单，本条保留为**独立第二来源**」。

### ④ 统一构建 —— **exit 0 且出现 client 拷贝行**

```
=== install: D:\Project\_dsh-host-0.2.0-rc.2\node_modules ===
=== checkout: D:\Project\deepseek-harness-master\deepseek-harness-master ===
=== compiling src -> lib ===
=== copied client/client.js -> client.js + lib/client.js ===   ← 拷贝行在（构建非 0 会跳过它）
```
三份 client 工件**同一时刻逐字节一致**：`9414deac2c3af8d157103c10f0a433940a96226326909d18da1fe6b7f79bd1dc`
（`client/client.js` = `client.js` = `lib/client.js`，mtime 均 01:49:47）。

---

## 2. 冻结清单（最终，2026-10-14 02:30:06 本地 / 18:30:06Z）

产物：`probe/out/final-integration/freeze.json` + `FREEZE.md`（含 38 模块逐项 + 清单外实体 + 39 个 src 哈希 + profile 参照）。

- `/diag/loaded`：**`anyStale=false`**，模块数 **38**；**清单规则机械成立**（清单 38 == 磁盘 38，无单边项）。
- 修订标识：**`lib/index.js` sha256 = `d5e1ea7135eb1106b38fb164be3a319311b233e0254053c6b76b066635c7b70d`**（mtime 02:25:35，258 813 B）。
- 关键模块（loaded == disk == 独立算出的 lib sha256 前 12 位）：

| 模块 | loadedHash | diskHash | stale | lib sha256(12) |
|---|---|---|---|---|
| `index.js` | `d5e1ea7135eb` | `d5e1ea7135eb` | false | `d5e1ea7135eb` |
| `provider.js` | `27d399ba5cbf` | `27d399ba5cbf` | false | `27d399ba5cbf` |
| `sessions.js` | `f35f98e184f1` | `f35f98e184f1` | false | `f35f98e184f1` |
| `types.js` | `7f398a3b3628` | `7f398a3b3628` | false | `7f398a3b3628` |
| `processpool.js` | `03a63a8f3b80` | `03a63a8f3b80` | false | `03a63a8f3b80` |
| `catalog-edit.js` | `fc9442c4346f` | `fc9442c4346f` | false | `fc9442c4346f` |
| `mcp-bridge.js` | `b769b1351621` | `b769b1351621` | false | `b769b1351621` |
| `mcp-bridge-proxy.js` | `6180800418c0` | `6180800418c0` | false | `6180800418c0` |
| `models.js` | `e4191e02a651` | `e4191e02a651` | false | `e4191e02a651` |
| `federation/providers.js` | `8ea806c992fc` | `8ea806c992fc` | false | `8ea806c992fc` |
| `federation/accounts.js` | `d1b80a56d265` | `d1b80a56d265` | false | `d1b80a56d265` |
| `team-routing.js`（**本轮新增，非我写**） | `085635bf8105` | `085635bf8105` | false | `085635bf8105` |

- 清单外实体：三份 client 工件（同一哈希 `9414deac…`）、`assets/workbuddy-managed.cjs` = `3032e84f623d0644…`（== 已验收常量）、
  `scripts/build.mjs`、`tsconfig.json`、`package.json`。
- 清单外「相关模块」**已不存在**（这正是穷尽规则的目的）；`lib/*.js.map` / `lib/types/**` 是产物不是运行模块，未纳入。

> ⚠️ **冻结的边界（必须一起读）**：`anyStale=false` 只证明「**这份进程**跑的是**磁盘上这一份**」，
> **不证明**那条能力真的被接线/被调用过 —— 所以下面每一项都另给行为取证。

---

## 3. A/B/C/D/E 逐项结果

### A. 离线/单元（零额度）—— **9/9 exit 0**（在冻结修订上复跑，`STRICT_ENTRANCES=1`）

`probe/out/final-integration/A2-suite-20261014-022749.log` + `.json`

| 探针 | exit | 断言/结论 |
|---|---|---|
| `verify-managed-account-alias-offline` | 0 | `assertions=96`，`aliases=4`，`noModelCalls=true` |
| `verify-actual-identity-offline` | 0 | `assertions=42`，`realVendorCalls=false`，`legacyFileUnchanged=true` |
| `verify-task-identity-ui-offline` | 0 | `assertions=29`，`offlineRendering=true`（`realBrowser=false` ⇒ 真浏览器部分见 D） |
| `verify-federation-identity` | 0 | `PASS` |
| `verify-catalog-edit`（`STRICT_ENTRANCES=1`） | **0** | **checks 61/61 OK，FINDINGS 清零** |
| `verify-subagent-account-alias` | 0 | pass（替身 harness，零额度） |
| `verify-team-observer-waterfall` | 0 | `exactStreamForwarded=true`，负对照检出 |
| `verify-model-discovery-unify` | 0 | **19/19 OK · findings 0**（pi 三出口 + 工具面 98/98/98） |
| `verify-managed-bootstrap-gate`（本轮新增） | 0 | **16/16 OK** |

**⚠️ 一个我修掉的探针缺陷（不是产品缺陷）**：`verify-catalog-edit` 首轮 `exit=1`，唯一 FINDING 是 `C7`
「GET /pool 出口**看不见** models」—— 但它的 detail 里 `models` **明明在**成员字段表里，自相矛盾。
真实原因：`finding(id, ok, detail)` 的第二个参数是**健康态**，而 C7 传的是 `httpHasModels === false`（**缺陷在场**）
⇒ H4 修好之后反而报 FINDING（`STRICT_ENTRANCES=1` 时升级为 FAILURE）。已按健康态改写标题与判据（并同步 C7b 措辞）。
**同一份历史数据的另一处交叉影响也已消解**：`verify-llm-adapter-unit` 那条「工具段必须明写 DSH 不会执行它们」
的断言**仍然成立**（新措辞保留了该句，并新增 MCP 例外段）—— 回归套件实测 **11/11 PASS**。

### B. 真实团队（单进程串行，唯一一次）—— **❌ 本轮未完成（不是未通过）**

**为什么没跑（两条硬前提都不成立，逐条给证据）**：
1. **没有可冻结的修订**：`src/**` 在本轮被**第三个写者**改动并重新构建 ——
   `src/team-routing.ts`（**新文件**，02:19:07）、`src/tools.ts`（02:17:43）、`src/llm-adapter.ts`（02:21:54）、
   `src/index.ts`（02:25:23）、`lib/**` 全部 02:25:35。我 02:10 的冻结因此失效，已重取（02:30）。
2. **`/probe/team` 被另一路持续占用**：另一路的 `probe/verify-team-final-acceptance-v2.mjs`
   **先**是 PID 46424（02:00:49 后长时间无写入，argv 日志到 02:20:08），它结束后**立刻**又起了 PID 38840。
   该 v2 脚本**不读共享锁**（`probe/out/.team-final-acceptance.lock` **不存在**）⇒ 我若开跑，`POST /probe/team/clear|configure`
   会覆盖它的观测状态，正是你已实测两次的「互相摧毁证据」。**我没有并发启动，也没有杀任何进程**（不按进程名杀）。

**已备好、可直接跑的替代品**：`probe/verify-team-final-acceptance-v3.mjs`
（由 `probe/_make-team-v3.mjs` **从 v2 逐字派生**，20 处改动逐条断言命中；`node --check` 通过；独立输出
`probe/out/team-final-acceptance-v3.json`，**不覆盖** v2 的产物）。**与 v2 的唯一差别是 ⑤ 的载体**：
不再要求「复述拼接 token」，改为**普通业务消息**（`HP-BIZ-A/B-<STAMP>` 业务编号）+ 判据
**「接收方回复是否引用该消息内容」**；反泄漏性质未变弱（编号只在发送方 prompt 与消息正文里，接收方 prompt 里没有）。

**为什么这个改动是对的（有实测支撑，不是我猜的）**：另一路 v2 run5 的现场（`probe/out/_v2-run5-console.log`）显示，
**两个方向的 L1+L2 全绿** —— `tools/call=["send_message"]`、`isError=false`、`queued(senderId=发送方会话)=true`、
`delivered=true`、桥接结果里的 messageId 与接收方回执 id 相等、回执**进了接收方本轮上下文**；
**唯独 `echo=false`**（接收方没逐字复述拼接串），于是判成 `PASS-WITH-CAVEAT`。
按你修正后的判据（B 自发调用 + `queued(senderId=B,target=A)` + A 收到同一 messageId 并受影响 ⇒ 通过），**这就是通过**。

**保留的历史**：旧 B→A 失败（B 那一轮 CLI 零 `tool.requested`、`queued(senderId=B)=false`、token 由 Lead 代发）
**一个字未改**，仍是 FAIL。

**v3 未覆盖的一处（如实说明）**：`5c` 正对照（原生成员 C）**仍保留三段拼接**写法 —— 它不在你说的 ⑤ 范围内，
且该判据（`cWithTokens.length > 0`）**依赖**那段拼接串，历史实测 PASS。我**没有**擅自改它。

### C. 账号别名（真实任务）—— **两个 WB 账号均 completed；跨修订，已标注**

| # | provider | runId | stop | 回复 | 身份（脱敏） |
|---|---|---|---|---|---|
| 1 | `harness-wb-managed-a-acct-‹acct:…-ab›` | `629b3a95-30e9-4a4c-ae49-2877ae379ec6` | completed | `WB-ALIAS-A-OK` | harness=`wb-managed-a` account=`acct:…-ab` transport=acp |
| 2 | `harness-wb-managed-ai-b-acct-‹acct:…-be›` | `806fe2fe-fc8b-4be1-86e1-494c04b0728b` | completed | `WB-ALIAS-B-OK` | harness=`wb-managed-ai-b` account=`acct:…-be` transport=acp |
| 3+4 | **并发**同批派发（同一消息内两路同时下发） | `58f4ab2a-…` / `fdc93dc9-…` | completed | `WB-PAR-A-OK` / `WB-PAR-B-OK` | 两个不同 nativeSessionId（`01a13680-25fe…` / `01a13680-597e…`），账号互不串号 |

- **这四次都经过我新接的门禁**（不通过会 `throw`，连 run 都不会有）⇒ 是门禁在**真实路径**上的放行证据。
- **⚠️ 跨修订**：第 1/2 次在 `tools.ts`(02:17:43) 之后、`index.ts`(02:25:23) 之前；第 3/4 次在 02:21–02:22。
  因此它们**不能**声称代表 02:30 的冻结修订。**但**：实现该门禁的模块在两个修订间**逐字节相同**
  （`provider.js` `27d399ba5cbf`、`sessions.js` `f35f98e184f1`、`types.js` `7f398a3b3628`，与 02:13 回归套件记录的 revisionBefore 一致）
  ⇒ 门禁本身的行为证据在这两个修订上等价；**端到端的「真实任务」那一步只在旧修订上有证据**。
- `provider`/`model` 一律 `(未回报)`：ACPI/ACP 未回报实际供应商与模型，**不拿请求值顶替**（`comparison` 只列两侧都有的 `harnessId/accountId`）。
- **安全注入无明文泄漏**：见 ①（37/37 + live-token-scan PASS，含「配置目录每个文件」「真机完整命令行」「日志」「API 响应」四处）。
- **`pi` 三 API 集合 + 工具面一致**：`verify-model-discovery-unify` **19/19**，`providers=98 / models=98 / overview=98`，
  工具面走同一 `parseModelListOutput`（`tools.ts` → `registry.targetModels`）。

### D. UI —— **沿用用户已做的两次真实 Chrome 验收（未重跑）** + 离线渲染证据

- 用户已独立验收两项（**新增档案**、**状态操作**）—— 按要求**没有重跑**。
- 离线渲染：`verify-task-identity-ui-offline` → `assertions=29`，`offlineRendering=true`（`realBrowser=false`，如实标注）。
- 活宿主渲染：`probe/out/ui-smoke.json` → `pass=true`、`failures=[]`、`renderedChars=60970`、
  slots（`conversation.input.model` / `settings.section:harness-pilot` / `settings.plugins.tab:harness-pilot`）、
  池面板 4 成员、进程面板同源快照、stage3 面板 8 个模型带状态。
- 任务卡身份行：客户端工件里确有 `requested` / `actualSource` / `actual` / 「请求模型：」徽章（静态核对），
  且 `actualSource === 'transport-outcome'` 才认「已验证来源」。
- **未验证**：本轮**没有**用真实浏览器重看「请求/实际/历史未知」三态在**新修订**上的渲染（`realBrowser=false`）。

### E. 口径 —— 逐条

- **自动耗尽的第二跳仍标明注入**：`probe/out/auto-switch-executor.json` → `pass=true`、`failures=[]`、
  `injectionUsed=true`，其 `disclaimer` 明写「被判为额度耗尽的用例全部是**结构化信号注入**（`evidenceKind=injected`），
  **不是真实额度耗尽观测**」，并指向真实执行侧证据在 `verify-auto-switch-live.mjs`。**✅ 未冒充真实额度耗尽**。
- **Antigravity 多账号**：`probe/out/agy-isolation.json` → 两个候选数据根开关（`ANTIGRAVITY_EXECUTABLE_DATA_DIR`、`XDG_CONFIG_HOME`）
  实测**均 INEFFECTIVE**（目录与基线逐项相同、全新目录零文件），且无 login/logout/status 子命令
  ⇒ 结论是「**CLI 侧目前无法诚实支持多账号**」。**未验则不冒充通过**：✅ 按未支持口径记录，**不是**通过项。
- **同厂商国内国际版并行**：本轮做了**新的**并发证据（C 的第 3/4 次，同批两路同时下发，两个 WB 安装/两个账号/两个 nativeSessionId，
  均 completed、互不串号）。**边界**：这证明「并发下发时两个账号各自完成且身份不串」，
  **不等于**「厂商共享认证槽在并发下永不互相影响」（`accounts.ts` 的隔离披露明写认证存储**未**隔离）；
  也**没有**测长期并发或令牌刷新竞争。⇒ 只报到证据支持的那一层。

---

## 4. 逐条证据矩阵

### 已验（有可观察产物）
1. MCP stdio 代理全链：配置/argv/日志/API **四处零明文**、真机 `tools/call` 经代理、回收三查（37/37）。
2. 执行前门禁：**两条真实派发路径**接线；放行/版本拒绝/fail-closed/适配器篡改/派发接缝显式拒绝/负对照（16/16）。
3. `SELF_MODULES` 穷尽规则成立（38 == 38）+ `anyStale=false`。
4. 构建 exit 0 + client 拷贝行 + 三工件同哈希。
5. A 组 9/9（含 catalog-edit 61/61、discovery 19/19、回归套件 11/11）。
6. `pi` 三出口 + 工具面一致（98/98/98）。
7. 两个 WB 账号的真实别名任务 completed（跨修订，见 C 的标注）。
8. 同厂商 CN/国际版**并发**下发完成且身份不串（新证据）。
9. profile 参照：`cordis.yml` = `33b0735dd8756caf…`；`cordis.patch.yml` = `f59de58775716d62…` @ 01:01:50（未归因写入，**未再变化**）。
10. 部署默认值**文件 + 活宿主双证未变**：文件 84–86 行 `provider: opencode-go` / `model: deepseek-v4.1-flash` / `reasoningEffort: max`；
    活宿主 `/llm-adapter` 的 `lastDecision.from = {opencode-go, deepseek-v4.1-flash}`。

### 已实现未验（代码在、本轮没拿到行为证据）
- `/catalog` 三条路由的**活宿主行为**（本轮只验了能力/选择/计划的纯函数面与 `execute` 的注入边界；未对活宿主 `POST /catalog/edit execute=true` 做真实写）。
- `HARNESS_PILOT_ALLOW_ADMIN_WRITES=1` 那条**写用户 CLI 配置**的通道（**故意未开**，会写用户真实配置）。
- `verify-managed-bootstrap-gate` 的 `A5` 放行分支只在**门禁函数**层验过；端到端「门禁放行 ⇒ 真任务跑成」的**同修订**证据缺（C 跨修订）。

### 受上游限制（不是我能定的）
- **B 组**：`/probe/team` 被另一路持续占用 + `src/**` 被第三个写者改动 ⇒ 无法满足「冻结修订 + 单进程串行」。
- `probe/out/mcp-bridge-acp-c1f/report.json` → `verdict = "STILL-UNVERIFIED"`：ACP 通道的「桥接工具真被调用」**未验**
  （opencode 那轮是 provider 路由错误 `No endpoints found that support tool use`；mimo-cli 那轮 `stopReason=completed` 但 `bridgeToolCalls=[]`；
  两轮 `tokenInLog=false`）。**如实标注，不当通过**。
- 编译期类型无法与 rc.2 完全一致（asar 里没有 `.d.ts`）—— 上游产物限制。
- `cordis.patch.yml` 01:01:50 的**未归因写入**：两路写入清单均无 profile，**不做无凭据的「恢复」**（那本身就是未经授权的 profile 写入）。

### 未完成
- B 组（见上）。
- 新修订上的真实浏览器 UI 复核（用户已做过两次，我按要求未重跑）。
- **`withAccountTarget` 的受管账号重复 wrapper 缺陷**（见 §5）。

---

## 5. 未支持边界 与 回滚基线

### 未支持边界（明确列出）
1. **HTTP `/dispatch`、`/task/start`、`harness_task_start` 传受管账号（`workbuddy-a` / `workbuddy-ai-b`）会拼出重复的、相对的 wrapper** ——
   **已确证缺陷，未修复**。机制：`src/index.ts` 的 `withAccountTarget()` 做 `args: [...launch.args, ...target.args]`，
   而受管 seed 的 `launch.args = ['workbuddy-managed.cjs','workbuddy-a']`（`poolconfig.ts` 的 `resolveAccountLaunch` 原样返回）
   ⇒ 目标是 `WorkBuddy.exe <abs wrapper> workbuddy-a -p`，前置后又多出 `workbuddy-managed.cjs workbuddy-a`（相对路径）。
   别名路径（provider.ts）**没有**这个问题（受管分支直接用目标自身 args，`managedAccountAliasRefusal` 逐条核对）。
   **为什么不修**：会改 `src/**` ⇒ 冻结与已采集证据全部失效；且不在本轮授权范围内。**建议**：把 `resolveAccountLaunch` 对
   `managed-bootstrap` 返回空 `args`（或让 `withAccountTarget` 对受管档案走别名语义），并补一条负对照。
2. **Antigravity CLI 多账号**：不支持（两个数据根开关实测无效 + 无 login/logout/status）。
3. **受管 bootstrap 的厂商内部协议**：依赖 `resources/app.asar` 内部模块与一次性命名管道；**厂商升级后必须重新验收**（这正是门禁存在的理由）。
4. **两个 WB 档案的认证存储未隔离**（厂商共享槽，仅 `authentication.id` 不同）—— 不得声称认证已隔离。
5. **ACP 通道的桥接工具调用**：未验证（见上）。
6. 本插件**不导出/不解密/不复制**任何令牌；不关闭加密；不伪造隔离支持。

### 回滚基线
- **集成前快照**：`probe/out/final-integration/snapshot-pre-20261014-015916/`
  （`src/**` 全量 + `client/client.js` + `client.js` + `lib/client.js` + `assets/workbuddy-managed.cjs` + `scripts/build.mjs`
  + `cordis.patch.yml` + `package.json` + `tsconfig.json`，共 49 文件；逐文件 sha256 见其 `MANIFEST.sha256.txt`）。
  快照时三份 client 工件同为 `9414deac…`（与当前一致）。
- **冻结记录（可回滚核对点）**：`probe/out/final-integration/freeze.json` / `FREEZE.md`
  （38 模块 loaded/disk/stale + lib 完整 sha256/mtime + 39 个 src 哈希 + 清单外实体 + profile 参照）。
- **profile 参照哈希**：`cordis.yml` = `33b0735dd8756caf6d5ecb55ed482fb485ab950ea86794002fd08959bc2acf42`（10-13 15:32:05，**未变**）；
  `cordis.patch.yml` = `f59de58775716d62f8570df4909460d002be05e4fa5ee1e491f169e9deed9a5f`（10-14 01:01:50，**未归因写入，保留在册，未做恢复**）。
- **回滚方式**：用快照覆盖 `src/**` → `node scripts/build.mjs`（必须 exit 0 且出现 client 拷贝行）→ 等热重载 → `/diag/loaded` 必须 `anyStale=false`。
  ⚠️ 回滚**只**覆盖快照里那 49 个文件；`src/team-routing.ts`（02:19 新增）**不在快照里**，回滚会把它留下 —— 需显式决定其去留。

---

## 6. 仍未确定（不得外推）

1. **B 组在冻结修订上的真实结论**：未跑 ⇒ **未知**。v3 已就绪，但需要一段**独占 `/probe/team`** 的静止窗口。
2. **第三个写者的意图与完成度**：`src/team-routing.ts` 是**新文件**（29 494 B），我没有读它的语义、也不知道它是否已接线/已验收。
   本报告只覆盖我这一轮的集成面；它的正确性**不在**本报告的证据范围内。
3. **`withAccountTarget` 受管重复 wrapper 缺陷的影响面**：我只从源码与 `resolveAccountLaunch` 的返回值确证了拼接机制，
   **没有**真机跑一次 `/dispatch?accountId=workbuddy-a` 去看它的实际失败形态（那会真的起进程）。
4. **`mcp-bridge-acp-c1f`**：ACP 通道桥接工具是否真被调用 ⇒ 未验；两轮失败原因一个是 provider 路由、一个是模型不调工具，**都不构成产品结论**。
5. **同厂商并发下认证槽的相互影响**：只验到「并发下发各自完成且身份不串」，**没有**验令牌刷新竞争/长期并发。
6. **`cordis.patch.yml` 01:01:50 写入的归因**：仍未归因（两路清单均无 profile）；我只做了「未再变化 + 部署默认值未变」的核对。
7. **本轮 A/C 证据与新修订的严格同版性**：A 组是冻结修订（02:27:49 起，src 自 02:25:23 未变）上的复跑；**C 的真实任务是跨修订的**（见 C 的标注）。
8. **`pi` 的 `harness_models` 工具出口**：`verify-model-discovery-unify` 里该项记「未直接调用」（它走同一 `parseModelListOutput`，但**没被本轮实测覆盖**）。
