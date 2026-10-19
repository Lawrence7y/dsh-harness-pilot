# 账号目标解析收口（`src/account-target.ts` = 唯一来源）

> 结论一句话：`/dispatch` · `/task/start` · team `prepare()`/冻结配方 · 子代理 provider
> 四条产品入口（外加 `harness_task_start` 与自动切换 `attempt()`）**不再各写一份**账号合并 ——
> 它们全部走新建的 `src/account-target.ts`。同轮修掉三类**同类缺口**：
> 受管账号的**冻结配方** prepend、`/dispatch` 的**第二份实现**、Qoder **硬绑定别名被误拒**。
>
> 本轮写入范围：`src/account-target.ts`（新建）、`src/index.ts`、`src/team-routing.ts`、
> `src/provider.ts`（别名注册那一处）、`src/processpool.ts`（**只改了一处过时注释里的条数 37→39**，
> 见 §9）、以及四个探针 + 本文档。**未**改 `src/tools.ts` / `src/sessions.ts` / `src/tasks.ts` /
> `src/mcp-bridge*.ts` / `src/transports/**` / `client/client.js` / `package.json` / profile 配置。

## 1. 汇合后的单一解析来源

| 层级 | 位置 | 说明 |
| --- | --- | --- |
| 模块 | `src/account-target.ts`（新建） | 「账号 → 目标」的**唯一**实现处 |
| 入口函数 | `withAccountTarget(input)` | 四条分支：① 受管 bootstrap 整份复用 ② 目标已按真实完整配方带着同一账号 ⇒ 整份复用（`sameAccountRecipe()` 五项逐项比对）③ 目标带着**别人**的真实配置目录 ⇒ 显式拒绝 ④ 普通合并（同 Harness 判定 + `mergePlainAccountInto()`） |
| 冻结配方 | `applyAccountToTarget(target, account, opts)` | 团队**每一轮**派发用；受管/硬绑定 ⇒ 整份复用；并用 `frozenTargetConfig` 做**错配判据** |
| 普通合并 | `mergePlainAccountInto(target, args, env)` | **别名注册与派发共用同一个函数**（这是「四处实现」不再漂移的可判定保证） |
| 受管元组核对 | `managedRecipeTupleProblem()` / `claimManagedAccountRecipe()` | 从 `index.ts` 原样搬来（**逐字**未改判定），供 dry 与 prepare 两侧共用 |
| 解算 | `resolveAccountRecipe()` | `team-routing.ts` 现在**只再导出**它 |

### 循环 import 如何避免（**实际**结构，不是计划）

```
index.ts ──▶ team-routing.ts ──▶ account-target.ts ──▶ provider.ts
   │                                   ▲                   │
   │                                   └── 惰性解析（createRequire）──┘
   │                                      只在真的要合并时发生
   └──▶ registerProviders(..., 第 7 形参注入 withAccountTarget())
```

* 静态图**无回路**：`account-target.ts → provider.ts` 单向；`provider.ts` 顶部**不** import
  `account-target.ts`（普通账号别名那一步用 `mergeAccountByPolicyLazy()` 惰性解析，
  `index.ts` 另在 `registerProviders()` 第 7 形参注入同一处实现；解析失败 ⇒ **如实跳过**该别名，
  绝不自己拼一份）。
* 核对方式（**不是读代码推断**）：`node probe/_check-alias-dispatch-equivalence.mjs`
  （别名合并 == 派发合并，逐字）与 `node probe/verify-account-target-unify.mjs`（53 格矩阵）
  都能直接把「未初始化绑定」暴露成崩溃或 FAIL。
* `src/index.ts` 与 `src/team-routing.ts` **互相不 import**
  （`git grep` 级核对：`team-routing.ts` 只 import `account-target.js` / `provider.js` / `federation/*`）。

## 2. 四个入口是否真的走同一来源（证据）

