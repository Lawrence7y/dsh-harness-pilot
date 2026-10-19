# 2026-10-14 20:3x–21:0x · 第九轮：子代理模型白名单（让「外部 CLI 模型」在**原生子代理入口**真的可用）

> 用户要求第 ⑤ 条：「该 harness 中的模型，**能够选择哪些在会话和子代理选择中被选择**」；
> 第 ⑧ 条：「外部 CLI 必须能够通过 DSH 的原生模型选择**和原生子代理入口**作为独立子代理执行任务」。

## 1. 为什么上一轮之后子代理侧是断的（真缺口）

| 链路 | 可见性来源 | 结论 |
|---|---|---|
| 会话选择器 | `remote.session.modelCatalog()` → `buildModelCatalog()`（`dsh-api-session-controller/lib/index.js:500-548`） | 只要插件注册 provider 就有 ⇒ 上一轮已通 |
| **子代理** | 同一份目录 **再叠一道精确串白名单**：`dsh-tool-subagent/lib/index.js:91-98` 的 `assertAllowedModelSelection`（`policy.routes.some(r => r.provider===p && r.model===m)`），不匹配就抛 `child LLM route "P/M" is not allowed for this Session`；`list_subagent_models` 也被同一份白名单过滤（`:150-162`） | 上一轮把目录改成 `harness-*` 之后，profile 里那 652 条**全是** `pilot-cli/*` 等旧条目 ⇒ **新路由一条都不在白名单里**，子代理侧实际不可用 |

**实测前置证据（本轮写前）**：
```
GET  /harness-pilot/api/subagent-model-selection → allowedCount=652，其中 harness-* 条目 = 0，candidateCount=590
原生子代理（本会话）：subagent(provider=harness-qoder-cn, model=Qwen3.8-Flash)
  → Error: child LLM route "harness-qoder-cn/Qwen3.8-Flash" is not allowed for this Session
```

## 2. 本轮实现

| 位置 | 内容 |
|---|---|
| `src/subagent-models.ts`（新增） | `normalizeRoutes` / `planPolicyChange`（只算加/删/已在/不存在，**绝不隐式清理**别人的条目）/ `readPolicy`（**服务值优先**＝运行期生效值，revision 取自设置文档）/ `applyPolicyChange`（每次 `settings.update` + **独立回读**）/ `candidatesFor`（不截断） |
| `src/index.ts` | `GET/POST /harness-pilot/api/subagent-model-selection`：GET 给现状 + 590 个候选 + 白名单里**别人的**条目（只报告，绝不清理）；POST 支持 `dryRun`，真写前落**回滚快照**（`~/.dsh/plugins/harness-pilot/subagent-model-backups/*.json`），写后回读并与目标比对，返回 `rollback.reverse`；`/overview.harnessGroups[].subagent` 带每组的 `allowedCount/candidateCount/writable`（首屏即有摘要）；新增 `POST /session/probe-turn`（**只建会话 + 发一条消息**，用于「新会话才生效」这类验收） |
| `client/client.js` | 每条 harness 的「可选择」块里新增 **SubagentPolicyPicker**：`可在子代理中被选择：N / M 个模型` + 「选择」展开（搜索框 + 复选框 + 改动摘要 + 「应用到新会话」）+ 结果行（回读一致 / 冲突 / 快照路径）+ 「只影响新会话」边界说明 |
| 探针 | 新增 `verify-subagent-model-policy`（离线纯逻辑，含三条失败路径）；`verify-ui-smoke` 增加三项断言（入口存在、**不得**再写「下一步实现 / 不做静默写入」的失实陈述、必须说明只对新会话生效） |

## 3. 端到端实测（原生子代理入口 → 外部 CLI）

**① 写入白名单（dry-run 先看差分，再真写）**
```
POST {add:[{provider:'harness-qoder-cn',model:'Qwen3.8-Flash'}], dryRun:true}
  → changed=true additions=1 removals=0 before=652 next=653；再读仍 652（确认没写）
POST 同上（真写）
  → ok=true verified=true conflict=false
  → readback=653；快照 = ~/.dsh/plugins/harness-pilot/subagent-model-backups/2026-10-14T12-06-27-954Z.json
  → 宿主原有 652 条（opencode-go / pilot-cli / step / xiaomi）一条未动
```

