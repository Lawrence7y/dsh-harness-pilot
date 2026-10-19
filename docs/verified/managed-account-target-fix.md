# 受管 bootstrap 账号配方的「重复 wrapper」修复（`withAccountTarget`）

> 结论一句话：`withAccountTarget()` 对 **受管 bootstrap（WorkBuddy）** 账号此前走的是
> 「把档案的**相对** `launch.args` 前置到目标参数前面」，于是拼出
> `WorkBuddy.exe workbuddy-managed.cjs <id> <绝对 wrapper> <id> -p`（**两个 wrapper、两个 id**）；
> 现在改为用 `planAccountAliases([target], …)` **认领该账号的完整已验收元组并整份复用**，
> 认不到合法计划就**显式拒绝**（脱敏、不 fallback、不换账号）。
> 同一轮里 `/dispatch` 的**第二份**内联合并（受管账号同样出错、且**没有**同 Harness 判定）
> 也改成走这一处实现；普通账号的内联分支**逐字保留**（本轮验收要求逐字等价）。
>
> 本轮改动文件：`src/index.ts`（独占）+ 三个探针 + 本文档。**未改**任何其它 `src/**`。

## 1. 缺陷（修复前**实测**形状，非读代码推断）

取证脚本：`probe/verify-managed-account-target-fix.mjs`（驱动**编译产物** `lib/index.js` 的
`createApiHandler()` —— 真实 HTTP 处理器；只把下游 sink 换成记录器，**不启动任何厂商 CLI**）。
基线报告：`probe/out/managed-account-target/before.json`（`lib/index.js` = `257d414422f4…`）。

| 入口 | 目标 | 账号（脱敏） | 修复前实测 |
| --- | --- | --- | --- |
| `POST /task/start` | `wb-managed-a` | `acct:…-ab` | **HTTP 400**：`账号 acct:…-ab 属于 Harness「workbuddy」，与目标「wb-managed-a」（wb-managed-a）不是同一个 Harness…` ⇒ 连配方都没产出（sink 0 次） |
| `POST /dispatch` | `wb-managed-a` | `acct:…-ab` | HTTP 200，argv = `["workbuddy-managed.cjs", "acct:…-ab", "D:\\…\\assets\\workbuddy-managed.cjs", "acct:…-ab", "-p"]` ⇒ 相对 wrapper **残留 1 个**、账号 id **出现 2 次** |
| `POST /dispatch` | `wb-managed-ai-b` | `acct:…-be` | 同上（换另一账号同形） |
| `POST /dispatch` | `wb-managed-a` | `acct:…-be`（**另一个** WB 账号） | HTTP 200，argv = `["workbuddy-managed.cjs", "acct:…-be", "D:\\…\\workbuddy-managed.cjs", "acct:…-ab", "-p"]` ⇒ **静默串号**：B 的 id 被塞进 A 的目标，A 的 id 还在 |

两条并存的根因：

1. `src/federation/accounts.ts` 里受管档案的 `launch.args` 是 `['workbuddy-managed.cjs', <id>]`
   （**相对**名，给「自己解析适配器」的场景用）；而受管目标 `wb-managed-a` /
   `wb-managed-ai-b` 的 `args` / `acpArgs` **已经是**完整元组
   `[<绝对 wrapper>, <id>, '-p'|'--acp']`。`[...launch.args, ...target.args]` 必然重复。
2. 受管账号 ↔ 目标的配对权威是 `provider.ts` 的 `MANAGED_ALIAS_RECIPES`
   （`wb-managed-a` ↔ 档案 `acct:…-ab`），**不是** `seedForTarget(target.name)`；
   受管目标的名字本来就不是任何档案的 `targetName`，所以原先那条同 Harness 判定
   把**唯一正确的配对**判成「不是同一个 Harness」（`/task/start` 对两个 WB 账号一律 400）。
   别名 provider 路径（`planAccountAliases()`）没有这两个问题 —— 它**整份复用**目标元组。

## 2. 修法（锚点清单）

`src/index.ts`（`src/index.ts` sha256 修复前 `134667DF2962DE65…` → 修复后 `d85a1e3a827fb377…`）：

