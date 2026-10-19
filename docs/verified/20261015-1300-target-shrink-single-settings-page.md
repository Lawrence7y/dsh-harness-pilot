# 2026-10-15 · 目标二次收缩 + 设置页合并 + model-connect 页面修复 + 全链真实联通验收

> 状态：**已完成并 live 验证**（含浏览器截图验收）。回滚快照：`D:\Project\_dsh-baseline\dsh-harness-pilot-P45-shrink-singlepage-20261015-1300.zip`（62MB）、`dsh-model-connect-P45-cardpage-20261015-1300.zip`（430KB）。上一快照 P44（拆分后初始态）仍保留。

## 0. 本轮用户指令（原话要点）
1. 从本系统卸载 commandcode、Grok。
2. 从外部 harness 管理插件删除 commandcode、Grok、Cursor、opencode。
3. Zcode / MiniMax / Kimi：如果无法获取模型，也删掉。
4. 外部 harness 管理插件只保留**一张**设置页（此前一级页 + 内置插件里的二级页并存）。
5. WorkBuddy/Qoder 插件（dsh-model-connect）的设置页此前不可见，参照 github.com/corrinehu/dsh-workbuddy-connect 的设置页补上。
6. 真实联通测试：① model-connect（WB 国内/国外 + Qoder 国内）真发请求；② pilot 对当前系统所有外部 harness 桌面版做连通性测试。
7. （追加）所有 UI 修改项都要用截图验证。

## 1. 系统卸载
- **Grok Bot 0.70.2**：`D:\Grok bot\Uninstall Grok Bot.exe /allusers /S` 静默卸载。验证：程序目录已删、HKCU 卸载注册表项已清、开始菜单快捷方式已删、`%APPDATA%\Grok Bot`（30MB Electron 缓存，无用户数据）已删。
- **command-code**：查证为 **WorkBuddy 桌面自带** `node_modules` 内的包（`C:\Users\Administrator\.workbuddy\...\node_modules\command-code`），**无独立系统安装可卸**。不动 WorkBuddy 自己的文件（model-connect 还依赖其桌面登录态），仅从插件删除目标。

## 2. pilot 目标表：16 → 5
实测后删除 11 个：
| 目标 | 依据 |
| --- | --- |
| opencode / opencode-flash / opencode-tui / opencode-desktop | 用户点名删 opencode（全家） |
| command-code | 用户点名；WorkBuddy 内置包 |
| grok | 用户点名；且已卸载 |
| cursor | 用户点名 |
| **kimi** | 无法获取模型：未登录、`kimi provider list` = No providers configured、config.toml 为空 |
| **zcode / zcode-cli** | 无法获取模型：CLI 0.16.9 无 models 命令、无 --model；`~/.zcode/cli/config.json` 仅 1 个自配模型；桌面 8 模型只能人肉读 GUI |
| **minimax** | 无法获取模型：仅 GUI，mavis shim 已失效 |

保留 5 个：**claude(7 模型) / codex(7) / pi(98) / mimo(66, 桌面端) / mimo-cli(66)** —— 全部「宿主原生调不了 + 能枚举模型」。
live 验证：`/harness-pilot/api/overview` → targets 5、harnessGroups 4（claude-code 7 / codex 7 / mimo 66 / pi 98）。

连带修改：`harness-groups.ts` CLASSES 表同步收缩；client.js TARGET 文案、package.json description；探针夹具换目标（verify-subagent-model-options：kimi→pi、command-code→mimo；verify-harness-llm-providers 阈值 ≥8→≥4）；**mimo-cli 通道顺序改为 headless 优先**（见 §5）。profile 的 allowedModels 里历史 provider 条目对已注销 provider 是惰性的，未动 profile。

## 3. pilot 设置页合并为一张
- 删除 `settings.plugins.tab` 座位注册与 `HarnessPilotCard` 组件（二级页）。
- 二级页承载的 7 个诊断面板（插件设置 / 任务与执行身份 / 实时会话 / 进程与内存 / DSH 供应商 / Harness 注册表 / 自动切换执行侧）**原样并入一级设置页底部，默认全部收起**——搬家不是删除。
- verify-ui-smoke 反向钉住：注册了 `settings.plugins.tab` 即 FAIL。

