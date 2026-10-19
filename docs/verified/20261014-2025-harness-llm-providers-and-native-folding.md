# 2026-10-14 20:0x–20:2x · 第八轮：一个 harness 一条 LLM provider（原生选择器里的「折叠」落地）

> 目标（长期）第 ⑥ 条：「会话与子代理选择中，对 harness 进行折叠，点开折叠后才是该 harness 的全部模型」。
> 本轮把它做成**宿主机制**上的事实，而不是插件自绘的假折叠。

## 1. 为什么只能这么做（宿主契约，先摆事实）

| 事实 | 出处 |
|---|---|
| 宿主模型菜单**只按 LLM provider 分组** | `dsh-client-ui-model-selection/lib/client.js:980-982`（`filteredGroups.map(group => MenuGroup({ label: group.name, children: … }))`） |
| 分组**不可折叠**：`MenuGroup` 只是粘性标题，全树没有组级折叠原语 | `dsh-client-ui-primitives/lib/index.js:4283-4305`、`:4315` |
| 子代理模型卡同样按 provider 分组 | `dsh-client-ui-settings-subagent/lib/client.js:313-330` |
| 分组数据来自 `ctx.llm.listProviders()/listModels()`，**空组会被丢掉** | `dsh-api-session-controller/lib/index.js:500-548`（`:541`） |
| `registerAdapter(providers, adapter)` **本就接受多路由** | `dsh-llm/lib/index.js:1826-1833` |
| 原版选择器的两级形态：供应商列表 → 钻进该供应商看全部模型 | `dsh-client-ui-model-selection/lib/client.js:480-505`（`pane: 'root' | 'model'`） |

⇒ 「**一个 harness = 一个 provider**」= 原生折叠 + 展开即全部模型。本轮据此改写（旧注释里
「为什么用组合 id 而不是多 provider」的取舍**按用户要求反转**，改动面：`OWNED_ROUTES` 动态化）。

## 2. 本轮改了什么

| 文件 | 改动 |
|---|---|
| `src/harness-llm.ts`（新增） | `buildHarnessLlmProviders()`（目标表 → provider 规格）+ `mergeHarnessModels()`（合并去重、**不截断**、每条标注**谁执行**）+ `isAccountPinned()` |
| `src/llm-adapter.ts` | 自有路由**动态集合**（`ownedRoutes()` / `isOwnedRoute()` / `setOwnedRoutes()`，闸门/purpose guard/请求层三处共用）；`providerInfo` 按 harness 返回分组标题；`listModels` 按 harness 返回**全部**模型、历史 `pilot-cli` 返回空（去重复）；`prepareCall` 把 provider **闭包**带进 `stream`；新增「清单已拿到但模型不在其中 ⇒ `PILOT_CLI_MODEL_REFUSED` 显式拒绝」；`streamThroughRoute` 增加 `provider` 形参 |
| `src/index.ts` | 注入 `harnessProviders()`；`/llm-adapter` 新增 `harnessRoutes`（含**逐目标模型数与错误**）；**挂载即预热**全部可派发目标；`extras.modelsFor/modelsErrorFor` |
| `src/settings.ts` | `sessionModelLimit` 默认 0 且**标注不再生效**（分组之后不再需要截断） |
| 探针 | 新增 `verify-harness-llm-providers`（16 条 provider / 账号固化优先 / 合并去重不截断 / 保留 id）；`verify-llm-adapter-unit`、`verify-ui-smoke` 口径按新设计改写（含「清单已拿到则过期 id 必须显式拒绝」与「历史 pilot-cli 不得再塞条目」） |

## 3. 实测证据

### 3.1 原生模型目录里就是「一个 harness 一个分组」（live `/overview.dsh.providers`）

```
pilot-cli               外部 CLI（pilot-cli）        0   ← 空组：历史路由不再重复列条目
harness-antigravity     外部 CLI · Antigravity       7   cli-default | gemini-3.8-flash-high | …
harness-claude-code     外部 CLI · Claude Code       5
harness-codex           外部 CLI · Codex             8
harness-mimo            外部 CLI · MiMo             67
harness-opencode        外部 CLI · OpenCode        486   ← **不截断**（旧实现被 sessionModelLimit 截到 10）
harness-pi              外部 CLI · Pi                99
harness-qoder-cn        外部 CLI · Qoder（国内）      14
harness-workbuddy-cn    外部 CLI · WorkBuddy（国内）  10
harness-workbuddy-intl  外部 CLI · WorkBuddy（国际）   5
…（共 16 条 harness 分组）
```
注册结果：`registration.routes = 17`（`pilot-cli` + 16 个 harness 分组）。

### 3.2 真的能派发（`POST /llm-adapter/stream`，一次真实短问答）

```
provider=harness-qoder-cn  model=Qwen3.8-Flash
→ ok=true  text="HARNESSROUTE-OK HPQD-Q38F-R2A001"  finish=stop  ms=33012
CLI argv（qoder 自己写的 manifest）：
bun … --config-dir C:\Users\Administrator\.dsh\harness-accounts\qoder-cn-a -m Qwen3.8-Flash -p
```
⇒ ① 模型真的落到命令行；② 跑的是**账号隔离目标** `qoder-cn-acct-a`，**没有**退到不带账号的 `qoderclicn`。