| # | 位置 | 改动 | 性质 |
| --- | --- | --- | --- |
| 1 | `import { join, dirname } from 'node:path'` | 加 `win32` | 加法 |
| 2 | `import { managedBootstrapRuntimeGate, registerProviders, … } from './provider.js'` | 加 `packagedManagedAdapterPath, planAccountAliases` | 加法 |
| 3 | `withAccountTarget()`：`seed === undefined` 之后、原同 Harness 判定**之前** | 新增 `seed.launch.mode === 'managed-bootstrap'` 分支：`claimManagedAccountRecipe()` 认领完整元组 ⇒ **直接返回 `claimed.target`**（`command`/`args`/`acpArgs`/`env` 全来自计划），**不再 prepend `launch.args`** | **加法**（普通账号分支一字未动） |
| 4 | 新增 `managedRecipeTupleProblem()` | 受管元组**逐项**显式核对：`command` 必须是已验收厂商 exe 且绝对；`args`/`acpArgs` 必须各是「绝对 wrapper **恰好 1 次** + 档案 id **恰好 1 次** + 旗标」且**无相对 wrapper 残留**；`env` 两侧都要 `ELECTRON_RUN_AS_NODE=1`；`configDir` 必须是 `~/.dsh/harness-accounts/<档案 id>`；`adapterId` 必须等于档案 id；版本前缀必须**声明** | 加法 |
| 5 | 新增 `claimManagedAccountRecipe()` | `planAccountAliases([target], { accounts: () => seeds, homeDir: home })` → 取 `binding.accountId === 档案 id` 的**唯一**条目 → `managedRecipeTupleProblem()` 复核 → 返回不可变快照。认领不到（0 条 / 多条 / 复核不过）⇒ **显式拒绝**并带出规划期说明（全部经 `redactAccountIdsInText()`） | 加法 |
| 6 | `POST /dispatch` 的账号合并块 | 仅当该账号是 `managed-bootstrap` 时改走 `withAccountTarget(target, accountId, homeDir(), seedsForDispatch)`（与 `/task/start` 同一处实现）；普通账号的内联分支**逐字保留**（外层 `if (!managedSeedForDispatch)` 守卫，不重排原文） | 受管分支加法 + 原分支零改动 |

**保留项（逐项复核仍在，见 §6）**：`fd18add2` 的 `TeamRoutingTable` / `team-routing` 接线与
`SELF_MODULES` 条目、`81b37cbf` 的 `catalogExtras` / `federation/providers.js` /
`accountRuntimeGate` / `mcp-bridge-proxy.js`、以及
`managedBootstrapRuntimeGate()`（`checkManagedBootstrapGate` + `checkAdapterIntegrity`）
在 `registry.dispatch()` 与别名 provider `start()` 两条真实路径上的执行前门禁 —— **均未改动**。

## 3. 零额度正负控证据（argv/env 实测）

