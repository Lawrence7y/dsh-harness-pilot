# 2026-10-14 23:0x · 第十四轮：账号与认证边界在设置页如实说明（需求 ④ 点名 Antigravity）

## 1. 缺口：边界**有数据、没出口**

`ISOLATION_PROFILES`（`src/federation/accounts.ts`）里早就写实了 Antigravity 的边界，而且证据很硬：

- `agy-core --help` 的 Available subcommands 里**没有** login/logout/status；
- `ANTIGRAVITY_EXECUTABLE_DATA_DIR=<全新临时目录>` → `agy-core models` 输出**逐字节相同**的 6 个模型，且临时目录**一个文件都没被创建**；
- `XDG_CONFIG_HOME=<全新临时目录>` 同样无效；
- 结构事实：agy 状态落在 `~/.gemini/`，没有可按调用切换的根。

但这条边界此前只挂在**已存在的账号档案**上（`/api/accounts[].isolation`）。
于是恰好是 Antigravity —— **不该也不能**建账号的那一类 —— 在设置页看不到任何说明，
只会看到「这个 harness 需要登录，但本插件还没有为它保存任何账号档案。在下面的面板里添加。」
⇒ 把人引到一个必然失败的按钮上（用户要求 ④ 原文：Antigravity 的共享认证槽边界**如实说明**）。

## 2. 本轮实现

| 位置 | 改动 |
|---|---|
| `src/index.ts` `/overview` | 每条 harness 附带 `isolation = { harnessId, viaTarget, configDirIsolated, authStoreIsolated, mechanism, launchKind, mayAddAccounts, disclosure, refuseReason?, evidence[], limits[] }`；harnessId 由该组成员目标经 `seedForTarget()` 推得（**与账号模块同一张表**）；推不出种子的（command-code / cursor / gemini / qwen / minimax）用 `isolationProfileFor(key)` 的**兜底对象**，如实说「没有任何隔离实测记录」+「未知时默认拒绝新增档案」——**不留空**（空白会被读成「没有边界」） |
| `client/client.js` | 新增 `IsolationBoundary` 组件：**结论行常驻可见**（配置目录隔离 / 认证存储独立 / 允许新增账号）+ 结论文案 + 「为什么不允许新增」+ 默认收起的「依据与限制」；对 `mayAddAccounts === false` 的 harness，把「去下面的面板添加」改成「**本插件不允许为它新增账号档案**（见边界说明）」 |
| 口径修正（三处**自相矛盾**，暴露后才看见） | ① `workbuddy` 档案原写 `configDirIsolated: false`，却与它自己的 disclosure（「配置目录可指定」）及账号档案（`workbuddy-a.isolation.configDirIsolated: true`）相反 ⇒ 按实测改为 `true` 并补证据（受管 wrapper 注入 `CODEBUDDY_CONFIG_DIR`；两个 WB 账号各带自己的目录运行），**同时点明「只有受管 CLI 路线成立，桌面端目标不支持」**；② `workbuddy-ai` 同改；③ `qoder-intl` 的 `authStoreIsolated` 按第 7 轮实测（默认根未登录 / 账号目录成功 / 空认证账号不回退）改为 `true`，仍保留「两个已登录国际账号并行未验证」的限制 |

纪律：`mechanism` / `launchKind` **没动** —— 它们参与自定义账号的 launch 合成（`launchFor()`），改成描述性文字会造出非法 env 名。

## 3. 实测

**live `/overview.harnessGroups[].isolation`（改后口径自洽）**
```
label             cfgDir authSlot mayAdd
Antigravity        False   False  False     ← 共享认证槽、不可验证隔离、不允许建账号（需求 ④ 点名的例子）
Claude Code        True    True   True
Codex              True    True   True
Qoder（国内）      True    True   True
Qoder（国际）      True    True   True      ← 第 7 轮实测的正向对照
WorkBuddy（国内）  True    False  False     ← 配置目录隔离 / 认证槽厂商共享
WorkBuddy（国际）  True    False  False
Grok/Kimi/MiMo/OpenCode/ZCode         False False False
Command Code/Cursor/Gemini/Qwen/MiniMax  兜底对象：无实测记录 + 默认拒绝新增
```
（16 条 harness 全部有边界，不再留空。）

**UI smoke（离线渲染 + 活数据）新增 6 条断言，全 PASS**
- 边界字段必须出现：`账号与认证边界` / `配置目录隔离` / `认证存储独立` / `允许新增账号`；
- 必须出现「不允许」口径 + 「为什么不允许新增」的原因；
- 对不允许建账号的 harness **不得**再说「去下面的面板添加」；
- Antigravity 的具体文案必须出现：`不支持可验证的多账号隔离`、`login/logout/status`、`ANTIGRAVITY_EXECUTABLE_DATA_DIR`（后两条是**依据**，而不是只给结论）。

## 4. 三态清单

- **已实现且实测通过**：16 条 harness 全部带边界（含 5 条无实测记录的如实兜底）；Antigravity 的共享槽边界与依据在设置页可见；
  不允许建账号时不再误导用户去点添加；三处自相矛盾的口径按实测统一；UI smoke 6 条新断言 + 全量回归。
- **已实现但未验证**：真浏览器里点开「依据与限制」的观感（离线渲染已覆盖 `allTabs` 展开态）；
  WorkBuddy **桌面端** `--user-data-dir` 路径（档案里写明「需要新增目标，未做」）。
- **尚未实现（下一轮）**：① `harness_agent` / 任务工具的 `model` 收敛到新分组 id（现在仍是自由字符串，
  容易写错且没有任何校验）；② 设置页「模型来源与四类」的真浏览器点击验收；③ 会话/子代理页面上
  「请求值 ≠ 实际值」的提示位（现在只落在账本与诊断里）。
- **受上游限制**：Antigravity CLI 没有 login/status 子命令、两个候选数据根开关实测无效 ⇒ 多账号隔离不可实现；
  WorkBuddy 认证槽厂商共享 ⇒ 同区域不能真多账号。

## 5. 复现

```powershell
node scripts/build.mjs
node probe/verify-ui-smoke.mjs      # 边界字段 + Antigravity 具体文案 + 不得误导
node probe/_regression-suite.mjs    # 19 项

# 逐条 harness 的边界
(Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/overview').harnessGroups |
  Where-Object { $_.isolation } | Select-Object label,
  @{n='cfgDir';e={$_.isolation.configDirIsolated}},@{n='authSlot';e={$_.isolation.authStoreIsolated}},
  @{n='mayAdd';e={$_.isolation.mayAddAccounts}},@{n='via';e={$_.isolation.viaTarget}}
```