## 4. model-connect 设置页：从「不可见」到卡片式
三个真实 bug，逐一修复并 live 验证：
1. **缺 `./client` 导出** ⇒ 客户端从未被加载（对照 workbuddy-connect 参考实现与 `dsh-cordis-client-runner` 源码注释确认：浏览器半边经 `exports["./client"]` 发现）。补 `"./client": "./client.js"`。
2. **client 返回值缺 `inject: ['slots']`** ⇒ `ctx.slots` undefined ⇒ apply 抛 TypeError ⇒ **web boot「entry did not activate」弹窗、应用无法启动**（03:59 与 04:16 两次 crash log 实证）。声明后启动干净。
3. **API 根路径写错**：客户端 GET/POST `/model-connect/api/connect`，服务端 summary 在 `/model-connect/api`（空 leaf）⇒ 405/404。旧探针把这个错误路径固化成了断言，一并修正。

页面按参考插件重做：顶部「添加账号」栏（5 个登录来源一个下拉）+ **每个已保存账号一张卡**（状态点 / 显示名 / 产品徽章 / 可用·积分·更新时间 / **状态·模型·明细三页签**）+ 号池配置与池事件收在底部 details。会话头徽章保留「账号：X」展示。离线探针 verify-connect-settings 全绿（含指纹只露前 8 位、错误必须可见、渲染期不发上游请求等断言）。

**事故记录**：04:12 在宿主运行中重建（HMR 生效中）触发上述 bug 2 的首次爆发，宿主两次弹「应用无法启动」。根因修复后干净重启，无新 crash log，两插件 API 均 200。教训：**client 返回 `inject` 数组是宿主硬约束**，离线 vm 探针桩掉了宿主注入器所以测不出来——现已把该契约钉进探针。

## 5. 真实联通测试（全部真发请求）
### 5.1 model-connect（新增 probe/verify-live-upstream.mjs，收据 probe/out/live-upstream-*.json）
| 账号 | 模型 | 结果 |
| --- | --- | --- |
| WorkBuddy 国内版 | hy4-preview-f | ✅ 回复「连通正常」，11.3s |
| WorkBuddy.AI 国际版 | default-model | ✅ 回复「连通正常」，1.6s |
| Qoder CN | Auto | ✅ 回复「连通正常」，0.8s |

（Qoder 国际版 1 模型账号不在用户指定清单，未测；探针支持按需补测。）

### 5.2 pilot 全目标真实派发（新增 probe/verify-live-dispatch.mjs + 前台分段执行）
| 目标 | 结果 |
| --- | --- |
| claude | ✅ headless / completed / 45s / 回复「正常」 |
| codex | ⚠️ 链路通（CLI 拉起、请求发出），上游 **401 Unauthorized（api.openai.com）**——OpenAI 登录态失效，**需用户在终端 `codex login`** |
| pi | ⚠️ 链路通；默认模型 gpt-5.5 被 ChatGPT 账号后端拒（not supported），显式 deepseek/deepseek-flash 又 401（pi 的 deepseek key 失效）——**两家凭据都需用户重新登录** |
| mimo-cli | ✅ headless / completed / 21s / 回复「正常」。**附带发现**：acp 通道会话能建立、turn completed 但**读不到正文** ⇒ 已把 mimo-cli 通道顺序改为 headless 优先（有实测依据） |
| mimo（桌面端） | ✅ CDP 全链：拉起 App → 附着 9334 → 输入注入 → 回车提交 → 读回「已处理 13s **正常**」（MiMo-V2.6-Pro 回复）。冷启动首轮读回被侧栏文本污染属已知读回质量问题，热测干净 |

结论：**插件侧链路全部可用**；codex/pi 的失败均在用户凭据层，插件无可修。

## 6. UI 截图验收（用户本轮追加要求；共 5 张 + 菜单交互序列）
1. 设置导航：一级页出现「外部 harness 管理」「API 模型连接」两项，原版风格 ✓
2. 外部 harness 管理页：4 条 harness 行（模型数非 0）、诊断面板折叠于底部、无二级页 ✓
3. API 模型连接页：添加账号栏 + 4 张账号卡（状态/模型/明细页签、积分、账号池）✓
4. 内置插件页：无重复管理界面 ✓
5. 模型选择器（新会话）：外部 CLI · Claude Code / Codex / Pi / MiMo 四组在列；搜索 grok / command-code **无匹配**，kimi 仅命中 MiMo 组内模型名（非 Kimi 组）；部署默认模型 MiMo-V2.6-Flash 未被改动 ✓

