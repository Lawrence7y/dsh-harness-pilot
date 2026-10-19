# Harness 联邦管理层 — 现状、差距、能力矩阵与分阶段计划

> 交付物 1/3。撰写时间：2026-10-13。目标插件：`D:\Project\dsh-harness-pilot`（`@dsh-external/dsh-harness-pilot` 0.1.1，profile `desktop` 以 `link:` 安装）。
> 本文所有「当前状态」条目都标明证据来源；未实测的一律标注 `未验证`／`推断`。

---

## 1. 当前状态（实测核对）

### 1.1 正在运行的 DSH 版本（不是本机旧源码）

| 项 | 实测值 | 证据 |
|---|---|---|
| 桌面外壳 | `@deepseek-ai/dsh-desktop` **0.2.0-rc.2** | `app.asar:/package.json` |
| 运行时 | `@deepseek-ai/dsh-desktop-runtime` **0.2.0-rc.2** | `app.asar:/dsh/package.json` |
| 构建提交 | `04f392c9ddd144fa426da2045178797da6db6c11`，`dshBuildDirty=false` | 同上 |
| Electron / Node / pnpm | 44.0.0 / 24.21.0 / 11.7.0 | `D:\DeepSeek harness\version`、`~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` |
| 进程 | 6 个 `DeepSeek Harness.exe`（`D:\DeepSeek harness`） | `Get-Process` |
| Profile | `desktop`（`~/.dsh/profiles/desktop`） | 环境变量 `DSH_PROFILE` |
| WebUI | `http://127.0.0.1:4200` | `~/.dsh/dsh-run.log` |

**必须排除的「旧源码假版本」**（用户明确警告的陷阱，本机确实存在三份）：

| 位置 | 版本 | 是否运行版本 |
|---|---|---|
| `~/.dsh/dist/node_modules/@deepseek-ai/dsh` | 0.1.1-rc.1 | ❌ 陈旧残留 |
| `C:\dsh\node_modules\@deepseek-ai\dsh` | 0.2.0-rc.1 | ❌ 独立安装，少一个 rc |
| `D:\Project\deepseek-harness-master\deepseek-harness-master` | 0.1.0-rc.8 | ❌ 源码 checkout，落后很多 |

宿主实现只存在于 `D:\DeepSeek harness\resources\app.asar` 内（`/dsh/...`）。本次侦察用自写 asar 读取器（`D:\Project\_dsh-asar\extract.mjs`）把 32 个相关宿主包抽成可读文本（`D:\Project\_dsh-asar\host\*`），因此**能力矩阵来自运行版本本体，不是旧源码**。

### 1.2 插件安装来源与版本

- profile 依赖：`"@dsh-external/dsh-harness-pilot": "link:D:\\Project\\dsh-harness-pilot"`（`profiles/desktop/package.json:5`）
- bundle 列表含该包（同文件 `dsh.profile.bundles`），`node_modules/@dsh-external/dsh-harness-pilot` 是指向该目录的 junction
- `package.json` 版本 `0.1.1`；`exports` = `./lib/index.js` + `./client`；`dsh.client = {platform:"web", immediately:true}`
- 运行时加载的是 **`lib/*.js`（tsc 产物）**，源码在 `src/*.ts`；`client/client.js` 由 `scripts/build.mjs` 拷到包根 `client.js` 与 `lib/client.js`
- **无 git 仓库**（`git status` → not a repository）。本次已建立回滚基线：`D:\Project\_dsh-baseline\dsh-harness-pilot-baseline-20261013-145003.zip`（2.1 MB，排除 `node_modules`）

### 1.3 ⚠️ 构建/运行依赖错位（必须修）

插件 `node_modules` 里的宿主 peer 依赖全部 junction 到 **`C:\dsh\node_modules`（0.2.0-rc.1）**：

```
@deepseek-ai/schemastery, dsh-tools, dsh-subagent, dsh-llm, dsh-session, dsh-agent, cordis
  -> C:\dsh\node_modules\@deepseek-ai\...
```

而宿主进程是 **0.2.0-rc.2**。`lib/*.js` 在运行期真实 import 的宿主模块为：`schemastery`（config.js）、`dsh-subagent`（provider.js）、`dsh-tools`（tools.js / task-tools.js）、`dsh-llm`（wake.js）。也就是说当前插件是在 **rc.1 的宿主模块实例上跑 rc.2 宿主里**——能工作，但正是用户要求避免的「把旧源码当归宿」。
另外 asar 内**不含 `.d.ts`**（实测 `@deepseek-ai` 子树 0 个 `.d.ts`），所以「编译期类型 = 运行期版本」需要另行安置。

