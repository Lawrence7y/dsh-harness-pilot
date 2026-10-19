# harness-pilot 换号可用性修复报告

日期：2026-10-17（凌晨；执行：ZCode / glm-5.3-flashx）
对象：`D:\Project\dsh-harness-pilot` 插件及其配置。**未改任何插件源码**，未改 `D:\Project\ra2-campaign-forge` 任何文件，未重启 harness-pilot / DSH 宿主。

---

## §1 根因

**直接原因（报错链路）**：`harness_task_start` 的显式 `accountId` 在 `src/task-tools.ts:449-472` 交给注入的 `withAccount`（`src/index.ts:5376-5378`），最终进 `withAccountTarget()`（`src/account-target.ts:514-521`）在**生效账号档案**里按 id 查找；查不到即拒绝并枚举已知档案——这就是「未知账号档案；已知：qoder-intl-a」。

**深层原因（为什么只剩一个档案）**：生效档案 = `effectiveSeeds(harness-accounts.json)`（`src/index.ts:4599-4606` → `src/federation/accounts.ts:1412-1484`），= 内置种子 + `custom` 数组。而：

1. 内置种子 `ACCOUNT_SEEDS` 已于 **2026-10-15 被清空**（`src/federation/accounts.ts:87-92` 注释：WorkBuddy / WorkBuddy.AI / Qoder 的账号型接入整体迁往 `@dsh-external/dsh-model-connect`，插件不再内置 CLI 账号档案）。
2. `harness-accounts.json` 的 `custom` 数组只剩 2026-10-14 创建的 `qoder-intl-a`。
3. **`account-pool.json` 的 5 条是「账号池」条目（自动切换候选），不是档案**——池条目从不参与 `accountId` 解析；`enabled=false` / `autoSwitchEnabled=false` 只约束自动切换，手动显式 `accountId` 路径根本不查池（`task-tools.ts:448-456` 只在**未显式指定**时用池默认）。

即报告 §4.4 的猜测成立：**池内条目未被注册为档案**；且 2026-10-15 拆分时没人把仍在磁盘上活着的 5 个凭据目录补登回档案登记表，派发侧 `accountId` 由此整体失联。

**换号的结构性事实（本轮确认，决定修复形状）**：

- `qoder-cn-native` 的 argv **硬绑** `--config-dir …\harness-accounts\qoder-cn-a`（`src/config.ts:392`）。对硬绑目标传别的账号会被 `withAccountTarget()` 分支③**显式拒绝**（防「两个 `--config-dir` 谁生效由 CLI 决定」的静默串号）——这正是要保留的保护。所以「按通道换号」的正解 = 一个**不带账号**的通道目标 + `accountId` 选账号（分支④普通合并，`--config-dir` 前置注入）。
- WorkBuddy 通道更严：账号由受管 wrapper 烘焙且有白名单（`src/account-target.ts:184` `NATIVE_MANAGED_WORKBUDDY_IDS=['workbuddy-a','workbuddy-ai-b']`；`src/sessions.ts:558-589` 执行前门禁）。当前每通道各只有一个 WB 账号，无「另一个账号」可换（见 §5.2）。

## §2 改动（文件:行；全部免重启生效，无一行 src/ 改动）

1. **`C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml`**（`harness-pilot.config.targets` 段，新增于 **yml:318-349**）：
   - 新增目标 **`qoderclicn`**（yml:324，规范名）：不带账号的 Qoder CN CLI 通道入口，`args=['-p','--permission-mode','bypass_permissions']`（词表 snake_case，沿用 v6 实测），`nativeCli=claude-stream-json`（`--session-id` 新建 / `--resume` 精确恢复，与 `qoder-cn-native` 同协议），`promptViaStdin=true`，`order=['headless']`。
   - 新增目标 **`qoder-cn`**（yml:337，别名）：与 `qoderclicn` 同配置只差名字。保留原因：2026-10-17 00:35 统筹会话已按 "qoder-cn" 名字派卡（见 §3.2），不保留会让其后续派发报 `unknown harness target`。
   - ⚠️ 档案记录的 `targetName` 必须是 **`qoderclicn`**（CLI 裸名）：custom 档案的 `launch.command` 取自 `targetName`（`accounts.ts:1236-1251` `launchFor`），`sameAccountRecipe()`（`account-target.ts:282-297`）要靠它与硬绑目标的 `…\qoderclicn.exe` 逐项比对通过，才能走到「整份复用」分支。第一版我用了 `qoder-cn` 就在这里被探针抓出（目标带目录但配方不一致 ⇒ 拒绝），改名后通过。
