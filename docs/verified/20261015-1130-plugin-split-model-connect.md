# 插件拆分：dsh-model-connect 独立插件 + harness-pilot 清理（2026-10-15 11:3x 实测版）

> 用户需求（2026-10-15 澄清后）：
> ① WorkBuddy 与 Qoder（账号接入）从 dsh-harness-pilot 拆出，成为**独立插件**；
> ② Antigravity 从插件删除——**先验证能否实现账号切换**：能则进新插件，不能则只用 call-agy 技能；
> ③ 已从本系统卸载的 harness 一并删除；只保留 DeepSeek harness **原生调用不了**的外部 harness。
> 本轮由上一轮（connect 迁移，Codex 实施）的现场直接续做；判定纪律不变。

## 1. Antigravity 账号切换可行性 → **不可行，走 call-agy 技能**

既有实测（`probe/out/agy-isolation.json`，2026-10-13）：agy CLI 无 login/logout/status 子命令；
`ANTIGRAVITY_EXECUTABLE_DATA_DIR` / `XDG_CONFIG_HOME` 两个候选数据根开关实测 **INEFFECTIVE**
（全新目录零文件、目录与基线逐项相同）⇒ CLI 级多账号不可行；其上游协议无 WorkBuddy 那样的
OpenAI 兼容接缝。**结论：不进插件**；Antigravity 任务走 call-agy 技能（冒烟 PASS 在档：
`AGY-SKILL-MIGRATION-OK`）或 agy headless。

## 2. 两个插件的最终边界

| | dsh-harness-pilot（清理后） | dsh-model-connect（新） |
|---|---|---|
| 职责 | DeepSeek 原生调不了的 **CLI/桌面型 harness** 桥接 | WorkBuddy / WB.AI / Qoder 双区 **账号型模型**（复用桌面登录态 → 上游 API 直连） |
| 目标/分组 | 16 目标 / 11 组：claude, codex, command-code, cursor, grok, kimi, mimo, mimo-cli, minimax, opencode×4, pi, zcode×2 | 4 条 provider：harness-workbuddy-cn/intl、harness-qoder-cn/intl |
| 已删除 | WB/Qoder/agy 全部目标与种子、gemini/grok-cli/mimo-ai/qwen（未安装）、Buddy/agy 管理器面、BuddyQuota 卡、隔离账号面板、connect 旧接线 | — |
| 账号 | 无内置种子（自定义登记表保留但无目标可派） | DPAPI 多账号库（本机 4 账号全部 ready） |
| 号池/额度切换 | CLI 通用池机制保留 | `PoolAdapter` 会话粘滞 + 仅结构化额度耗尽切换（autoSwitchEnabled:true, maxSwitches:2） |

**live 实测**（拆分后重启两次的最终宿主）：connect 四账号 ready，模型 18/24/14/1，积分 2222/449 实读；
harness-pilot 目标 16、分组 11、WB/Qoder/agy 零残留；`/diag/loaded anyStale=false`。

## 3. 用户三点反馈的处置

1. **model-connect 独立设置页**：新插件 client 注册 `settings.section`（id `model-connect`，
   label「API 模型连接」，order 35，紧邻「外部 harness 管理」）——账号导入/启停/刷新/删除、
   号池与额度切换配置、账号池事件、会话头部执行身份徽章（含账号标签）。
2. **行头 0 个模型 bug（已修）**：根因 = 落盘模型目录缓存 **6 小时 TTL** 过期后被按「不新鲜」丢弃，
   后台预热完成前概览/行头就是 0，且页面不会自己变。修复：行头计数改用与原生选择器同源的
   `group.picker.total`（服务端同一份合并实现），并在「有目标但全部组 0 模型」时**自动补拉**（15s/35s）。
   实测预热后计数：claude 7 / codex 7 / mimo 66 / opencode 483 / pi 98。
3. **单模型显示控制（已恢复完整交互）**：Codex 在收尾时把它退化成只读目录 + POST 一律 409
   （配合「外部模型仅供子代理」一刀切隐藏）。按用户最新指示**恢复**：`/model-visibility` POST
   完整语义回归，`listModels` 恢复按 `pickerVisibility` 过滤（整组隐藏 / 组内隐藏 / 上限 / cli-default 显隐），
   一刀切的 conversation-model-policy 从本插件移除（model-connect 保留它自己的）。端到端实测：
   hide → 宿主目录即时少一组；limit=3 → 该组只报 cli-default+3；reset → 复原。
   UI：每条 harness 展开体首块「选择器显示」——整组开关 + 上限 + 逐模型勾选 + 恢复默认。

