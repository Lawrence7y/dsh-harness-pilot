# 2026-10-14 23:5x · 第十六轮：请求值 ≠ 实际值的**可见位**（需求 ⑧ 收尾）

## 1. 缺口：归因只在账本里，**会话里看不到**

插件有两个既有能力，但**没接上**：
- `task-tools.ts` 早就有 `actualIdentityLines()` / `mismatchLines()`（逐字段对照、未回报就说未回报）；
- `wake.ts` 的 `buildReceipt()` 是插件**唯一**写进 DSH 会话的东西 —— 但它只写
  「回执 ID / 目标（model=请求值）/ 终态 / 工作区 / 交付正文」，**完全不含实际身份**。

⇒ 用户在会话里看到的是「任务完成 + 一个请求过的模型名」，而**实际用了什么 model/provider、
请求与实际是否一致、有没有回报** —— 全都只有翻账本才知道。这正是需求 ⑧
「呈现真实 model/provider 归属，请求值 ≠ 实际值时提示、未知即未知」缺的那一格。

## 2. 本轮实现

| 位置 | 改动 |
|---|---|
| `src/task-tools.ts` | 把逐字段对照抽成**单一实现** `compareIdentity(view)` → `{evaluated, compared, differences, missing, recorded}`；新增一行结论 `identityVerdictLine(comparison)`；`mismatchLines()` 改为**只负责排版**、复用同一份对照（不写第二遍比对） |
| `src/wake.ts` | 回执新增身份段：`----- 执行身份（请求值 vs 实际回报）-----` + `结论：…` + `actualIdentityLines()` + `mismatchLines()` + 结束标记 |
| `src/index.ts` | `/overview.tasks[]` 附带 `identity = {verdict, evaluated, compared, differences, missing, recorded}`（服务端算，客户端不重新实现比对） |
| `client/client.js` | 设置页任务面板每条任务显示身份徽章（`⚠️ 身份不一致 / 未回报` 或 `身份：…`，title 里给全文） |

**结论行的四态（顺序即优先级）**
1. 通道**已记录**的不一致（`mismatch[]`，如别名绑定账号与实际回报账号不符）⇒ `⚠️ 请求值 ≠ 实际值（不得当作成功）`；
2. **比出来的**不一致（请求 model=X / 实际 Y）⇒ 同上并列出差异字段；
3. 实际**未回报**某字段 ⇒ 「实际身份**未完整回报**（缺 model）⇒ 无法判定一致」——**不是** mismatch 语气，但也**不许**说一致；
4. 两侧都有证据且一致 ⇒ 「已有两侧证据的字段一致（…）；**不代表整体身份已确认**」。

**证据来源纪律**（沿用既有实现，不放松）：`provider`/`model` 只有在 `actualSource === 'transport-outcome'`
（真的来自执行回报）时才参与比较；ACP 之类的「配置应答」不算 —— 历史记录缺来源标记时，界面上写明「不能用旧记录确认本轮采用值」。

## 3. 实测

**live（真跑一条任务，模型实际未回报）**
```
harness_task_start(target='qoderclicn', model='Qwen3.8-Flash', prompt='ticket R10-ID-1 …')
  → 任务终态 error（CLI 原话 `Not logged in · Please run /login` —— 该全局根未登录，插件**没有**回退到任何已登录账号）
  → 账本：requested.model=Qwen3.8-Flash，actual.model=''（未回报），actualSource=transport-outcome

/overview.tasks[该任务].identity
  verdict = 实际身份**未完整回报**（缺 model）⇒ 无法判定一致
  missing = model      compared = harnessId

回执（**真的进了我的会话转录**，落在 `agent/inbox/spliced` 的 next-turn 插入里）
  Harness Pilot 子代理任务完成回执。…
  回执 ID：50de0583-…；目标：qoderclicn（model=Qwen3.8-Flash）；终态：error。
  ----- 执行身份（请求值 vs 实际回报）-----
    结论：实际身份**未完整回报**（缺 model）⇒ 无法判定一致
    actual: harness=qoderclicn account=(未回报：无法确认账号档案是否被采用) provider=(未回报)
            model=(未回报) nativeSessionId=(未回报：本通道未提取原生会话 id …) transport=headless
    requested: harness=qoderclicn account=(未回报) provider=(未回报) model=Qwen3.8-Flash
      （model 未回报，无法确认实际模型；ACP 配置应答不能证明本轮采用了请求模型）
  ----- 执行身份结束 -----
```
⇒ 「未知即未知」在**会话里**就是这句话，而不是让用户把 `model=Qwen3.8-Flash` 读成「实际用了它」。

**探针**
- 新增 `probe/verify-identity-verdict.mjs`：6 例覆盖四态 + 证据来源纪律，全 PASS；
- `probe/verify-receipt-lands-in-session.mjs` 增强：现在**必须**在会话转录里找到身份段，
  否则报 `RECEIPT_PRESENT_BUT_NO_IDENTITY_BLOCK` 并以非 0 退出。实测
  `identity_block.present=true / has_verdict=true / says_not_reported=true`。

## 4. 三态清单

- **已实现且实测通过**：对照逻辑单一实现；回执带身份段（会话转录里已核）；四态结论（含未知）；证据来源纪律；
  设置页任务面板身份徽章；两个探针（含会话可见性断言）。
- **已实现但未验证**：真浏览器里那条徽章的观感（离线渲染 + live `/overview` 已验，未做真点击）；
  子代理**会话页**（宿主 conversation chrome）里的身份位 —— 宿主没有插件可用的槽位，
  所以归因落在**回执**与**账面**两处（这一点在文档里如实标注为上游限制）。
- **尚未实现（下一轮）**：① 设置页「模型来源与四类」的真浏览器点击验收；② `harness_send` 的 CDP
  `model` 路径归并到 `resolveModelRequest`（现在那条路不校验）；③ 跨会话的「同一任务在多处显示的身份一致性」复核。
- **受上游限制**：宿主 conversation chrome 没有插件插槽（此前实测 `session.header.utilities` 徽章不渲染），
  因此「会话内可见」只能靠**回执**这一条插件自有写入路径。

## 5. 复现

```powershell
node scripts/build.mjs
node probe/verify-identity-verdict.mjs            # 离线四态 + 证据来源纪律
node probe/verify-receipt-lands-in-session.mjs    # 回执进会话 + 身份段存在（非 0 退出即失败）
node probe/_regression-suite.mjs                  # 22 项

# live：/overview.tasks[].identity.verdict 与回执正文
(Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/overview').tasks |
  Select-Object -First 3 task_id,target,status,@{n='verdict';e={$_.identity.verdict}}
```