2. **`C:\Users\Administrator\.dsh\plugins\harness-pilot\harness-accounts.json`**（`custom` 数组，updatedAt=2026-10-16T16:24:31Z）：
   - `custom += qoder-cn-a`：`harnessId=qoder-cn`，`targetName=qoderclicn`，`configDirSubdir=qoder-cn-a`，`region=cn`，displayName「Qoder 国内 A」。
   - `custom += qoder-cn-b`：同上，`configDirSubdir=qoder-cn-b`，displayName「Qoder 国内 B」。
   - **注册动作执行者与方式（对应报告 §4.4）**：由本轮 ZCode 经插件自带的进程内 CRUD 接口 `POST http://127.0.0.1:4200/harness-pilot/api/accounts/manage`（`src/index.ts:2201-2262`，body `{kind:'create', input:{…}}`）写入——走插件自己的校验（`applyAccountCrud`，qoder-cn 在 `mayAddAccounts` 白名单，隔离依据=实测两账号 `--config-dir` 身份指纹不同），并即时刷新内存 `accountRegistry` + 账号池重同步（`src/index.ts:4666-4680`）。**未手改 JSON**。字段含义：`id`=派发侧 accountId；`harnessId`=所属 harness（决定能套到哪些目标）；`targetName`=登记的入口目标（同时成为 launch.command）；`configDirSubdir`=凭据目录子目录（`~/.dsh/harness-accounts/<subdir>`，只登记路径名，**不读不写凭据**）。
   - ⚠️ 编码坑（复现须知）：Git Bash 里 `curl -d '中文'` 内联体会被 GBK 转码成 `???` 落盘（第一轮中招，已 delete+recreate 修正）；**注册含中文的 displayName/note 必须用 UTF-8 文件体** `curl --data-binary @file`。残留：`patches` 里留有 `qoder-cn-a/b` 两条与记录同值的补丁（首轮修编码的痕迹，仅使 /accounts 多一行「已由用户修改」limits 提示，无行为影响；CRUD 无删除 patch 的接口）。
3. **`probe/verify-account-switch-20261017.mjs`** 新增（只读探针，见 §3.1）。
4. **副作用（如实）**：`account-pool.json` 的 `workbuddy-a` / `workbuddy-ai-b` 两条池条目被 CRUD 的池重同步移除（`src/index.ts:4676-4677` 设计行为：池条目与档案联动）。它们本就 `enabled=false` 且对应账号无档案（幽灵条目），行为无影响；`autoSwitchEnabled=false` 与其余策略字段原样未动。
5. **保护未动**：跨账号恢复边界告知（`resolveAccountLaunch` 的 isolationNote 原样进成功 note，`src/federation/poolconfig.ts:303-326`；/pool/switch 的 `native-resume` / `checkpoint-new-session` boundary 语义未触碰）；同账号并发切换闸门（`src/federation/coordination.ts` heldBy 机制）与硬绑目标防串号拒绝（分支③，探针 R4 复验）全部原样。

## §3 验证方式与结果

1. **离线探针** `node probe/verify-account-switch-20261017.mjs`（用现场 `lib/` + 现场 `harness-accounts.json`，纯函数调 `withAccountTarget`，**不派发任务、不 spawn CLI**）：**15/15 PASS**——
   - R1 生效档案含 qoder-cn-a / qoder-cn-b / qoder-intl-a；
   - R2 **报告最小复现通过**：`qoder-cn-native + accountId=qoder-cn-a` ⇒ 成功且**整份复用**（不重复注入 `--config-dir`），note 带隔离边界告知；
   - R3 换号主路径：`qoderclicn + accountId=qoder-cn-a|qoder-cn-b` ⇒ 成功，`--config-dir` 前置且各指本人目录，`-p`/`bypass_permissions` 保留，合并后目标可被原生会话门禁识别；
   - R4 保护：`qoder-cn-native + accountId=qoder-cn-b` ⇒ **显式拒绝**（不静默串号）；
   - R5/R6 `seedForTarget('qoderclicn')=qoder-cn`；未知账号仍拒绝并列已知档案。
