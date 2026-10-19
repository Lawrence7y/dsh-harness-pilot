# @dsh-external/dsh-harness-pilot

## 2026-10-15：桌面账号 API 接入

WorkBuddy 国内版、WorkBuddy.AI 国际版、Qoder 国内/国际已改为读取桌面登录态、直连对应模型 API，不再使用插件内这些产品的 CLI 适配器。Antigravity 改用 DSH 原生 `call-agy` 技能（技能内部仍可运行 agy CLI）。以下旧通道说明仅适用于保留的其他 harness 或历史实现。

设置中的“API 账号池”按四个区域独立管理。选择登录来源，点击“打开原生应用登录”，在原生应用完成登录后再导入；切换原生应用账号并重复导入即可保存多个账号。同一 UID 更新凭据，不同 UID 分开保存；支持 Qoder CN 与 Qoder CN IDE 两个国内登录来源。凭据使用当前 Windows 用户 DPAPI 加密，不向设置页返回令牌。

设置展示各账号完整 API 目录及接口提供的计费信息；倍率不是每次请求的固定积分，接口未提供则显示未知。普通会话手选菜单不列外部模型；模型可通过原生 `list_subagent_models` / `subagent` 选择，用户也可在提示词中指定 provider/model。子代理展示路由的产品、模型及账号；未取得厂商独立回报的实际模型仍为未知。

新 API 账号池启用额度自动切换，最多两次：只在同产品、同区域、支持同一模型的账号间，并且收到明确额度耗尽且尚未输出语义内容/工具调用时切换。401/403/429、网络错误、未知错误不当成额度耗尽；已输出内容不重放。指定 `账号ID::模型ID` 固定账号不自动切换。同一会话后续工具轮次保持账号，优先级/启用状态变化仅影响新会话；明确额度切换后保持新账号。旧 CLI 池开关与本 API 池独立。

真实验收见 `probe/out/native-api-connections-live.json`；离线回归运行 `node probe/verify-connect-pool.mjs`。不要为了验收故意耗尽真实账号额度。现有真实登录来源每区一个，额外账号需用户登录后逐个导入。