**处理方案（P0，已列入实施）**：从 asar 抽出 rc.2 的宿主包到稳定目录，把 junction 改指向它；插件自带 `types/` 最小声明供 tsc 使用；新增运行时自检，把「解析到的宿主包版本 vs 宿主进程版本」写进管理页，错位即显式报错。

### 1.4 已验证、必须复用、不得重写的既有能力

来源：插件 `README.md` 与 `~/.dsh/plugins/harness-pilot/` 运行态。

| 能力 | 现状 |
|---|---|
| 工具面 | `harness_list / harness_dispatch / harness_agent / harness_open / harness_send / harness_sessions / harness_task_start / harness_task_status / harness_task_list / harness_task_cancel` |
| 通道梯子 | `acp → headless → pty → cdp → window`（`src/transports/*`），降级发生在预检阶段，不中途换通道重跑 |
| 子代理 provider | 每个目标注册 `harness-<名字>`（默认目标额外 `harness-pilot`）到 `ctx.subagents` |
| 运行账本 | `~/.dsh/plugins/harness-pilot/tasks/*.json|.log|.result.json`，`kind=task` 与 `kind=subagent` 共用；终态必落盘；停滞探测；崩溃恢复读作 `interrupted` |
| 完成回执 | 任务终态 → 组装回执 → `sessionController.resolveAgent` → `agent.followup` → `sessions.flush`；`callback.status ∈ delivered/failed/uncertain/skipped` |
| 设置页 | client 通过 `ctx.slots.inject('settings.section', …)` + `settings.plugins.tab` 注册；HTTP `GET /harness-pilot/api/overview|probe|settings|tasks` |
| 运行时设置 | `~/.dsh/plugins/harness-pilot/runtime-settings.json`（当前 `maxConcurrent:0`、`notifyOnComplete:true`、`deliverResult:true`） |

**注意术语归属**（宿主 API 报告 §12 已核实）：`stalled`、`harness_agent`、`harness_task_*` 都是**本插件自造**的词，宿主 `dsh-subagent` 只有 `running|inactive` × `one-shot|continuable|unknown`。文档与界面必须如实区分，不能冒充宿主状态。

### 1.5 本机真实 CLI 清单（实测版本）

| 目标 | 入口（实测） | 版本 | 备注 |
|---|---|---|---|
| Codex | `C:\Users\Administrator\.codex\plugins\.plugin-appserver\codex.exe` | `codex-cli 0.160.1` | 有 `exec`、`app-server`、`login`、`mcp`、`resume`、`queue`、`fork`、`-m/--model`、`-s/--sandbox`、`-a/--ask-for-approval` |
| Claude Code | `...\node_modules\@anthropic-ai\claude-code\bin\claude.exe` | `2.1.291` | |
| OpenCode | `...\node_modules\@opencode\cli\bin\opencode.exe` | `v2.0.14` | 已验证 ACP |
| Pi | `...\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`（node 运行） | `1.1.0` | |
| Qoder CN CLI | `C:\Users\Administrator\.qodersec\bin\qoderclicn.exe` | 1.1.41（前次实测） | `--acp`、`status -o json`、`-p`、`--tools`、`--no-session-persistence` |
| WorkBuddy | `D:\workbuddy\WorkBuddy.exe` + 内置 `codebuddy` | `2.156.0` | 需受管 bootstrap |
| WorkBuddy.AI | `D:\workbuddy ai\WorkBuddyAI\WorkBuddyAI.exe` + 内置 `codebuddy` | `2.156.0` | 需受管 bootstrap |
| MiMo | `C:\Users\Administrator\.mimocode\bin\mimo.exe` | `0.1.4` | |
| Kimi | `C:\Users\Administrator\.kimi-code\bin\kimi.exe` | `0.26.0` | |
| Grok | `C:\Users\Administrator\AppData\Local\grok\grok.exe` | `0.2.103` | |
| Antigravity CLI | `C:\Users\Administrator\AppData\Local\agy\bin\agy-core.exe` | 未取到 `--version` | `agy.ps1` 直接透传 |

