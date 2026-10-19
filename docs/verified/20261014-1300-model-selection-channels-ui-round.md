# 2026-10-14 12:0x–13:0x · 会话/子代理模型选择修复 + 三通道实测 + 设置页改版

> 交付物 2/2（本轮）。判据纪律同前：非空真实回复 + 正确身份 + 终态才算通过；
> 「能列出来」≠「能选」≠「选了真生效」，三件事分开取证。

## 1. 用户反馈的两个问题：根因与修复

### (a) 会话里无法选择 harness 和模型 / 怀疑屏蔽了 DSH 本地模型

**实测结论（修复前）**：
- DSH 本地模型**没有被屏蔽** —— `modelCatalog()` 实测 6 组：`opencode-go / step / xiaomi / deepseek-official / deepseek-account / pilot-cli`，前 5 组是 DSH 本地供应商，部署默认仍是 `opencode-go/deepseek-v4.1-flash`。
- 真正的缺口：`pilot-cli` 组的条目**只是 harness 目标名**（22 条，如 `opencode`、`wb-managed-a`）——
  看得见 harness，却**没有模型槽**（该 harness 的哪个模型不可选），这与「子代理设置里无法选择模型」(b) 是**同一个根因**。

**修复（全部已构建并热重载生效）**：
1. `listModels` 在「目标名（默认模型）」条目之外增加 **`目标名::模型`** 组合条目，模型来自发现层（与 `/api/models`、`harness_models` 同一解析器）；每目标上限 12 条。
2. 缓存未命中 ⇒ 只出「默认模型」条目并触发**后台预热**（并发 2、每目标只试一次、只跑 modelsCommand 不发模型请求）。
3. **选择必须真正生效**：`stream()` 解析组合槽 → 派发侧按「目标 modelArgs → 已实测 `--model` 注入」下发；两条都承载不了 ⇒ **显式拒绝**（不静默丢弃）。与团队冻结模型冲突 ⇒ 显式拒绝（`PILOT_CLI_MODEL_CONFLICT`）。
4. 修掉别名目标（`wb-managed-*` / `qoder-cn-acct-*`）**丢失模型发现配置**的问题：
   - Qoder 别名补 `modelsCommand + --config-dir`（裸跑 `--list-models` 会 “Not logged in”，实测；带档案 config-dir 实测 13 个模型）；
   - WorkBuddy 新增 `modelsFile` 安全读取（`readModelCatalogFile`：**只取 `id/name` 名字字段、拒令牌形状**，不读任何值字段）与 `modelsFixed` 静态清单（见 §3 矩阵）。
5. `SELF_MODULES` 相关出口（tools/overview）同步支持三种模型来源。

**修复后目录实测**：`pilot-cli` 组 **121 条**，含 `wb-managed-a::deep-model`、`wb-managed-ai-b::fast-model`、`qoder-cn-acct-a::Qwen3.8-Max`、`agy::gemini-3.8-flash-high` 等真实模型条目；DSH 本地 5 组原样保留。

### (b) 子代理（插件代理）设置里无法选择模型

同一根因（pilot-cli 组内是目标名不是模型）。数据层修复后，**宿主 `modelCatalog()` 的消费方（会话选择器 + 子代理模型授权列表）都会拿到真实模型条目**。
另实测：`subagent-model-selection-settings.allowedModels` 是**精确路由白名单**（`assertAllowedModelRoutes`，`dsh-tool-subagent/lib/model-selection-settings.js`）——它只是「授权哪些路由可被 agent 为子代理选」，**不是**目录来源；目录修复后新条目会出现在该设置页的可勾选列表里（勾选后写入 allowedModels）。本轮**未改 profile**（不需要写配置即可让条目出现/可选）。

## 2. 通道打通 + 三通道实测（用户点名 WorkBuddy / Qoder / Antigravity）

`probe/verify-harness-channels-3.mjs`（真实任务，唯一标记，notify=false，无重试）：