同一脚本、同一组用例，修复前/后各跑一次；逐条对比脚本
`probe/_diff-managed-account-target.mjs`（报告：`probe/out/managed-account-target/diff.txt`）。

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| ① 两个 WB 账号经 `withAccountTarget` 都拿到**正确且完整**的配方 | **PASS 4/4** | `args = [<绝对 wrapper>, <档案 id>, '-p']`、`acpArgs = [<绝对 wrapper>, <档案 id>, '--acp']`、`env = {ELECTRON_RUN_AS_NODE: '1'}`、`command` = 已验收厂商 exe（`D:\workbuddy\WorkBuddy.exe` / `D:\workbuddy ai\WorkBuddyAI\WorkBuddyAI.exe`）；**wrapper 绝对路径恰好 1 次、档案 id 恰好 1 次、相对 `workbuddy-managed.cjs` 残留 0 个**（`/task/start` 与 `/dispatch` 各 2 条） |
| ② cross-account 拒绝（A 的账号打 B 的目标，反之亦然；含 `/dispatch`） | **PASS 4/4** | 全部 **HTTP 400** + sink 调用 **0** 次（没有产出配方、没有派发）；拒绝文案含「本次是显式拒绝」「不会改用其它账号、或回退到不带账号的目标」 |
| ②b 跨 Harness（`qoderclicn` + WB 账号） | **PASS**（仍拒绝） | HTTP 400、sink 0；文案由「不是同一个 Harness」变为受管计划拒绝（**仍是显式拒绝**，安全语义未变） |
| ③ 篡改配方拒绝（真实处理器 + 篡改过的 target/seed 输入） | **PASS 5/5** | 5 种篡改全部 400、sink 0：wrapper 换成**相对**名 / 换成另一个账号 id / 删 `ELECTRON_RUN_AS_NODE` / 换厂商 exe / `acpArgs` 改成 headless 同形 |
| ④ 普通 Qoder 行为不变 | **PASS** | `plainCasesDiffering = 0`（5 条普通用例**逐字等价**）；其中 2 条普通拒绝文案（`qoder-cn-acct-a` / `qoder-cn-acct-b` + 对应账号）**逐字相同**（`refusalTextIdentical = 2`） |
| ⑤ 相同 `config-dir` 重复是否去重 | **未去重（有意）** | `/dispatch` `qoder-cn-acct-a` 的 `--config-dir … --config-dir …`（两个**完全相同**的值）修复前后**逐字一致**。去重要证明「去重后 CLI 仍接受且账号未变」，需要一次真实 Qoder 调用，超出本轮「一条真实调用」的额度 ⇒ **不做、也不声称**。（该形状本就是已冻结的观测：`docs/verified/team-routing.md` 第 135 行记录了同形的 `--config-dir` 双写） |

补充：修复前「拒绝文案里出现**原始** accountId」的条数为 **12**，修复后为 **2** —— 剩下 2 条是
**普通**路径（`qoder-cn-acct-a/b`）的历史文案，本轮按「普通路径逐字等价」口径**刻意未改**，
已记为待办（见 §5）。

## 4. 真实调用（一条，最小 prompt）

`probe/verify-managed-account-real-task.mjs`：`POST /harness-pilot/api/task/start`
（`target=wb-managed-a`、`accountId=acct:…-ab`、prompt `Reply with exactly: PONG`、`notify:false`、
`timeout_ms=180000`），随后只读轮询 `GET /task?id=…&result=1`。

| 观测 | 值 |
| --- | --- |
| HTTP | **200**（`account` 字段＝脱敏后的 `account=acct:…-ab configDir=…\harness-accounts\acct:…-ab — 配置目录按档案隔离，但**认证存储未随它隔离**…`） |
| 任务 | `cde995c4-3ee9-4c00-85c9-87514c7b49b7`，`status=completed`，`transport=acp` |
| 回复 | `PONG`（textChars = 4；任务日志 4 字符、`PONG` × 1；`error/login/auth/quota/429` 关键词各 **0** 次） |
| **真进程 argv** | `facts.argv = D:\workbuddy\WorkBuddy.exe D:\Project\dsh-harness-pilot\assets\workbuddy-managed.cjs acct:…-ab --acp` ⇒ 运行中**恰好一个绝对 wrapper、恰好一个档案 id、无相对残留**（这正是 ACP 通道用的 `acpArgs`） |
| 身份 | `requested = {harnessId: wb-managed-a, accountId: acct:…-ab}`；`actual = {harnessId: wb-managed-a, transport: acp, nativeSessionId: 01a137ed-…, accountId: acct:…-ab}` ⇒ 请求身份与**实际**身份一致，无偏差 |
| 进程收尾 | `pid=18184`、`spawnedAt 01:00:50.646Z → exitedAt 01:00:56.717Z`、`terminatedBy=transport-settle-kill`、`treeKillIssued=true`、`cancelled=false` |
| 证据文件 | `probe/out/managed-account-target/real-task.json`、`real-task-view.json`（均经脱敏器） |

> 说明：这次调用的 argv 来自**真实 spawn 的进程事实**（`facts.command/argv`），不是记录器 sink ——
> §3 的记录器只用于零额度正负控。

## 5. 本次**未**改 / 未验证（不得外推）

