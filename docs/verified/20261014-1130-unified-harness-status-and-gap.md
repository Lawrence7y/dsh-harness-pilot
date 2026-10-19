# 统一 Harness 管理层 — 现状、差距、能力矩阵、数据模型、UI 方案与实施顺序（2026-10-14 11:30 实测版）

> 本文是本轮（2026-10-14 10:5x–11:3x）**重新实测**后的交付物 1/2（交付物 2/2 为本轮实施与验收记录，见文末 §7–§9）。
> 纪律沿用 `docs/verified/` 既有口径：不给百分比；「已验证」必须带复核手段；拿不到证据写「未验证」；
> 不把安装成功 / 握手成功 / 身份可读 / 退出码 0 / 界面显示「完成」当行为验收。
> 历史详细取证保留在 `docs/00-verified-status-report.md`（562 KB，2026-10-13–14）与 `docs/verified/*`，本文只写**当前**结论与其出处。

---

## 1. 当前状态（本轮实测，不是旧源码推断）

### 1.1 正在运行的 DSH 与插件

| 项 | 实测值 | 复核手段（本轮） |
|---|---|---|
| 运行中的宿主 | `D:\DeepSeek\DeepSeek Harness.exe`（主进程 + gpu/network/renderer/host 子进程在跑） | `Get-CimInstance Win32_Process` |
| 宿主版本 | `@deepseek-ai/dsh-desktop` **0.2.0-rc.2**（exe ProductVersion 0.2.0.0；rc 号取自 asar 内 dsh 包，见 `docs/verified/host-api-0.2.0-rc.2.md`） | 进程命令行 + 既有 asar 取证（本轮复核进程与安装根未变） |
| CLI 侧另有一份 `dsh` | `@deepseek-ai/dsh` **0.1.7-rc.2**（`~/.workbuddy/binaries/node/versions/22.22.2/dsh`） | `package.json` version —— **不是**运行中的桌面宿主，勿混用 |
| 插件安装来源 | `~/.dsh/profiles/{desktop,web,headless}/node_modules/@dsh-external/dsh-harness-pilot` → **链接到 `D:\Project\dsh-harness-pilot`** | 三处 `src/index.ts` MD5 与工程目录逐字节相同 |
| 插件版本 | `0.1.1`（`/harness-pilot/api/overview` 自报） | live HTTP |
| 运行中的插件代码 | `lib/**/*.js`（41 个服务端模块），`/diag/loaded` **`anyStale=false`、41 模块、0 不可读** | live HTTP（本轮在最终构建后复核） |
| 热重载 | desktop profile `cordis.patch.yml` 的 `hmr.root = ['D:/Project/dsh-harness-pilot']` 已开启 ⇒ 构建 `lib` 后运行进程会重新加载 | 文件 + 本轮构建后 `/accounts/managers` 新路由立即 200 |
| 活动 profile | `desktop` | 主进程命令行 |

**陷阱复核**（用户点名的「不要把本机旧源码当运行版本」）：本机仍存在 `~/.dsh/dist/…`(0.1.1-rc.1)、`C:\dsh\…`(0.2.0-rc.1)、`D:\Project\deepseek-harness-master\…`(0.1.0-rc.8) 三份**非运行**副本，以及 `~/.workbuddy/…/dsh`(0.1.7-rc.2) 这个 CLI 侧入口。本轮结论全部取自运行中 asar 抽出的 rc.2 树 `D:\Project\_dsh-host-0.2.0-rc.2\node_modules` 与 live HTTP/进程实测。

### 1.2 本轮开始时发现的真实缺陷（已修复，见 §8）

1. **构建是断的**：`src/index.ts:4808` 对象字面量重复键 `accountManagers`（两个写者各加一次）⇒ TS1117 ⇒ `scripts/build.mjs` 全断。
   后果：10:49–10:54 写入的 `src/**`（含新模块 `account-managers.ts`）**从未进入运行代码**。
2. **身份离线探针与源码脱节**：`probe/verify-actual-identity-offline.mjs` 只抽取 `dispatch`，而派发逻辑已下沉到 `private dispatchUnleased`（共享槽租约层）⇒ 探针自摆空 stub 报 `this.dispatchUnleased is not a function`。
3. **穷尽清单破洞**：`SELF_MODULES`（`/diag/loaded` 陈旧自检）缺新模块 `account-managers.js`，磁盘 41 vs 清单 40。

