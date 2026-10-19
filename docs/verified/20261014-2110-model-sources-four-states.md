# 2026-10-14 21:xx · 第十轮：模型来源分级 / 四类归类 / 四态（需求 ②）+ 卸载 grok-cli 与 command-code

## A. 需求 ② 的落地

### A.1 先摆事实：改之前是什么样

`/api/models` 只回 `{models, note, mechanism}`；`/providers` 的逐条 `{id, availability, evidence}` 里
**分类只藏在 evidence 自由文本**（`configured-alias: …；可选择；实际可用性待执行确认`）——
设置页无法把「可选择 / 仅展示 / 别名 / 当前默认」分开，也没有任何地方能说出
「未安装 / 未登录 / 没有配置供应商 / 没有模型列举能力」。

### A.2 新增（唯一一份实现）

| 文件 | 内容 |
|---|---|
| `src/model-sources.ts`（新增，纯函数） | `ModelSource`（`cli-query` / `native-config` / `official-cache` / `official-alias`，**顺序即需求里的优先级**）、`classifyModelEntries()`（逐条给 `source`+`sources[]`+`kind`+`selectable`+`reason`）、`countByKind()`、`selectableIds()`、`discoveryStateOf()`（六态） |
| `src/native-model-catalog.ts` | 每条原生目录条目新增 `role: 'default'`（Claude `settings.model` / Codex `config.toml model` / ZCode `config.json model`）——**显式字段，不靠 evidence 里有没有「当前模型」几个字猜** |
| `src/models.ts` | `modelEntriesFor()`：把四处观测汇成条目（CLI 输出→`cli-query`；原生配置→`native-config`；`models_cache.json`/`models.json`→`official-cache`；官方别名与 `modelsFixed`→`official-alias`）。`listHarnessModels()` 现在返回 `entries` + `state`，且 `models = selectableIds(entries)`（**仅展示的底层 id 绝不混进可选清单**）。新增 `missingEntryArgOf()` 与 `overviewStateFor()` |
| `src/federation/providers.ts` | 导出 `authBlockedInOutput()`（与列表命令共用同一份认证判据，不再抄第二份正则） |
| `src/sessions.ts` | `TargetOverview` 新增 `modelState` / `modelCounts` / `modelMeasured`；缓存条目**形状不符视为未命中**（否则升级后四态一直空白） |
| `src/index.ts` | `POST /api/models` 返回 `entries` / `counts` / `state` / `selectable` / `sourceLabels` / `kindLabels` / `classificationNote`；同步模型链与异步链改用**同一个** `modelEntriesFor`（同一能力不再有两份口径） |
| `client/client.js` | 每条目标新增 `ModelDiscoveryRow`：四态行 + 四类计数 + 「测量」按钮（按需真的问一次）→ 结果按四类折叠列出，每条标**来源**与「能否作 `--model`」 |

### A.3 实测（live，逐条可复现）

```
POST /harness-pilot/api/models {"target":"<name>"}   四态            可选  仅展示  别名  默认
wb-managed-a        就绪（9 个可作为 CLI 模型参数）                     0    11      9     0
wb-managed-ai-b     就绪（4 个）                                       0    11      4     0
qoder-cn-acct-a     就绪（13 个）                                     13     0      0     0
agy                 就绪（6 个）                                       6     0      0     0
opencode            就绪（485 个）                                   485     0      0     0
qoderclicn          未登录（输出里出现认证字样；模型清单不算可用）           0     0      0     0
grok-cli            未安装（参数/命令都解析不到）                          0     0      0     0
command-code        未安装（启动参数里的绝对路径不存在）                    0     0     11     0
codebuddy           没有配置供应商（跑通但 0 条、原生配置也没有供应商）        0     0      11     0
kimi / gemini / qwen / minimax / cursor   没有模型列举能力                    0     0      0     0
codebuddy（未测量时）/ agy（未测量时）        未知（证据不足）                     0     0      0     0
```

- **仅展示的底层 id 没有冒充可选**：WorkBuddy 原生目录里的 11 条 `r-*`（CLI 会响亮拒绝）全部进
  `display-only` 且 `selectable=false`；CN 的 9 个档位进 `alias`（有据：`--help` 的 Currently supported，见 config.ts 注释）。
- **不编造**：没有来源报出的 id 不出现；`classifyModelEntries({})` = 空。
- **不截断**：opencode 485 条全出（离线探针另有 900 条不截断用例）。
- **不冒充宿主目录**：DSH 自己的供应商仍在设置页**另一栏**（`/overview.dsh.providers`），两处命名空间不混。