## 7. 探针与回归
- pilot `_regression-suite.mjs`：**21/21 PASS**（含修正后的 ui-smoke / subagent-model-options / harness-llm-providers）
- model-connect：verify-connect-pool / connect-settings / connect-wire-failover 全 PASS；live-upstream ALL-OK
- 宿主重启后：无新 web-boot crash log；`/model-connect/api` 200（4 账号 ready）；`/harness-pilot/api/overview` 200（5 目标/4 组）

## 8. 边界与已知事项
- codex、pi 需要用户在各自 CLI 重新登录后才能出活（链路已验证畅通）。
- mimo-cli 的 acp 通道「completed 但无正文」未修（规避：通道顺序已改为 headless 优先）；若要修需另行排查 mimo ACP 的 sessionUpdate 文本抽取。
- MiMo 桌面端冷启动首轮读回可能混入侧栏文本（完成判据已要求 prompt 回显；热轮次干净）。
- pi 分组展示 antigravity/* 模型属正常（pi CLI 经其 antigravity 供应商枚举，归属 Pi 组）。
- command-code 无法从系统卸载（WorkBuddy 内置包），已仅从插件移除。
- pilot node_modules 里指向已删 vendor 的悬空 junction（dsh-llm-pi-ai）已清理。

## 9. 追加轮（同日 13:00-13:35）：对话可选 + 子代理白名单清理 + 桌面/账号矩阵
### 9.1 用户追加指令
1. 参考插件能在**对话中**选 WorkBuddy 模型（每模型带积分抵扣系数 + 思考强度），本机看不到 → 补齐。
2. 「子智能体选择」残留 OpenCode 等已删 harness 的模型 → 清掉。
3. 真实联通矩阵：4 账号各一发（WB 双版=DeepSeek V4.1 Flash；Qoder 双版=Qwen3.8 Flash）；桌面拉起 Qoder.CN 桌面版、MiMo、Antigravity、ZCode（用户中途补：Qoder.CN 桌面版与 Qoder CN IDE 是两个软件，都要测）。

### 9.2 对话内可选（积分系数）
- 根因：上轮 model-connect 装了 conversation-model-policy（subagent-only）——把 4 条 provider 从 sessionController.modelCatalog 滤掉并在 selectModel 拒绝。按用户指示**整块移除**（`src/conversation-model-policy.ts` 已删）。
- 积分系数**无需新增代码**：vendored 适配器本就把 billing rate 折进模型显示名（与参考插件同一份代码），解除过滤即自动生效。
- 截图实证（新会话模型目录）：「外部模型 · WorkBuddy（国际 / WorkBuddy.AI）」Primary **×3.31** / Hy4 preview **×0.29** / Hy3、Deepseek-V4.1-Flash **×0.00 Free now**；「外部模型 · Qoder（国内）」Kimi-K3 **×1.40** / Kimi-K2.8-Preview **×0.80** / MiniMax-M2.7 **×0.20**；「外部模型 · Qoder（国际）」Qwen3.8-Flash **免费**；账号别名条目（`· WorkBuddy.AI 国际版当前桌面登录`）并存。思考强度走宿主原生「推理等级」选择器。
- 快照：`dsh-model-connect-P45b-picker-visible-20261015-1330.zip`。

### 9.3 子代理白名单清理（1466 → 183 种子 → live 297）
- 根因：`subagent-model-selection-settings.allowedModels` 的 profile 种子含历史死条目：pilot-cli 647、harness-opencode 483、harness-antigravity 6、过期 qoder/wb 快照 147。
- 修复：备份（`cordis.patch.yml.bak-presubagent-clean-20261015-1305`）后重写种子为 183 条（xiaomi/step/opencode-go + 现存 pilot 4 组），全文件 YAML 复验通过。第一次行级重写曾把块尾接错（YAML 断裂），立即从备份恢复并用逐条解析重做——教训已记。
- 事实确认：**profile patch 就是宿主设置的持久化层**——model-connect 的白名单授予会把 live 条目写回该文件（文件在运行中被宿主改写，已目击）。
- live 验证：`/subagent-model-selection` → 297 条 = pilot 4 组(178) + connect 4 组当前 live 模型(114，插件自动重授予，带账号别名) + 宿主原生(5)；**foreignProviders 只剩 3 个宿主原生供应商**；pilot-cli / harness-opencode / harness-antigravity **零残留**。

### 9.4 真实联通矩阵
**账号侧**（probe/verify-live-upstream.mjs 扩展 `family-region=modelId` 覆盖参数；收据 live-upstream-1792039955887.json）：
| 账号 | 指定模型 | 结果 |
| --- | --- | --- |
| WorkBuddy 国内 | deepseek-v4.1-flash | ✅ 回复「连通正常」2.9s |
| WorkBuddy.AI 国际 | deepseek-v4.1-flash | ✅ 回复「连通正常」4.0s |
| Qoder CN | Qwen3.8-Flash | ✅ 回复「连通正常」0.8s |
| Qoder 国际 | Qwen3.8-Flash | ❌ 上游 112 + pricing 链接（**登录态有效**，账号套餐/额度不允许发起对话——用户侧权益问题） |

**桌面侧**（临时测试目标挂 profile config，内置表不变；测完可删）：
| 桌面 | 指定模型 | 结果 |
| --- | --- | --- |
| MiMo 桌面版 | MiMo-V2.6-Flash（其界面默认） | ✅ 回读「已处理 3s 连通正常」 |
| Antigravity 桌面版 | Gemini 3.8 Flash | ✅ 读回含「Gemini 3.8 Flash High Turbo … 连通正常」，98s |
| Qoder CN 桌面版 0.4.3 | Qwen3.8-Flash | ✅ 转录实证「已处理 连通正常 · 由 AI 生成 · Qwen3.8-Flash」（通用判据读回偏早，第三次派发取到累积证据） |
| Qoder CN IDE（另一软件） | Qwen3.8 Flash | ⚠️ 拉起 + CDP 9343 连通，但 AI 面板输入框**无可见 textarea/contenteditable 可寻址**（heuristic 找不到；需先手动展开 AI 面板，无选择器配置）——GUI 自动化缺口，如实报告 |
| ZCode 桌面版 | MiMo V2.6 Flash | ⛔ 本轮不可测：CDP 需带调试端口重启（=杀死承载本轮开发会话的进程）；window 通道实测把输入打进命令面板（读回证实），继续尝试有干扰当前会话风险。建议 ZCode 空闲时由用户配合再测 |

### 9.5 遗留
- profile 里 4 个【临时测试目标】（qoder-cn-app / zcode-desktop / antigravity-desktop / qoder-cn-desktop）测完可删——等用户确认后移除或保留。
- Qoder CN IDE 的自动派发需补它的 AI 面板选择器（input/busy selector）才能用。
- Qoder 国际版账号需用户在 Qoder 侧恢复套餐/额度后重测（插件与凭据都正常）。

## 10. 追加轮（同日 14:30-15:00）：卸载 MiMo Code，只留 MiMo 桌面端
- **系统卸载**：MiMo Code CLI = `C:\Users\Administrator\.mimocode`（@mimo-ai/plugin 0.1.14），已删目录 + 用户 PATH 里的 `.mimocode\bin` 条目；`where mimo` 已找不到。MiMo 桌面端（D:\mimo）独立，保留。
- **插件**：mimo-cli 目标删除（config.ts + harness-groups CLASSES），mimo 桌面端保留；内置目标 5→**4**（claude/codex/pi/mimo）。MiMo 桌面端无 CLI 发现命令，选择器只展示「CLI 默认模型」档（描述里写明）。
- **可派发口径修正**：`isDispatchable` 从「仅 transport:auto」扩为「auto 或 cdp」——2026-10-15 桌面矩阵实测 cdp 一次性派发端到端可用（mimo/antigravity/qoder 桌面版都真实回话），旧结论「cdp 只能 GUI 操控」作废；window 通道仍不可承诺（实测会误入命令面板）。mimo 桌面端因此保住会话/子代理可选资格（harness-llm.ts + harness-groups.ts 同口径）。
- **并行会话冲突（重要）**：修复期间发现**另一会话在同时编辑本仓库**（src/config.ts 13:54、harness-groups.ts/harness-llm.ts 13:58、llm-adapter.ts 13:29、client.js 面板文案 13:39 的改动都不是本会话所写）：
  1. 「选择器显示」面板文案换版（探针旧断言失配 → 已对齐现版文案）；
  2. **listModels 的可见性过滤被移除**（「选择器显示」面板变成不生效的摆设，直接违背用户「逐模型显隐」验收口径）→ 本会话已按用户口径**恢复过滤**（整组隐藏=空目录；组内隐藏+上限=filterPickerModels；执行面不受影响），探针 verify-visibility-isolation 重归绿。
  3. 请用户注意：两个会话同时改一个插件会互相覆盖；建议只保留一个会话在写。
- **回归**：`_regression-suite.mjs` **21/21 PASS**（ui-smoke 补 ctx.effect 桩 + 文案对齐；federation-providers TEST_CASES 裁到 pi/codex 并重建基线；visibility-isolation 恢复过滤后过）。中间一次 400「空变更」是探针与用户实时操作同一份可见性配置相撞（用户 14:01 全隐藏 / 14:14 取消 claude-code 隐藏），状态已按用户操作还原（claude-code 可见，其余 7 组保持用户设置的隐藏）。
- **live 终态**：targets = 4 内置（claude/codex/pi/mimo）+ 4 临时桌面测试目标；MiMo 组只剩桌面端成员。

## 11. 追加（同日 15:0x）：清理子代理白名单「已保存但当前不可用」条目
- 用户指示：把子代理选择模型中「已保存但当前不可用」的条目全部移除（用户界面计数 173；按 live 目录口径实算 **171**——差 2 条是 connect 侧目录里仍活着的边角，以 live 目录为准）。
- 构成：harness-pi 98 + harness-mimo 66 + harness-codex 7——全部因为**用户 14:01 的可见性隐藏**（整组隐藏 ⇒ listModels 过滤 ⇒ 宿主目录里没有这些模型 ⇒ 白名单条目显示为「已保存但不可用」）+ mimo 的 66 条本就随 MiMo Code CLI 卸载而失效。
- 执行：`POST /subagent-model-selection {remove:[171 条]}`（处理器自动落回滚快照到 `~/.dsh/plugins/harness-pilot/subagent-model-backups/`）。
- 结果：白名单 **240 → 69**（原生 5 + harness-claude-code 7 + connect 四组 57），revision 0→1；全部条目均可路由，UI 的「已保存但不可用」清零。
- ⚠️ 后果说明：若日后**取消隐藏** codex / pi / mimo 组，这些模型的白名单条目**不会自动回来**——需在设置页各 harness 行的「可选择」面板重新勾选，或从最近一份回滚快照恢复（171 条明细在备份文件里）。

## 12. 追加（同日 15:00-15:40）：全部模型可选推理强度（按模型定制词表）
- 用户要求：会话中全部供应商的全部模型都能选择推理强度，且按模型定制档位。
- **宿主契约**（逆向确认）：adapter `resolveModel` 返回 `reasoning {efforts:[{id,name}], defaultEffort}` ⇒ 目录条目带 reasoning ⇒ 选择器渲染推理强度子菜单；选中值经请求配置（registry 校验 UNSUPPORTED_REASONING_EFFORT）回到 adapter stream 的 options.reasoningEffort。
- **pilot 实现**（此前完全不声明）：
  · `TargetConfig.thinking { levels, default, args }`（schema + merge 透传）；
  · 按各 CLI `--help` 实测词表：codex `-c model_reasoning_effort=`（minimal/low/medium/high，默认 medium）、claude `--effort`（low/medium/high/xhigh/max）、pi `--thinking`（off/minimal/low/medium/high/xhigh/max）；
  · `resolveModel` 按 harness 主目标声明产出 reasoning；
  · `streamForProvider` 读取请求里的 reasoningEffort → dispatch dep 校验档位 ∈ 词表（未声明目标带 effort ⇒ 显式拒绝）→ 按 args 模板追加到命令行（与 modelArgs 兜底同模式）；
  · mimo 桌面端无任何机制 ⇒ 如实不声明（选择器不给它渲染档位，不冒充）；
  · ⚠️ 修复点：`pilotCliTargets()` 的映射曾丢 `thinking` 字段 ⇒ 推理元数据到不了目录（UI 实证后定位）。
- **model-connect**：无需改动——vendored 两家都走 dsh-llm-pi-ai 桥（thinkingLevelMap → efforts 自动产出），workbuddy 上游带 EFFORT_VALUES、qoder per-model effortLevels + shim 读 body.reasoning_effort，链路本来就是按这套契约设计的。
- **UI 实证**（浏览器）：选中 外部 CLI · Codex · gpt-6.1-sol 后，推理强度 combobox 渲染 Minimal（最省）/Low（低）/Medium（中）[默认]/High（高）。claude/pi 同一机制（词表来自各自 CLI）。
- **回归**：21/21 PASS。注：验证期间用户正并行使用应用（侧栏出现新会话、可见性配置被实时操作），UI 自动化已收敛为最小点击并及时退出。

## 13. 追加（同日 15:5x）：修复「选为不显示后无法保存」
- 用户反馈：模型选择列表里把模型选为「不显示」后无法保存。
- 根因：`applyVisibilityPatch` 把「空变更」（目标状态与当前一致——重复保存/双击/另一端已写入）判成 `400 空变更`，面板把 400 渲染成保存失败，而用户要的状态其实早已生效。
- 修复：空变更改为**幂等成功**（ok:true + note「无需变更（当前配置已是目标状态）」，落盘保持原样）。
- 实证（live）：隐藏 haiku → 200「模型显隐 1 处」；**重复同一隐藏 → 200「无需变更」**（原 400）；恢复显示 → 200。
- 子代理白名单保存路径同轮复验：remove/add 均带回读校验正常落地（68↔69 往返，revision 正确递增）。
- 回归：21/21 PASS。

## 14. 追加（同日 17:0x）：会话头徽章瘦身 + 覆盖全部供应商（纯客户端修复）
- 用户要求：①徽章只显示「供应商 · 模型」；②不只外部供应商，DeepSeek 内部所有供应商也要显示；③**不要破坏性修复、不影响 DSH 里正在运行的任务**。
- **静默约束的落实**：只改两个插件的 `client/*.js`（浏览器端工件），重建只刷新 client.js/lib/client.js 浏览器产物——**不重启宿主、不动 lib 运行时**，运行中任务零影响；用户刷新页面即可生效。
- 徽章改动（pilot `HarnessSessionIdentity`，通用化）：
  · 渲染条件从「pilot-cli / harness-*」放开为**任意 provider**（来自会话路由快照，原生 opencode-go/xiaomi/step/muze/deepseek 等全覆盖）；
  · 正文只剩「供应商 · 模型」；账号 / 实际模型 / 偏差明细全部退到悬停 tooltip（诚实性不丢，占位 clutter 消失）；
  · 原生供应商展示名映射（deepseek→DeepSeek 等）+ connect 四组中文名补进 CLI_LABELS；
  · API 里的历史遗留 fallback 文案（「账号型模型已拆到…」）不再上屏。
- **去重**：dsh-model-connect 的 `ConnectSessionIdentity` 座位（order 45）删除——它的四条 provider 已被通用徽章覆盖，此前同一会话头渲染两条重复徽章（用户截图右半正是它）。其探针同步改为静态断言「本插件不得再注册会话头徽章座位」。
- 实证（浏览器截图）：「外部 Harness 统筹官」会话头部 = `opencode-go · deepseek-v4.1-flash`（内部供应商），悬停可见账号/实际模型细节。
- 探针：两插件各自 PASS；pilot ui-smoke 的「原生路由不渲染」断言与通用化不冲突（离线沙箱无 modelDirectories）。

## 15. 追加（同日 17:3x）：qoder 60s 单请求超时修复 + workbuddy 429 重试（dsh-model-connect）
用户编排侧实测 5 次长任务 0/5：qoder 双渠道 61s 聚类 TIMEOUT、workbuddy-intl 429 秒拒、workbuddy-cn 214s 上游掉线。
修复与实证记录见 **dsh-model-connect 仓库** `docs/verified/20261015-1730-qoder-60s-timeout-and-429-retry.md`：
①qoder vendored upstream 的握手超时 signal 会连带 abort 响应体流（61s 聚类死因），已改手写 controller+clearTimeout，
长生成 101.6s 实证跨墙；②providerRetryPolicy maxRetries 0→2（429 瞬时限流自动重试）。详见该文件。