### 1.3 已复用、不重写的既有能力（均有历史取证）

派发、任务账本（`.json`/`.log`/`.result.json`，现有 137 条任务记录）、完成回执（`notify/deliverResult`）、会话恢复（原生 resume / 可追溯检查点交接）、进程池（空闲回收、并发闸、所有权实测）、任务身份 `requested/actual` 分离、账号档案 CRUD、四态供应商发现、账号池与自动切换执行侧 —— 全部沿用，本轮**未重写**。

---

## 2. 功能差距（对照本次需求逐条）

### 2.1 已实现且本轮复核有证据

| 需求 | 现状 | 证据 |
|---|---|---|
| 设置页统一 Harness 管理（注册表/入口/版本/通道/启停） | ✅ `settings.section=harness-pilot`，含「Harness 注册表 · 真实入口 / 真实版本 / 通道分级」分区；停用目标显式拒绝派发 | client.js 分区清单；`verify-managed-bootstrap-gate` C 组（disabled 显式拒绝） |
| CLI 路径查看/指定、能力可见 | ✅ `/overview` 逐目标给出 command/commandPath/transport/order/available；ACP/headless/PTY/CDP 分级与降级标注 | `/overview` 实测（agy 例：commandPath=…\agy.cmd，order=[headless,pty]） |
| 供应商/模型四态区分（已配置/可发现/认证有效/实际可用） | ✅ UI 四态徽章与判据文案分开（`configured / discoverable / auth-valid / usable`） | client.js:709-713；`verify-catalog-edit` PASS；`verify-federation-providers` PASS |
| 供应商/模型受约束增删改 + 选择真实生效 | ✅ `/catalog/edit` 只按能力探测允许的范围改；模型经 `modelArgs`/实测 `--model` 注入**真的进 argv**，不能承载则拒绝派发 | `verify-catalog-edit` PASS；`modelArgsFor` 拒绝分支（index.ts dispatch 处） |
| 账号档案：多账号/国内国际并存/登录/状态/退出/一键切换 | ✅ CRUD 12 步 + 9 个拒绝用例；原生认证规格 14 条 | `verify-account-crud` PASS（本轮复跑） |
| 三态认证分离（登录成功/身份可读/模型请求认证有效） | ✅ UI 三态分开渲染并各自带判据说明 | client.js:724-728 |
| 隔离披露（哪些真隔离/哪些厂商共享） | ✅ 每个档案展示隔离边界原文（例如 WorkBuddy：配置目录隔离、**认证存储未随它隔离**，槽位在厂商 `sharedDataPath/auth/<authentication.id>.info`） | 本轮真实任务返回的 account 描述原文 |
| 会话页：模型位改为 Harness→账号档案→供应商→模型 | ✅ 会话控制区已有「Harness（含原生 DSH）/ 账号 / 模型」三级选择 | client.js:1944-1959 |
| 切换真正路由到外部执行引擎 | ✅ 外部 harness 走 `dsh-llm` adapter + 任务派发双链，不改模型名冒充 | `docs/verified/llm-adapter-contract.md`（rc.2 逐行引证） |
| 子代理/团队接入、身份显示、取消传播、失败恢复 | ✅ `harness_spawn_teammate` 唯一权威处 `team-routing.js`；冻结配方（账号+模型）派发；取消 abort 终态如实 | `docs/verified/team-final-acceptance.md` / `…-independent.md` / `verify-team-routing-selfmodules` COVERED |
| 执行卡片/任务详情显示真实身份 + 不一致提示 | ✅ 任务卡渲染 `requested`（请求模型徽章）与 `actual`（仅 `actualSource=transport-outcome` 才显示，否则「无法确认实际模型」+ `legacy-unverified`） | client.js:551-604；`verify-actual-identity-offline` 42 断言 PASS |
| 多账号池（默认/优先级/冷却/额度/自动切换/熔断/上限/退避） | ✅ `account-pool.json` 策略字段齐；自动切换只在启用池内、切换前验证目标、`onModelUnavailable:stop` 不静默换模型 | `verify-quota-pool` PASS；`verify-auto-switch-executor` PASS |
| 账号切换事件可追溯（原因/前后脱敏账号/时间/恢复方式/结果） | ✅ `switch-log.json` 每条含 scope/from/to(脱敏)/reason/recovery/boundary/result/trigger/modelPreserved | 磁盘 switch-log 实测 |
| 已完成操作不重复执行 | ✅ 冷恢复核验实际状态（`bind.written → bind.kept`，逐 id 计数只 +1 新投递） | `team-final-acceptance-independent.md` ⑦ PASS |
| WorkBuddy 受管启动适配整合进插件 | ✅ 适配器随包 `assets/workbuddy-managed.cjs`（sha256 `3032e84f…` 与验收件一致）+ 配方映射（`workbuddy-a→wb-managed-a` 等）+ **执行前门禁**（适配器 sha256 + 厂商 CLI `--version` 实测 2.156.0 前缀，不通过在任何副作用前显式拒绝） | `verify-managed-account-alias-offline` 96 断言；`verify-managed-bootstrap-gate` 16/16（含 C3 诊断带「实测 2.156.0 / 期望前缀」） |
| 2 WorkBuddy + 2 Qoder 并发真实任务 | ✅ **本轮两次 PASS**（最终修订上为第 2 次）：四路唯一标记、非空回复、互不含他人标记、四个执行身份、终态 completed | `probe/verify-concurrency-acceptance.mjs` 2026-10-14 11:2x 输出（wb ACP×2 + qoder headless×2） |

