# 2026-10-14 13:1x–13:4x · 会话选择器「选了不生效」根因 + 设置页分栏改版

> 判据纪律同前：**能列出来 ≠ 能选 ≠ 选了真生效**，三件事分开取证。
> 本轮补齐了此前**从未被执行过**的第三条腿，并据此找到用户报告现象的真实根因。

## 0. 环境事实（本轮实测，不引用旧源码）

| 项 | 实测值 | 依据 |
|---|---|---|
| 正在运行的 DSH | **0.2.0-rc.2**（`@deepseek-ai/dsh-desktop` = `dsh-desktop-runtime` 0.2.0-rc.2，cordis 4.0.4） | `D:\DeepSeek\resources\app.asar` 内 package.json |
| 正在运行的 profile | **desktop**（`C:\Users\Administrator\.dsh\profiles\desktop`） | 宿主进程命令行（PID 36272 那条 `dsh-desktop-host` 链） |
| 插件安装来源 | `@dsh-external/dsh-harness-pilot` → **link:D:\Project\dsh-harness-pilot**（v0.1.1） | desktop profile `package.json` |
| 宿主 HTTP 端口 | **4200**（0.0.0.0） | `Get-NetTCPConnection` + 活体 GET |
| 客户端加载方式 | 宿主按 `plugins/??<specifier>/client.js&rev=<hash>` 发；**rev 随文件内容重算** ⇒ 改客户端**不需要重启宿主** | 改前 rev=`ea7fe34d7515`，改后 rev=`d2425d3f451a` |
| `C:\dsh`(rc.1) / `deepseek-harness-master`(rc.8) | **都不是正在运行的版本**，只是编译期 checkout | 与上表对照 |

## 1. 根因：`save` 不在作用域 ⇒ 选择器**每一次选择都静默失败**

**代码级事实**（`client/client.js`）：

- `useSessionBinding()` 内部定义了 `const save = React.useCallback(patch => { …POST /session/binding… })`，
  但**返回值是** `Object.assign({ reload }, state)` —— **`save` 从来没有被返回**。
- `HarnessSessionSelector` 里所有写入都写成 `save({ … }, false)` ⇒ 每次都是
  **`ReferenceError: save is not defined`**，**同步抛在 `onChange` 内**。

**真实浏览器现场证据**（Chrome + CDP，非夹具）：

```
ReferenceError: save is not defined
    at remember (.../dsh-harness-pilot/client.js&rev=74dd5b60f7c9:26752:33)
    at Object.onChange (...:26671:26)
```

抛出点在 React 事件处理器内、**早于任何 `setState`** ⇒ React 把受控 `<select>` 的值回退成旧值，
界面既不报错、也不变化。这与用户描述**逐条吻合**：

| 用户原话 | 对应机制 |
|---|---|
| 「会话中选择 Harness，只有 DeepSeek Harness 原生**能够选择**」 | 下拉里 35 个外部 harness 都**列得出来**（数据面正常），但选中即抛 ⇒ 值回退到 `dsh` |
| 「选了原生 DSH 也不能修改模型；点击模型列表只有默认模型」 | 同一异常：模型 `onChange` 也走 `save` ⇒ 值回退，看起来「只有默认」 |

**为什么此前没被发现**：`verify-ui-smoke.mjs` 与 `verify-session-selector-live.mjs` 都只**渲染**组件
（渲染 → 断言文字），**从不调用事件处理器**。项目文档写着「能列出来 ≠ 能选 ≠ 选了真生效」，
但第三条腿此前没有任何脚本覆盖 —— 这是一条**测试盲区**，不是「已实现但没验收」。

## 2. 本轮修复（全部已构建、已实测）

### 2.1 修根因

- `useSessionBinding` → `Object.assign({ reload, save }, state)`（并把原因写进注释，防止再被删）。
- `HarnessSessionSelector` 不再裸调 `save`，改走 `remember(patch)`：
  写入入口缺失/抛错/Promise 拒绝**一律转成可见错误行**，不再静默。

### 2.2 补测试腿（**这是本轮的纪律修复**）

新增 `probe/verify-session-binding-write.mjs`：在最小 React 沙箱里**真的调用**各下拉的 `onChange`，
并按三分判据逐条断言「发出 POST」+「GET 读回的绑定真的变了」。
实测（`probe/out/session-binding-write.json`）：

| 步骤 | 结果 |
|---|---|
| 选外部 harness `wb-managed-a` | 绑定读回 `{harnessKind:external, harnessId:wb-managed-a}` ✓ |
| 选该 harness 的模型 `deep-model` | 绑定读回 `model=deep-model` ✓ |
| 切回原生 DSH | 绑定读回 `{native, dsh}` ✓ |
| 原生模型下拉 | 3 项，含 2 个真实 `provider::model` ✓ |
| 供应商维度收窄到 `pilot-cli` | 122 项，**全部**以 `pilot-cli::` 开头（没有混入别的供应商）✓ |
| 真实选择器入口 | `POST /harness-pilot/api/llm-adapter/select-model {"provider":"pilot-cli","model":"opencode"}` 真的发出 ✓ |

