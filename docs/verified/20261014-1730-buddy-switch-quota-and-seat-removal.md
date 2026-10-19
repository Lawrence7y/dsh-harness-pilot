# 2026-10-14 17:0x–17:3x · 第三轮：Buddy Switch 真实额度接入 + 会话选择器座位被撤的核查

> 本轮起点：用户给了分享链接（Codex 会话）。先做**独立核对**，不采信上一路的自我声明。
> 判据纪律不变：**装了 ≠ 接上了；沙箱过 ≠ 真实可用；能列出来 ≠ 能选 ≠ 选了真生效**。

## 0. 先说一条**与上一路结论相反**的实测

上一路在分享里写：「已加入插件…编译、针对性检查、**真实管理器沙箱**和浏览器验证已通过」，
并给出入口「设置 → 外部 harness 管理 → 账号管理 → 外部账号管理器」。

本机独立核对结果：

| 检查 | 实测 |
|---|---|
| 插件的 `buddyUrl` | **空串**（`GET /api/accounts/managers → config.buddyUrl: ""`） |
| 本机有无该 HTTP 服务 | **没有**。全量监听端口扫描（1–30000）无 Buddy Switch 服务 |
| 本机装的是哪个 Buddy Switch | `NextAgentX/trae-workbuddy-switch` 版本 2026.10.11028，**Tauri 桌面版**（`buddy-switch-rust.exe`），只走 Tauri IPC |
| 那套 `/api/accounts?variant=…` 路径 | **只在它的 webui 构建里存在**（官方说明：「桌面端走 Tauri 命令通道，webui 走本地 HTTP 通道」） |
| `agy-switch.exe` | **本机不存在**（全盘搜索无命中） |
| 因此 | 「沙箱通过」是通过**替身**过的：真实管理器在这台机器上**根本没被调用过**。HTTP 通道不是「配置漏了」，而是**形态不匹配** |

## 1. 本轮新增：Buddy Switch **积分快照**只读接入（真实可用）

绕开不存在的 HTTP 通道，改读桌面版自己落盘的官方积分：

```
%USERPROFILE%\.buddy-switch\state.json
  accounts["<managerId>"] = { realm, nickname, credits, credits_expiring,
                              credits_refreshed_ms, disabled, breaker_until_ms, model_cooldowns, … }
```

**该文件不含任何令牌**（令牌在同目录 `accounts.json` / `accounts.global.json` —— 本模块**从不打开那两个文件**，连 `existsSync` 都不做）。

新增 `src/federation/buddy-quota.ts`，纪律与 `readModelCatalogFile` 同一套且更严：
字段**白名单**、昵称**掩码输出**、令牌形状字符串一律丢弃、只读、**陈旧快照一律 `unknown`**。

接入点：`AccountManagers.state().buddyQuota` → `GET /harness-pilot/api/accounts/managers`；
界面新增 `BuddyQuotaCard`，挂在「设置 → 外部 harness 管理 → 登录账号（WorkBuddy 家族）」栏。

**真实数据（本机实测，17:26）**：

| 区域 | 账号（脱敏） | 额度 | 采集时间 | 状态 |
|---|---|---|---|---|
| 国内 | `La…` | **2122** | 2026-10-14T08:57:20Z | 有额度 |
| 国内 | `la…` | **793** | 同上 | 有额度 |
| 国际 | `ye…@gmail.com` | **423** | 同上 | 有额度 |
| 国际 | `sk…@gmail.com` | **410** | 同上 | 有额度 |

这正是用户要的「**查看脱敏身份、额度信息及其更新时间**」，且本机**真实成立**（此前一律显示「未知」）。

## 2. 本轮顺手修掉的三类缺陷

1. **3 处字面 `**` 泄漏**（16:00 那版新引入的 markdown 未渲染）：
   `只有「隔离开关**实测有效**」…`、服务端 `refuseReason` 里的 `**厂商共享目录**`、`restore **只**恢复…`。
   全部改走 `Hint` / `rich()`。**浏览器实测泄漏点 0**（`probe/out/buddy-quota-round/star-leaks.json`）。
2. **掩码用 `***` 造成假阳性**：`La***` 会被「界面不得出现 `**`」的冒烟断言误判。
   改为 `…`（与项目既有 `acct:…-aa` 同一风格）。
3. **`AccountPoolPanel` 已是死代码**（section 改版后不再挂载）—— 我最初把额度卡插在那里，界面看不到。
   已移到实际渲染的「登录账号」栏。

## 3. ⚠️ 需要你决定的一件事：会话选择器座位**已被撤掉**

**实测事实**（源码与运行实例一致，`anyStale=false`、44 模块）：

- `HarnessSessionSelector`（Harness → 账号 → 供应商 → 模型，含上一轮修的 `save` 根因、供应商维度、
  错误可见化、能力真话行）**仍然定义在 `client/client.js:2197`，但已不再注册**。
- `conversation.input.model` 这个座位**没有任何注册**（全文只剩一处注释）。
- 取而代之：`HarnessSessionIdentity` 注册到 `conversation.session.header.utilities`，
  是**只读徽章**（`harness · model`），代码注释写明 **“Read-only identity utility. Route selection remains entirely native.”**