| 入口 | 改前 | 改后 | 证据 |
| --- | --- | --- | --- |
| `POST /dispatch` | **第二份**内联合并（无同 Harness 判定、note 未脱敏） | `withAccountTarget({...})`，`index.ts:2125` | 53 格矩阵里 `/dispatch` 的 12 格（2 受管 + 1 普通 + 2 硬绑定 + 6 负控 + 5 篡改）全 PASS |
| `POST /task/start` | 私有 `withAccountTarget()`（已验基线） | 同一个 `withAccountTarget()`，`index.ts:2457` | 同上；硬绑定别名从 400 变 200（§4） |
| team `prepare()` 冻结配方 | 自己写「同 Harness 判定 + `resolveAccountRecipe`」（受管冻结出相对 wrapper） | `withAccountTarget()` + `accountSideOf()`，`team-routing.ts:448` | 矩阵 `team prepare()` 9 格 + `_check-alias-dispatch-equivalence` |
| 子代理 provider（`harness_agent` / 别名 provider） | 注册期**自己拼一份** `args/env` | `planAccountAliases()` 注入 `withAccountTarget()`（`index.ts:4451`）+ 惰性兜底 | `verify-subagent-account-alias` **77/77 PASS**（真实 `SubagentProvider.start()` → 真 headless → 替身进程 argv/env） |
| team 冻结配方**派发合并**（两处：`pilotCli.dispatch` / `/team/dispatch`） | `[...frozen.args, ...found.args]` ×2 | `applyAccountToTarget()`，`index.ts:4551` / `index.ts:4703` | 矩阵 `/team/dispatch` 7 格全 PASS（含 1 格**错配拒绝**） |

> 「子代理 provider」那一格**无法离线驱动**（要真起 Agent 会话）。矩阵里的
> `subagent provider (offline-equivalent)` 格是**同一函数、同一入参**的离线等价对照，
> 报告里如实标为「离线等价」；活体证据由 `verify-subagent-account-alias`（77 断言）承担。

## 3. 零额度矩阵逐格结果（`node probe/verify-account-target-unify.mjs`）

**53 格：PASS 53 / FAIL 0**（退出码 0）。报告：`probe/out/account-target-unify/after.json`。

| 组 | 格数 | 结果 |
| --- | --- | --- |
| 受管正控（2 WB 账号 × `/task/start` `/dispatch`） | 4 | 完整元组 `[<绝对 wrapper>, <id>, '-p'|'--acp']`、wrapper×1、id×1、相对残留 0、`ELECTRON_RUN_AS_NODE=1` |
| 受管正控（team `prepare()` `/team/dispatch` 离线等价） | 4 | 同上（`team prepare()` 的冻结侧账号参数为空 = 整份复用） |
| 普通 Qoder 正控（`qoderclicn` × 三入口） | 3 | `--config-dir <A>` **恰好 1 次**、env 逐项一致 |
| **Qoder 硬绑定别名**（`qoder-cn-acct-a/b` × 四入口） | 10 | **全部走通**（改前 `/task/start` 400、`/dispatch` argv 双写）⇒ 硬绑定别名不再被误拒 **10/10** |
| 负控：cross-account / 跨 Harness / 错配目标 | 28 | **28/28 显式拒绝且 sink 调用 0** |
| 负控：篡改配方（相对 wrapper / 换 id / 删 env / 换 exe / `acpArgs` 同形）× 2 入口 | 10 | 10/10 拒绝、sink 0 |
| 重复 `config-dir` 的格 | 0 | 「同一个 `--config-dir` 值在整条 argv 里出现次数」全部 == 1 |
| 拒绝文案含**原始** accountId | 0 | 全部经 `redactAccountIdsInText()` |

**基线对比（普通路径逐字等价）**：与上一轮 `probe/out/managed-account-target/after.json`
逐字段比对，**差异 0 条**（5 条普通 Qoder 用例的 `args` 完全一致）。

**别名 vs 派发（逐字）**：`node probe/_check-alias-dispatch-equivalence.mjs` → PASS，
4 个别名目标的 `command/args/acpArgs/env` 与 `withAccountTarget()` 的产物**逐字相同**；
「别名接受 ⇒ 派发必接受」的硬约束在 **35 目标 × 4 档案** 全组合上无一违反。

## 4. 三类同类缺口（改前形状 → 改后形状）

1. **team 冻结配方 prepend（已确证）**：`resolveAccountRecipe()` 冻结的受管 `args` 是**相对**的
   `['workbuddy-managed.cjs', <id>]`，派发侧 `[...frozen.args, ...found.args]` ⇒
   `["workbuddy-managed.cjs", <id>, "<绝对 wrapper>", <id>, "-p"]`（两个 WB 账号 2/2）。
   **改后**：`applyAccountToTarget()` 走受管分支**整份复用**目标元组（`args`/`acpArgs`/`env` 全来自计划）。
   其探针 `verify-team-routing-frozen-recipe` 只用普通 Qoder 账号判等价 ⇒ 那一格**曾经是假绿**；
   现在由本轮的 53 格矩阵覆盖（受管 × 团队两入口）。