### 2.2 未验证 / 受上游限制（明确不冒充）

| 项 | 状态 | 边界 |
|---|---|---|
| 真实额度耗尽触发的自动切换 | **未验证（注入测试）** | `verify-auto-switch-executor` 的切换全部 `evidenceKind=injected`（结构化错误注入）；真实额度耗尽无法安全复现，**不冒充真实实测** |
| 团队成员「自发通信 → 影响行为」 | **部分成立/整体 FAIL（上游模型行为）** | 通道✅到达✅，但「照做式影响行为」仅 1 次，其余被模型以 prompt injection 拒绝 —— 不改判据凑绿，见 `team-final-acceptance-independent.md` ⑤ |
| 关闭桌面应用 / 整机重启后的执行 | **未验证** | 受管适配器复用厂商桌面安装与原生认证槽位，桌面卸载/重启场景未测 |
| 令牌到期刷新 / 退出登录后恢复 | **未验证** | 仅有「CLI 进程重启后登录恢复」已验证（新进程多轮，`verification.json` managed2/3/4） |
| 内存收益（WebUI vs 桌面） | **未验证** | 有完整进程集合的观测面（`/diag/processes`、`/diag/processpool`、`verify-idle-release.ps1`），但**没有**做完整进程集合的空闲/并发/任务后内存对比测量，不下结论 |
| Buddy Switch / agy-switch 外部账号管理器 | **接线完成、厂商采纳未验证** | `/accounts/managers` 自报 `cliAdoption:"unverified"`；仅允许 `http://127.0.0.1:port` 与 `agy-switch.exe` 绝对路径，占用不明确时**拒绝**切换 |
| WorkBuddy 任意数量同区域多账号 | **明确不支持** | 厂商认证槽位为共享存储（两个应用两个槽位）；配置目录隔离 ≠ 认证存储隔离 |
| Qoder CN IDE 内置 `QoderCN.exe` | **不可直接当聊天 CLI** | 它是 IDE 服务后端（历史实测），不纳入派发目标 |

---

## 3. 接口与能力矩阵

### 3.1 DSH 原生接口 × 本插件用途（全部按运行中 0.2.0-rc.2 契约）

| 原生接口 | 用途 | 状态 |
|---|---|---|
| `ctx.llm.registerAdapter / llm/stream`（`@deepseek-ai/dsh-llm`） | 会话模型位的 Harness/账号/模型选择 → 真路由到外部 CLI | VERIFIED（`llm-adapter-contract.md` 逐行引证 rc.2） |
| `@deepseek-ai/dsh-subagent` + `harness_spawn_teammate` | 外部 CLI 作子代理与团队成员；冻结配方派发 | VERIFIED（`team-routing.md`、`team-final-acceptance*`） |
| `@deepseek-ai/dsh-tools` | `harness_*` 工具面（list/dispatch/task/status…） | VERIFIED |
| webServer 路由（`registerApiRoute` + `ctx.effect` disposer 语义） | `/harness-pilot/api/*` 设置页/写接口/探针 | VERIFIED（disposer 语义坑已修，见 00-报告 §1.5） |
| `settings.section` / `settings.plugins.tab` | 设置页入口（`Harness 管理` order 30；插件页 tab order 40） | VERIFIED（client.js 资源树注册） |
| `dsh-hmr`（`hmr.root`） | 构建后热重载（**也会打断在途任务** ⇒ 构建前必须确认无在途任务） | VERIFIED（本轮实测） |
| credentials/原生认证（各 CLI 自己的） | 登录/退出/三态验证入口，只做「原生入口 + 状态读取」，不落明文 | VERIFIED（14 条原生认证规格，各带实测出处） |