## 4. 拆分中的关键坑（如实记录）

- **bundle 只贡献 patch 层**（组合从空根开始）：插件的 plugin 行必须由 bundle 自己的
  `cordis.patch.yml` `- insert:` 挂载；纯注释文件会让宿主报「must be a top-level YAML array」并
  **跳过整个 bundle**。
- **vendor 链解析**：新插件 node_modules 必须链齐 vendor 所需宿主包（dsh-atomic-write /
  dsh-home-paths / dsh-attachment / dsh-settings / dsh-host-webserver / dsh-llm-pi-ai /
  dsh-llm-retry / @earendil-works/pi-ai——最后者在宿主树缺失，链到 harness-pilot 的
  work/api-migration 副本，0.87.1 与内核同约束；rc.2 抽取树根也补了同名 junction）。
- **DPAPI 执行器**：Mimosa 安全扫描要求进程 spawn 全字面量 ⇒ 改为随包 `.ps1` 脚本文件 +
  `-File <字面量>` + 载荷走 stdin（`vendor/dpapi/`，密文格式与旧库一致，DPAPI 库文件直接复用）。
- **数据迁移**：`~/.dsh/plugins/harness-pilot/connect-api` → `~/.dsh/plugins/dsh-model-connect/connect-api`
  整目录复制（DPAPI 绑定用户/机器，与路径无关）——4 账号 + 目录缓存原样可用。

## 5. 验收证据

| 项 | 结果 |
|---|---|
| dsh-model-connect 独立探针（从 pilot 迁入并适配） | `verify-connect-pool` PASS（顺带修复重写引入的 identity 守卫反转 bug）、`verify-connect-settings` PASS、`verify-connect-wire-failover` PASS |
| 独立服务冒烟（零宿主） | `createConnectService` + `initialize()`：4 账号 ready、目录齐全 |
| pilot 全量回归 `probe/_regression-suite.mjs` | **21/21 PASS**（摘除 5 个绑死已迁出特性的条目并注明；修复 harness-groups / harness-llm-providers / ui-smoke / model-options / quota-pool / federation-accounts / visibility-isolation 的过期断言） |
| 可见性端到端 | hide → `/llm-adapter` 目录即时少组；limit=3 → 只报 cli-default+3；reset 复原（live HTTP） |
| model-connect live | `/model-connect/api`：4 账号 ready + 积分实读（= 真实上游 API 连通） |
| 会话菜单 | 外部模型恢复进入会话选择器（按可见性配置过滤），直选外部模型不再被 409 拦截 |
| 快照 | P44 双快照（pilot post-split 29MB + model-connect initial 363KB） |

## 6. 未验证 / 边界

1. **真实模型对话**（chatStream）在拆分后的新插件上未重跑——同一 vendored 代码（sha 锚定）在
   拆分前有 4 条线的真实子代理执行证据（`probe/out/connect-runtime-final.json` / `native-api-connections-live.json`）；
   拆分只改了宿主挂载方式，不改 wire 路径。如需绝对确证可在 DSH 里开一次子代理对话。
2. 桌面版（CDP/窗口）派发通道本轮未重测——代码零改动，此前各轮已验收；GUI 目标（cursor/grok/mimo/minimax/zcode/opencode-desktop）仍在目标表。
3. 真实额度耗尽触发的自动切换仍未实测（继承上轮口径：合成故障转移 PASS，真耗尽取证待自然发生）。
4. harness-pilot 深层孤儿代码（provider.ts 受管门禁函数、sessions 的 WB 鉴权记录、workbuddy-isolation.ts、
   account-managers 的 buddy/agy 槽）**保留但不可达**（无种子/无目标使其永不触发）——为不动共享派发路径
   而留；如需物理删除建议单独一轮做。
5. profile 的 `subagent-model-selection-settings.allowedModels` 里 connect 条目仍指向原账号 id ——
   这些 id 在新插件里不变（DPAPI 库迁移保 id），白名单继续有效。

## 7. 回滚

- P44（本轮后）：`dsh-harness-pilot-P44-post-split-*.zip` + `dsh-model-connect-P44-initial-*.zip`
- P43（拆分前）：`dsh-harness-pilot-P43-pre-split-20261015-090031.zip`
- 回滚 pilot：P43 覆盖 → `node scripts/build.mjs` → HMR；同时从 profile `package.json` 的
  `dsh.profile.bundles`/`dependencies` 移除 `@dsh-external/dsh-model-connect` 并重启宿主。
- 回滚 model-connect：`set_bundle` 停用或从 bundles 移除；账号库目录独立，删除即清账号。