### A.4 顺带抓到并修掉的一个真 bug（由本轮卸载暴露）

卸载 `command-code` 之后，插件仍把它报成「**没有配置供应商**」——
因为该目标 `command` 是 `node`（**存在**），被删掉的是**参数里那个绝对路径**
（`…\node_modules\command-code\dist\index.mjs`）：进程能起来、脚本找不到，输出 `Cannot find module`，
于是被读成「列举跑通了但没模型」。⇒ 新增 `missingEntryArgOf()`：检查参数里带脚本/可执行后缀的
**绝对路径**是否存在，不存在直接判「未安装」，不再去起那个必然失败的进程。
（这条同时补上了本机此前**没有实例**的「未安装」态 live 证据。）

## B. 本次卸载（用户要求：真的卸载本机程序）

| 程序 | 安装形态 | 做了什么 | 核对 |
|---|---|---|---|
| **grok-cli** | 单文件 `C:\Users\Administrator\AppData\Local\grok\grok.exe`（Grok CLI 0.2.103，123.89 MB，Rust 自包含） | 删 exe + 删空目录 | `Get-Command grok` = 不在 PATH；目录不存在 |
| **command-code** | npm 全局 `command-code@1.79.1`（173.55 MB，29600 文件，安装根 `…\workbuddy\binaries\node\versions\22.22.2\node_modules\command-code`，bin：`command-code` / `commandcode`） | `npm uninstall -g command-code`（输出 `removed 295 packages in 8s`） | 包目录不存在；6 个 shim 全清；两个命令都不在 PATH；`npm ls -g` 无此包 |

**回滚快照**：`D:\Project\_uninstall-backups\20261014-204631\`
- `grok.exe`（123.89 MB，原文件副本）；`manifest.json` 记录了版本、路径、大小与恢复方式。
- 恢复：把 `grok.exe` 复制回 `C:\Users\Administrator\AppData\Local\grok\`；command-code 用 `npm i -g command-code@1.79.1`。

**保留未动**（并已如实告知）：
- `C:\Users\Administrator\.grok`（该 CLI 的用户配置/认证）——卸载程序不等于删认证；要删请单独说。
- 插件 `src/config.ts` 里的 `grok-cli` / `command-code` 两个**目标定义**（用户只要求卸载程序）——
  它们现在在设置页显示为「未安装」，**不影响**其它 harness。
- `D:\Grok bot\Grok Bot.exe`（Grok **桌面端**，与 `grok-cli` 是两条不同目标）——未触碰。

## C. 三态清单（本轮）

- **已实现且实测通过**：来源四级 + 四类归类 + 六态（含未安装/未登录两条 live 实例）；逐条来源与
  「能否作 `--model`」；`/api/models` 结构化输出；overview 缓存层四态与计数；设置页四态行 + 测量按钮 +
  四类折叠清单；仅展示 id 不进可选清单；不截断（485 条 / 900 条用例）；离线探针 20 余条断言 + UI smoke 新断言；
  两个程序卸载并核对干净；回滚快照落盘。
- **已实现但未验证**：真浏览器里点「测量」的交互（离线渲染 + live HTTP 已验）；`/providers` 与
  `/api/models` 两处对**同一目标**的可用性文案是否完全一致（两处是不同用途的出口，未逐条比对）。
- **尚未实现（下一轮）**：① `harness_agent`/任务工具的 `model` 收敛到分组 id；② Antigravity 历史
  `exit 2`（argv 污染）复核；③ 多账号并行任务验收 + 空认证不回退全局账号的反向对照；
  ④ WorkBuddy 账号档案 `targetName` 写成了账号 id（`src/federation/accounts.ts:162/224`）。
- **受上游限制**：宿主在会话创建时记录一次子代理策略（白名单变更不影响已开会话）；
  宿主没有组级折叠组件（折叠只能靠「一个 harness 一个 provider」）。

## D. 复现

```powershell
node scripts/build.mjs
node probe/verify-model-sources.mjs        # 来源优先级 / 四类 / 六态（含未安装、未知）
node probe/verify-ui-smoke.mjs             # 设置页四态与测量入口 + 不得失实陈述
node probe/_regression-suite.mjs           # 16 项（唯一失败项 verify-federation-accounts 是既有问题）

# live 四态（把 <name> 换成 wb-managed-a / agy / qoderclicn / command-code / kimi …）
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/models' -Method Post `
  -ContentType 'application/json' -Body '{"target":"agy","refresh":true}' |
  Select-Object state,counts,@{n='entries';e={$_.entries.Count}}
```
