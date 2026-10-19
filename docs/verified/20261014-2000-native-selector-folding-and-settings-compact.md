# 2026-10-14 19:1x–20:0x · 第七轮：原版选择器归位 + harness 折叠分组 + 设置页三块式

> 用户指令（长）：把 `@dsh-external/dsh-harness-pilot` 做成「原版选择器 + 外部 CLI 可选的模型目录 +
> 按 harness 折叠 + 设置页只留三块 + 多账号真隔离 + 原生子代理真实执行」，并追加四点
> （① 会话/子代理里按 harness 折叠 ② WorkBuddy 模型数不全 ③ Antigravity 模型报错 ④ 设置页重复与信息过量）。
> 本轮纪律不变：**结论必须有实测证据**；没做的如实说没做。

## 1. 本轮结论（4 条硬事实）

| # | 事实 | 证据 |
|---|---|---|
| ① | **原版模型选择器已经归位**：插件对 `conversation.input.model` 座位的注册**为零**，shipped 组件自然渲染 | `client.js` 全文只有注释、无注册；`probe/verify-ui-smoke.mjs` 输出 `会话模型座位：未占用（按用户要求保留宿主原生选择器）`；宿主渲染语义 `dsh-client-ui-slots/lib/index.js:221/278-293` + `dsh-client-ui-renderer/lib/client.js:1148-1151`（取 `entriesOfSlot[0]` = 唯一那条 shipped） |
| ② | **外部 CLI 的模型确实进了宿主原生目录**（走宿主机制，不是客户端自绘） | UI smoke 同一次输出：`原生选择器里的外部 CLI 模型条目：19 个（例：wb-managed-a::deep-model, …）`；链路 `llm-adapter.ts:registerAdapter` → `dsh-llm:1833` → `dsh-api-session-controller:500-548 buildModelCatalog` → `remote.session.modelCatalog()` |
| ③ | **「一条 harness」折叠分组已实现并上线**：34 个内置目标 → **18 条**用户可见条目；**只有 Qoder / WorkBuddy** 拆国内/国际 | `src/harness-groups.ts`（唯一一份显式分类表）+ `probe/verify-harness-groups.mjs` **PASS**；`/overview` 实测返回 `harnessGroups` 18 条，账号归属正确（Qoder 国内 2 / Qoder 国际 1 / WorkBuddy 国内 1 / 国际 1） |
| ④ | **WorkBuddy「模型数量不全」的根因是「把国际版写死给了两家」**，已按版本分开 | 侦察实测 `--help` 原文：国内 = 9 个（`auto, glm-5v-turbo, glm-5.1, glm-5.0-turbo, glm-5.0, glm-4.7, kimi-k2.5, minimax-m2.7, deepseek-v3-2-volc`，**没有** `primary-model`）；国际 = 4 个（含 `primary-model`）。修后 live `/api/models` 实测：国内 **9** / 国际 **4**，逐字一致 |

## 2. 设置页重做（用户要求：只看到三块）

`HarnessPilotSection` 重写为**「一条 harness 一行」**（`client.js`），默认只显示：

```
外部 harness 管理                                    [刷新]
搜索 harness 或它的目标名
┌──────────────────────────────────────────────────────────────┐
│ Qoder（国内）      可用 · 模型 14 个 · 账号 2 个        [展开] │
│ Qoder（国际）      可用 · 模型 14 个 · 账号 1 个        [展开] │
│ WorkBuddy（国内）  可用 · 模型 9 个 · 账号 1 个         [展开] │
│ …（共 18 条；CLI/IDE/TUI/桌面端/账号配方都折进同一条）         │
└──────────────────────────────────────────────────────────────┘
▸ 高级与诊断（注册表 / 任务 / 会话 / 进程 / 宿主供应商 / 自动切换执行侧 / 插件设置）
```

展开一条 harness，**只有三块**：
1. **模型**：`FederationProvidersPanel`（该 CLI 自己的发现结果，完整不截断）+ 目标与通道（折叠）；
2. **登录账号**（`login === 'accounts'` 的 harness 才出现）：当前档案行（显示名 + 身份状态 + 国内/国际）+ `AccountsPanel`（加/登录/存/切/退/删）+ **`AccountPoolPanel` 收在这一块里**（用户要求第 3 条「作为号池进行管理」）；
3. **可选择**：会话侧走**原版**模型菜单（明确写出「本插件只注册路由、不替换原版选择器」）+ 子代理侧需 `allowedModels` 白名单（如实标注「目录可见 ≠ 白名单已生效」，**并写明写入白名单是下一步实现**）。

**分层不是删能力**（对账结果）：上一版被我折叠掉的面板，UI smoke 探针当场抓出并已**全部挂回**——
`AccountPoolPanel`、`BuddyQuotaCard`、`AutoSwitchRuntimePanel`（标注「本轮暂不启用」）、
`RegistryPanel`（「Harness 注册表」）、`ProvidersList`（「DSH 本 profile 已配置供应商」+「两栏永不混用、**不含**对方」声明）。
`probe/verify-ui-smoke.mjs` 现为 **PASS**（渲染文本 212,258 字符）。

## 3. 三份只读侦察（原生子代理执行，未写盘、未花额度）