- 结果：`probe/verify-session-binding-write.mjs` 与 `probe/verify-session-selector-live.mjs`
  **现在都失败**，失败原因就是「没有注册 conversation.input.model 座位」。
  **这两个探针在正常工作** —— 它们在报告一个真实的能力回退，不是探针坏了。

**两面说清**：

- 这个改动**有其合理性**：不劫持宿主原生模型 chrome，改道/归因问题也就不用背；而宿主原生模型菜单
  现在确实列出 `pilot-cli` 的 **734** 个条目（本轮实测），所以「选 Harness + 选模型」**仍能通过原生菜单完成**。
- 但它**确实回退了你的原始要求**：「在当前会话页面原来的模型选择位置，改成先选择 Harness，再选择账号档案、供应商和模型」。
  原生菜单能表达「目标::模型」，但**表达不了账号档案**（账号是插件侧的绑定，不是宿主路由的一部分）。
- 另外，`HarnessSessionSelector` 变成了 **~200 行死代码**，其中包含上一轮验证过的修复。

**三个选项，请你选一个**：

1. **恢复座位**：把 `HarnessSessionSelector` 重新注册回 `conversation.input.model`（priority −1），
   与只读徽章并存或二选一。可恢复「Harness → 账号 → 供应商 → 模型」四段式，代价是重新承担改道/归因面。
2. **保持现状，但补账号选择**：保留只读徽章；在徽章旁加一个**只选账号档案**的窄控件
   （账号是原生菜单表达不了的唯一一维），其余交给原生菜单。改动最小、不碰改道。
3. **彻底移除**：删掉 `HarnessSessionSelector` 死代码与两个探针，明确「会话内不再由插件选 Harness」。
   这样仓库里就不留「看起来有、实际没有」的东西。

> 我没有擅自恢复座位：那是与上一路**明确写下的设计决定**冲突的改动，且会重新承担改道归因面。

## 4. 回归（本轮实测）

| 探针 | 结果 |
|---|---|
| `verify-buddy-quota-offline`（**本轮新增**） | **PASS** —— 真实快照 4 账号；陈旧⇒`unknown`；缺失/非法⇒`available:false` 不抛错；`credits=0`⇒`exhausted`；非数值⇒`unknown` 且 `credits=null`；令牌形状昵称被丢弃；不读 `accounts*.json` |
| 浏览器 `verify-quota-ui`（**本轮新增**） | **PASS** —— 卡片在、2122/793/423/410 全中、国内/国际分区、无字面 `**` |
| 浏览器 `find-stars`（**本轮新增**） | **PASS** —— 泄漏点 **0** |
| `verify-actual-identity-offline` | **PASS**（42 断言） |
| `verify-llm-adapter-live` | **PASS**（`anyStale=false`、pilot-cli **734** 槽、部署默认未变、`profileUnchanged=true`） |
| `verify-session-binding-write` | **FAIL** —— 座位已撤（见 §3，**这是正确检出**） |
| `verify-session-selector-live` | **FAIL** —— 同上 |
| `verify-ui-smoke` | **FAIL 3 条** —— `自动切换执行侧` / `lastResult` / `进程面板` 文案与结构在 16:00 那版被改（面板在、措辞变了）。**未放宽断言**，留给下一轮定性 |

三工件一致：`client/client.js` = `client.js` = `lib/client.js`（`a2710777968c02f8…`）。

## 5. 三态清单

**已完成（本轮实测）**：Buddy Switch 真实额度/区域/采集时间只读接入（国内 2122/793、国际 423/410）；
陈旧/缺失/非法一律 `unknown` 且不抛错；令牌零接触（模块不打开 `accounts*.json`）；3 处字面 `**` 修复；
掩码改 `…`；额度卡挂到实际渲染的栏位。

**未验证 / 未接通**：
- **额度耗尽 → 自动换号**：**仍未接通执行侧**。额度现在是**读到了**，但「读到 0 之后自动切到哪个账号、
  怎么保证 CLI 真的采用新账号」这一链没有实现 —— 卡片里如实写「未绑定 ⇒ 不参与自动切换」。
- **管理器账号 ↔ 执行档案的绑定**：缺 `uid` 链路（`state.json` 只有管理器自己的 UUID + 昵称；
  要拿厂商 uid 就得读 `accounts*.json`，**那里有令牌，我不读**）。所以绑定向导只能由你手选，不能自动推断。
- `agy-switch` 多账号：**本机无此程序**，无从验收。
- 会话选择器座位：见 §3，待你决定。

**受上游/形态限制**：
- Buddy Switch 桌面版**不提供账号切换的 HTTP 通道**（webui 构建才有）；想在这台机器上自动切换，
  要么装它的 webui 形态（官方说明：需自行构建前端再编译服务端，npm 包未发布），要么保持在桌面版手动点。
- WorkBuddy 切换必然要**关闭并重启客户端**（单实例 + 认证写在认证文件里），无法「无感」。

## 6. 回滚

- 本轮回滚点：`.bak-buddyquota-20261014-170903/`（`src/` 与 `lib/` 全量快照）。
- 只回滚客户端：三份文件一起换回即可。只回滚本轮新增：删 `src/federation/buddy-quota.ts`
  与 `lib/federation/buddy-quota.js`，并从 `src/index.ts` 的 `SELF_MODULES` 移除对应一行。
- **服务端改动需要重启 DSH 才彻底生效**（本轮是靠 HMR 热加载生效的，实测 `anyStale=false`、44 模块）。
