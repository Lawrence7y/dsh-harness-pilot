# 2026-10-14 13:5x–14:0x · 第二轮：设置页信息密度 + 空模型列表自我解释

> 承接 `20261014-1340-session-selector-write-bug-and-ui-round.md`。
> 本轮**只动客户端**（`client/client.js` → 三工件同步），未改 `src/**`、未改 profile、未重启宿主。
> 判据纪律不变：能列出来 / 能选 / 选了真生效 分开取证；空列表必须说明**为什么**空。

## 1. 设置页信息密度（用户原话：「信息过多，不方便操作」）

**做法**：不删任何信息，只改默认可见性。新增 `Collapsible`（一行摘要 + `<details>` 全文）
与 `Hint`（与 `Notice` 同一套 `**加粗**` 渲染）两个组件；长边界说明全部折叠，摘要行保留结论。

真实浏览器实测（Chrome + CDP；证据 `probe/out/web-ui-round2/`）：

| 栏 | 改版前可见文本 | 本轮可见文本 | 折叠块 |
|---|---|---|---|
| 账号管理 | 14512 字符 | **8035 字符（−44.6%）** | 4（认证三态 / 身份探测 / 原生登录退出 / 额度判定） |
| 供应商与模型 | — | 2403 字符 | 1（子智能体选模型） |
| Harness 与状态 | — | 8820 字符 | 0 |

**反向对照（证明是折叠而不是删除）**：展开「认证三态」后其正文 188 字符、页面可见文本 8035 → 8177。
断言写在 `dsh-probe/verify-density.mjs`：若「展开后页面文本不增加」即判失败。

## 2. 空模型列表必须解释自己（用户原话：「无法选择CLI的模型，只能使用默认模型」）

### 2.1 修掉英文内部术语泄漏

改版前界面上直接出现服务端的内部英文说明：
`模型来源：no modelsCommand configured for this harness` —— 中文设置页里一条英文术语，
用户既看不懂也不知道下一步做什么。新增 `modelSourceText()` 逐条转写（**命令原文原样保留**，那是可核对的证据）：

| 服务端原文 | 界面显示 |
|---|---|
| `no modelsCommand configured for this harness` | 该 CLI 没有可用的模型列举命令（本插件不猜、不编造列表） |
| `catalog file …` | 读该 harness 自带的模型目录文件（只取 id / name，未读取任何值字段） |
| `静态清单…` / 命令原文（`grok models` 等） | 原样 |

### 2.2 空列表给出原因与下一步

外部 harness 报出 0 个模型时，选择器里新增一段（红色、可 hover 看原始响应）：

> 该 harness 没有报出可选模型 —— <原因>。<入口状态：missing（没装或路径不对…）>
> 本插件**不编造**列表：没有列举能力的 CLI（例：Claude Code 的 `--model` 只收别名或完整名）
> 就只提供「该 harness 默认模型」，不会拿 DSH 的供应商列表冒充它。想真的选到具体模型，
> 先让该 CLI 自己登好并在原生侧能报出模型；或在「设置 → 外部 harness 管理 → 供应商与模型」看
> 该 harness 的原生发现到底返回了什么。

断言：`claude`（0 模型）必须出现中文原因 + 「不编造」且**不得**出现英文原文；
`wb-managed-a`（4 模型）**不得**出现这段（防「没牙的断言」）。

### 2.3 顺带修掉的渲染缺陷

本轮实测发现 6 处把带 markdown 的文案当纯文本画，界面直接显示字面星号
（最典型：新加的 `本插件**不编造**`，以及既有的 `**不允许**新增` / `**不含** DSH 的供应商` /
`**原生发现**` / `**还没有发生过**`）。全部改走 `Hint`/`rich()`。
两条浏览器断言现在都会检 `body.innerText` 里**不得出现 `**`**。

## 3. 本轮实测到的 CLI 模型能力事实（不外推）