2. **`/dispatch` 第二份实现**：无同 Harness 判定、note 未脱敏、受管同样双写。
   **改后**：走 `withAccountTarget()`；note 在构造处 `redactAccountIdsInText()`，
   本轮矩阵里「含原始 id 的拒绝文案」= **0**。
3. **Qoder 硬绑定别名被误拒**：`seedForTarget('qoder-cn-acct-a')` 解析不到档案 ⇒
   `targetSeedId` 回落成目标名 ⇒ `/task/start` 一律 400「不是同一个 Harness」。
   **改后**：`sameAccountRecipe()` 用**真实完整配方**（配置目录 + 可执行文件 + 参数前缀 + env 四项）
   认成「同一账号」⇒ **整份复用、不重复注入**。命令比较必须做 `.exe` 去尾归一
   （档案写裸名 `qoderclicn`、目标写绝对路径 `…\qoderclicn.exe`；不归一就会误拒）。

## 5. 一条真实产品路径（唯一一次真实调用）

`POST /harness-pilot/api/task/start`（`target=qoder-cn-acct-a`、`accountId=qoder-cn-a`、
prompt `Reply with exactly: PONG`、`notify:false`、`timeout_ms=180000`）：

| 观测 | 值 |
| --- | --- |
| HTTP | **200**（改前这条是 **400**） |
| `account` note | `account=acct:…-aa configDir=…\harness-accounts\acct:…-aa — …（该目标已按真实完整配方带着这个账号：可执行文件 / 参数前缀 / 配置目录 / 环境变量逐项一致 ⇒ 整份复用，不重复注入）`（**脱敏**） |
| 任务 | `fb8783da-1b8f-4469-a7f5-9bd2e942c785`、`status=completed`、`transport=headless`、`elapsed 13236 ms` |
| 回复 | `PONG`（`text="PONG\n"`，`output_chars=5`；`exitCode=0`） |
| `actual` | `{harnessId: qoder-cn-acct-a, transport: headless, accountId: acct:…-aa}`；`actualSource=transport-outcome` |
| 真实进程 | `facts.command = C:\Users\Administrator\.qodersec\bin\qoderclicn.exe`、`pid=16848`、`spawnedAt 02:01:29.214Z → exitedAt 02:01:41.807Z`、`cancelled=false`、`treeKillIssued=false`、`ladder=headless=ok` |
| **argv 长度交叉核对** | `facts.argvChars = 123`；用**产品代码**算出的 `command + args` 长度**恰好 123**，加 prompt 会是 148 ⇒ 真实 spawn 的那条命令行**就是** `qoderclicn.exe --config-dir …\acct:…-aa -p`（**一个** `--config-dir`、**一个**目录） |
| 进程收尾 | `/diag/processpool`：`ownedPids=[16848]`、`runningOwnedPids=[]`、`lingeringAtTaskEnd=[]`、`unconfirmedReleases=0` |
| 证据文件 | `probe/out/managed-account-target/real-task-qoder-hardbound.json` |

> ⚠️ **如实说明这条证据的边界**：headless 通道的 `facts` **故意不含完整 argv**
> （`promptDelivery='argv'` 时那段命令行里带着整段 prompt，记进去等于把会话正文搬进日志）。
> 所以「argv 里只有一个 `--config-dir`」这一格的证据是
> **真实 `command` + 真实 `argvChars` 与代码路径算出的长度逐位相等**，
> **不是**从 OS 层抓取的进程命令行。离线侧那一格由矩阵的 argv 重建承担（同一条代码路径）。

## 6. B 的因果链核查（**如实说**）

只读复核（**不跑任何真实调用**）：`probe/out/bridge-attribution-history.json`（01:21:31）。

| 方向 | 判据（同一条 `messageId`） | 结论 |
| --- | --- | --- |
| A→B | CLI `tool.requested=[mcp__dsh_bridge__send_message]` → 桥接 `mcp.tool/call(send_message)` → `mcp.tool/result messageId=team-message-09329b7f-…`（`isError=false`）→ 宿主 mailbox `team/message/queued(senderIsA) + delivered` → **对端（B）会话里同一 messageId 的回执** | **完整 5 环** |
| B→Lead（`mcp.tool/call` → `senderId=B` → `messageId` → Lead 收到） | B 那一轮：CLI 零 `tool.requested`、桥接零 `tools/call`、宿主 mailbox 里 `senderId=B` 的 `queued = 0`；A 之所以说出 token 是**Lead 代发**了同 token 的消息 | **仍未验证**（历史 FAIL 成立） |