**② 本会话**（策略已在创建时记录）仍然拒绝 —— 这不是 bug，是宿主契约：
```
subagent(provider=harness-qoder-cn, model=Qwen3.8-Flash)
  → Error: child LLM route "harness-qoder-cn/Qwen3.8-Flash" is not allowed for this Session
```

**③ 新会话**（`POST /session/probe-turn` 建 `session-probe-mv82k4g3`）里的完整证据链：

| 证据 | 值 |
|---|---|
| 新会话策略事件 `subagent/model-selection-policy` | `allowedModels = 653`，含 `{provider:"harness-qoder-cn", model:"Qwen3.8-Flash"}` |
| 原生 agent 的 `tool/call` | `{"name":"subagent","arguments":{"provider":"harness-qoder-cn","model":"Qwen3.8-Flash","prompt":"Reply with exactly: NATIVESUB-OK HPQD-R3-B2",…}}` |
| `tool/result` | `NATIVESUB-OK HPQD-R3-B2` |
| **子会话** `2a5c20bf-…`（`subagent/descriptor = {mode:"one-shot", provider:"spawn"}`） | `request/header.config = {"provider":"harness-qoder-cn","model":"Qwen3.8-Flash"}`；`assistant/message.source` = **同一对**；`turn/end = completed` |
| **外部 CLI 侧**（qoder 自己写的 run manifest） | `bun … --config-dir …\harness-accounts\qoder-cn-a -m Qwen3.8-Flash -p --mcp-config …` |

⇒ 「请求值 = 子会话路由 = assistant 归属 = CLI 实参」四处一致，且跑的是**账号隔离**目标（未回退全局账号）。

## 4. 三态清单（本轮）

- **已实现且实测通过**：白名单读（现状/revision/候选）；dry-run 差分；真写 + 快照 + 独立回读；宿主既有条目零改动；
  **原生子代理入口**在 `harness-qoder-cn/Qwen3.8-Flash` 上真实执行（上文四处一致）；「新会话才生效」的边界被实测确认；
  设置页可勾选入口（UI smoke 3 条断言通过）；离线探针覆盖冲突/回读不一致/无写入面。
- **已实现但未验证**：浏览器里实际点击勾选（离线渲染 + live HTTP 已验，未做真点击）；`remove` 路径只做了离线单测，
  未在 live profile 上真删过一条（避免动用户配置）；`/session/probe-turn` 只用于验收，未加入常规回归。
- **尚未实现（下一轮）**：
  1. **模型来源链**（真实 CLI 查询 → 原生配置 → 官方缓存 → 有据别名）与每条目四态 + 未安装/未登录/无供应商/无列举能力。
  2. `harness_agent` / 任务工具的 `model` 收敛到新的分组 id（现在仍接受自由字符串）。
  3. Antigravity 历史 `exit 2`（argv 污染）复核 + 多账号并行任务验收 + 空认证不回退全局账号的反向对照。
  4. WorkBuddy 账号档案 `targetName` 写成了账号 id（`src/federation/accounts.ts:162/224`）⇒ 别名 provider 全被拒。
- **受上游限制**：宿主在**会话创建时**记录一次策略（`selectForSession`），所以白名单变更**无法**作用于已开会话
  —— 界面上已明说，不假装能改。

## 5. 复现

```powershell
node scripts/build.mjs
node probe/verify-subagent-model-policy.mjs      # 离线：差分/冲突/回读/无写入面
node probe/verify-ui-smoke.mjs                   # 设置页可勾选入口 + 不得失实陈述

# 现状与候选（live）
(Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/subagent-model-selection') |
  Select-Object available,writable,revision,allowedCount,candidateCount,foreignCount
# dry-run（不写）
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/subagent-model-selection' -Method Post `
  -ContentType 'application/json' -Body '{"add":[{"provider":"harness-qoder-cn","model":"Qwen3.8-Flash"}],"dryRun":true}'
# 回滚（把本次加上的删掉）
#   POST {"remove":[{"provider":"harness-qoder-cn","model":"Qwen3.8-Flash"}]}
```