### 3.2 传输通道分级（按真实能力，降级必标注，绝不静默重复派发）

| Harness | 首选 | 降级 | 备注 |
|---|---|---|---|
| Claude Code / Codex / OpenCode / Qoder CN / Pi | ACP / headless（`-p/--print`） | PTY | Qoder CN 实测 headless 稳定（本轮 2 账号并发） |
| WorkBuddy / WorkBuddy.AI（内置 CodeBuddy CLI 2.156.0） | **ACP**（经 `assets/workbuddy-managed.cjs` 受管 bootstrap） | headless `-p` | 依赖厂商内部发布模块 + 一次性命名管道；**执行前门禁**实测版本与适配器哈希 |
| Antigravity（agy 1.2.12） | headless `-p` | PTY | 模型目录来自登录后实时发现（14 项），非静态清单 |
| GUI/CDP 类目标 | — | CDP/窗口级（明确标注降级） | 仅窗口级操控需要 python 运行时 |

### 3.3 团队角色能力（真实能力，不用角色名冒充）

| 能力 | 归属 | 证据 |
|---|---|---|
| 主控 + 委派其他 CLI | DSH 原生（`harness_spawn_teammate` 冻结配方） | team-routing 实测 |
| 执行成员（独立会话 + 运行记录） | 全部接入的外部 CLI | 每成员独立原生会话 id + 轮次计数（独立验收 ④：A 到第 7 轮） |
| 成员间通信 | MCP 桥接（stdio 安全代理，零明文令牌四处扫描） | `mcp-bridge-stdio-proxy/report.json` 37/37 |
| 取消传播 / 失败恢复 | abort 终态如实 + 冷恢复核验实际状态 | 独立验收 ⑥⑦ PASS |

---

## 4. 账号及会话数据模型

### 4.1 账号档案（`~/.dsh/plugins/harness-pilot/harness-accounts.json` + `~/.dsh/harness-accounts/<id>/`）

```ts
AccountSeed {
  id: 'workbuddy-a' | 'workbuddy-ai-b' | 'qoder-cn-a' | …   // 档案 id（UI 一律脱敏为 acct:…）
  harnessId: 'wb-managed-a' | 'qoder-cn-acct-a' | …          // 目标别名（= 执行身份）
  region: 'cn' | 'intl'                                      // 服务区域（国内/国际并存）
  configDir: '…/.dsh/harness-accounts/<id>'                  // CLI 配置目录（真隔离）
  authRef: { kind: 'native', authenticationId: string }       // 原生认证引用（**不复制、不导出**）
  launch: { mode: 'managed-bootstrap' | 'plain',             // WorkBuddy 走受管 bootstrap
            bootstrap?: { adapterId, vendorExecutable, requiresVendorVersionPrefix: '2.156.0' },
            env: Record<string,string> }
  provider?/model?: 默认供应商与模型（冻结进任务）
}
```

- **真隔离**：`configDir`（会话/日志/项目目录）、进程 env、任务账本、切换日志。
- **厂商原生共享**：WorkBuddy 两应用的认证槽位（`sharedDataPath/auth/<authentication.id>.info`，`workbuddy-desktop` / `workbuddy-desktop-ai`）——UI 每个档案都明示这条边界。
- **凭据从不**：复制未解密认证文件 / 关闭加密 / 明文进配置与日志（四处零明文扫描见 mcp-bridge 报告）。

### 4.2 账号池（`account-pool.json`）

```ts
Pool {
  autoSwitchEnabled: boolean
  policy: { maxSwitchesPerTask, backoffBaseMs, backoffFactor, maxConsecutiveFailures,
            onModelUnavailable: 'stop' }        // 不能保持原模型 ⇒ 停止并提示，不静默换模型
  entries: { [accountId]: { enabled, priority, cooldownMs } }   // 自动切换只在 enabled 集合内
}
```

