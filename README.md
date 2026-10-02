# @dsh-external/dsh-harness-pilot

把**其他 agent harness** 接入 DeepSeek Harness：既能作为 DSH 的**子代理**派发任务，也能以窗口级方式**交互操控**它们。不依赖截图 OCR —— 优先走协议与文本通道，截图只在最后兜底。

```
DSH Agent
├── 工具面  harness_list / harness_dispatch / harness_agent / harness_open / harness_send / harness_sessions
└── 子代理   ctx.subagents 上的 harness-<名字> provider（harness_agent 与标准 subagent 工具都能用）
        └── 通道梯子（自动选，选不到就如实报错，绝不悄悄重复执行）
            1. acp      ACP 协议（opencode acp …）—— 流式文本，最稳
            2. headless CLI 一次性打印（opencode run / agy --print / claude -p / codex exec）
            3. pty      宿主 ConPTY（ctx.subprocess.spawnTerminal）+ xterm 屏幕模拟
            4. cdp      Chromium DevTools 协议（Electron harness：读 DOM / 写输入框 / 点发送）
            5. window   真实窗口：定位 → 聚焦 → 注入键盘 → 无障碍树或控制台缓冲区读文本
```

## 为什么不是「截图 + 点击」

本机实测结论（决定了通道顺序）：

| 事实 | 证据 |
|---|---|
| Electron harness 的 UIA 树基本是空的 | 对 ZCode / 小米 MiMo 深挖 UIA：只有 `Chrome Legacy Window` + 4 个窗口按钮，对话文本一个字都不暴露 |
| GUI harness 往往另有 CLI | `mimo`（Bun SEA）、ZCode 的 `zcode.cjs`（`ELECTRON_RUN_AS_NODE`）、WorkBuddy 的 `codebuddy`、`kimi`、`grok` |
| 终端类 harness 能直接读屏幕缓冲区 | `AttachConsole` + `ReadConsoleOutputCharacterW` 拿到真实屏幕文本，无需 OCR |
| ConPTY 已在宿主里 | `ctx.subprocess.spawnTerminal` 已挂载，白拿一个伪终端 + 整树回收 |

所以：能走协议就走协议；不行读文本（控制台缓冲区 / DOM / 无障碍树）；再不行才注入键盘；截图是最后手段。

## 通道与能力矩阵

| 通道 | 适用 | 读 | 写 | 依赖 |
|---|---|---|---|---|
| `headless` | 有一次性模式的 CLI | stdout | 参数 / stdin | 无 |
| `acp` | 支持 ACP 的 harness（`opencode acp`） | 流式 `agent_message_chunk` | `session/prompt` | `@agentclientprotocol/sdk`（宿主随 `dsh-acp` 自带） |
| `pty` | 只有全屏 TUI 的 CLI | PTY 输出（xterm 渲染成屏幕文本） | 写入 pty（等于人敲键盘） | `ctx.subprocess.spawnTerminal` |
| `cdp` | Electron / Chromium harness | `document.body.innerText`（可配选择器） | `Input.insertText` + 回车 / 点发送按钮 | `--remote-debugging-port`，`ws` |
| `window` | 任意有窗口的 harness | UIA 无障碍树 → 控制台缓冲区 → 截图 | `pyautogui` 键盘注入（非 ASCII 走剪贴板） | python + pyautogui/uiautomation/pywin32/Pillow |

## 目标登记表（内置目录）

内置一份本机实探过的 harness 目录；profile 里只写差异即可覆盖。CLI 类走协议，GUI 类走 CDP / 窗口。

| target | 类型 | 入口 | 通道 |
|---|---|---|---|
| `opencode` | CLI | `opencode` | acp → headless(`run`) → pty |
| `opencode-flash` | CLI | `opencode run --model opencode-go/deepseek-v4.1-flash` | headless → pty（演示「每个目标绑定不同模型」） |
| `opencode-tui` | CLI | `opencode` | pty（交互会话用） |
| `agy` | CLI | `agy`（Antigravity CLI） | headless(`--print`) → pty |
| `claude` / `codex` / `gemini` / `qwen` | CLI | 同名命令 | headless → pty |
| `zcode` | Electron | `D:\zai\ZCode\ZCode.exe` | cdp → window |
| `mimo` | Electron | `D:\mimo\Xiaomi MiMo\Xiaomi MiMo.exe` | cdp → window |
| `workbuddy` | Electron | `D:\workbuddy\WorkBuddy.exe` | cdp → window |
| `cursor` | VSCode fork | `D:\cursor\Cursor.exe` | cdp → window |
| `qoder` / `qoder-cn` | VSCode fork | `D:\Qoder\Qoder.exe` / `D:\Qoder CN IDE\Qoder CN IDE.exe` | cdp → window |
| `antigravity` | Electron IDE | `...\Programs\antigravity\Antigravity.exe` | cdp → window |
| `minimax` | Electron | `D:\minimax\MiniMax Code\MiniMax Code.exe` | cdp → window |
| `grok` | Electron | `D:\Grok bot\Grok Bot.exe` | cdp → window |