`pi` / `claude` / `opencode` 三个 shim 位于 `C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\` —— **WorkBuddy 自带 Node 前缀下的共享安装**。这是「厂商原生共享存储」的一个真实例子，必须在账号隔离说明里如实标出，不能宣称已隔离。

### 1.6 已验证的账号基础（前次交付，可复用）

- `~/.dsh/harness-accounts/` 下已有 `qoder-cn-a`、`qoder-cn-b`、`workbuddy-a`、`workbuddy-ai-b` 四个档案目录
- 身份指纹：`workbuddy-a = 84790ea6680a`、`workbuddy-ai-b = 11c07a33c387`（`verification.json`）
- 四路并发（2×WorkBuddy + 2×Qoder CN）全部返回各自唯一标记，`stopReason=end_turn`，工具请求 0（`verification.json`，2026-10-13 14:28 CST）
- WorkBuddy 受管 bootstrap 适配器 `workbuddy-managed.cjs`：以厂商 exe 的 Node 模式启动 → 取原生 `electron_browser_workbuddy_storage` 能力 → 一次性命名管道把 `{symmetricKey,userKey,developerPublicKey}` 交给自己的 CLI 子进程；密钥只在内存与本地管道流转
- **边界（不得夸大）**：依赖厂商内部发布模块与启动协议，升级后需重新验收；**未验证**整机重启、令牌到期刷新、退出登录后恢复、关闭桌面应用后的执行、内存收益
- WorkBuddy/WorkBuddy.AI 的 `CODEBUDDY_CONFIG_DIR` / `WORKBUDDY_CONFIG_DIR` **不覆盖完整认证存储**：发布包 `FileAuthenticationStorage` 用 `sharedDataPath/auth/<authentication.id>.info`（本机 `CodeBuddyExtension/Data/Public/auth`），两个应用的 `authentication.id` 分别是 `workbuddy-desktop` / `workbuddy-desktop-ai`。因此**配置目录隔离 ≠ 认证存储隔离**

---

## 2. 功能差距（需求 → 现状 → 差距）

| # | 需求 | 现状 | 差距 |
|---|---|---|---|
| G1 | 设置中统一 Harness 管理页：查看/**安装或指定** CLI 路径/启停/真实版本/连接状态/能力 | 只有 `harness_list` 与 `GET /api/probe`；无版本探测、无启停持久化、无路径编辑 | 缺注册表模型 + 真实探测 + 启停持久化 + 管理 UI |
| G2 | 读取各 Harness **当前配置的供应商与模型**，区分 `已配置 / 可发现 / 认证有效 / 实际可用` | 有 `harness_models`（读 `ctx.llm`，是 **DSH 侧**）与 `modelsCommand`（问 CLI），两者在同一个界面并列 | 缺四态语义、缺按账号维度的原生配置读取、缺「不得混用」的强约束 |
| G3 | 在原生接口允许范围内**新增/修改/删除供应商配置**、选择模型（不能只填任意模型字符串） | `harness_dispatch(model=…)` 可传任意字符串 | 缺真发现（`listModels`/CLI 原生配置）+ 受约束选择 |
| G4 | 账号管理：同厂商多账号、国内外并存、登录/查看/退出/**一键切换**，档案绑定 Harness/区域/原生认证引用/配置目录/供应商/默认模型 | `~/.dsh/harness-accounts/*` 只是目录约定，插件**不认识**账号概念；`login-*.ps1` 是外部脚本 | 缺完整账号数据模型与生命周期 |
| G5 | 明确说明哪些数据真隔离、哪些仍用厂商原生共享存储 | 无 | 缺隔离声明字段与界面披露 |
| G6 | 不得靠复制未解密凭据/关闭加密/明文存令牌伪装支持 | 受管 bootstrap 已遵守 | 需在实现中固化为不变量并自检 |
| G7 | 账号切换作用范围明确（当前会话能否切换、已有任务绑定创建时账号、不串号） | 无 | 缺会话↔账号绑定时点与不可变语义 |
| G8 | 令牌刷新、认证失效提示、重新登录；三种状态分开验证 | 无 | 缺状态机 |
| G9 | 会话页原模型选择位置改为 Harness→账号→供应商→模型，并按真实能力给权限/推理档位 | 模型选择器**未被触碰** | 见 §3 约束：`conversation.input.model` 是 `single` 槽，只能**替换**不能插入 |
| G10 | 原生 DSH 也作为可选 Harness；切换后**真正路由**到所选 CLI 执行引擎 | 无 | 需 LLM 适配器或等价的真实路由 |
| G11 | 外部 Harness 接入原生子代理与**智能体团队**，可创建/配置/查看/启动/停止/取消/恢复 | 子代理 **有**（`harness-<名>` provider）；团队**无** | 需把 provider 名接进 `freshProvider`/`forkProvider` 并用原生团队工具 |
| G12 | 子代理/团队/执行卡片/任务详情显示真实 Harness、账号脱敏名、供应商、模型、原生会话 id、执行状态；配置值≠实际值时提示 | 无 | `TeamMemberView` 字段封闭，只能靠命名/描述/诊断承载 |
| G13 | 每个外部子代理/团队成员有独立执行会话与运行记录；接入分工、依赖、通信、交付、取消传播、失败恢复 | 账本已有，团队无关 | 需把账本与团队 run 对齐 |
| G14 | 按真实能力区分可当主控/只能当执行成员；用受支持的 MCP/协作 CLI/原生协议跨 Harness 调度 | 无 | MCP 在宿主里**只能配置、不能运行时增删** |
| G15 | 优先原生 ACP/app-server/HTTP-SSE/RPC，PTY 降级，GUI/CDP 明确标注；降级不得静默重复派发 | 通道梯子已满足「不中途重跑」 | 需在能力矩阵里显式分级 |
| G16 | WebUI + 本地服务；按需启动、控制并发、释放空闲进程；账号登录 ≠ 进程常驻 | 有 `maxConcurrent`，无空闲回收 | 缺进程池与空闲释放 |
| G17 | 用完整进程集合实测空闲/并发/任务结束后内存 | 有 `probe` 脚本但无内存结论 | 缺评测 |
| G18 | 整合 WorkBuddy 受管 bootstrap 启动适配，保留版本检查/明确失败/升级后重新验收边界 | 适配器在仓库外，**未接入** | 需内置并加版本门禁 |
| G19 | 保留现有配置、历史会话、可回滚基线 | 已建基线 zip；无 git | 建议补 git 初始化（可选） |
| G20 | 验收：真发现、选择生效、多账号隔离与切换、重启后认证恢复、原生子代理派发、团队执行与通信、取消与失败、四路并发 | 前次交付覆盖「四路并发 / 重启恢复 / 隔离」的**脚本级**验证 | 需在**插件内**重跑并留证 |

---

## 3. 接口与能力矩阵

### 3.1 宿主扩展点（0.2.0-rc.2 实测；证据见 `D:\Project\_dsh-asar\reports\host-api-0.2.0-rc.2.md`）

| 需求 | 宿主是否支持 | 接入点 | 证据 |
|---|---|---|---|
| 设置页 | ✅ 完全支持 | `settings.section`（`kind:"list"`，由 `dsh-client-ui-settings-general` 声明）；也开放 `plugins.item`、`settings.general.item`、`settings.onboarding`、`settings.models*` | ui-settings-general `lib/client.js:1136-1139`；注册形状 ui-settings-models `lib/client.js:4059-4075` |
| 会话模型选择座位 | ⚠️ 只能替换 | `conversation.input.model` 是 `kind:"single"`，**第二个占用者抛错**；同一 priority 冲突，**lowest renders**，改 priority 即 shadow | ui-conversation `lib/client.js:18321-18324`；ui-slots `lib/index.js:168-174` |
| 同级并排选择器 | ✅ | 开放 `list` 槽：`conversation.input.left/.right/.overlay/.composer.dock` | ui-conversation `lib/client.js:18297-18332`，渲染顺序 `:17522,17524,17532,17615` |
| 模型选择数据契约 | ✅ | props `{available, directory(store), load(), select(selection)}`；`select → sessions.selectModel({sessionId,provider,model,reasoningEffort?})`；`ModelSelection{provider,model,reasoningEffort?}` | ui-model-selection `lib/client.js:1254-1261`、`:246-251` |
| 子代理 provider | ✅ | `ctx.subagents.registerProvider(provider)`；接口 `{name, capabilities, inheritsParentContext, agentRouteDefaults?, start(), prepareContinuable?()}` | api-catalog `:2870`、`:7200`；随包先例 `dsh-subagent-spawn-in-process/lib/index.js:11-45` |
| 取消/恢复 | ✅ | 取消 = `request.signal`（无 `cancel()`）；恢复 = `startContinuable`+`prepareContinuable`+`sendMessage` | api-catalog `:7208` |
| 进程外子代理公共缝 | ✅ | `NO_START_CAPABILITIES`、`settleRunResult`、`subprocessRunHandle`、`resolveChildCwd` | `dsh-subagent/lib/types/out-of-process.js:49,163,203,137` |
| 团队成员 = 外部 Harness | ✅ **同一 provider 接口** | 团队按 **provider 名**创建成员：`freshProvider`/`forkProvider`（配置）+ `SpawnTeammateRequest.provider` | `dsh-experimental-tool-agent-team/lib/index.js:16-19`、api-catalog `:7040` |
| 主控角色 | ✅（仅团队内） | `role:'lead'|'teammate'`；9 个原生工具 `spawn_teammate/send_message/list_agents/wait_agent/interrupt_agent/team_task_*` | api-catalog `:7352,7356`；`lib/index.js:243-459` |
| 团队 UI 列扩展 | ❌ | `TeamMemberView` 字段封闭（`id,name,role,status,description?,provider?,context?,model?,diagnostics[]`），无扩展点 | api-catalog `:7356` |
| 外部 provider 带 per-child model | ❌ 硬约束 | 进程外 provider 必须广告 `capabilities.agentOptions=false`，于是 per-child model/maxDepth/persona 在 `start()` 之前被拒 | out-of-process `:44-48`、dsh-tool-subagent README `:53,67` |
| LLM 供应商（真路由） | ✅ 但成本高 | `ctx.llm.registerAdapter(providers, adapter)`；`LlmAdapter` 唯一抽象方法 `stream(options): AsyncIterable<StreamChunk>` + 6 个元数据方法 | api-catalog `:1302`、`:5508` |
| 可配置供应商 + **模型发现** | ✅ | `ctx.llm.registerConfigurableProviders([{provider,displayName,settingsNs,settingsPath}])`、`ctx.llm.registerModelDiscovery(settingsNs, discover)` | `dsh-llm/lib/index.js:1910,1974,1995` |
| 推理档位 | ⚠️ 不是枚举 | `ReasoningEffortId` 是 branded string，按模型声明；不支持的显式档位**在 I/O 前拒绝**，无钳制无别名 | api-catalog `:6092`、`:5556`、`:1376` |
| 权限预设 | ❌ 不能新增 | 只有 `workspace-write`/`danger-full-access` + 保留 `auto`/`custom`；「Callers cannot publish another preset through a generic contribution API」 | dsh-permission-presets README `:60`、`:134-138` |
| MCP | ⚠️ 仅配置 | `inject=["tools"]`，`apply(ctx,config)` 读 `transport:stdio|streamable-http`；运行时增删**无 API** | dsh-mcp-client `lib/index.js:763,780-800`；api-catalog `:1419` 仅资源注册 |
| 会话派生状态 | ✅ | `ctx.sessionProjections.register/stateOf/snapshot`；客户端用 `wire.view` 预算 | api-catalog `:2087-2156` |
| 会话卡片自定义元数据 | ❌ | `SessionHeader` 封闭；唯一缝是 `SessionSummary.projections` + `ctx.uiConversation.events.register()` | api-catalog `:6560,:6800` |
| 配置热重载 | ✅ 默认开启 | profile patch 热重载是默认行为，**源码**热重载才是 opt-in | `dsh-base/cordis.patch.yml:27-32`；链路见报告 §10.3 |

**由此得到的三条硬约束（必须写进 UI 与交付说明）**：
1. 「先选 Harness 再选账号/供应商/模型」**无法插入**宿主选择器内部，只能**替换** `conversation.input.model`，或在旁边开放槽并排；替换即接管该座位的全部职责。
2. **权限模式不能新增预设**。外部 Harness 的权限模式只能作为**该 Harness 自己的原生参数**暴露与传递，不能伪装成 DSH 预设；DSH 侧预设仍由 profile patch 配置。
3. **团队成员行不能加列**。Harness/账号/原生会话 id 只能通过 `provider` 名、`description`、`diagnostics` 与插件自建面板承载；不得声称已改宿主团队 UI。

### 3.2 各 Harness 真实能力矩阵（本机实测 + 已核实协议）

| Harness | 原生连接方式 | 模型选择落地 | 供应商配置读取 | 多账号隔离 | 会话恢复 | 可当主控 |
|---|---|---|---|---|---|---|
| Codex 0.160.1 | `app-server`（JSON-RPC）/`exec` | `-m/--model`、`-c model=…` | `~/.codex/config.toml` + `codex login status` | `CODEX_HOME` 目录级隔离（未实测） | `resume`/`fork`/`queue` | 待验证 |
| Claude Code 2.1.291 | headless `-p`（stream-json） | `--model` | `~/.claude.json`、`settings.json` | `CLAUDE_CONFIG_DIR`（未实测） | `--resume`（未实测） | 待验证 |
| OpenCode 2.0.14 | **ACP**（已验证） | `--model` / ACP `session/set_config_option` | `opencode.json`、`models` 命令 | `XDG_CONFIG_HOME`/`OPENCODE_CONFIG`（未实测） | ACP 会话 id | 待验证 |
| Pi 1.1.0 | headless `--print` | `--model`/`--list-models`（45 项，前次实测） | 其自身配置 | 未实测 | 未实测 | 待验证 |
| Qoder CN CLI 1.1.41 | **ACP**（已验证） | `--acp` 会话内设置 | `.qoder-cn` 原生配置 | ✅ `QODERCN_CONFIG_DIR` 实测隔离 | ACP 会话 id | 待验证 |
| WorkBuddy / .AI 2.156.0 | **ACP**（经受管 bootstrap，已验证） | `acpModel` | 厂商共享 auth 槽 + `models.json` | ⚠️ **配置目录隔离、认证槽共享** | ACP 会话 id | 待验证 |
| MiMo 0.1.4 | ACP（前次实测） | `acpModel` | `model-catalog.json`（账号级） | 未实测 | 未实测 | 待验证 |
| Kimi 0.26.0 | ACP（前次实测） | `acpModel` | 自身配置 | 未实测 | 未实测 | 待验证 |
| Grok 0.2.103 | headless | `--model` | 自身配置 | 未实测 | 未实测 | 待验证 |
| Antigravity `agy` | headless `--print` | `--model` | 自身配置 | 与 IDE 同一账号 | 未实测 | 待验证 |
| 原生 DSH | 进程内 | 原生选择器 | 原生 | profile 级 | 原生 | ✅ |

**通道分级（按用户要求显式标注）**：
- 一级（原生协议）：ACP、app-server、HTTP/SSE、RPC
- 二级（headless/PTY）：一次性打印、ConPTY
- 三级（降级，必须显式标注且不得静默重派）：CDP、窗口注入

### 3.3 需要 DSH 核心修改的事项（12 项，全部经证据核实，本方案默认**不做**）

1. 在选择器内部插入阶段
2. 给选择器加 harness/account 维度
3. 通过贡献 API 新增权限预设
4. 运行时增删 MCP 服务器
5. 会话/执行卡片附加自定义元数据
6. 插件自定义会话事件 `type`
7. 团队行增加字段/列
8. 进程外 provider 支持 per-child model/depth/persona
9. 从选择器把 per-child 模型送进子代理 run
10. 无 opt-in 的源码热重载
11. 全局 `harness*` API（不存在，是本插件自造）
12. `settings.plugins.tab`（本 build 未声明，用 `plugins.item`）

**最小核心修改方案（仅当必须）**：把 `conversation.input.model` 从 `kind:"single"` 扩成可声明的 `chain`/`list`，或允许宿主选择器接受外部注册的"选择维度提供者"。改动面：`dsh-client-ui-conversation` 的槽声明 + `dsh-client-ui-model-selection` 的选择流程。**本方案不需要它**（用替换座位实现），因此暂不提出。

---

## 4. 账号与会话数据模型

### 4.1 Harness 描述符 `HarnessRecord`

```ts
type TransportId = 'acp' | 'app-server' | 'headless' | 'pty' | 'cdp' | 'window'
interface HarnessRecord {
  id: string                 // 稳定标识：codex / claude / opencode / pi / qoder-cn / workbuddy / workbuddy-ai / dsh
  displayName: string
  vendor: string             // openai / anthropic / qoder / tencent / xiaomi / local ...
  kind: 'cli' | 'electron-gui' | 'vscode-fork' | 'native'
  enabled: boolean           // profile 配置持久化
  install: {
    status: 'found' | 'missing' | 'unknown'
    command: string          // 实际可执行入口（含 .ps1 → 底层 exe/js 的解析结果）
    resolvedFrom: 'builtin-catalog' | 'profile-config' | 'path-scan' | 'user-specified'
    version?: string         // 真实 --version 输出
    versionProbe?: { argv: string[]; parse: 'stdout-trim' | 'regex'; regex?: string }
    versionCheckedAt?: string
    managedNote?: string     // 例如「位于 WorkBuddy 自带 Node 前缀，属共享安装」
  }
  transports: Array<{
    id: TransportId
    tier: 1 | 2 | 3           // 原生协议 / headless-PTY / 降级
    available: boolean
    evidence?: string         // 探测命令与输出摘要
  }>
  capabilities: {
    modelSelect: 'argv' | 'acp-config' | 'none'
    providerConfigRead: string[]   // 原生配置文件相对路径
    modelListCommand?: string[]
    multiAccount: 'isolated-config-dir' | 'shared-native-store' | 'unknown'
    sessionResume: boolean
    permissionModes?: string[]     // 该 CLI 自己的参数取值（不是 DSH 预设）
    reasoningEffort?: string[]
    mcpServer: boolean             // 自身可作为 MCP server
    canLead: 'verified' | 'candidate' | 'no'
  }
  probe?: { at: string; connection: 'ok'|'fail'|'timeout'; latencyMs: number; detail: string }
  upstreamLimits: string[]   // 受上游限制的明确声明
}
```

### 4.2 账号档案 `AccountProfile`

```ts
interface AccountProfile {
  id: string                    // workbuddy-a / qoder-cn-b / codex-default
  harnessId: string
  displayName: string           // 脱敏：workbuddy-a (8479…680a)
  region: 'cn' | 'intl' | 'unknown'
  identity: {
    state: 'unknown' | 'login-ok' | 'identity-readable' | 'model-request-authorized' | 'auth-invalid'
    fingerprint?: string        // sha256(userId)[0:12]，不存原值
    authType?: string
    checkedAt?: string
    detail?: string
  }
  nativeAuthRef: {
    kind: 'vendor-store' | 'file' | 'keychain'
    scope: 'isolated' | 'vendor-shared'
    locator: string             // 例如 CodeBuddyExtension/Data/Public/auth/<authentication.id>.info
    authenticationId?: string   // workbuddy-desktop / workbuddy-desktop-ai
  }
  configDir: string
  launch: {
    mode: 'direct' | 'managed-bootstrap'
    command: string
    args: string[]
    env: Record<string, string>
    bootstrap?: { wrapper: string; adapterId: string; requiresVendorVersion: string; vendorNode: string }
  }
  isolation: {
    configDirIsolated: boolean
    authStoreIsolated: boolean
    sharedWith: string[]        // 与哪些档案共享厂商存储
    disclosure: string          // 人话说明
  }
  providers: ProviderRecord[]
  defaultProvider?: string
  defaultModel?: string
  switchSemantics: {
    currentSession: 'in-place' | 'requires-new-process' | 'requires-new-session' | 'unknown'
    note: string
  }
  limits: string[]              // 例如「令牌刷新未验证」
}
```

### 4.3 供应商与模型 `ProviderRecord` / `ModelRecord`

四态分离，**不得合并显示**：

```ts
type Availability = 'configured' | 'discoverable' | 'auth-valid' | 'usable' | 'unavailable'
interface ProviderRecord {
  id: string; displayName: string
  source: 'cli-native-config' | 'cli-list-command' | 'acp-session' | 'dsh-native' | 'none'
  sourcePath?: string
  models: ModelRecord[]
  state: Availability          // 综合判定
  evidence: string[]           // 每个判定依据
}
interface ModelRecord { id: string; name?: string; availability: Availability; evidence?: string }
```

- `configured`：在该 Harness 的**原生配置**里存在
- `discoverable`：该 Harness 能**列出**它（`--list-models`/`models`/ACP 目录）
- `auth-valid`：用该账号发起过一次**成功的认证**（身份可读 + 凭据被接受）
- `usable`：**真实完成过一次模型请求**（非空回复）
- 严禁把 DSH 的 `ctx.llm` 列表当作外部 CLI 的列表；界面上两栏必须分标题

### 4.4 执行记录 `ExecutionRecord`（会话/任务绑定）

```ts
interface ExecutionRecord {
  runId: string
  requested: { harnessId: string; accountId: string; provider: string; model: string; reasoningEffort?: string; permissionMode?: string }
  actual:    { harnessId?: string; accountId?: string; provider?: string; model?: string; reasoningEffort?: string; permissionMode?: string }
  mismatch: string[]            // 配置值≠实际值时的可读提示
  nativeSessionId?: string
  transport?: TransportId
  pid?: number
  startedAt: string; endedAt?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'stalled'
  stopReason?: string
  delivery?: { content: string; truncated: boolean }
  artifacts: { json: string; log: string; result?: string }
}
```

**绑定时点语义（G7）**：`ExecutionRecord.requested` 在**创建时固化**；之后修改账号默认值**不影响**已创建的执行。会话级默认账号另存 `sessionBinding`，切换只影响**新创建**的执行。`switchSemantics.currentSession` 如实标注该 Harness 是否支持会话内切换。

---

## 5. UI 改动方案

### 5.1 设置 → 外部 Harness（改造为「Harness 管理」）

现有页面保留（目标表 / 会话 / 后台任务 / 插件设置），新增三段，全部走真实数据：

1. **Harness 列表**：每行 `显示名 · 类型 · 入口路径 · 真实版本 · 连接状态 · 通道分级徽章 · 启停开关 · 设为默认`；行内可「指定路径」「重新探测」。缺失时给出可复制的候选路径，不假装可用。
2. **账号档案**：按 Harness 分组；每行 `脱敏名 · 区域 · Harness · 配置目录 · 原生认证引用与共享范围 · 四态徽章 · 默认供应商/模型`；操作 `登录 / 查看状态 / 退出 / 设为默认`。切换按钮旁必须显示 `switchSemantics.note`。
3. **供应商与模型**：**两栏分标题**——「该 Harness 原生配置」与「DSH 本 profile 已配置」；每项带四态徽章与证据 tooltip；可用模型只能从已发现集合中选（受约束选择），但保留「手动输入并标注为未验证」的显式入口。

### 5.2 会话页选择器

- 在 `conversation.input.model` **替换**宿主座位（同 priority 冲突，需以更低 priority shadow），渲染：
  `[Harness ▾] [账号 ▾] [供应商 ▾] [模型 ▾] [权限模式 ▾*] [推理档位 ▾*]`
  `*` 仅在该 Harness 的真实能力里存在时显示；不存在时显示为禁用并给出原因，**不伪造**。
- 选择「原生 DSH」时，回落到宿主 `modelDirectories` store + `select({provider,model,reasoningEffort})`，行为与宿主一致。
- 选择外部 Harness 时：写入 `sessionBinding`（经插件 HTTP API），并通过 **LLM 适配器**把该会话的模型请求真正交给所选 CLI 执行；未注册适配器的 Harness 明确显示「本会话选择只影响新建的外部子代理/任务，不影响本会话模型请求」——**不得静默降级**。
- 变更选择时在座位旁显示一行提示：`本会话由 <Harness>/<账号脱敏名>/<模型> 执行` 或 `需要新建会话/进程才能生效`。

### 5.3 子代理 / 团队 / 执行卡片

- provider 命名编码身份：`hx-<harness>-<account>`（例：`hx-workbuddy-workbuddy-a`），使 `list_agents` 的 `provider` 字段即可读出 Harness 与账号。
- `description` 写「Harness · 账号(脱敏) · 供应商 · 模型」。
- `diagnostics` 携带原生会话 id、传输通道、transport tier、config-vs-actual mismatch。
- 插件自建「外部执行」面板（`conversation.session.header.actions` 或设置页任务区）展示完整 `ExecutionRecord`，因为**宿主团队行不能加列**（§3.1）。

### 5.4 术语与诚实性约束（写进界面文案）

- `stalled` / `running|inactive` 归属要说清：前者是插件词汇，后者是宿主词汇。
- 未实测项一律显示 `未验证`，不得显示为可用。
- 两处列表永不混用：**「DSH 已配置供应商」** vs **「<Harness> 原生供应商」**。

---

## 6. 分阶段实施顺序

| 阶段 | 内容 | 产出 | 验收 |
|---|---|---|---|
| **P0** | 基线归档（✅ 已做）；把宿主依赖 junction 从 `C:\dsh`(rc.1) 改指 rc.2 抽出件；新增宿主包版本自检 | 可回滚基线 + 版本一致性自检 | 自检能报出「rc.1 vs rc.2」错位 |
| **P1** | Harness 注册表：安装探测（路径/真实版本/来源）、连接探测、能力矩阵、启停持久化 | `src/federation/registry.ts` + 工具 + API | `harness_registry list` 返回本机 10 个目标的真实版本 |
| **P2** | 账号档案：数据模型、四态状态机、登录/状态/退出/切换、隔离与共享披露；WorkBuddy 受管 bootstrap 内置 + 版本门禁 | `src/federation/accounts.ts`、`assets/workbuddy-managed.cjs` | 四账号可读身份、指纹不同、切换后新执行用新账号 |
| **P3** | 供应商/模型真实发现（原生配置 + CLI 命令 + ACP 目录），四态判定，受约束选择 | `src/federation/providers.ts` | 对 opencode/codex/qoder/workbuddy 得到非空真列表 |
| **P4** | 设置界面「Harness 管理」三段（真实数据） | `client/client.js` | 页面显示真实版本/状态/账号/模型，无假数据 |
| **P5** | 会话选择器替换座位 + `sessionBinding` + LLM 适配器真实路由（先做 ACP/headless 两条） | `src/federation/adapter.ts` + 客户端座位 | 选择外部 Harness 后，本会话模型请求由该 CLI 产生非空回复 |
| **P5b** | 子代理/团队接入：provider 命名编码身份、description/diagnostics、原生团队工具可用 | `src/provider.ts` 扩展 + 工具 | 团队成员 `provider` 显示为 `hx-*`，可派发/通信/取消 |
| **P6** | 进程生命周期：按需启动、并发上限、空闲释放（账号登录 ≠ 常驻） | `src/federation/pool.ts` | 空闲后进程数回落，实测内存前后对比 |
| **P7** | 行为验收：真发现、选择生效、多账号隔离与切换、CLI 重启后认证恢复、原生子代理派发、团队执行与通信、取消与失败、**2 WorkBuddy + 2 Qoder 并发真实任务** | `probe/verify-*.mjs` + 证据 json | 非空真实回复 + 正确执行身份与模型 + 任务终态 + 独立核验 |

**依赖关系**：P1 → P2 → P3 → P4 顺序实施；P5 依赖 P3；P5b 依赖 P1/P2；P6 依赖 P2；P7 在 P1–P6 之后。

---

## 7. 明确不做与受上游限制

- 不修改 DSH 核心（当前无需）；如需，最小方案见 §3.3 末段
- 不能新增 DSH 权限预设；不能给团队行加列；不能运行时增删 MCP；不能给会话卡片加自定义元数据
- WorkBuddy 适配器依赖厂商内部协议：**升级后必须重新验收**，失败要显式报错而不是退化
- 不宣称验证过：整机重启、令牌到期刷新、关闭桌面应用后的执行、内存收益（除 P6 实测结论）
- 不复制未解密凭据、不关闭加密、不在配置/日志明文存令牌
