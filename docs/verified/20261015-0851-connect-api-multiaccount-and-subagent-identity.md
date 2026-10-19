# API 模型连接（WorkBuddy/WB.AI/Qoder 多账号）+ 子代理身份显示 + call-agy（2026-10-15 08:5x 收尾版）

> 本轮由并行 Codex 会话实施（用户已授权修改），因 Codex 额度耗尽由本会话接续收尾。
> 用户最终需求：① WorkBuddy 与 WorkBuddy.AI 按 dsh-workbuddy-connect 的方式接入（复用桌面登录态、直连上游 API，**不走两家 CLI**）；② Qoder 同法；③ Antigravity 用 call-agy 技能委托（不接账号）；④ 多账号（国内/国际各多个）；⑤ 号池 + 额度自动切换；⑥ 子代理页面可见「哪个 harness 的哪个模型」；⑦ claude/codex/opencode 先核实宿主原生能力，不行才完善插件。
> 判定纪律不变：不给百分比；真实执行才有「已验证」；未验如实标注。

## 1. 落地架构（一句话版）

**外部模型不再经 CLI/桌面进程**：`src/connect/` 复用桌面 App 登录态（导入凭据→**Windows DPAPI 加密存储**）→ 直连上游 API（WorkBuddy 国内 `copilot.tencent.com`/计费 `codebuddy.cn`、国际 `workbuddy.ai`；Qoder 国内/国际各自上游）→ 以 4 条 LLM provider 注册进宿主目录：
`harness-workbuddy-cn`（18 模型）/ `harness-workbuddy-intl`（24）/ `harness-qoder-cn`（14）/ `harness-qoder-intl`（1，上游实报）。
上游客户端为 **vendored 锁定源码**（`vendor/connect/**`，1.1 MB，来源与改笔见 `vendor/connect/PATCHES.md`；sha256 锚定动态加载）。**运行期不需要启动任何桌面 App 或 CLI 进程**——内存占用诉求由此满足。

- **多账号**：`AccountStore`（每账号 `<id>.dpapi` + 元数据 `accounts.dpapi`，DPAPI CurrentUser；身份取 uid 指纹，拒绝按 token 冒充新账号、拒绝跨指纹覆盖凭据）。设置页「API 模型连接」面板：导入当前桌面登录 / 打开对应桌面 App 登录 / 启停 / 刷新 / 删除。
- **号池与额度自动切换**：`PoolAdapter` 会话粘滞（同一会话固定账号，不串号）+ **仅结构化额度耗尽**才轮换（`wire-quota.ts`：私人标记 `DSH_PILOT_QUOTA_EXHAUSTED`，401/403/429/5xx 一律不算额度，绝不因正文提到积分就切号）。`autoSwitchEnabled:true, maxSwitches:2`（当前运行值）。
- **会话/子代理边界（conversation-model-policy，subagent-only）**：外部 harness 模型**从会话模型菜单隐藏**，`selectModel` 直选外部模型显式拒绝（提示「请通过子代理工具指定 harness 和模型」）；原生子代理目录保持全量，白名单自动授予 + 写前快照 + 回读核验（`connectPolicyStatus.verified:true`）。
- **子代理身份显示**：`SessionIdentityStore`（落盘 `session-execution-identities.json`）+ `GET /api/session/identity`：provider / requestedModel / harnessLabel（如「WorkBuddy.AI（国际）」）/ accountLabel / stopReason；**actualModel 恒为 null**（上游不回报实际模型 ⇒ 未知即未知，不拿请求值冒充）。

## 2. 验收证据（最终构建 08:42 上复跑）

| 套件 | 结果 | 性质 |
|---|---|---|
| `verify-connect-runtime.mjs`（主验收） | **PASS**：四目录有模型、原生子代理白名单启用、`/session/identity` 四线全对（provider/model/stopReason=stop/账号已记录/harnessLabel）、跨源 403、非法来源 400、部署默认模型 hash 未变、call-agy 冒烟在档 | live 状态 + 已存真实任务产物 |
| `native-api-connections-live.json`（08:33） | **pass:true, nativeToolCallObserved:true**——4 条 provider 各跑一次**真实原生子代理**（WB-CN/WB-intl/Qoder-CN/Qoder-intl），工具调用被观测 | 真实模型调用 |
| `verify-connect-pool.mjs` | PASS（DPAPI 持久化、身份护栏、同区域精确模型故障转移、工具块透传不重放、auth/限流/网络不误判额度） | 离线合成 |
| `verify-connect-settings.mjs` | PASS（四区域、模型/搜索 UI、积分未知如实、来源隔离、导入/登录/刷新、自动切换配置、子代理账号身份） | 离线渲染 |
| `verify-connect-wire-failover.mjs` | PASS（额度才切、其余不切） | 离线合成 |
| `verify-conversation-subagent-only.mjs` | PASS（会话菜单过滤、直选拒绝、原生发现完整、HMR 可还原） | 离线 |
| `verify-simplified-subagent.mjs` | PASS（宿主历史路由身份、原生负对照、徽章渲染、mismatch、原版选择器保留） | 离线 |
| `verify-region-account-routing.mjs` | PASS（四区域路由、WB 区域锁、Qoder 账号级模型解码、跨目标拒绝） | 离线 |
| `/diag/loaded` | `anyStale=false`，50 模块 | live |