## 工具

| 工具 | 用途 |
|---|---|
| `harness_list` | 列出目标与可用性；`probe=true` 时逐个通道实测（会碰窗口/端口，稍慢） |
| `harness_dispatch` | 一次性派发任务，返回 harness 的回答。可 `transport=` 强制通道、`extra_args=` 追加参数（如换模型） |
| `harness_agent` | 以 **DSH 子代理**语义派发：稳定 runId、stopReason、partial output、diagnostic |
| `harness_open` | 打开/附着交互会话（CDP / 窗口 / PTY），返回 session id + 当前屏幕文本 |
| `harness_send` | 向会话注入文本或按键；不带输入时就是「读当前屏幕」；`model=` 切模型、`click=` 点元素 |
| `harness_sessions` | 列出 / 关闭会话 |
| `harness_task_start` | **后台派发**长任务，立即回 task_id；完成后自动回执唤醒本会话 |
| `harness_task_status` | 任务状态 / 进度（增量日志）/ 终态交付内容 |
| `harness_task_list` | 列出最近任务（状态、回执投递情况） |
| `harness_task_cancel` | 取消在跑任务 |

## 完成回执：任务完成 → 交付内容 → 唤醒会话（含会话重新启动）

`harness_task_start`（或 `POST /harness-pilot/api/task/start`）派发的后台任务到终态时，
插件**主动**把交付内容送回发起会话并触发新一轮：

1. 组装回执文本：回执 ID / 目标 / 终态 / 工作区 / 结果文件路径 / **交付内容正文**（可配截断）/ 续办提示；
2. 注入发起会话并唤醒：`sessionController.resolveAgent(sessionId)` → `agent.followup(userMessage)`
   → `sessions.flush()` 落盘确认（与 `dsh-schedule` 同一条唤醒链）；
3. **会话重新启动**：会话 agent 不在线时 `resolveAgent` 会先 resume（`agents.resume`）把会话拉起来，
   再投递回执 —— 冷会话也能被唤醒继续任务；
4. 投递状态如实记账在任务的 `callback.status`：`delivered` / `failed` / `uncertain` / `skipped`
   （进程中断期间的投递不重发、不假装成功）。

回执行为在**设置 → 外部 Harness → 插件设置**里可调：`notifyOnComplete`（完成后唤醒）、
`deliverResult`（回执附带交付正文）、`maxResultChars`、`maxConcurrent`、`defaultTaskTimeoutMs`、
`resumeInstruction`。设置存 `~/.dsh/plugins/harness-pilot/runtime-settings.json`，保存即生效；
任务三件套（`.json`/`.log`/`.result.json`）存 `~/.dsh/plugins/harness-pilot/tasks/`。

## 配置示例（profile 覆盖差异）

```yaml
- id: harness-pilot
  name: '@dsh-external/dsh-harness-pilot'
  config:
    defaultTarget: opencode
    pythonPath: ''            # 窗口助手用的 python；留空自动探测
    targets:
      - name: opencode
        args: ['run', '--model', 'opencode-go/deepseek-v4.1-flash']   # 固定模型
      - name: agy
        args: ['--print']
        promptViaStdin: true   # prompt 走 stdin 而不是命令行参数
        timeoutMs: 900000
      - name: zcode
        command: 'D:\zai\ZCode\ZCode.exe'
        cdp:
          launchArgs: ['--remote-debugging-port=<port>']
          inputSelector: 'textarea'
```

## 作为子代理使用

