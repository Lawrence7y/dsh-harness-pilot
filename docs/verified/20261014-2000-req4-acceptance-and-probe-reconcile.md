# 2026-10-14 19:2x–20:0x · 第六轮：要求 4 端到端验收（结论：**一半达成、一半是死注册**）+ 8 条探针对账

> 用户指令：先做要求 4 的端到端截图验收，再对账那 8 条探针。
> 两条都做完了，且都有明确结论 —— 其中一条是**否定结论**。

---

# 第一部分：要求 4 的端到端验收

要求原文：「**在每个子代理会话的页面中**，需告知用户当前使用的是哪个外部 CLI，以及该外部 CLI 对应的模型。」

## 1.1 结论（先说清，避免读大）

| 面 | 结论 | 证据 |
|---|---|---|
| **会话页（交互式）** | **达成** —— composer 的模型芯片直接显示 `Claude Code · sonnet`（= 哪个 CLI + 哪个模型） | `probe/out/req4-and-probe-reconcile/B2-after-pick.png` |
| **子代理 / 后台任务的执行卡片** | **达成** —— 每条都显示执行身份：CLI / 脱敏账号 / 请求模型 / 通道 / 终态 | `T0-task-identity.png` |
| **插件自己那个「会话头身份徽章」** | ❌ **未达成 —— 这个注册是死的** | 见 §1.3 |

## 1.2 已达成部分（真实数据）

**① 会话页**：在原生模型选择器里搜 `Claude Code` → 筛出该 CLI 的 5 个条目
（`（默认模型）` / `sonnet` / `opus` / `haiku` / `opusplan`），选中后 composer 右下角由
`DeepSeek V4.1 Flash Max` 变为 **`Claude Code · sonnet`**。
截图：`B1-search-ClaudeCode.png`（搜索命中）、`B2-after-pick.png`（选中后）。

**② 执行卡片**（`任务与执行身份` 面板，实测真实任务账本）：

```
98a49109 | wb-managed-a | 请求模型：fast-model | completed | 回执 skipped | 13s · 17 chars
  执行身份：Harness wb-managed-a · 账号 acct:…-ab · 供应商 未回报 · 模型 未回报 · 通道 acp；未回报项无法确认
```

即：**哪个 CLI（wb-managed-a）、哪个模型（请求 fast-model）、哪个脱敏账号、哪条通道**都在，
并且对 CLI 没回报的字段如实写「未回报 · 无法确认」——没有拿请求值冒充实际值。

## 1.3 ❌ 未达成部分：会话头身份徽章**根本没挂上**

**现象**：选中外部 CLI 模型后，`[data-harness-identity]` 元素数 **始终为 0**。

**排除过程**（每一步都是实测，不是推理）：

| # | 假设 | 做法 | 结果 |
|---|---|---|---|
| 1 | `inject` 取参形状错 | 改成宿主 `open-in-app` 那种**无参** `inject: () => ({...})` | 无效 |
| 2 | `inject` 字段本身有问题 | **整个去掉** `inject` | 无效 |
| 3 | 座位名写错 | 从运行版 asar 里查：`dsh-client-ui-conversation` **确实声明** `conversation.session.header.utilities`，`kind: "list"`, `scope: "session"` | 名字对 |
| 4 | 只是 `utilities` 这一个子座位坏 | **同时注册** `…header.utilities` 与 `…header.actions` | **两个都空** |
| 5 | 组件逻辑提前 return 了 | 把组件临时改成**无条件渲染一段 DIAG 文本** | 仍然 0 个元素 ⇒ **组件从未被调用** |
| 6 | 有异常被吞 | 打开 `Runtime.exceptionThrown` + `Log.entryAdded` | **零报错** |

**因此**：注册语句执行了（同一 `apply` 里后面的 `settings.section` 正常渲染），
但 `conversation.session.header.*` 下的子座位**不产生任何输出**。
父座位 `conversation.session.header` 是 `single` 且自带 `children` 声明 ——
剩下的可能路径是「子座位注册需要走父座位的授权（`SlotOwnershipError` 那套）」，本轮没打通。

**处理**：保留注册（上游修好即生效）+ 保留 `directoryFor` 的 `try/catch`
（宿主该 API 对未知会话**会响亮报错**：`ui-model-selection: session "…" resolved no scope`），
并在代码里把上面 6 条排除过程写成注释，**明确标注「要求 4 在本轮判定为未达成」**，
不把死注册写成「已接入」。

---

# 第二部分：8 条探针对账

## 2.1 对账原则

**先分清「漂移」和「丢失」**：
- **漂移**（结构/措辞变了、语义还在）⇒ 改断言到新结构，**保留语义**；
- **丢失**（能力真的没了）⇒ **恢复能力**，而不是删断言。

对账前 8 条全红；对账后 **`verify-ui-smoke` PASS**。