**判定**：这不是产品缺陷（桥接链路本身已由 A→B 的 5 环证明可用），而是
**B 这一轮根本没有调用工具**。本轮**没有**、也**不能**用自己的证据取代它 ——
需要一次真实的团队运行（B 自己 `send_message`）才能判定，那会同时占掉全局 lead 会话与额度。
⇒ **沿用旧的「未过」字面，不改为通过**。

## 7. 既有接线逐项重测（改完后仍在）

| 项 | 核对方式 | 结果 |
| --- | --- | --- |
| `TeamRoutingTable` / `team-routing` 接线 | `verify-account-target-unify`（真实 `TeamRoutingTable` + `/team/dispatch` 处理器） | 在；8 格 team 格全 PASS |
| `catalogExtras` | `verify-ui-smoke`（11 项回归内） | PASS |
| `federation/providers.js` | `verify-federation-providers`（回归内）+ `/diag/loaded` 哈希一致 | PASS |
| `accountRuntimeGate` | `verify-managed-bootstrap-gate` | **16/16 OK**（含适配器 1 字节篡改被拒） |
| `mcp-bridge-proxy.js` | 回归内 `verify-ui-smoke` / 桥接探针 + 文件未被本轮触碰 | PASS |
| 门禁两条真实路径（`registry.dispatch()` / 别名 provider `start()`） | `verify-managed-bootstrap-gate` + `verify-subagent-account-alias` | PASS |
| `SELF_MODULES` | `verify-team-routing-selfmodules`：`declaredCount=39`、`diskCount=39`、`setEqual=true` | **39 项**（+`account-target.js`），COVERED |
| 安全 stdio 通道（四处零明文令牌） | `verify-mcp-bridge-live-token-scan` 等本轮未触碰；回归内 `verify-ui-smoke` 通过 | 未改动 |

## 8. 回归与陈旧自检

* `node probe/_regression-suite.mjs` → **11/11 PASS**（退出码 0）。
* 构建：`node scripts/build.mjs` **exit 0 且出现 client 拷贝行**；三工件一致
  `client/client.js = client.js = lib/client.js = 9414deac2c3af8d1…`；
  冻结受管适配器 `assets/workbuddy-managed.cjs = 3032e84f623d0644…`（**未触碰**）。
* `GET /harness-pilot/api/diag/loaded` → `anyStale=false`、**39** 个模块，
  `index.js 3bbd30025934`、`account-target.js 50341f1a0f34`、`team-routing.js ae460bc659dd`、
  `provider.js e6ca7bb93a0e`、`processpool.js 461000087d68`，loaded == disk。
* 宿主**没有**重启：`processpool.loadedAt = 2026-10-14T02:00:19.582Z`（本轮最后一次热重载），
  用户点名的 08:29:17 重启发生在**本轮之前** ⇒ 本轮全部活体证据属于「重启后」这一层。

## 9. 本轮改动清单（含**如实**标注的范围外一处）

| # | 文件 | 改动 | 性质 |
| --- | --- | --- | --- |
| 1 | `src/account-target.ts` | 新建：唯一来源（含受管元组核对 / 硬绑定识别 / 冻结合并 / 错配判据） | 新建 |
| 2 | `src/index.ts` | 删掉三个私有实现（`withAccountTarget` / `managedRecipeTupleProblem` / `claimManagedAccountRecipe`），六个调用点改走新模块；`/dispatch` 删掉第二份内联；两处冻结合并改走 `applyAccountToTarget()`；`registerProviders` 第 7 形参注入；`SELF_MODULES` + `account-target.js`（38→39） | 收口 + 加法 |
| 3 | `src/team-routing.ts` | `resolveAccountRecipe` 改为再导出；`prepare()` 的账号分支委派 `withAccountTarget()`；新增 `accountSideOf()`（三态：整份复用 ⇒ 账号侧为空 / 普通 ⇒ 档案配方 / 差分兜底） | 收口 |
| 4 | `src/provider.ts` | 普通账号别名分支**不再自己拼一份**：`injectedMerge ?? options.withAccount ?? 惰性解析`；新增 `AccountMergeLike` / `mergeAccountByPolicyLazy()`；`registerProviders` 加第 7 形参 | 收口 |
| 5 | `src/processpool.ts` | **只改注释**：过时条数 `37 项` → `39 项`（`SELF_MODULES` 那两处说明） | ⚠️ 范围外（注释） |