### 3.3 不改用户的部署默认模型（走**真实选择器服务端入口**）

```
POST /llm-adapter/select-model {provider:'harness-qoder-cn', model:'Qwen3.8-Flash'}
→ gate.blocked 0→1，lastBlocked={harness-qoder-cn, Qwen3.8-Flash}
→ profile 双文件哈希 before==after（cordis.patch.yml + cordis.yml），unchanged=true
→ gate.ownedRoutes = 17 条（pilot-cli + 16 个 harness）
```

### 3.4 诊断能力（本轮因一个真 bug 而加，实测有效）

`/llm-adapter` 的 `harnessRoutes[].modelsPerTarget` 逐目标回报「几个模型 / 什么错」。它当场抓出：

- `harness-workbuddy-cn` 曾经 **0 个模型**：不是「WB 没模型」，而是该组里 `codebuddy` 这条件目标的
  账号合并被**显式拒绝**（受管配方校验不过），异常沿 `modelsFor` 冒泡把整组清零。
  ⇒ 改成**逐目标容错 + 错误留痕**（`syncModelErrors`），修后 `workbuddy-cn = 10`（`cli-default` + 国内 9 个）。
- `WorkBuddy（国内）` 的默认执行目标原本被配置顺序选成 **`codebuddy`**（坏 bin）：
  ⇒ `isAccountPinned()` 增加「受管 bootstrap wrapper（`…-managed.cjs`）」识别，修后 primary = **`wb-managed-a`**。

## 4. 三态清单

- **已实现且实测通过**：多 provider 注册（17 条路由）；原生目录按 harness 分组且**不截断**（opencode 486 条）；
  `pilot-cli` 不再重复列条目；`harness-qoder-cn/Qwen3.8-Flash` 真实派发（argv 含 `-m` 且走账号隔离目标）；
  选择 harness 路由**不改部署默认模型**（哈希不变 + 闸门计数）；过期模型在清单可得时**显式拒绝**；
  WorkBuddy 国内模型数 9（`harness-workbuddy-cn` 组 10）；账号固化优先；
  两个新探针 + 两个口径更新后的探针 PASS。
- **已实现但未验证**：真实浏览器里「分组标题 → 钻进模型列表」的观感（离线渲染已断言分组存在，但无截图）；
  子代理设置卡里同一分组的表现（同一份目录，未逐一点选验证）；`cli-default`（CLI 默认档）真实派发未单独跑。
- **尚未实现（下一轮）**：
  1. **模型来源链**（真实 CLI 查询 → 原生配置 `product.json` → 官方缓存 `acc-product-config-v3.json` →
     有据别名）与每条目的「可选 / 仅展示 / 别名 / 当前默认」四态 + 未安装/未登录/无供应商/无列举能力说明。
  2. **`allowedModels` 写入**：设置页勾选「哪些模型可在子代理里被选」（现在只读）。⚠️ 新的 provider 路由
     尚未进 profile 白名单，所以**子代理**侧目前只能选到旧的 `pilot-cli/*` 条目。
  3. `harness_agent` / 任务工具的 `model` 仍是自由字符串，未收敛到新分组 id。
  4. Antigravity argv 污染复核（历史 3 条 exit 2）。
  5. 多账号并行任务验收 + 空认证环境不回退全局账号的反向对照。
  6. **新发现待修**：内置 WorkBuddy 账号档案的 `targetName` 是 `workbuddy-a` / `workbuddy-ai-b`
     （= 账号 id，不是目标名）⇒ 别名 provider 全部被「targetName 未匹配本 profile 目标」拒掉
     （`src/federation/accounts.ts:162`、`:224`）。Qoder 的是 `qoderclicn`（正确）。
- **受上游限制**：宿主没有组级折叠组件、没有「插件优先于 shipped」的配置项；侧边栏会话列表无 harness 分组槽位。

## 5. 复现

```powershell
node scripts/build.mjs
node probe/verify-harness-llm-providers.mjs     # 分组规格（离线）
node probe/verify-llm-adapter-unit.mjs          # 适配器（含过期模型显式拒绝）
node probe/verify-ui-smoke.mjs                  # 设置页 + 座位 + 分组断言（打活宿主）

# 目录分组（live）
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/overview' |
  Select-Object -ExpandProperty dsh | Select-Object -ExpandProperty providers |
  Where-Object { $_.id -like 'harness-*' } | Select-Object id,@{n='n';e={$_.models.Count}}

# 真实派发（一次短问答）与逐目标诊断
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/llm-adapter/stream' -Method Post `
  -ContentType 'application/json' -Body '{"provider":"harness-qoder-cn","model":"Qwen3.8-Flash","prompt":"reply OK"}'
(Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/llm-adapter').harnessRoutes
```