**live 运行值**（收尾时实测）：4 账号全部 `ready`；WB 国内 18 模型/2222 积分、WB.AI 国际 24/449、Qoder 国内 14、Qoder 国际 1（刷新后仍 1——上游对该账号实报，非缺陷）。

## 3. Antigravity（call-agy）

- 插件**不做** agy 账号集成（用 agy 自身登录态；`agy` 目标保留 headless 派发，`agy models` 实时目录 6 条，实测可用）。
- **call-agy 包装器冒烟已通过**（`probe/out/call-agy-migration-smoke.md`：真实 agy 应答 `AGY-SKILL-MIGRATION-OK`，SUCCESS，17.7s，receipt 齐全）——这是「不接账号、整任务委托」路径的可复现证据。
- ⚠️ 如实边界：**DSH 内以技能方式执行 call-agy 未独立演练**（`callAgyDshSkillExecution: 'not independently exercised'`）。当前从 DeepSeek 派发 Antigravity 任务走插件的 agy 目标（零账号工作），交互式委托走 call-agy 技能。

## 4. claude / codex / opencode 原生能力核实（用户问题⑦）

**宿主原生不能调用这三家 CLI，插件桥接仍必要，未做改动。** 依据：rc.2 宿主 LLM provider 全部是 API 型（`deepseek-official / deepseek-account / opencode-go / step / xiaomi / muze`，经 `dsh-llm-pi-ai` 的 openai-completions/anthropic 协议）；`opencode-go` 是网关型 API 配置，不是 OpenCode CLI；宿主的 `dsh-acp` 是**服务端**（把 DSH 暴露为 ACP agent 供别家驱动），不是消费端。三家 CLI 的接入由本插件既有通道承担（此前多轮已验收），本轮零改动。

## 5. 未验证 / 边界（如实，不得外推）

1. **真实多账号额度耗尽轮换未实测**——只有合成故障转移测试（`realMultiAccountQuotaExhaustion: 'not exercised'`）；需要等某账号真实耗尽才能取证。
2. **浏览器真实点击验收未做**（设置面板/子代理页面渲染有离线+live 断言，`browserClicks:'not verified'`）。
3. 会话菜单**看不到外部模型是本轮设计**（subagent-only）：外部模型用法 = 在提示词/子代理工具里指定 harness+模型；若要恢复「会话菜单可选外部模型」，卸载 conversation-model-policy 即可（可逆包装，宿主服务不改写）。
4. Qoder 国际上游仅报 1 模型（刷新复核过）；Qoder 上游积分接口未返回余额（`balanceKnown:false`，不编造 0）。
5. 上游为私有接口（非官方开放 API），厂商升级可能失效；vendored 补丁范围见 `PATCHES.md`，凭据只在 DPAPI 库，不进日志/argv/诊断。

## 6. 回滚与快照

- **P42（本轮完成后全量）**：`D:\Project\_dsh-baseline\dsh-harness-pilot-P42-connect-api-and-subagent-identity-20261015-085007.zip`（src/client/vendor/assets/scripts/probe/package.json/cordis.patch.yml/tsconfig，29 MB）。
- **P41（本轮与「选择器可见性」轮之前）**：`…P41-pre-picker-visibility-20261015-001700.zip`。注意：P41→P42 之间包含两轮改动（选择器可见性 + 本轮），回滚到 P41 会同时撤掉两轮。
- 回滚步骤：解压覆盖 → `node scripts/build.mjs`（exit 0 + client 拷贝行）→ HMR/重启 → `/diag/loaded` 必须 `anyStale=false`。账号凭据库（`~/.dsh/plugins/harness-pilot/connect-api/`）独立于代码，回滚代码不清除凭据，需显式决定去留。
