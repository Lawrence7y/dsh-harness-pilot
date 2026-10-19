# 2026-10-14 21:4x · 第十一轮：修 Antigravity 模型使用报错（需求 ⑦）+ 账号池默认账号按目标分域（需求 ④）

## 1. 先把用户报的「Antigravity 模型使用报错」取证到底

插件自己的任务账本里留着三次 agy 失败（`~/.dsh/plugins/harness-pilot/tasks/*.json`）。逐条读出来的**真因不是 agy**：

| 任务 | 目标 | 记录里的 `actual.accountId` | 报错文本 |
|---|---|---|---|
| `f4b473be-…` | `agy` | **`qoder-cn-a`** | `flags provided but not defined: -config-dir` + agy 的 usage 列表（exit 2，306ms） |
| `f552c3d9-…` | `agy` | **`workbuddy-a`** | `Error: unexpected argument "workbuddy-managed.cjs".`（exit 2，317ms） |
| `551a0ef0-…` | （另一个目标） | — | `Error: unexpected argument "ID".` |

⇒ 三次都是**别家 harness 的账号配方被拼进了 agy 的命令行**（`--config-dir` 是 Qoder 的旗标、
`workbuddy-managed.cjs <账号 id>` 是 WorkBuddy 的启动元组）。agy 一个都不认，exit 2。
**这不是「模型用不了」，是「命令行被污染」** —— 也就是说：用户看到的「Antigravity 模型使用报错」
是整个目标被跨 harness 账号污染搞坏的。

## 2. 修掉的两个缺陷

### ① 跨 harness 注入现在**显式拒绝**（复核既有实现，给出证据）
`withAccountTarget()`（`src/account-target.ts` 唯一实现）第 ④ 分支已有同 Harness 判定。实测（本轮）：

```
POST /dispatch {"target":"agy","accountId":"qoder-cn-a"}    → 400 账号 acct:…-aa 属于 Harness「qoder-cn」，与目标「agy」…不是同一个 Harness
POST /dispatch {"target":"agy","accountId":"workbuddy-a"}   → 400 受管 bootstrap 账号 … 在目标「agy」上没有可用的**已验收启动计划**
POST /task/start {"target":"agy","accountId":"qoder-cn-a"}  → 400 同上（任务链同一实现）
```
⇒ 历史那三次的 argv 污染路径已经不存在；显式点名外来账号一律大声拒绝。

### ② 新缺陷（本轮实测发现并修）：账号池**默认账号是全局一个**，会被当成「任何目标都能用」

实测（改之前）：把池默认设成 `workbuddy-a`，然后向 `agy` 派发（**不给** `accountId`）：
```
POST /dispatch {"target":"agy","prompt":"ping"}  → 400 受管 bootstrap 账号 … 在目标「agy」上没有可用的已验收启动计划
```
即：**换一个默认账号，别的 harness 全部派发失败**。这与需求 ④「切换新任务默认账号不得影响在跑会话/子代理」
直接冲突（虽然它没有静默串号，但它把无关目标整个打挂了）。

修法 —— 新增 `src/account-target.ts` 的 `defaultAccountForTarget()`（唯一实现），语义与显式账号**刻意不同**：

| | 不属于本目标时 |
|---|---|
| **显式** `accountId` | **大声拒绝**（不许静默串号） |
| **默认/兜底**账号 | **不套用**（`accountId:''` + 可读原因），派发照常 |

判据用 `src/harness-groups.ts` 的**产品身份表**（`classifyTarget` / `classifyHarnessId`），
**不**用 `seedForTarget(target.name)?.id`：实测踩到 —— 内置 WorkBuddy 档案的 `targetName` 写成了账号 id
（`src/federation/accounts.ts:162`），于是 `seedForTarget('wb-managed-a')` 解析不到，
会把**唯一正确的配对**（`workbuddy-a` × `wb-managed-a`）误判成跨 harness。

