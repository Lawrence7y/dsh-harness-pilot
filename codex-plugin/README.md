# Harness Pilot 0.3.3

Codex 本地 MCP 插件：将任务派发给本机其他 harness，按任务选择模型、读取增量进度和最终结果。复用已有 Harness Pilot 通道实现，新增独立 MCP 服务与任务管理；不依赖 DSH 常驻。外部 harness 是独立产品进程，保留自身账号和权限，并非 Codex 原生子代理。

## 能力

| 工具 | 用途 |
| --- | --- |
| harness_list / harness_probe | 目标目录与通道探测 |
| harness_models | 查询产品自身模型列表或已连接 GUI 的可见选项 |
| harness_start | 立即返回 task_id，在后台执行任务 |
| harness_status / harness_progress | 状态与字符游标增量日志 |
| harness_wait / harness_result | 有界等待与分页结果，完整结果落盘 |
| harness_cancel / harness_tasks | 取消与当前进程任务列表 |
| harness_open / harness_read / harness_send | 连接真实 GUI 会话、切模型、读屏与发消息 |

内置 29 个目标（部分为同一产品的 CLI、GUI 或固定模型别名）：OpenCode、AGY / Antigravity、Claude Code、Codex、MiMo、ZCode、Qoder / Qoder CN、Kimi、Pi、Grok、MiniMax、WorkBuddy / CodeBuddy、Command Code、Cursor，以及未安装占位 Gemini / Qwen。实时返回可用性；找到可执行文件不代表目标能启动或账号可调用模型。新增产品可通过配置注册，不需要修改 MCP 工具。

## 安装和启动

需要 Node.js 22+。在插件目录执行 `npm ci --ignore-scripts --no-audit --no-fund`。依赖 ACP SDK、ws 和 zod；未安装依赖时，基础 headless 通道仍可启动，ACP/CDP 会报告不可用。安装本地插件可在 Windows PowerShell 中运行：

```powershell
powershell -NoProfile -File D:\Project\dsh-harness-pilot\codex-plugin\scripts\install-local.ps1
```

安装脚本将本目录复制到个人 marketplace 的 `plugins/harness-pilot`，保留其他插件条目并通过 Codex CLI 安装。它不会上传云端。安装后刷新插件或重新打开 Codex 聊天，使 MCP 工具加载。

