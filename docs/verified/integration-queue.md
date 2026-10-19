# 待集成队列（Lead 独占）

> **本文件由 Lead 维护**。任何一路回报「完成」时，先对照本表确认：
> 它是否**真的释放**了写入权、以及它的产物**是否已在冻结修订上验证**。
> ⚠️ 本项目已多次出现「一路的现状描述在自己写下之后失效」——**以最终冻结修订上的实测为准**。

## 一、已释放、待我统一构建＋验证

| # | 内容 | 出处 | 验证要求 |
|---|---|---|---|
| 1 | **`actual` 请求值/回报值分离** —— `sessions.ts`/`tasks.ts`/`task-tools.ts`/`provider.ts` 的请求透传与身份文案；`start`/`track` **独立冻结 `requested`**；`actualSource=transport-outcome` **仅接原生 outcome 字段**；旧账本无来源 ⇒ 读视图 provider/model **降未知并标 `legacy-unverified`**（**原文件 SHA 不变**）；拒绝派发**不写**实际 model；ACP ack **不冒充**实际模型；未知**不叫**「未采用/整体一致」 | Codex worker | 统一构建后跑 `verify-actual-identity-offline`（**42 断言**）、`verify-federation-identity`、`verify-catalog-edit`、`verify-subagent-account-alias` |
| 2 | **WorkBuddy 精确受管配方映射** —— `src/provider.ts` + `probe/verify-subagent-account-alias.mjs` + 新增 `verify-managed-account-alias-offline.mjs`；`workbuddy-a/workbuddy/workbuddy-a → wb-managed-a`；`workbuddy-ai-b/workbuddy-ai/workbuddy-ai-b → wb-managed-ai-b`；复用 target 完整 `args`/`acpArgs`/`env`，**不前置 `seed.launch.args`**（防重复 wrapper／错账号） | Codex worker | **离线 96 断言 PASS ≠ 模型调用成功** ⇒ 统一构建后必须跑**原完整 probe + 真实别名行为** |
| 3 | **MCP 安全 stdio 注入** —— `mcp-bridge.ts`（明文 `mcpConfigDocument(url,token)` 已消除）、新增 `mcp-bridge-proxy.ts`、`types.ts` 的 `extraEnv`、`transports/{headless,acp}.ts` 的 `...spec.extraEnv`、`index.ts` 一行 `...(bridge.handoffEnv)` | 安全修复路 | **四处零明文令牌扫描**（配置 / args / 日志 / API）＋ **真机回归** ＋ **C1f 结论**（真做或如实标注未验收） |
| 4 | **`renderPrompt()` 的假声明** —— `src/llm-adapter.ts:286-300` 无条件写「DSH 不会执行上述任何工具，不要当可调用函数」，而改道成员**确有可用 MCP server** ⇒ **该句对桥接工具是假的**（run1 里 A **逐字引用 3 次**拒调）。补丁见 `probe/patch-llm-adapter-bridge-disclaimer.md`（**最小版＝改一个字符串**） | AA | 集成后 A **不再引用该句拒调** |
| 5 | **`src/index.ts` 的积压补丁（Z 的 H1–H10）** —— 含 **H9**（已由 BB 落地并实测四出口 98/98/98/98）、`/catalog*` 路由、`ApiExtras.catalog`、`/pool` 成员加 `models`、`/pool/switch` 兜底 | Z | 逐锚点合并；**与 BB 已落地部分去重** |

## 二、尚未做（不在任何一路的写入范围内）

| # | 内容 | 阻塞原因 |
|---|---|---|
| 6 | **执行前 version（＋若存在 hash）门禁接线** —— `checkManagedBootstrapGate`（`accounts.ts:546`）**0 调用点**，是死代码；`assets/workbuddy-managed.cjs` sha256=`3032E84F623D0644…` 是可校验实体 | ⚠️ **两个候选接线位（`sessions.ts`、`provider.ts`）刚被 Codex worker 写过** ⇒ 此刻插线即并发写入。**须等其释放后由 Lead 串行接** |
| 7 | **`federation/**` 纳入 `SELF_MODULES`** | 现状：12 项不含 `federation/**` ⇒ 对 `lib/federation/providers.js`、`lib/models.js`、`lib/sessions.js`，**`anyStale=false` 是空话**，须行为取证。纳入时**须同步任何逐字列清单的说明**（否则制造新的滞后文案） |
| 8 | **客户端任务卡身份行** —— `normalizeTasks` 只保留顶层 `t.model`，卡片直接显示**无标签模型徽章**；`requested`/`actual`/`actualSource` **未接到卡片**；**未发现字面 `actual.model ?? view.model` 回退**，但**卡片仍看不清请求 vs 实际** | **Codex 同一 worker 独占**（`normalizeTasks`/任务卡身份行最小补丁）。**Lead 与 X 的剩余补丁不得并行写这两处**；X 的补丁按**不同锚点**合并，**不覆盖已验的 CRUD/状态入口** |
| 9 | **冻结修订 + 单进程最终验收** | 修订仍在变动（01:37–01:43 六分钟内 10 个文件被写） |

## 三、已确证的口径（不要再误判）