- 本插件为每个目标注册 `harness-<名字>`（默认目标额外注册 `harness-pilot`）。
- `harness_agent` 走这条路径；也可以用宿主的 `tool-subagent` 挂一个标准工具：
  ```yaml
  - insert:
      - id: harness-subagent-opencode
        name: '@deepseek-ai/dsh-tool-subagent'
        config:
          provider: harness-opencode-flash
          toolName: harness_opencode
  ```

## 模型：跨 harness 用已配置的供应商模型

两层模型信息都能看到，也能在派发时指定：

- **DSH 侧**：`harness_models` 直接读 `ctx.llm`，列出本 profile 配置的供应商路由与模型
  （实测 8 条：`deepseek-official` / `opencode-go` / `opencode1` / `xiaomi` / `step` / `synapse` …）。
- **harness 侧**：目标配置里的 `modelsCommand` 会去问那个 CLI 自己有哪些模型并缓存。
  实测 `opencode models` 返回 **408** 个、`agy models` 14 个、`pi --list-models` 45 个、`mimo models` 7 个。
- **派发时指定**：`harness_dispatch(model=…)` / `harness_agent(model=…)`。落地方式按目标配置：
  - `modelArgs: ['--model','{model}']` → 追加到 argv（opencode / agy / claude / mimo / pi / grok / kimi / qodercli…）
  - `acpModel` → ACP 会话内 `session/set_config_option`（opencode / mimo / kimi / codebuddy）
  - 两者都没有的 GUI harness（ZCode / Cursor / Qoder IDE / Antigravity…）只能在它们自己的 UI 里选模型，插件会如实说明。

每个目标绑定不同模型也很简单（内置 `opencode-flash` 就是例子）：把模型写进 `args` 即可。

## 设置界面（client 半边）

- **设置 → 外部 Harness**：一张表列出全部 harness（名称、说明、通道、可用性 + 命令路径、默认模型、模型数、活跃会话），
  顶部汇总 `N 个 harness · M 个可用 · K 个会话`，下面还有「DSH 已配置供应商」清单与「刷新」按钮；
  外加两个新区块：
  - **插件设置**：可编辑表单（完成后唤醒会话 / 回执附带交付内容 / 交付截断 / 并发上限 / 默认超时 / 续办提示），
    「保存设置」写回 `runtime-settings.json` 并立即生效；
  - **后台任务**：`harness_task_start` 任务列表（状态、回执投递状态、耗时），可展开「结果」看交付内容、
    对在跑任务「取消」。
- **设置 → 插件**：一张 `Harness Pilot · 外部 harness 接入` 卡片，让插件在插件管理里可见。
- 数据来自宿主 HTTP 接口（同源，无需鉴权配置）：
  - `GET /harness-pilot/api/overview` → 目标 + 会话 + 供应商模型（`?models=1` 才会去问各 CLI，慢）
    + `runtimeSettings` + 最近任务
  - `GET /harness-pilot/api/probe?target=<name>` → 该目标的通道梯子实测结果
  - `GET /harness-pilot/api/settings`、`POST /harness-pilot/api/settings/save` → 运行时设置读写
  - `GET /harness-pilot/api/tasks`、`GET /harness-pilot/api/task?id=…&result=1`、
    `POST /harness-pilot/api/task/start|cancel` → 后台任务
- client 工件构建后落在**包根 `client.js`**（`exports["./client"]`）并同时拷到 `lib/client.js`；
  `dsh.client = { platform: "web", immediately: true }` 让它在页面启动时注册槽位。

> 若插件是运行时新装配的，页面需要**刷新一次**（客户端模块图在启动/文件变化时重组；刷新后即可看到上面两个界面）。

## 各 harness 实测可用模型（2026-10-01 审计）

审计方式：能列模型的 CLI 直接问它（`harness_models`）；GUI 应用读它**自己的账号级模型目录**，或在带调试端口启动后用 CDP 打开模型选择器逐项枚举。