- 额度状态三值：`available / exhausted / unknown`；只有**原生额度接口**或**明确结构化错误**才判耗尽；网络错误/认证失效/普通故障/短暂限流 ⇒ `unknown`，**不触发**切换（`verify-bridge-skip-throttle`、`quota-error-observations.md`）。
- 并发协调：共享槽读写租约（`ManagerSlotLeases`：读多写一、占用期间拒绝切换）、`switchlog` 追加、熔断（连续失败上限）全池不可用 ⇒ 任务暂停并提示恢复条件。

### 4.3 任务与会话身份（requested / actual 分离）

```ts
Task {
  requested: { harnessId, accountId(脱敏), provider, model }   // start/track 时冻结，之后不可变
  actual:    { harnessId?, accountId?, provider?, model?, nativeSessionId? }
  actualSource: 'transport-outcome' | 'legacy-unverified'      // 只有原生 outcome 才算实际值
  mismatch: string[]                                            // 请求 vs 实际偏差提示；未知不判一致
  switchEvents: [{ reason, from, to, at, recovery, result }]    // 账号切换事件（脱敏）
}
```

- 配置值 ≠ 运行值时：卡片显示「存在偏差」；未回报项显示「无法确认实际模型」；旧账本降级 `legacy-unverified` 且**原文件不改写**。

---

## 5. UI 改动方案（当前实现 vs 仍需做）

| 位置 | 状态 | 内容 |
|---|---|---|
| 设置页「Harness 管理」 | ✅ 已实现 | 六个分区：注册表（真实入口/版本/通道分级 + 启停）、账号档案（CRUD/原生登录退出/三态/隔离披露）、供应商与模型（四态两栏）、账号池（额度/优先级/冷却/一键切换/自动切换侧）、进程与内存（完整进程集合）、插件设置 |
| 会话页模型位 | ✅ 已实现 | 选择顺序：Harness（含「原生 DSH」）→ 账号档案 → 供应商/模型；权限模式、推理档位按各 Harness 真实能力出选项 |
| 子代理/团队页 · 执行卡 · 任务详情 | ✅ 已实现 | 显示 harness、脱敏账号、供应商、模型、原生会话 id、执行状态；请求/实际不一致提示；`external`/`harness` 这类笼统标签已不存在于任务卡身份行 |
| 账号切换事件在会话/子代理/团队详情可见 | ✅ 已实现 | switch-log 按 scope（session/subagent/team）投影 |
| 仍需打磨 | ⬜ | ① 设置页里「额度未知」的说明文案与原生额度接口出处逐 Harness 落齐（部分 harness 无额度接口 ⇒ 恒为「未知」，需逐条注明原因）；② 切换事件时间线的图形化（当前为列表）；③ 「任务级切换」显式操作按钮的引导文案（能力已在 `/pool/switch`，入口文案待补） |

---

## 6. 分阶段实施顺序（后续轮次）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P-收尾 | 本轮已做（见 §8）：构建修复、探针修复、穷尽清单、最终修订上四路并发复跑 | — |
| P-next-1 | 真实额度/认证失效场景的**现场取证**（现为注入测试）；额度接口缺失的逐 Harness「未知」原因落文案 | 上游提供可复现额度事件或明确结构化错误 |
| P-next-2 | 团队成员通信「影响行为」判据复跑（现 FAIL-部分成立，属模型行为边界）；不改判据凑绿 | 模型行为 / 上游 |
| P-next-3 | 内存测量：完整进程集合（含厂商守护进程）在空闲/四路并发/任务结束三时点的实测对比 | 可重复的负载脚本 |
| P-next-4 | Buddy/agy 外部账号管理器采纳验证（`cliAdoption: unverified → verified`） | 厂商/本地管理器 |

---

## 7. 本轮实施记录（2026-10-14 10:5x–11:3x）