- **历史 5a 的 `tools/call=[]` = 探针关联采样缺陷，不是产品缺陷**（三路独立：同一 messageId 的 7 环链；①窗口上界取早 ②CLI 日志 ③join key `cfg-<bridgeId>.json` 全量命中）。
- **`--allowed-tools` 一直在**：58/58 run 的 CLI 自有 `manifest.json` 带、57 条 OS argv 采样带、**0 条缺**；CLI 真调过 **9 轮**，权限全 `allowed=true`，**无一条 `blocked by a permission prompt`** ⇒ **不是权限问题、不是接线问题**。
- **历史 5b 的 FAIL 成立**（B 那轮 CLI 零 `tool.requested`、`queued(senderId=B)=false`、A 说出 token 是 **Lead 代发**）。**旧失败保留**；新版若 B **自发**调用 + `queued(senderId=B,target=A)` + A 收到同一 `messageId` 并受影响 ⇒ **应按新行为通过**。
- **⑦ 在历史数据上判 `INVALID-TEST`**：历史只留档绑定 3 个字段 ⇒「完整绑定字段一致」**无法重算**，**按纪律不判正负**。
- **`cordis.patch.yml` = `F59DE587…` @ 01:01:50**≠参照 `2D0C5781…`：**未再变化**；两路写入清单**均无 profile**；**部署默认值经文件 + 活宿主双证未变**（`opencode-go / deepseek-v4.1-flash / max`）⇒ **「部署默认值被改」不成立**；**未归因的写入**保留在册；**不做无凭据的「恢复」**（那本身就是未经授权的 profile 写入）。

## 四、纪律（每轮都要守）

- **单一集成路径**：同文件**只允许一个写入者**；「编辑前重读/只做加法」**不能保证不丢更新**。
- **陈旧自检**：`anyStale=false` **只说明清单内文件是新的**；清单外文件（`federation/**` 等）**必须行为取证**。
- **构建陷阱**：`scripts/build.mjs` 在 tsc 非 0 时 `process.exit`，**跳过 client 拷贝** ⇒ 三工件哈希不一致；**多路写入下「三件一致」只能按时刻理解**。
- **不要派发后台真实任务后立刻 build/热重载** —— 会把后台任务 abort（已实测）。
- **验收测试单进程串行**：`/probe/team` 是**全局 lead 会话**，两个验收同时跑必然互相摧毁证据（已实测两次）；共享脚本有锁，但**新建的 v2 脚本不读该锁**。
- **不给百分比**；**不把调用失败当已实现**；**不把推断写成确证**。

---

## 五、2026-10-14 11:3x · 统一构建后的状态更新（本轮实测，不改写上表历史）

上表写于 01:xx–02:xx，此后有第三/第四路写者继续落地；本轮（10:5x–11:3x）统一构建并复跑后逐项核对如下：

| # | 上表条目 | 当前状态 | 证据 |
|---|---|---|---|
| 1 | requested/actual 分离 | **已落地并复验** | `verify-actual-identity-offline` 42 断言 PASS（探针已随 `dispatch→dispatchUnleased` 下沉修复，判据未放宽） |
| 2 | WorkBuddy 精确受管配方映射 | **已落地并复验** | `verify-managed-account-alias-offline` 96 断言 PASS；真实行为见 P7 四路并发 |
| 3 | MCP 安全 stdio 注入 | **已落地**（冻结验收 ①，37/37） | `probe/out/mcp-bridge-stdio-proxy/report.json` |
| 4 | `renderPrompt()` 假声明 | **已落地**（冻结验收 ④） | `final-integration-freeze-acceptance.md` §1 |
| 5 | index.ts 积压补丁（H1–H10 等） | **已落地**（H9 四出口 98/98/98/98） | 同上 |
| 6 | 执行前版本/哈希门禁接线 | **已接线并复验** | `verify-managed-bootstrap-gate` 16/16（门禁在派发前被咨询、拒绝不声明身份、诊断含实测版本） |
| 7 | `federation/**` 纳入 SELF_MODULES | **已完成**（上一路已改穷尽规则）；本轮再补 `account-managers.js` ⇒ 41 项 | `verify-team-routing-selfmodules` VERDICT: COVERED；`/diag/loaded` anyStale=false、41 模块 |
| 8 | 客户端任务卡身份行 | **已落地**（client.js 请求徽章/实际仅 transport-outcome/未知与 legacy 标注） | client.js:551-604 + 离线 42 断言 |
| 9 | 冻结修订 + 单进程最终验收 | **本轮达成构建一致性**（`/diag/loaded` anyStale=false = 运行代码==磁盘代码），但**团队长任务单进程最终验收仍未跑**（`/probe/team` 全局会话纪律）⇒ 保留为待办 | 见 `20261014-1130-unified-harness-status-and-gap.md` §10 |

本轮另有三处真实修复：`src/index.ts` 重复键 `accountManagers`（TS1117，曾使 10:49–10:54 的 src 全部进不了运行代码）、探针 `dispatchUnleased` 抽取、穷尽清单计数同步。详情与回滚见 `docs/verified/20261014-1130-unified-harness-status-and-gap.md` §7–§9。