| harness | 供应商 | 可用模型 | 当前/默认 |
|---|---|---|---|
| **Qoder CN IDE**（账号 `<redacted>`，IDE 已登录） | Qoder CN 网关（UI 只有一个 provider） | **13 + Auto**（界面实时枚举）：Qwen 5 · DeepSeek 2 · GLM 3 · Kimi 2 · MiniMax 1 —— `Qwen3.8-Max`/`Qwen3.8-Flash`/`Qwen3.7-Max`/`Qwen3.7-Plus`/`Qwen3.7-Flash`、`DeepSeek-V4-Pro`/`DeepSeek-Flash`、`GLM-5.3`/`GLM-5.3-Flash`/`GLM-5.2`、`Kimi-K3`/`Kimi-K2.8-Preview`、`MiniMax-M2.7`（带倍率，如 Qwen3.8-Flash 0x、Kimi-K3 1.4x） | `Qwen3.8-Flash` |
| **MiMo 桌面端**（账号 `<redacted>` · CN） | `xiaomi` @ api.xiaomimimo.com | **7**：文本 `mimo-v2.6-pro`/`mimo-v2.6-flash` · TTS ×3 · ASR `mimo-v2.5-asr` · 图像 `Doubao-Seedream-5.0-pro` | `mimo-v2.6-pro` |
| **MiMo 桌面端 AI**（账号 `<redacted>` · SGP） | 同上 | **7**，与上表唯一差异：图像是 `gpt-image-2` | `mimo-v2.6-pro` |
| **ZCode 桌面端** | 5 家（账号级；四套 coding plan 均 `coding_plan_not_entitled`） | **8**：`opencode`→`deepseek-v4.1-flash`,`mimo-v2.6-flash` · `xiaomi-mimo`→`mimo-v2.6-pro`,`mimo-v2.6-flash` · `step`→`step-5-preview` · `synapse`→`claude-opus-5-5` · `bigmodel`→`GLM-5.3`,`GLM-5.3-Flash` | 最近用 `step-5-preview` |
| **Antigravity IDE**（账号 `<redacted>`） | Google / Anthropic / OpenAI-oss（UI 不标 provider） | **7**（选择器实时枚举）：`Gemini 3.8 Flash(High)`、`3.7 Flash(Medium)`、`3.6 Flash(Medium)`、`3.1 Pro(Low)`、`Claude Sonnet 4.6(Thinking)`、`Claude Opus 4.6(Thinking)`、`GPT-OSS 120B(Medium)` | `Gemini 3.8 Flash (High)` |
| **Antigravity CLI**（`agy`，同账号） | 同上 | 目录 **14**：Gemini 11 · Claude 2 · GPT-OSS 1（`agy models` 是目录，当前登录态下 entitlement 拉取被跳过，实际可用以运行为准） | `gemini-3.8-flash-high` |

要点与坑：

- **GUI 应用只能在它自己的界面里选模型**——插件能派发任务、能读界面，但不能替它切模型（`canSelectModel=false`）；CLI/ACP 类的目标可以（`model=` / `acpModel`）。
- **Qoder CN**：目录里有 21 个具体模型、账号实际只被授权 13 个（`catalog-v6` 是加密容器，过滤规则读不出来）；`qoderclicn` CLI **未登录**（与 IDE 是两套凭据）。
- **ZCode**：桌面端模型来自 `provider_config.json` + models.dev，`~/.zcode/cli/models/api.json`（145 供应商/5264 模型）**只是 CLI 自己的镜像**，不是桌面端下拉框的来源。
- **MiMo**：账号级目录 `model-catalog.json` 会校验 `account` 字段（不匹配就返回空），所以它就是"当前登录账号能选什么"的权威答案；另有 BYOK 目录 `models-with-claude.json`（223 供应商 / 7958–8177 模型）属于"自定义模型"入口。
- **Antigravity**：`agy models` 的 14 个不等于 entitlement（其代码路径报了 `not logged into Antigravity` 并跳过 `fetchAvailableModels`）；IDE 与 CLI 目前指向**同一个** Google 账号。

## 构建与安装

```powershell
node scripts/build.mjs          # junction 链接依赖 + tsc 编译 src → lib + 拷 client 工件
```

- 依赖链接目标是**正在运行的 DSH 安装**（默认 `C:\dsh\node_modules`），保证编译期 `.d.ts` 与运行期模块实例都和 harness 一致；可用 `DSH_INSTALL` 覆盖。
- 开发期热注入：`dev_inject_plugin <本仓库路径>`；改完 `dev_reload_package harness-pilot`。
- 持久安装：`dev_install_package`（或 `plugin_manager install_bundle`），由 `cordis.patch.yml` 挂载。

## 已验证 / 未验证

**已实测通过（2026-10-01，桌面端 desktop profile）**