| # | 原失败断言 | 归类 | 处理 |
|---|---|---|---|
| 1 | 账号池面板没有显示脱敏审计结果 | **丢失** | **重新挂载 `AccountPoolPanel`**（上一路 section 改版时被摘掉，`h(AccountPoolPanel` 出现 0 次） |
| 2 | 自动切换执行侧面板缺少「自动切换执行侧」/「/pool/autoswitch」/「lastResult」 | **丢失** | 同上，随 1 一起恢复 |
| 3 | lastResult 为空时没有写明「还没有发生过自动切换尝试」 | **丢失** | 同上 |
| 4 | 进程面板缺少「完整进程集合」 | **丢失（口径声明）** | 给 `ProcessMemoryPanel` 补回口径行：「按**完整进程集合**统计（含树外厂商守护进程）；只报事实与占用，不做归因」 |
| 5 | 有共享认证的账号，但界面上没有出现「厂商共享」 | **丢失（诚实性）** | **恢复三态徽章**：`已隔离` / `厂商共享` / `隔离未确认`。上一路只剩「认证已隔离 / 认证隔离未确认」，**把「厂商共享」这一态丢了** —— 而用户明确要求「明确说明哪些数据真正隔离、哪些仍使用厂商原生共享存储」 |
| 6 | 有已隔离账号，但界面上没有出现「已隔离」 | **丢失（诚实性）** | 同 5 |
| 7 | 缺少右栏标题「DSH 本 profile 已配置供应商」 | **丢失（诚实性）** | 恢复显式两栏命名 + 「两栏永不混用」声明（用户明确要求「不能将 DSH 的供应商和模型列表冒充外部 CLI 的列表」） |
| 8 | 账号档案面板缺少「管理（改 / 删 / 原生登录退出）」 | **漂移** | 把折叠块的 summary 改成这个命名（能力一直在：原生登录/退出按钮 + 改/删字段），并在块内写明走哪两个接口 |
| 9 | 没有注册 `conversation.input.model` 座位 | **需求变更** | 改为断言「**不得**占用该座位」+ 目录里必须存在 `目标名::模型` 条目。见 §2.2 |

## 2.2 唯一一条「改断言」的地方，以及为什么它不是放宽

第 9 条（`conversation.input.model` 座位）原本要求插件**接管宿主自带的模型选择器**。
你后来的指示是「选择模型部分的 UI 改得太乱了，**先切回原版**；并给用户选择 CLI 以及
harness CLI 模型的权利」。⇒ 接管座位这件事**被你明确否定**了。

因此这条断言改成：**不得**占用该座位（占用即回退到被否定的方案），
并新增一条真正对应「能选」的断言 —— **模型目录里必须存在 `目标名::模型` 形状的条目**
（实测 **55 个**，例：`opencode::opencode-go/cat-jam-free`）。
「搜得到、选得中」由浏览器 `search-model` 实测（§1.2 ①）。

同一处理也用在另外两个「测已撤座位」的探针上：
- `verify-session-binding-write` → 保留**与座位无关**的那条腿（`POST/GET /session/binding` 写入/回读/还原），实测 `wb-managed-a` 写入成功、还原回 `dsh` 成功 ⇒ **PASS**；
- `verify-session-selector-live` → 只断言「不得占用座位」并在输出里指明替代脚本 ⇒ **PASS**。
两者都在文件头写明**已被需求变更取代**、以及替代断言在哪，**不删文件、不静默跳过**。

## 2.3 顺带修掉的两处**基座失真**（不是产品缺陷）

1. `verify-ui-smoke` 的最小 React shim **没有 `useSyncExternalStore`** —— 任何用它订阅外部 store 的组件在该基座下都会抛错。已按 React 语义补上。
2. 探针在 `allTabs` 模式下只看得到**当前 CLI 那一族**的账号 ⇒ 按 CLI 分屏后看不到别族的隔离披露。已让 `allTabs`（= 探针用的「全渲染」模式）覆盖所有家族。

---

# 第三部分：回归与状态

| 探针 | 结果 |
|---|---|
| `verify-ui-smoke`（live 数据整页渲染） | **PASS**（76299 字符；四态文字同时出现） |
| `verify-llm-adapter-live` | **PASS**（`anyStale=false`；目录 106 条；部署默认未变） |
| `verify-actual-identity-offline` | **PASS**（42 断言） |
| `verify-buddy-quota-offline` | **PASS** |
| `verify-session-binding-write` | **PASS**（绑定接口那一腿） |
| `verify-session-selector-live` | **PASS**（座位未占用） |
| 浏览器 `verify-settings-ui2` / `search-model` | **PASS** |

三工件一致：`client/client.js` = `client.js` = `lib/client.js`（`3a2013348a0397c0…`）；
运行实例 `anyStale=false`、44 模块。

## 三态清单

**已完成（本轮实测）**：要求 4 的两个已达成面（会话页 composer 芯片、执行卡片身份行）都有真实数据截图；
8 条探针全部对账完毕且**其中 6 条是恢复能力而非改断言**；两处基座失真修掉。

**未达成（明确否定）**：插件在 `conversation.session.header.*` 子座位上的注册**不渲染**（6 条假设已排除，零报错）。
要求 4 的「插件自己再加一个会话头徽章」这一形态**判定未达成**，代码里已如实标注。

**未验证**：子代理会话**自身**的页面（而不是执行卡片）是否也有 composer 芯片 ——
子代理 run 只能由宿主进程内调用方发起，外部脚本触发不了（rc.2 契约边界）。

## 回滚

- 本轮只改客户端 + 探针：三份 `client*.js` 换回 `.bak-buddyquota-20261014-170903/`；
  探针改动只影响测试，回滚即回到「8 条红」的状态（**不建议**，那 6 条是恢复的能力）。
- 服务端本轮未改。