| Harness | 模型发现 | 实测事实 |
|---|---|---|
| `claude` | **无列举命令** | `claude auth status` 实测 `{"loggedIn":false,"authMethod":"none"}` —— **未登录**。`--model` 只收别名（`fable`/`opus`/`sonnet`）或完整名。**空列表是正确结果，但真实缺口是「没登录」**，不是「不支持选模型」（`modelArgs: ['--model','{model}']` 早已接好） |
| `kimi` | `kimi provider list` | 实测 `No providers configured.` ⇒ 无模型可用。空列表正确 |
| `command-code` / `qwen` / `cursor` | 无列举命令 | 空列表正确，界面现在会说明原因 |
| `grok-cli` | `grok models` | **实测可用**，返回 `grok-build`（`/api/models` 已给出 1 条） |
| `codex` | — | 本机**未安装**（`commandPath: undefined`）⇒ 空列表正确 |
| `wb-managed-a` / `-ai-b` | 静态清单 | 4 个别名（`deep/fast/balanced/primary-model`）；目录里 11 个 `r-*` 是路由 id，`--model` 会被响亮拒绝 |
| `qoder-cn-acct-a/b` | `--list-models`（**必须带 `--config-dir`**） | 13 个 |
| `agy` | `agy models` | 6 个 |
| `opencode` / `pi` | `opencode models` / `pi --list-models` | 486 / 98 |

> 结论口径：**「不能选模型」在这台机器上是三类不同事情**——① 没登录（claude）、
> ② 该 CLI 无列举能力（只能填它自己的取值）、③ 目标没装（codex）。界面现在把这三类分开说，
> 不再用一句英文术语糊过去。

## 4. 子智能体侧的边界（本轮新增可见性，不新增能力）

「供应商与模型」栏新增折叠说明「子智能体选模型」，内容为**已验证的口径**：

- 子智能体选模型走**宿主的精确路由白名单** `subagent-model-selection-settings.allowedModels`，
  **不是**本插件的目录；要用外部 CLI 就必须有 `pilot-cli` + `目标名[::模型]` 条目。
- 本插件把外部 harness 注册成宿主 LLM 路由 `pilot-cli`；宿主目录里它**现在可见**，
  槽位数实时显示（本轮实测 121 个）。
- ⚠️ **本插件取不到该白名单的运行期加载态**：宿主的 settings document 在浏览器上下文里回
  `settings are unavailable in this browser`。所以「profile 补丁是否已被当前进程加载」**仍未验证**，
  界面不把它写成「已生效」。

## 5. 回归（全部通过）

| 探针 | 结果 |
|---|---|
| `verify-session-binding-write`（上一轮补的第三条腿） | **PASS** |
| `verify-session-selector-live` | **PASS**（Harness 36 / 原生模型 3 / 外部 5） |
| `verify-ui-smoke`（live 数据整页渲染） | **PASS** |
| `verify-actual-identity-offline` | **PASS**（`assertions:42, noLibWrites:true`） |
| `verify-llm-adapter-live` | **PASS**（`anyStale=false`、pilot-cli 121 槽、部署默认未变、`profileUnchanged=true`） |
| 浏览器 `verify-density` / `verify-empty-models`（本轮新增） | **PASS** |

三工件一致：`client/client.js` = `client.js` = `lib/client.js`（sha256 `f6065c84d66f8e78…`）。

## 6. 三态清单

**已完成（本轮实测）**：信息密度 −44.6%（不删信息，展开可证）；空模型列表自我解释；
英文术语泄漏修复；6 处字面星号修复；子智能体白名单边界写入界面；6 探针 + 2 浏览器新探针全绿。

**未验证**：`allowedModels` 的**运行期加载态**（浏览器上下文取不到宿主 settings document）；
子代理端到端跑批（要由宿主进程内调用方发起，外部脚本触发不了 —— 这是 rc.2 的契约边界，
不是本轮改动引入的）；`balanced-model`/`primary-model` 别名；`claude` 登录后的模型可用性。

**受上游限制**：`claude`/`command-code`/`qwen`/`cursor` **没有模型列举命令**（不可发现，只能填入）；
`kimi` 无 provider 配置；`codex` 本机未安装；WorkBuddy 只认 4 个别名；
`multiAccount`/`canLead` 在注册表里对全部 35 个目标都是 `unknown`。

## 7. 回滚

- 上一轮回滚点仍有效：`.bak-ui-round-20261014-132744/`。
- 本轮改动全在客户端：把 `client/client.js`、`client.js`、`lib/client.js` 三份一起换回备份即可；
  **不需要重启宿主**（宿主按内容重算 `rev`），刷新页面生效。