| 通道 | 目标 | 显式模型 | 结果 |
|---|---|---|---|
| WorkBuddy（受管） | `wb-managed-a` / `workbuddy-a` | `deep-model` | **completed，回复含唯一标记** ✓ |
| Qoder CN | `qoder-cn-acct-a` / `qoder-cn-a` | `Qwen3.8-Flash` | **completed，回复含唯一标记** ✓ |
| Antigravity | `agy` | `gemini-3.8-flash-low` | **completed，回复含唯一标记** ✓ |

**模型下发反证**（证明选择不是摆设）：
- Qoder 非法模型 `definitely-not-a-model-xyz` ⇒ **error 明确拒绝**（该 CLI 的 `-m` 是响亮校验，实测 exit 42 列可用模型）；
- WorkBuddy 非法模型 ⇒ **error 拒绝**。

证据：`probe/out/harness-channels-3.json`。

## 3. WorkBuddy `--model` 取值矩阵（为什么目录出 4 个别名而不是 11 个 id）

`probe/_wb-model-matrix.mjs` / `_wb-model-matrix-2.mjs`（每格一条真实任务）：

| `--model` 取值 | 结果 |
|---|---|
| （不带） | completed（基线） |
| `deep-model` / `fast-model`（别名） | **completed** ✓ |
| `r-auto` / `r-dsv4f`（目录文件 id） | **error，被 CLI 响亮拒绝** |
| `DeepSeek V4 Flash`（目录 name） | **error，被拒绝** |

⇒ 目录文件里的 11 个 `r-*` 是路由 id，**不是** `--model` 接受的取值。因此 WorkBuddy 的选择器条目只出四个别名
（`deep-model`/`fast-model` 实测完成真实任务；`balanced-model`/`primary-model` 来自其帮助文本，标注为「声明未实测」）。
**不拿“能列出来”的 11 个 id 冒充可选模型。**

## 4. 设置页改版（原生风格）

- 改名：侧栏与插件页统一为「**外部 harness 管理**」。
- 卡片化：每个分区改为原生风卡片（圆角边框、13px 标题、11px 弱色提示行），提示行取代长文字墙。
- 分区重排：Harness 目标 → 注册表 → **账号管理** → **账号池** → 供应商与模型 →（折叠）诊断（实时会话/DSH 供应商/进程与内存/后台任务）→ 插件设置。
  ⇒ 你要求的 harness 账号管理（账号档案 CRUD/登录/退出/切换 + 账号池默认/优先级/冷却/额度/自动切换）就在本页两张卡里。
- 修掉说明文本里 `**加粗**` 原样显示星号的问题（新增 `rich()`/`Notice`，16 处提示盒统一走它）。
- 在「DSH 已配置供应商」卡里明示：那是 DSH 自己的供应商（原生 DSH 仍可用、未被屏蔽）。

⚠️ **UI 改版只做了代码级验证**（语法 + 构建 + 接口数据），**未做浏览器截图验收**（本机 browser-control 服务 8795 未运行）。

## 5. 附带事件（如实记录）

- 12:14 DSH 桌面宿主正常退出（userData 出现 `background-close-confirmed`，无崩溃事件），在途 WB 任务被按设计取消（`cancelled by caller`）；已重启宿主（5 进程，API 200）后复测。**不是崩溃、不是本次改动导致**。
- 回归：`verify-llm-adapter-unit` / `verify-llm-adapter-live` / `verify-actual-identity-offline`(42) / `verify-h9-model-outlets`（四出口一致）全部 PASS。

## 6. 三态清单

- **已完成**：目录真实模型条目（会话+子代理同源）、选择真正下发（带反证）、别名目标模型发现修复、三通道真实任务（WB/Qoder/AGY）+ 模型下发反证、设置页卡片化/改名/星号修复/诊断折叠。
- **未验证**：浏览器视觉验收；`balanced-model`/`primary-model` 两个别名（帮助文本声明）；子代理设置页勾选后的端到端子代理跑批（数据面已通，未跑完整子代理长任务）。
- **上游限制**：WorkBuddy 只认 4 个别名（目录 id/name 不可用）；其回复不回报实际内部模型 ⇒ 实际模型仍标「未知」；Qoder `--list-models` 必须带账号 config-dir（否则 Not logged in）。