根 `plugin.json` / `mcp.json` 为 Agent Plugins 可移植清单；`.codex-plugin/plugin.json` / `.mcp.json` 为本机 Codex 兼容清单，两者保持一致。MCP 标准输出只写 JSON-RPC，诊断写标准错误。stdio 遵循 [MCP 传输规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。

WSL 下的 `scripts/start.mjs` 会自动桥接 Windows Node，以便调用 Windows 中安装的 harness。默认使用本机 WorkBuddy 自带 Node；可通过 `HARNESS_PILOT_WINDOWS_NODE` 覆盖。要只运行 Linux harness，设置 `HARNESS_PILOT_NATIVE_LINUX=1`，并通过自定义目标替换 Windows 专用路径。Windows 子代理的 cwd 使用 `D:\Project\...`，不是 `/mnt/d/...`。

## 用法

安装后可以直接对 Codex 说：

- “列出本机可用的 harness 和模型选择方式。”
- “让 OpenCode 使用它的某个模型只读审查这个仓库，持续读取进度，完成后汇总结果。”
- “把这个独立模块交给 AGY 实现，限制它只改指定文件。”
- “查看刚才的子代理任务进度。”
- “取消这个任务。”

底层调用示例（参数中的模型必须先确认真实存在）：

```json
{
  "target": "opencode",
  "model": "opencode-go/deepseek-v4.1-flash",
  "cwd": "D:\\Project\\your-project",
  "prompt": "只读审查 README 与入口模块，不修改文件。返回发现、证据和未解决问题。",
  "transport": "acp",
  "timeout_ms": 600000,
  "auto_approve": false
}
```

用返回的 task_id 调用 progress / wait / result。progress 的 offset 是字符位置，使用 next_offset 继续读取。result 默认返回最多 12000 字符，可用 offset/limit 分页；完整正文保存在 result_path。

## 自定义 harness

复制 `config.example.json` 到用户目录并填写真实 command 与参数；通过 MCP 的环境变量 `HARNESS_PILOT_CONFIG` 指向它。`targets` 按 name 合并内置目录，可追加任意符合通道调用约定的 CLI 或桌面目标。CLI 的 prompt 默认为最后一个参数；`promptViaStdin=true` 改用 stdin。模型模板 `modelArgs` 使用 `{model}`。仅支持已验证的 npm / 原生二进制 shim；未知 .cmd 包装脚本会要求配置其真实 exe 或 node 入口，避免提示词被 shell 解释。

任务目录默认 `~/.harness-pilot/tasks`；`HARNESS_PILOT_STATE_DIR` 可以更改。日志与结果保存在本机，可能包含子代理读取的工作区内容；不上传到插件云端。重启后已完成结果可凭 ID 读取，未完成任务标记 interrupted，不自动重跑。maxConcurrent 默认 4；同一 GUI 不同时启动两个任务。

## 实际限制

- 各家模型 ID、支持的参数、登录态和额度各不相同；没有统一全模型清单。不能枚举模型的产品仍可接受其支持的 model 参数；完全不支持模型选择时会明确报错。
- ACP 默认拒绝新的工具权限请求；仅用户明确授权时可设置 auto_approve=true，且只批准 allow_once。CLI/GUI 使用各产品自身权限；这个参数不会覆写它们。
- GUI 切模型需要可用 CDP 和可识别的模型选择器，并读回验证。窗口通道需要 Python 的 pyautogui、Pillow、pywin32、uiautomation；不自动安装。
- PTY 自动复用已安装的 node-pty（本机 C:/dsh/node_modules/node-pty），或通过 HARNESS_PILOT_PTY_MODULE 指定模块路径；未找到时报告通道不可用。TUI 的结束判定也是文本稳定的启发式，须核验任务结果。
- GUI 结果可能是屏幕快照。窗口通道只有在稳定画面中能读回本次提交的提示词前缀时才报告 completed；若只看到主页、导航或侧栏变化，会在 10 秒提示词回显期限后以 error 返回。此检查仍是启发式，关键结果应检查正文；取消监测不保证停止产品的后台生成。
- 部分 CLI 不提供实时输出，此时状态只能显示正在运行，不能计算进度百分比。
- 任务随 MCP 进程存活；关闭连接会请求终止 CLI 进程树，不承诺跨重启续跑。

## 验证

`npm test` 测试 MCP 发现、模型参数、中文日志、分页、错误退出、取消、并发、超时和重启后结果读取。

`scripts/probe-local.mjs` 查询真实本机目录和 OpenCode 模型，不派发任务。添加 `--smoke` 会发送一次禁止工具与文件修改的短回复测试；必须先从产品返回的列表确认模型，并验证终态与回答。

## 完成后自动唤醒原会话（0.3.3）

默认工作流程为：派发 → 本轮结束 → harness 后台执行 → 保存结果 → 向原 Codex 会话发送回执 → Codex 自动续办、核验工作、按需派发下一任务。无需模型持续轮询每个 harness。harness_start 新增 notify_complete（默认 true）与 continuation_instruction；harness_callback_status 只读检查当前会话绑定和桌面管道。

本机 IPC 调用使用桌面端已有 tools/call/send_message_to_thread，而非独立 app-server；通过 MCP 元数据绑定派发来源，适配当前桌面版本 callerSource 字段。桌面通道属于宿主接口，未来版本变化需要重新验证。默认模式在来源或通道不可用时拒绝派发；notify_complete=false 显式选择旧手动模式。

每任务保存 callback 状态：pending/sending/delivered/failed/uncertain。发送后连接丢失不自动重发；delivered 仅表示宿主接受回执。结果正文独立保存；回执不嵌入不受信任的 harness 指令。应用及 MCP 服务须保持运行；关闭应用不保证续办。