0. **团队路由的「冻结配方」路径对受管账号有同形状缺陷**（**已确证**，`probe/_finding-team-frozen-recipe.mjs`，
   零额度零 spawn）：`team-routing.ts` 的 `resolveAccountRecipe()` 走 `resolveAccountLaunch()`，
   于是冻结下来的 `account.args` 是**相对**的 `['workbuddy-managed.cjs', <档案 id>]`；
   派发侧（`index.ts` 冻结分支 / `/team/dispatch`）按 `[...frozen.args, ...found.args]` 合并
   ⇒ 合并后 argv = `["workbuddy-managed.cjs", <id>, "<绝对 wrapper>", <id>, "-p"]`
   （相对残留 1、档案 id ×2，两个 WB 账号 **2/2**）。
   **本轮未改**：`src/team-routing.ts` 不在本轮写入范围，且这段接线是 `fd18add2` 刚验收完的，
   改动会作废其证据。⚠️ 它自己的探针 `verify-team-routing-frozen-recipe.mjs` 只用
   `qoder-cn-a/qoder-cn-b`（普通账号）做等价性判定，**不覆盖**受管账号这一格。
1. **`qoder-cn-acct-a` / `qoder-cn-acct-b` 在 `/task/start` 上仍被误拒**（实测 HTTP 400，
   原因仍是「不是同一个 Harness」）：`seedForTarget('qoder-cn-acct-a')` 解析不到档案，
   于是 `targetSeedId` 回落成目标名。这条**不是**本轮口径内的缺陷（普通路径要求逐字等价），
   故**只记录、不改**。它对 P7「2 Qoder 账号并发」验收是真实阻塞点，需要单独一轮修 + 单独取证。
2. **`/dispatch` 的普通账号内联合并**仍是第二份实现：**没有**同 Harness 判定、`account` note
   **未脱敏**（HTTP 出口会带原始 id）。本轮保留是为了普通路径逐字等价；建议下一轮把它也收进
   `withAccountTarget()`（受管那半已经收进去了）。
3. **`config-dir` 重复未去重**（见 §3 ⑤）：**未验证**「去重后 CLI 仍接受且账号未变」。
4. 受管负控的**拒绝文案**有 4 条发生变化（3 条原本是**错的**原因「不是同一个 Harness」）。
   拒绝语义不变（400 + 零派发），但若某处按文案字面匹配断言，需要同步。
5. 本轮**没有**跑 `/probe/team/*`（全局 lead 会话，两路同跑会互相摧毁证据），
   因此**没有**对团队路由做新的活体验收 —— item 5 的「接线仍在」是**静态 + 构建产物 + 运行时模块表**
   三级核对，不是活体成员跑通。

## 6. 复现命令

```powershell
cd D:\Project\dsh-harness-pilot
node probe/verify-managed-account-target-fix.mjs before     # 需在修复前的构建上跑（本次已留存 before.json）
node scripts/build.mjs                                      # 唯一一次构建；退出码 0 才会拷 client
node probe/verify-managed-account-target-fix.mjs after
node probe/_diff-managed-account-target.mjs                 # PASS=exit 0
node probe/verify-managed-bootstrap-gate.mjs                # 16/16 OK（含适配器 1 字节篡改）
node probe/verify-managed-account-real-task.mjs wb-managed-a <账号> "Reply with exactly: PONG"   # 一条真实调用
node probe/_regression-suite.mjs
```

## 7. 工件哈希

| 工件 | 值 |
| --- | --- |
| `src/index.ts`（修复后） | sha256 `d85a1e3a827fb377c5b373b9443e1e339145080ab64abe0fd0112d2449d7de8d` |
| `lib/index.js`（修复前 / 修复后） | `257d414422f4…`（08:48:43 构建，即 `before` 基线）/ `392d7c8863bcc227097f8fac4911b31e3d56d11808783b7d646cdbdc5114d24e` |
| 运行时已加载 | `GET /harness-pilot/api/diag/loaded` → `index.js loaded=392d7c8863bc disk=392d7c8863bc`、`anyStale=false`、38 个模块 |
| 三工件一致 | `client/client.js` = `client.js` = `lib/client.js` = `9414deac2c3af8d1…`（构建非 0 会跳过拷贝，本次退出码 0 且三者一致） |
| 冻结受管适配器 | `assets/workbuddy-managed.cjs` sha256 = `3032e84f623d06441aa8d81ac55547ad6c8e9c8431f4608cd30133f1c39a7ac1`（**未被本次改动触碰**） |