---

# 追加轮（14:0x–15:0x）：会话选择器真实模型 + 子代理白名单 + 标签页改版

针对用户二次反馈的四条，逐条处理：

## 1. 「会话中只有原生 DSH 可选、模型只有默认」——根因与修复

- **模型下拉从不加载真实模型**（只渲染「(harness 默认)」+ 当前值）——真缺陷，已修：
  新增 `useTargetModels()`（POST `/api/models` 按目标取**该 harness 自己的模型**）；外部 harness 的模型下拉现在列真实模型（如 `wb-managed-a` 的 `deep-model/fast-model/...`、qoder 的 `Qwen3.8-*`、agy 的 `gemini-3.8-*`）。
- **原生 DSH 的模型下拉**现在列 DSH 自己的供应商×模型（来自 overview `dsh.providers`），改选后调用宿主**真实**选择入口 `POST /llm-adapter/select-model`（`ctx.sessionController.selectModel`）——不是只写绑定。
- **Harness 下拉**：注册表为空时回退概览目标（修「只剩原生 DSH」的退化形态）。
- **当前模型展示**：选择器行内新增「当前模型：…」（外部=绑定模型或「该 harness 默认模型」；原生=当前部署默认 `provider/model`）。
  一次性子智能体/后台任务卡已有「请求模型 + 实际身份（供应商/模型/原生会话 id）」行，未回报项如实标「无法确认」。

## 2. 「子智能体设置里看得见外部 CLI、选不了模型」——根因与修复

根因：宿主 `subagent-model-selection-settings.allowedModels` 是**精确路由白名单**（`assertAllowedModelRoutes`），只列了 xiaomi/step/opencode-go 等 ⇒ pilot-cli 的路由（外部 CLI）不在授权集，只能落默认。
修复：desktop 与 web 两份 profile patch 的 `allowedModels` 追加 10–13 条 `pilot-cli` 路由（`wb-managed-a[::deep-model]`、`qoder-cn-acct-a[::Qwen3.8-Flash]`、`agy[::gemini-3.8-flash-low]` 等，注释写明 `目标名` 与 `目标名::模型` 的语义与实测口径）。YAML 已校验（desktop 17 条 / web 14 条），随重启加载。
⚠️ 未验证：设置页勾选/下拉的端到端视觉效果（无浏览器）；如仍有拦截，把界面报错原文发我。

## 3. 「外部 harness 管理页面信息过多」——标签页改版

页面改为 7 个标签：概览 / Harness 注册表 / **账号管理** / **账号池** / 供应商与模型 / 插件设置 / 诊断，一次只显示一块；
`props.allTabs=true` 是全展开视图（离线断言与打印用）。账号供应商/模型的管理入口即「账号管理」「账号池」「供应商与模型」三个标签。
离线 UI 断言 `probe/verify-ui-smoke.mjs` **PASS**（live 数据渲染 69097 字符；四态、三态、额度规则、责任边界、原生登录退出等诚实性文案全部在）。
顺带修了两处测试基座失真（不放宽断言）：迷你 React shim 现在按 React 语义把 children 放进 `props.children`；探针渲染改用 `allTabs`。

## 4. 本轮证据

| 项 | 结果 |
|---|---|
| `verify-ui-smoke`（live 渲染断言） | **PASS** |
| `verify-managed-account-real-task`（重启后 WB 真实任务） | **REPLIED**（PONG） |
| `verify-llm-adapter-live`（目录/真实选择入口/闸门） | **PASS** |
| `/diag/loaded`（重启后） | anyStale=false、41 模块 |

**未验证**：浏览器视觉验收（browser-control 服务未运行）；子代理设置页选外部模型的端到端子代理跑批；`balanced-model`/`primary-model` 别名。