- **桌面端挂载**：`profiles/desktop/package.json` 增加 link 依赖 + bundles 条目、
  `node_modules/@dsh-external/dsh-harness-pilot` junction；经 `pluginManager` RPC 热切换
  bundle（`setBundleEnabled` false→true）即可加载/重载新代码，**无需重启 DSH**。
- **服务时序修复（关键缺陷）**：bundle 启动场景下主 fiber 只等 `inject` 声明的服务，
  `ctx.get('webServer')` 在 webServer 注册前抢跑拿到 undefined → HTTP 路由静默丢失（全 404）。
  修复：webServer / subagents 走**子 fiber**（`ctx.plugin({ inject })`，服务到了才注册，永不抢跑）；
  唤醒链服务（agents / sessionController / sessions）改为**投递回执时惰性解析**。
  修后 `GET /harness-pilot/api/overview` 200、`GET /settings` 正常返回。
- **完成回执端到端**：`POST /task/start`（target=opencode，notify=true，session_id=发起会话）
  → 后台跑完回 `TASK-E2E-OK` → 任务 `callback.status=delivered`（"completion receipt queued as a
  follow-up turn …; agent woken"）→ 回执（含交付内容）作为新 turn 出现在发起会话并唤醒 agent 继续任务。
- **离线测试** `probe/verify-tasks-wake.mjs`：23/23 PASS（设置读写/落盘、任务全生命周期、
  回执文本与截断、failed/skipped 如实记账、resolveAgent→followup→flush 唤醒链、
  惰性服务解析、agents.resume 会话重新启动回落）。

**历史实测（web profile，0.3.x 时代）**

- 工具面与子代理 provider 都真实注册进运行时（六个 `harness_*` 工具在工具表里）；已 `dev_install_package` 持久装配，重启后由 bundles 列表接管。
- `harness_dispatch target=opencode` **headless** → 真实 OpenCode CLI 返回 `PILOT-E2E-OK`（约 3.7s）。
- `harness_dispatch target=opencode` **acp** → `PILOT-ACP-OK`，`stop=completed`、`acpStopReason=end_turn`、`acpModelNote=model set to opencode-go/deepseek-v4.1-flash`（`initialize` agentName=OpenCode 2.0.14 / protocolVersion=1）。
- `harness_agent target=opencode-flash` → 子代理 provider 返回 `PILOT-SUBAGENT-OK`，`stop=completed`，带稳定 runId。
- `harness_open target=opencode-tui` + `harness_send` → 完整读到交互式 OpenCode TUI 屏幕（xterm 屏幕还原，200 列）。
- **cdp**：headless Chromium 全链路 PASS（`/json/list` → attach → `Runtime.evaluate` → `Input.insertText` → Enter 三事件 → 稳定判定 → 清理）；真实 Electron（MiniMax Code）成功附着 `app://./archon` 并读出 DOM 文本；对正在运行且无调试端口的 ZCode/MiMo 在 spawn 之前诚实拒绝（PID 集合前后一致，没偷偷再起实例）。
- **window**：模块 E2E 11/12 PASS（真实 conhost 窗口：launch → focus → 读控制台真实文本 → 注入 → 文本变化 → abort/timeout/错误路径），唯一 FAIL 是探针自带的「冻结 helper」断言（它专门验证已被修掉的 bug）。
- **window 读真实 GUI**：`harness_open target=zcode` 成功附着运行中的 ZCode（hwnd 1182200），读出 70+ 行真实 UI 文本（项目列表、任务名、命令面板、标签页）。注意：这是**界面文本**（导航/列表/按钮），不等于聊天正文；聊天正文建议走 `cdp` 或该 harness 的 CLI。
- `.cmd` shim 引号修复：带空格/冒号/`&`/内嵌引号的 prompt 作为**单个** argv 原样送达（`&` 未被当命令分隔符）；双形态 argv（verbatim 给 child_process，普通形态给 node-pty）。

**本轮修掉的本机缺陷（都有复现证据）**