2. **生产侧端到端（最硬证据，非我派发）**：2026-10-17 00:35 统筹会话经 `harness_task_start` 按新入口真实派发两卡——task `21c15d39`（`requested.accountId=acct:…-aa` 即 qoder-cn-a）与 task `e68a285b`（`acct:…-ba` 即 qoder-cn-b），目标 `qoder-cn`，transport=headless，**均 status=completed**（00:42:54，`GET /harness-pilot/api/tasks` 账本）。⇒ 「指定账号 → 注入 `--config-dir` → CLI 执行 → 完成」全链路在生产侧已走通，且账本里 accountId 已脱敏。
3. **在跑任务安全**：`/api/tasks` 全账本 0 running / 0 queued；改动窗口（00:17-00:50）内最近的任务照常完成；全程未重启任何服务/宿主/插件。
4. **生效方式核验**：`GET /accounts`（进程内）列 3 档案（中文显示名正确）；`GET /registry?measure=0` 列出 `qoderclicn` 与 `qoder-cn`；`GET /pool` 确认 `autoSwitchEnabled=false`、池条目 `enabled` 全 false。

## §4 是否需要人工确认 / 重启

- **不需要重启，也不需要人工确认**。两处改动都是热路径且已生效：档案注册走插件进程内 CRUD（即时生效，生产卡已实际使用）；profile patch 目标走宿主配置热重载（00:35 的派发即证明）。
- 宿主下次冷启动会从磁盘重读 `harness-accounts.json` 与 profile patch——两者均已落盘，预期一致（未做冷启动复验，见 §5.5）。
- 建议人工知晓一件事：池里 `workbuddy-a` / `workbuddy-ai-b` 两条目被设计内重同步移除（§2.4）。如在意，可在 WB 通道支持多账号后随档案注册自动回来。

## §5 我不能证明什么

1. **「换号刷新额度」的实际效果未验证**：探针只证明「派发配方解析正确 + 不串号」；00:35 两卡 completed 说明两个账号当时都能真实执行，但「额度按账号独立计数、切号后额度恢复」无法从任务账本证明（我未读 result 正文，也未做配额对比——那需要真实消耗）。
2. **WorkBuddy / WorkBuddy.AI 通道的换号未解决**：WB 账号由受管 wrapper 白名单烘焙（仅 `workbuddy-a` / `workbuddy-ai-b`），新增 WB 账号需要扩白名单 + 厂商版本重新验收（`accounts.ts` 受管门禁）；且隔离画像判 WB 认证槽厂商共享（`mayAddAccounts=false`），注册新 WB 档案会被插件自身校验拒绝。当前每通道仅一个 WB 账号，无第二账号可换。
3. **qoder-intl 通道未动**：`qoder-intl-a` 是唯一国际账号且已注册；其 `targetName` 仍指向已删除的 `qodercli` 目标——只影响「原生登录/状态」入口的解析（`planNativeAuth`），不影响派发；本轮未改（避免碰与本诉求无关的存量数据）。
4. **持久会话的跨账号续问行为未实测**：显式换账号续接已有逻辑会话时，预期被「cwd/账号与冻结绑定冲突」拒绝（tasks.ts 会话绑定复核，这是保护），但我没有真实触发过该拒绝路径；`harness_task_start` 的 accountId 路径也不写 switch-log（切换账本只在 /pool/switch 与自动切换路径记账）——本轮未产生任何 switch 事件。
5. **冷启动一致性未复验**：本轮全部验证在当前活进程内；「宿主重启后同样生效」是基于两处都已落盘的推断，非实测。
6. **配置目录内的登录态有效性未探测**：我未对 `qoder-cn-a/b` 目录跑 `qoderclicn status -o json` 之类的只读身份探测（避免在三个任务运行窗口制造任何厂商子进程）；「账号本身可登」沿用了报告提供的 mtime 证据与 00:35 两卡 completed 的事实。