### 2.3 选择器功能对齐用户要求

- **Harness → 账号 → 供应商 → 模型** 四段式（原来是 Harness→账号→模型，缺供应商段）。
  - 原生侧：供应商来自 DSH 自己的 provider 表（`overview.dsh.providers`）；改选供应商 = 选它第一个模型，
    仍走宿主**真实**选择入口 `sessionController.selectModel`（不是只写绑定）。
  - 外部侧：**只有模型名自带前缀时**才给供应商下拉（opencode 的 `opencode-go/xxx`、pi 的 `antigravity/xxx`）；
    `wb-managed-a` 的 `deep-model` 这种没有前缀 ⇒ 显示「供应商：该 harness 未区分」，**不伪造**维度。
- **不再静默退化**：注册表/概览任一读失败时，选择器顶部显示
  「⚠ Harness 列表不完整：…」并给出原因 —— 「只有原生 DSH 可选」这种形态以后会**自己说出来**。
- **能力真话行**（来自注册表 `capabilities`，只报声明、不冒充已接线）：
  `权限模式：该 CLI 声明 N 项（未接线） · 推理档位：未声明 · 多账号：未知/未验证 · 可主控：未知/未验证`。
- **「当前模型：」始终可见**：外部=绑定模型或「该 harness 默认模型」；原生=绑定值或「部署默认（只读）」。
- 模型来源行（`模型来源：<modelsCommand 原文>`），让「这个列表从哪来」可核对。

### 2.4 设置页改版（回应「风格差别大 / 信息过多 / 找不到账号·供应商·模型在哪」）

- 一排「像按钮的方块」→ **原生风分栏标签条**（下划线指示当前栏，与 DSH 设置页一致）。
- 分栏重排为 **账号管理 / 供应商与模型 / Harness 与状态 / Harness 注册表 / 插件设置 / 诊断**：
  用户找的两件事（账号、供应商与模型）**排到最前两位**；原「账号池」并入「账号管理 → 账号池与额度」。
- `pool` 键保留为别名，老书签不会失效。

真实浏览器验收（Chrome + CDP，截图见 `probe/out/web-ui-round/`）：

| 验收项 | 结果 |
|---|---|
| 会话 Harness 下拉 | 36 项（原生 DSH + 35 外部） ✓ |
| 会话供应商下拉 | 6 项（opencode-go / step / xiaomi / DeepSeek / DeepSeek Account / pilot-cli） ✓ |
| 改原生模型后「当前模型」 | `opencode-go::muse-spark-1.3-contributor` → 跟随，**且还原回 `deepseek-v4.1-flash`** ✓ |
| 设置页分栏 | 6 栏名称全部命中 ✓ |
| 「账号管理」栏内容 | 含「账号档案」「账号池与额度」「额度」 ✓ |
| 「供应商与模型」栏内容 | 含两栏分标题「原生供应商与模型」「DSH 本 profile 已配置供应商」 ✓ |

### 2.5 回归

| 探针 | 结果 |
|---|---|
| `verify-ui-smoke`（live 数据整页渲染） | **PASS**（35 目标 / 4 档案 / 76451 字符 / 四态文字同时出现） |
| `verify-session-binding-write`（本轮新增） | **PASS** |
| `verify-session-selector-live` | **PASS** |
| `verify-actual-identity-offline`（42 断言） | **PASS**（`pass:true, assertions:42, noLibWrites:true`） |
| `verify-llm-adapter-live` | **PASS**（`anyStale=false`；部署默认仍是 `opencode-go/deepseek-v4.1-flash`；`profileUnchanged=true`） |
| `verify-managed-account-real-task` | **REPLIED** —— 真实任务 `status=completed text="PONG"` |

三工件一致性：`client/client.js` = `client.js` = `lib/client.js`
（sha256 `af7268e9…` → 修 `save` 后为当前值，三者逐字节相同）。

## 3. 接口与能力矩阵（本机实测，不外推）

| Harness | 真实入口（解析自） | 通道（可用 tier） | 模型发现来源 | 该 CLI 声明的权限开关 | 多账号 |
|---|---|---|---|---|---|
| 原生 DSH | 宿主自身 | — | `overview.dsh.providers` 6 组 / 131 槽 | DSH 自己的权限预设 | — |
| WorkBuddy / WorkBuddy.AI（受管别名 `wb-managed-a` / `wb-managed-ai-b`） | `D:\workbuddy\WorkBuddy.exe`（`profile-config`） | acp(headless 未验证) | **静态清单 4 个别名**（`--model` 实测矩阵：只认 `deep/fast`，`r-*` 与 name 被 CLI 响亮拒绝） | 未采集 | 2 个身份已实测并发（认证槽位**厂商共享**） |
| Qoder CN（`qoder-cn-acct-a/b`） | `qoderclicn --config-dir <档案>` | acp | `--list-models`（**必须带 config-dir**，否则 Not logged in）13 个 | 未采集 | 2 个身份、独立配置目录、CLI 重启后保持 |
| Antigravity（`agy`） | `%LOCALAPPDATA%\agy\bin\agy-core.exe` | headless / pty（**acp 探针实测不支持**） | `agy models` → 6 | 声明 4 项 | 未验证（已确认当前数据根参数无效） |
| opencode | PATH 上 `opencode` CLI 2.0.14 | acp / headless / pty | `opencode models` → **486** | `--auto` / `opencode.jsonc` policies | 未验证 |
| Pi | PATH 上 `pi` | headless / pty | `pi --list-models` → **98** | 声明 6 项 | 未验证 |
| Codex / Claude | PATH | headless / pty | **未配置 modelsCommand** ⇒ `/api/models` 返回空 | 未采集 | 未验证 |