> 本机运行时并发设置支持 `maxConcurrent=0`（不限数量）；正整数为有限上限，不再钳制到 16。2026-10-03 按用户要求设为 0，并通过本机 `@dsh-external/harness-unlimited` 辅助插件热应用到已加载的任务管理器，保留现有后台进程和回执。配置文件仍是 `~/.dsh/plugins/harness-pilot/runtime-settings.json`。

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
| `qoder` / `qoder-cn` | VSCode fork | `D:\Qoder\Qoder.exe` / `D:\Qoder CNide\Qoder CN IDE.exe`（按 exe 名探测，兼容 `D:\Qoder CN IDE\` 旧目录名） | cdp → window |
| `antigravity` | Electron IDE | `...\Programs\antigravity\Antigravity.exe` | cdp → window |
| `minimax` | Electron | `D:\minimax\MiniMax Code\MiniMax Code.exe` | cdp → window |
| `grok` | Electron | `D:\Grok bot\Grok Bot.exe` | cdp → window |

## 工具

| 工具 | 用途 |
|---|---|
| `harness_list` | 列出目标与可用性；`probe=true` 时逐个通道实测（会碰窗口/端口，稍慢） |
| `harness_dispatch` | 一次性派发任务，返回 harness 的回答。可 `transport=` 强制通道、`extra_args=` 追加参数（如换模型） |
| `harness_agent` | 以 **DSH 子代理**语义派发：稳定 runId、stopReason、partial output、diagnostic。返回的 runId 已记进运行账本，可事后用 `harness_task_status` 查 |
| `harness_open` | 打开/附着交互会话（CDP / 窗口 / PTY），返回 session id + 当前屏幕文本。`transport=` 强制某一档；`kill_first=true` 处理单实例阻塞（见下节） |
| `harness_send` | 向会话注入文本或按键；不带输入时就是「读当前屏幕」；`model=` 切模型、`click=` 点元素 |
| `harness_sessions` | 列出 / 关闭会话 |
| `harness_task_start` | **后台派发**长任务，立即回 task_id；完成后自动回执唤醒本会话 |
| `harness_task_status` | 查一次运行：状态 / 进度（增量日志）/ 终态交付内容。**两类都支持**：`kind=task`（后台任务）与 `kind=subagent`（内部子代理 run） |
| `harness_task_list` | 列出最近运行（`kind` / 状态 / 回执投递情况），含内部子代理 run |
| `harness_task_cancel` | 取消在跑任务 |

## 单实例应用：`harness_open` 被挡住时怎么办

Electron 桌面端默认单实例。目标**已经在跑、但没带 `--remote-debugging-port`** 时，
再启动一次只会把旧窗口拉到前台，CDP 永远不会出现。这种情况 `harness_open` 会抛出一条
**可直接照做**的错误（`SingleInstanceBlocked`），内容包含：

- 进程映像名与 pid；
- **插件真正会使用的端口**（已按 `cdp.port` / 扫描范围选好的空闲端口，不是猜测值）；
- 五条出路 `[A]`~`[E]`，其中 `[E]` 是**落盘的脚本**：
  `<home>/plugins/harness-pilot/remedies/relaunch-<target>-<port>.ps1`（端口已固化，
  启动 argv 与插件自己启动时逐字一致，末尾还会校验端点是否真的起来）。

```text
[A] harness_open  target=zcode  kill_first=true      # 让插件自己完成整条流程
[B] Stop-Process -Name ZCode -Force                  # 自己关掉，再 harness_open
[C] 关掉 + 带端口重启（一行 PowerShell）
[D] harness_open  target=zcode  transport=window     # 放弃 CDP，直接驱动已有窗口
[E] 直接运行上面那个 .ps1
```

`kill_first=true` 的五条安全约束（都在 `terminateForLaunch()` 内实现，别处不得绕过）：

1. **只在 CDP 端点确实不存在时执行** —— 端点存在时代码早已 attach 返回，**绝不重启一个能用的应用**；
2. **只碰检查时见过的 pid**：动手前逐个核对 pid 的映像名（防 **pid 复用**误杀），
   绝不终止检查之后才出现的进程；一个都没匹配上时如实拒绝并提示 `kill_force=true`。
   > 早先写成"出现任何新 pid 就整体拒绝"，对多进程 Electron 是**有害**的：渲染/GPU helper
   > 本来就会随时增减，护栏于是变成"`kill_first` 在真实应用上直接失效"。
3. **动手前最后一次确认**：这期间若出现了属于本目标的 CDP 端点，立即放弃终止
   —— 那是一个**刚刚变得可用**的会话，不能杀；
4. **优雅优先**：先发 `WM_CLOSE`，3s 后才强制结束，给应用落盘机会；
5. **白名单**：映像名为空或属于系统/宿主进程（`explorer.exe`、`node.exe`…）直接拒绝 —— 防配置写错。

被杀掉的 pid 会写进会话 `detail`、工具返回文本与插件日志，可审计。

> **`harness_list probe=true` 的预检是只读的**：它只报告"被挡住 + 补救命令"，不会真的去杀。
> 真正执行终止的只有 `harness_open kill_first=true` 这一条路径 —— 而"能不能用"的判定
> 必须把 `kill_first` 一起算进去，否则 `open()` 会在预检处 `continue` 跳过 cdp，
> `openCdp()` 里的终止分支永远走不到（这正是 `kill_first` 曾"提示了却从不执行"的原因）。

另外：**通道降级不再静默**。以前 `registry.open()` 对不可用通道直接 `continue`，
你以为在用 CDP、其实跑的是 window。现在会在返回文本顶部显式说明降级原因与补救命令。

### 启动 GUI 应用时必须清掉 `ELECTRON_RUN_AS_NODE`

宿主环境（Codex / 某些 agent 运行时）会设置 `ELECTRON_RUN_AS_NODE=1`。**Electron 只要看到这个变量
就以 Node 模式运行** —— 不开窗、不初始化应用、跑完直接退出（exit 0）：

```text
"D:\Qoder CN\Qoder CN.exe" --version   →   v24.18.0      # Node 版本，不是应用版本
"D:\Qoder CN\Qoder CN.exe" --help      →   Usage: node [options] [ script.js ] …
```

对 `kill_first` 来说这是**最阴的失败模式**：它先把用户的应用关掉，再"带调试端口拉起"时拉起的是
一个立刻退出的 Node 进程 → 没有 CDP 端点 → 等端点超时 → 回收进程 → **应用被留在关闭状态**。

所以 `launchEnv()`（`launcher.ts`）在派生子进程时统一清掉它；**目标自己显式声明时以目标为准**
（`zcode-cli` 那种**就是要**当 Node 跑的 CLI 仍保留 `env: { ELECTRON_RUN_AS_NODE: '1' }`）。
CDP 启动与窗口 helper 两条路径都走它。

> 排查技巧：应用"启动后立刻 exit 0、连自己的日志目录都不建"基本就是这个原因 ——
> 用 `"<app>.exe" --version` 一测便知（输出 Node 版本就是它）。

## 输入安全：点击 / 换模型失败时 **绝不**继续投递

`harness_send` 的 `click=` 与 `model=` 都是 **fail-closed**：

- `click=` 匹配不到元素 → **什么都不输入、不提交**，报错并给出近失配候选（`near misses`）；
- `model=` 切换失败 → 同样中止，避免"你以为已经切好了"却把任务发给了错误的模型。

两者都默认关闭「照发不误」。确实需要 best-effort 时显式打开：

```text
send_anyway_on_click_fail=true    # 点的是可选面板，点不中也能继续
send_anyway_on_model_fail=true    # 就用当前模型发，不要求切换成功
```

> 这条规则的由来是一次真实误投递：`clickByTextSnippet()` 匹配不到元素时**不抛异常**、
> 只返回 `{ ok: false }`，而调用方只 `catch` 了"抛异常"，于是文本被打进当时的焦点位置并回车提交。

## 运行账本：内部子代理 run 也可查询

`harness_task_start`（`kind=task`）与 `harness_agent` / 宿主 subagent 工具经 provider
派发的内部 run（`kind=subagent`）**共用同一本账**，因此：

- `harness_agent` 返回的 `runId` 可以原样丢给 `harness_task_status`（两者是同一个 id）；
- 终态**必落盘**（含失败），`.json` / `.log` / `.result.json` 三件套；
- **停滞探测**：超过 `stallTimeoutMs`（默认 120s）既无进度也无终态 → 状态标成 `stalled`
  并写明 idle 时长，不再永远显示 `running`；真有输出回来会收回 `running`；
- **崩溃恢复**：插件进程结束后，磁盘上仍未完成的 run 读作 `interrupted` 并说明原因，
  不会被当成"还在跑"。

> 内部 run 刻意**不**投递完成回执：调用方本来就在 await 结果，再回执一次就是重复唤醒。
> 卡住的情况靠 `stalled` 状态查询发现。

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

审计方式：能列模型的 CLI 直接问它（`harness_models`）；GUI 应用读它**自己的账号级模型目录**，或在带调试端口启动后用 CDP 打开模型选择器逐项枚举。完整证据在 [probe/audit/](probe/audit/)。

| harness | 供应商 | 可用模型 | 当前/默认 |
|---|---|---|---|
| **Qoder CN IDE**（账号 `aliyun7629794577`，IDE 已登录） | Qoder CN 网关（UI 只有一个 provider） | **13 + Auto**（界面实时枚举）：Qwen 5 · DeepSeek 2 · GLM 3 · Kimi 2 · MiniMax 1 —— `Qwen3.8-Max`/`Qwen3.8-Flash`/`Qwen3.7-Max`/`Qwen3.7-Plus`/`Qwen3.7-Flash`、`DeepSeek-V4-Pro`/`DeepSeek-Flash`、`GLM-5.3`/`GLM-5.3-Flash`/`GLM-5.2`、`Kimi-K3`/`Kimi-K2.8-Preview`、`MiniMax-M2.7`（带倍率，如 Qwen3.8-Flash 0x、Kimi-K3 1.4x） | `Qwen3.8-Flash` |
| **MiMo 桌面端**（账号 `3207006862` · CN） | `xiaomi` @ api.xiaomimimo.com | **7**：文本 `mimo-v2.6-pro`/`mimo-v2.6-flash` · TTS ×3 · ASR `mimo-v2.5-asr` · 图像 `Doubao-Seedream-5.0-pro` | `mimo-v2.6-pro` |
| **MiMo 桌面端 AI**（账号 `6871001722` · SGP） | 同上 | **7**，与上表唯一差异：图像是 `gpt-image-2` | `mimo-v2.6-pro` |
| **ZCode 桌面端** | 5 家（账号级；四套 coding plan 均 `coding_plan_not_entitled`） | **8**：`opencode`→`deepseek-v4.1-flash`,`mimo-v2.6-flash` · `xiaomi-mimo`→`mimo-v2.6-pro`,`mimo-v2.6-flash` · `step`→`step-5-preview` · `synapse`→`claude-opus-5-5` · `bigmodel`→`GLM-5.3`,`GLM-5.3-Flash` | 最近用 `step-5-preview` |
| **Antigravity IDE**（账号 `sk01096691696@gmail.com`） | Google / Anthropic / OpenAI-oss（UI 不标 provider） | **7**（选择器实时枚举）：`Gemini 3.8 Flash(High)`、`3.7 Flash(Medium)`、`3.6 Flash(Medium)`、`3.1 Pro(Low)`、`Claude Sonnet 4.6(Thinking)`、`Claude Opus 4.6(Thinking)`、`GPT-OSS 120B(Medium)` | `Gemini 3.8 Flash (High)` |
| **Antigravity CLI**（`agy`，同账号） | 同上 | 目录 **14**：Gemini 11 · Claude 2 · GPT-OSS 1（`agy models` 是目录，当前登录态下 entitlement 拉取被跳过，实际可用以运行为准） | `gemini-3.8-flash-high` |

要点与坑：

- **GUI 应用只能在它自己的界面里选模型**——插件能派发任务、能读界面，但不能替它切模型（`canSelectModel=false`）；CLI/ACP 类的目标可以（`model=` / `acpModel`）。
- **Qoder CN**：目录里有 21 个具体模型、账号实际只被授权 13 个（`catalog-v6` 是加密容器，过滤规则读不出来）；`qoderclicn` CLI **未登录**（与 IDE 是两套凭据）。
- **ZCode**：桌面端模型来自 `provider_config.json` + models.dev，`~/.zcode/cli/models/api.json`（145 供应商/5264 模型）**只是 CLI 自己的镜像**，不是桌面端下拉框的来源。
- **MiMo**：账号级目录 `model-catalog.json` 会校验 `account` 字段（不匹配就返回空），所以它就是"当前登录账号能选什么"的权威答案；另有 BYOK 目录 `models-with-claude.json`（223 供应商 / 7958–8177 模型）属于"自定义模型"入口。
- **Antigravity**：`agy models` 的 14 个不等于 entitlement（其代码路径报了 `not logged into Antigravity` 并跳过 `fetchAvailableModels`）；IDE 与 CLI 目前指向**同一个** Google 账号。


```powershell
cd D:\Project\dsh-harness-pilot
node scripts/build.mjs          # junction 链接依赖 + tsc 编译 src → lib + 拷 client 工件
```
- 依赖链接目标是**正在运行的 DSH 安装**（默认 `C:\dsh\node_modules`），保证编译期 `.d.ts` 与运行期模块实例都和 harness 一致；可用 `DSH_INSTALL` 覆盖。
- 开发期热注入：`dev_inject_plugin D:\Project\dsh-harness-pilot`；改完 `dev_reload_package harness-pilot`。
- 持久安装：`dev_install_package`（或 `plugin_manager install_bundle`），由 `cordis.patch.yml` 挂载。


```powershell
cd D:\Project\dsh-harness-pilot
node scripts/build.mjs          # junction 链接依赖 + tsc 编译 src → lib
```
- 依赖链接目标是**正在运行的 DSH 安装**（默认 `C:\dsh\node_modules`），保证编译期 `.d.ts` 与运行期模块实例都和 harness 一致；可用 `DSH_INSTALL` 覆盖。
- 开发期热注入：`dev_inject_plugin D:\Project\dsh-harness-pilot`；改完 `dev_reload_package harness-pilot`。
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
| MiMo 桌面端（账号 `3207006862`） | cdp（9334，先重启带端口） | ✅ 回复 `HARNESS-OK`，已处理 14s | DOM 时间戳 + 回复 |
| MiMo 桌面端 AI（账号 `6871001722`） | cdp（9333） | ✅ 回复 `HARNESS-OK`，已处理 6s | DOM 时间戳 + 回复 |
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

## 变更记录

### 0.1.1（2026-10-09）— Qoder CN IDE 目录改名 + Quest 窗口

起因：`harness_open target=qoder-cn` 报 `cannot resolve "D:\Qoder CN IDE\Qoder CN IDE.exe"`，
而 `harness_send` 又报 `cannot find the prompt box`。两个独立缺陷：

1. **安装目录名被改，写死的路径失效。**
   Qoder CN IDE 重装/升级把安装目录从 `D:\Qoder CN IDE` 改成了 `D:\Qoder CNide`（旧的
   `D:\Qoder CN IDE` 只剩 `resources/` + `debug.log`）。因为**目录还在**，光看路径存在性
   发现不了，`cdp` 通道会以"命令无法解析"直接 skip、`window` 通道也匹配不到进程 —— 整个
   目标静默失效。现在用 `resolveRenameableExe()`：先按已知候选探测，都不到就扫
   `D:\` / `C:\` 下带同名 exe 的 `Qoder*` 目录，目录改名不再需要改配置。

2. **`window.title` 的 `/xxx/i` 写法从未生效。** `matchPatterns()` 旧条件是
   `startsWith('/') && endsWith('/')`，而 `/Qoder/i` 结尾是 `i` —— 于是内置目录里**所有**
   GUI 目标的 title 匹配规则（`/Qoder/i`、`/ZCode/i`、`/MiMo/i`、`/Cursor/i` …）全部退化成
   「按字面量找带斜杠的字符串」，永远匹配不上，只剩进程名/目标名还能加分。后果：**标题为空
   的页面拿 0 分**，`bestScore > 0` 判定失败，目标被当成"别人的 CDP 端点"拒绝。现在按
   `/body/flags` 正确解析（非法正则退回字面量），并放宽成"配了 `pageMatch` 不命中只扣分"，
   页面尚未出现时仍能附着到兜底页。

3. **新增 `cdp.pageMatch`：把附着页面钉到真正有输入框的那个。**
   一个 Electron 应用常在同一个调试端口上暴露多个 page。Qoder CN IDE 1.32 把 agent 对话
   搬到了**独立的 Quest 窗口**（`…/lingma/agents-window/…`），workbench 里根本没有输入框 ——
   附着到 workbench 就必然找不到输入框。`qoder-cn` 现在配了
   `pageMatch: 'agents-window'` + `inputSelector: '.chat-input-contenteditable'` +
   `sendSelector: 'button[aria-label="Send message"]'`。

   > ⚠️ 派发前需要 Quest 窗口已打开（菜单栏 `打开 Quest`）。1.32 起 workbench 内不再有
   > agent 输入框，插件也没有"点开 Quest"这一步。

验证脚本（都在 `probe/`，对着一个已经带 `--remote-debugging-port=9336` 跑着的 IDE）：

```bash
node probe/verify-qoder-cn-target.mjs 9336   # probeCdpTarget.available 必须为 true
node probe/verify-qoder-cn-send.mjs 9336 180 # 走 session.send()，等一个每次唯一的 nonce 回复
```

两个脚本在修复前分别失败在「目标被判定为不可附着」和「找不到输入框」，修复后通过；
`verify-qoder-cn-send.mjs` 收到的是当次 nonce 的原样回复。

**踩坑记录（不是插件的 bug，但会浪费很久）**：从 DSH 派生的 shell 里手工敲
`"D:\Qoder CNide\Qoder CN IDE.exe" --remote-debugging-port=9336` 会**启动即退出**，
因为它继承了 `ELECTRON_RUN_AS_NODE=1` —— 一测 `--version` 输出 `v24.15.0` 就是它。
插件自己的启动路径走 `launchEnv()` 会清掉这个变量，所以只有手工启动会踩到。