| 缺陷 | 症状 | 修法 |
|---|---|---|
| `ctypes.wintypes.COORD` 在 Py3.12 不存在 | 控制台读取全部抛错 → window 通道报废 | 用 `getattr(wt,'COORD',wt._COORD)` |
| 文本来源启发式按长度比较 | 113 字的标题栏装饰压过 46 字真实终端内容 | 只要控制台读到非空文本就优先控制台 |
| `GlobalAlloc/GlobalLock/SetClipboardData` 没声明 `restype` | 64 位 HGLOBAL 被截断 → 非 ASCII/多行 prompt 打不进去 | 声明 `c_void_p` restype/argtypes |
| 中文 IME 改写注入按键 | `>`→`》`、空格被吃、回车只提交候选词 | 一律剪贴板粘贴 + 打字期间 `ImmAssociateContext(hwnd,NULL)` |
| `shot` 用屏幕区域抓取 | 窗口被遮挡时拍到的是前面的浏览器 | 优先 `PrintWindow(PW_RENDERFULLCONTENT)`，失败才回退 |
| `.cmd` argv 二次转义 | `cmd.exe` 报「不是内部或外部命令」 | 双形态 argv + `windowsVerbatimArguments`（headless/acp/cdp 都改） |
| ACP 无法选模型 | opencode ACP 默认模型走 OpenRouter（余额不足） | 新增 `acpModel`，`session/new` 后发 `session/set_config_option` |

**多账号实测（2026-09-30 当晚，6 个目标各发一条连通性消息）**

| 目标 | 通道 | 结果 | 证据 |
|---|---|---|---|
| Antigravity CLI (`agy`) | headless `-p` | ✅ 27.5s 回复 `HARNESS-OK` | stdout |
| Qoder CN IDE | cdp（端口 9336） | ✅ 回复 `HARNESS-OK` | DOM 里同时出现我的消息与回复 |
| MiMo 桌面端（账号 `<redacted>`） | cdp（9334，先重启带端口） | ✅ 回复 `HARNESS-OK`，已处理 14s | DOM 时间戳 + 回复 |
| MiMo 桌面端 AI（账号 `<redacted>`） | cdp（9333） | ✅ 回复 `HARNESS-OK`，已处理 6s | DOM 时间戳 + 回复 |
| ZCode 桌面端 | window（UIA） | ✅ 已送达并被处理 | 任务名自动生成 + `HARNESS-OK` 落在 `~\.zcode\cli\db\db.sqlite` |
| Antigravity IDE | cdp（9337） | ✅ 新建会话并回复 `HARNESS-OK` | DOM：`Thought for 2s` + 回复 |

本次为打通 GUI harness 补的能力（都在 `harness_send` / 目标配置里）：

- `harness_send(click: "…")` —— **按名字点元素**：CDP 会话走 DOM 文字匹配，窗口会话走 UIA 名字匹配（打开面板、点「新建任务」/发送按钮）。
- `window.openInputKeys` —— 打字前先按快捷键把焦点带进输入框（ZCode 用 `ctrl+n`）。
- 每个 GUI 目标分配**固定 CDP 端口** + 端点归属校验（避免 A 应用占了端口、B 目标误附着到 A 的页面上）。
- **关会话不再关用户窗口**：只有插件自己启动的窗口才在 `harness_sessions close` 时关闭（附着来的窗口只脱手）。
- helper 关掉 pyautogui 角落自锁并在注入前把光标挪出角落，否则光标停角落时连键盘注入都会被误拒。


**已知限制**

- `window` 通道对 Electron harness 读取到的是**界面文本**（导航、列表、按钮），不保证包含聊天正文；需要正文请走 `cdp`，或干脆走它的 CLI（`zcode-cli` / `mimo-cli` / `codebuddy`）。
- `cdp` 需要 harness **以调试端口启动**；已在运行且没带该端口的 Electron 应用是单实例，重新启动只会聚焦旧实例 —— 这种情况插件会明确报错，让你先关掉再用 `harness_open` 拉起。ZCode/MiMo 的 `inputSelector` / `sendSelector` / `busySelector` 仍为空（需在它们带端口启动后实测补上），当前靠 DOM 启发式定位输入框。
- `send()` 是光标处插入、不清空输入框（正文里原有草稿会被前缀拼接；note 里会报 `N chars before`）。
- `pty` 通道对全屏 TUI 的文本还原依赖 `@xterm/headless`；缺失时退化为「去 ANSI + 取尾部」。
- `harness_dispatch` 不会在运行中途换通道重跑（避免任务被执行两次）：通道选择发生在预检阶段。
- ZCode 的内置 CLI 需要 app 内的 provider 配置（本机该文件缺失），所以走 `ELECTRON_RUN_AS_NODE` 时 `-p` 仍可能报「无法定位 CLI ZCode Built-in Provider Config」；这种情况请用 GUI/CDP 通道。