> 矩阵口径：`modelSelect` / `multiAccount` / `canLead` 三项在注册表里对**全部** 35 个目标都是
> `unknown`（只有少数目标显式 `canLead: no`）⇒ 「哪些能当主控」目前**没有实测结论**，
> 不把这些字段读成 `yes`。

## 4. 账号与会话数据模型（现状，未改）

- 账号档案：`id / harnessId / displayName / region / configDir / launch{mode,command,args,env} /
  nativeAuthRef{kind,scope,locator} / identity{state,checkedAt,fingerprint,displayIdentity,detail} /
  isolation{configDirIsolated,authStoreIsolated,sharedWith,disclosure,evidence[]} /
  switchSemantics{currentSession,note} / limits[]`。
  认证三态：`login-succeeded · identity-readable · auth-valid`（**互不等价**，逐条披露）。
- 会话绑定：`sessionId / harnessKind(native|external) / harnessId / accountId / provider / model /
  setAt / scopeNote`，落盘 `.dsh/plugins/harness-pilot/session-bindings.json`。
  **写入入口 = `POST /harness-pilot/api/session/binding`**（本轮修复后才真正被界面调用）。
- 账号池：`entries{accountId → {enabled,priority,cooldownMs}} + policy{maxSwitchesPerTask,
  backoffBaseMs,backoffFactor,maxConsecutiveFailures,onModelUnavailable}`；额度 `state ∈
  {known,unknown,exhausted}`，**未知一律显示「未知」**，自动切换默认关闭。

## 5. UI 改动方案（已完成 / 未完成）

**本轮已完成**：分栏标签条原生化；账号与供应商/模型前置；账号池并入账号管理；选择器四段式 + 能力真话行 + 错误可见化。

**仍建议的下一步（未做）**：
1. 账号管理栏里的长边界说明改成 `<details>` 折叠（目前仍是成段小字，密度偏高）。
2. 把 `permissionModes` 真正接到派发参数上（需要在 dispatch 侧加参数槽 + 实测每个 CLI 的取值语义），
   在此之前界面继续标「未接线」。
3. `codex` / `claude` 补 `modelsCommand`（现在模型下拉是空的 —— 应为空而不是编造）。
4. 子智能体设置页（`settings.subagent`）的端到端跑批：数据面已通（`allowedModels` 已含
   `pilot-cli/wb-managed-a[::deep-model]` 等 17 条），但**本轮未跑通一次真正的子代理长任务**。

## 6. 三态清单

**已完成（本轮实测）**：`save` 根因修复；写入测试腿补齐；选择器四段式 + 错误可见 + 能力真话行；
设置页分栏原生化与重排；三工件一致；上述 6 个探针全绿 + 一次真实任务 `PONG`。

**未验证**：子代理设置页勾选后的端到端子代理跑批；`balanced-model` / `primary-model` 两个别名；
账号 CRUD 的浏览器端到端（本轮只做了服务端与分栏可见性）；`real-task` 那条任务的**执行身份**
（`identity=null`，CLI 不回报身份 ⇒ 插件如实标未知，未外推）。

**受上游限制**：WorkBuddy 只认 4 个别名模型（目录里的 11 个 `r-*` 是路由 id，`--model` 会被拒）；
WorkBuddy 两档案**认证槽位厂商共享**（`configDir` 隔离 ≠ 认证存储隔离）；
`agy` 不支持 `acp`；`codex`/`claude` 无模型发现命令；注册表 `multiAccount`/`canLead` 全为 unknown。

## 7. 回滚

- 客户端回滚点：`D:\Project\dsh-harness-pilot\.bak-ui-round-20261014-132744\`
  （`client.js` / `lib-client.js` / `dir-client.js`，改动前 sha256 `aebedb37337523b6…`）。
- 回滚方式：把其中 `client.js` 拷回 `client/client.js`，再拷到 `client.js` 与 `lib/client.js`；
  **客户端改动不需要重启宿主**（rev 会随内容重算），刷新页面即生效。
- 本轮**未改** `src/**`、未改 profile、未重打 `lib/*.js`（除 `lib/client.js` 这一份客户端拷贝）。