**保留项**（逐项核对仍在）：`TeamRoutingTable`/`team-routing` 接线、`catalogExtras`、
`federation/providers.js`、`accountRuntimeGate`、`mcp-bridge-proxy.js`、
`managedBootstrapRuntimeGate`（两条真实路径）、安全 stdio 通道。

## 10. 本轮**未**验证 / 未做（不得外推）

1. **团队冻结配方的活体验收没跑**：`/probe/team/*` 是**全局 lead 会话**，与其它路同跑会互相
   摧毁证据，且本轮额度只允许**一条**真实调用（已用于 §5）。所以「team prepare/冻结配方」
   这一格是**离线真实代码 + 真实处理器**取证，**不是**活体成员跑通。
2. **子代理 provider 的活体驱动没跑**：`harness_agent` 要真起 Agent 会话；
   本轮用的是「同函数同入参的离线等价」+ `verify-subagent-account-alias` 的真实
   `SubagentProvider.start()` → 真 headless → 替身进程（77 断言，零额度）。
3. **真实进程 argv 没有从 OS 层抓取**（headless `facts` 故意不给完整 argv）——
   见 §5 的边界说明。
4. **B→Lead 的因果链仍未验证**（§6），沿用旧字面「未过」。
5. **`verify-api-account-redaction` 的越界项仍在**：`GET /overview` 的
   `$.targets[].description` 含原始档案 id —— 责任方是 `src/config.ts` 的**目标描述文案**
   （历史声明式数据，不在本轮范围）。该脚本对本轮改动负责的出口判 PASS，越界项如实保留（退出码 2）。
6. **`/team/dispatch` 的 `note` 仍是原始 `configDir` 路径**（含档案 id 的目录名）：
   它由 `redactAccount()` 脱敏了 `account=` 那一段，但 `configDir=` 是**路径**，
   与工具面历史行为一致（本轮未改口径）。

## 11. 复现命令

```powershell
cd D:\Project\dsh-harness-pilot
node scripts/build.mjs                                        # exit 0 且出现 client 拷贝行
node probe/verify-account-target-unify.mjs after              # 53 格矩阵，PASS 53 / FAIL 0
node probe/_check-alias-dispatch-equivalence.mjs              # 别名合并 == 派发合并
node probe/verify-managed-account-target-fix.mjs after         # 受管基线（4/4 正控 · 4/4 负控 · 5/5 篡改）
node probe/verify-team-routing-frozen-recipe.mjs              # 普通 Qoder 等价性（旧口径，仍 PASS）
node probe/verify-managed-bootstrap-gate.mjs                  # 16/16
node probe/verify-team-routing-selfmodules.mjs                # 39 项集合相等
node probe/_regression-suite.mjs                              # 11/11 PASS
node probe/verify-managed-account-real-task.mjs qoder-cn-acct-a qoder-cn-a "Reply with exactly: PONG" real-task-qoder-hardbound
```

## 12. 工件哈希（本轮）

| 工件 | sha256 |
| --- | --- |
| `src/account-target.ts` | `b91db63b3562913f3ebde2702dc81803f106e683a2d30c41ab21327004c8e11d` |
| `src/index.ts` | `081523a99002d4f6ebf4bfca1eb407c18a83a3a159b9f12c00d7a30408c68cbd` |
| `src/team-routing.ts` | `eb203c1b3424ca3fd96d773df3d9bc3daa5f54b7b2ad7b5cdc69e75fede46738` |
| `src/provider.ts` | `0a476fa39aff3b985b602539c6aa4a6b63bd40db3413e56417a8263d1d5c95d2` |
| `lib/index.js` | `3bbd30025934079bad9acc13734ab0e4e1203e3f314e0bf58d4951f85fb304f4` |
| `lib/account-target.js` | `50341f1a0f34ae27527e3283bb10b5b885e44ecab70da01bdffb3932deaaa089` |
| `client/client.js` = `client.js` = `lib/client.js` | `9414deac2c3af8d157103c10f0a43394…` |
| `assets/workbuddy-managed.cjs`（冻结实体） | `3032e84f623d06441aa8d81ac55547ad6c8e9c8431f4608cd30133f1c39a7ac1` |