四条链全部接到同一处（离线探针静态断言调用点，残留全局兜底 = 0）：
`/dispatch`、`/task/start`、`harness_task_start`（`src/task-tools.ts`）、
会话/子代理路由（`src/llm-adapter.ts` 的 `deps.defaultAccountFor`）。
`catalog plan` 那条也一并分域（它此前同样先看全局默认）。

## 3. 实测（live，改之后）

```
池默认 = workbuddy-a
① POST /dispatch {target:'agy'}                 → 200 stopReason=completed，agy 真的跑了：
     text={"status":"SUCCESS","response":"AGY-R5-C3\n",...}
     account=账号池默认账号属于 Harness「workbuddy」，与目标「agy」（antigravity）不是同一个 Harness
             ⇒ 本次**不套用**它（目标用自己的账号/全局认证；不影响这次派发）
② POST /llm-adapter/stream {provider:'harness-antigravity', model:'gemini-3.8-flash-low'}
                                                → ok=True，agy 真的跑了（296 字节回复）
     跳过原因记在**路由账本** `records[-1].error`（成功路径不往对话正文里塞东西）
③ POST /dispatch {target:'wb-managed-a'}        → 200 text=WB-R5-D4
     argv=D:\workbuddy\WorkBuddy.exe …\workbuddy-managed.cjs workbuddy-a --acp   ← 同 harness ⇒ 正确套用默认账号
   （note 已脱敏：account=acct:…-ab）
④ 回归护栏：显式外来账号 POST /dispatch {target:'agy', accountId:'qoder-cn-a'} → 仍然 400 大声拒绝
⑤ 池默认已还原为空（改测试不留状态）
```

## 4. 三态清单

- **已实现且实测通过**：三次历史 argv 污染的根因定位（账本逐条）；跨 harness 显式注入在 `/dispatch` 与
  `/task/start` 都被显式拒绝；池默认账号按目标分域（`agy` 跳过并成功 / `wb-managed-a` 正确套用）；
  会话路由链同上；显式外来账号护栏未放松；离线探针 6 组断言（含「同 harness 必须套用」的反向控制）+
  静态断言四条链都走唯一实现；池状态已还原。
- **已实现但未验证**：`harness_task_start`（工具链）的 live 行为（离线已断言调用点，未真跑一次工具）；
  `agy` 在**多账号/多会话并发**下的表现（下一项）。
- **尚未实现（下一轮）**：
  1. 多账号**并行**任务验收（Qoder CN/INTL + WorkBuddy CN/INTL 同时跑）+ 空认证环境**不回退全局账号**的反向对照。
  2. WorkBuddy 账号档案 `targetName` 写错（`src/federation/accounts.ts:162/224`）—— 本轮它已经真实咬到一次
     （分域判据被迫绕开 `seedForTarget`），建议直接修档案而不是继续绕。
  3. Antigravity 的**共享认证槽**边界在设置页的显式说明（现在只写在隔离档案里）。
- **受上游限制**：`agy` 没有 `--config-dir` 一类的账号旗标 ⇒ 账号隔离只能靠「按档案隔离的配置目录 +
  认证存储随它变化」，本插件不能凭空给它加旗标（这正是历史污染的来源，已改为拒绝而不是硬拼）。

## 5. 复现

```powershell
node scripts/build.mjs
node probe/verify-default-account-scope.mjs     # 分域语义 + 显式拒绝对照 + 四条链静态断言

# live（会真的调 agy / WorkBuddy，各一次短问答）
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/pool' -Method Post -ContentType 'application/json' -Body '{"defaultAccountId":"workbuddy-a"}'
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/dispatch' -Method Post -ContentType 'application/json' -Body '{"target":"agy","prompt":"Reply with exactly: AGY-R5-C3"}'
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/pool' -Method Post -ContentType 'application/json' -Body '{"defaultAccountId":null}'   # 还原
```