1. **修复 TS1117**：`src/index.ts` `createApiHandler` 参数对象重复键 `accountManagers`（双写者冲突）→ 只保留一处。构建恢复。
2. **修复身份探针**：`probe/verify-actual-identity-offline.mjs` 抽取 `dispatch`+`dispatchUnleased`（含 `export` 前缀修正），stub `this` 携带真实 `dispatchUnleased` —— 断言数保持 42，不放宽任何判据。
3. **穷尽清单补洞**：`SELF_MODULES` + `src/processpool.ts` 计数说明同步为 **41 项**（新增 `account-managers.js`）。`verify-team-routing-selfmodules` 由 NOT-COVERED → **COVERED**。
4. **统一构建**：`scripts/build.mjs`（rc.2 运行树依赖）→ `lib/**` 全量；构建前确认任务账本无在途任务（411 条记录仅 error/completed/timeout/aborted）。
5. **热重载生效核验**：新路由 `/accounts/managers` 200；`/diag/loaded` **anyStale=false、41 模块**。

## 8. 本轮验收证据（全部为最终修订上的复跑）

| 套件 | 结果 | 性质 |
|---|---|---|
| `verify-managed-bootstrap-gate` | **16/16 OK**（门禁真的被派发前咨询；拒绝不声明实际身份；诊断含「实测 2.156.0/期望前缀」） | 离线 + 行为缝 |
| `verify-managed-account-alias-offline` | **96 断言 PASS**（planning-only，明确「≠ 模型调用成功」） | 离线 |
| `verify-actual-identity-offline` | **42 断言 PASS**（requested/actual 分离、legacy 文件不改写） | 离线 |
| `verify-federation-{identity,accounts,providers,registry}` | **PASS×4** | 离线 |
| `verify-catalog-edit` / `verify-quota-pool` | **PASS×2** | 离线 |
| `verify-auto-switch-executor` | **PASS**（切换事件均标 `evidenceKind=injected`） | 注入测试 |
| `verify-account-crud` | **PASS**（12 步 CRUD + 9 拒绝用例 + 14 条原生认证规格） | live HTTP |
| `verify-managed-account-real-task` | **REPLIED**（`PONG`，completed，`wb-managed-a` 真实受管链路） | 真实模型调用 |
| `verify-concurrency-acceptance` | **PASS×2**（2 WB + 2 Qoder 四路并发，唯一标记、非空回复、四身份、终态 completed） | 真实模型调用 |

> 判定纪律重申：以上「PASS」均以**非空真实回复 + 正确执行身份 + 任务终态 + 独立核验**为准；
> 安装/握手/身份可读/退出码 0/界面「完成」**均未**计入通过。

## 9. 回滚说明

- **基线**：`D:\Project\_dsh-baseline\dsh-harness-pilot-P40-account-managers-prebuild-20261014-111200.zip`（本轮改动前快照，1.4 MB，含 src/lib/client/assets/scripts/package.json/cordis.patch.yml/tsconfig）。
  上一可用基线：`…P39-headless-exit-and-usable-evidence-20261014-000842.zip`。
- **回滚步骤**：① 停止插件在途任务（`/task/cancel` 或等账本无 running）；② 解压 P40 覆盖 `D:\Project\dsh-harness-pilot`；③ `node scripts/build.mjs` 重建 `lib`（或直接使用 P40 内的 lib）；④ 依靠 HMR 或重启 `DeepSeek Harness.exe`；⑤ `/diag/loaded` 确认 anyStale=false。
- **不动的东西**：`~/.dsh/plugins/harness-pilot/**`（任务账本/账号池/切换日志/绑定）与 `~/.dsh/harness-accounts/**`（账号配置目录）**本轮零写入**，历史会话与账本保留；厂商安装与原生认证存储未被修改。
- **本轮源码改动清单**（可单独逆向）：`src/index.ts`（重复键删除 + SELF_MODULES+注释）、`src/processpool.ts`（计数说明）、`probe/verify-actual-identity-offline.mjs`（探针结构修复）。其余 src 为本轮之前写者留下的已完成工作，一并构建。

## 10. 三态清单（务必按此对外表述）

- **已完成**：§2.1 全部条目 + §8 全部套件。
- **未验证**：真实额度耗尽自动切换、关闭桌面/整机重启、令牌到期刷新、内存收益、Buddy/agy 管理器厂商采纳、WorkBuddy 多于其认证槽位数的多账号。
- **受上游限制**：团队成员通信「影响行为」（模型以 prompt injection 拒绝，判据不放宽）、WorkBuddy 内部协议随厂商升级需重新验收（门禁会**明确失败**而不是静默跑偏）、Qoder CN IDE 内置服务后端不可作聊天 CLI。