| 侦察 | 关键结论（都带 file:line / 命令原文） |
|---|---|
| 宿主选择器与设置页契约 | 宿主**没有**可折叠分组：`MenuGroup` 只是粘性标题（`dsh-client-ui-primitives:4283-4305`），子代理设置卡也是分组网格（`dsh-client-ui-settings-subagent:313-330`）。**分组的粒度只能是 provider** ⇒ 「一个 harness 一个 LLM provider」= 原生折叠。同时 `sessionModelLimit` 必须设 0，否则「展开后是全部模型」不成立 |
| WorkBuddy 模型 | 根因见 §1④；另查明 `~/.codebuddy/models.json` 的 11 个 `r-*` 在受管通道下**根本不被加载**（`assets/workbuddy-managed.cjs:19` 把 config dir 指到账号目录：CN 不存在、INTL 为 `[]`）⇒ 那 11 个**只能当展示项**，且实测会被网关以错误码 11136 拒（`probe/out/wb-model-matrix*.json`） |
| Antigravity 报错 | **不是模型 id**：插件配的 6 条逐条都在 `agy models` 里。真凶是 ① **argv 污染**：别的 harness 的账号配方被注入（`tasks\f4b473be….result.json` 原文 `flags provided but not defined: -config-dir`，其 `actual.accountId=qoder-cn-a`；`tasks\f552c3d9….json` 原文 `unexpected argument "workbuddy-managed.cjs"`）；② 单模型额度耗尽（exit 3 / RESOURCE_EXHAUSTED，10-01～10-03 密集、10-14 未再出现）；③ 已从目录消失的历史 id（`gemini-3.7/3.6-flash-high`，当前 profile/src 已无）。`--output-format json` + `-p` **合法**（成功 run 返回 JSON 信封、exit 0）|

## 4. 本轮改动清单（`src` → 构建 → 热重载）

| 文件 | 改动 |
|---|---|
| `src/harness-groups.ts`（新增） | 显式分类表（34 内置目标全覆盖）+ `groupTargets` / `buildGroupIndex` / `providerIdFor` / `classifyHarnessId` / `loginModeOf` |
| `src/index.ts` | `/overview` 增加 `harnessGroups`（**只给索引**，模型/账号明细仍走既有出口，不造第二份数据源）；失败时带 `harnessGroupsError`，不静默 |
| `src/config.ts` | `wb-managed-a` → 国内 9 个模型；`wb-managed-ai-b` → 国际 4 个（含 `primary-model`）；`agy` 描述纠正（1.3.5 / 实时目录 / exit 2 语义 / exit 3 额度） |
| `client/client.js` | 设置页主体重写为「一条 harness 一行 + 三块展开体 + 一个高级折叠块」；账号归属用服务端 `accountIds`（不再在客户端实现第二份区域判断） |
| `probe/verify-harness-groups.mjs`（新增） | 分组离线验收（覆盖率 / 只拆两家 / 折叠不丢成员 / provider 名形状） |
| `probe/_regression-suite.mjs` | 队列加第 13 项 `verify-harness-groups`；第 12 项 `verify-subagent-model-options` 上一轮已加 |

## 5. 三态清单（本轮结束时）

- **已实现且实测通过**：① 原版选择器归位（UI smoke 断言 + 零注册）；② 外部模型进原生目录（19 条实测）；③ harness 折叠分组（离线探针 PASS + live `/overview` 18 条 + 账号归属正确）；④ WorkBuddy 国内外模型集分开（live `/api/models` 9 / 4）；⑤ 设置页三块式重做且**无能力回退**（UI smoke PASS）；⑥ agy 模型目录动态化（live 6 条）+ 描述纠正。
- **已实现但未验证**：设置页在**真实浏览器**里的观感与交互（只做了离线渲染断言）；`harnessGroups` 在 profile 追加目标（`workbuddy-ai`）下的分组（离线探针只覆盖内置表）。
- **尚未实现（下一轮）**：
  1. **provider 按 harness 拆分**（把「一个 `pilot-cli` + 扁平 `目标::模型`」改成「每个 harness 一个 LLM provider 路由」）——这是「原生选择器里按 harness 折叠」的唯一宿主可行路径；同时把 `sessionModelLimit` 设为 0（不截断）。
  2. **模型来源链**（真实 CLI 查询 → 原生配置 `product.json` → 官方缓存 `acc-product-config-v3.json` → 有据别名），并给每个条目标注**可选 / 仅展示 / 别名 / 当前默认**与未安装/未登录/无供应商/无列举能力四态；WorkBuddy 的 `--help Currently supported:` 动态查询属这条。
  3. **`allowedModels` 写入**（设置页勾选「哪些模型可在子代理里被选」）——现在只读显示。
  4. **Antigravity argv 污染的当前态复核**（历史 3 条 exit 2 已定位；需实测现在的跨 harness 账号注入是否已被拒）。
  5. 多账号真隔离的**并行任务**验收（Qoder 国内/国际 + WorkBuddy 国内/国际 同时跑）、空认证环境不回退全局账号的反向对照。
  6. 子代理会话页的「当前外部 CLI / 请求模型 / **可验证的实际模型**」呈现（现徽章座位 `conversation.session.header.utilities` 实测不渲染，需换宿主支持的落点）。
- **受上游限制**：宿主**没有**组级折叠组件（`MenuGroup` 是粘性标题、无 `Collapsible`），所以「点击展开/收起」只能靠 provider 分组 + 插件自有 surface；侧边栏会话列表也没有可用的按 harness 分组槽位。

## 6. 复现

```powershell
node scripts/build.mjs                       # src → lib（运行中的宿主热重载）
node probe/verify-harness-groups.mjs         # 折叠分组（离线，零额度）
node probe/verify-ui-smoke.mjs               # 设置页渲染 + 座位断言（打活宿主，零额度）
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/overview' |
  Select-Object -ExpandProperty harnessGroups | Format-Table label,providerId,login,accountCount
# WorkBuddy 版本差异（零额度：读静态清单；动态口径见 --help Currently supported:）
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/models' -Method Post -ContentType application/json -Body '{"target":"wb-managed-a"}'
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/models' -Method Post -ContentType application/json -Body '{"target":"wb-managed-ai-b"}'
```
