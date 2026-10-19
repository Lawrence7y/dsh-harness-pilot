# 2026-10-14 17:4x–18:1x · 第四轮：会话模型菜单瘦身（734 → 106）+ 逐条核对用户 5 项要求

> 用户本轮把要求重排了优先级，并明确「额度耗尽自动切换**暂时不做**」——本轮起不再把它当缺口。
> 判据纪律不变：**能列出来 ≠ 能选 ≠ 选了真生效**；每一条都要有实测。

## 0. 逐条核对（先说结论，再说证据）

| 用户要求 | 现状（本轮实测） |
|---|---|
| 统一管理多个 harness CLI | **已有**：35 个目标，含 Claude Code / Codex / Antigravity / Qoder / WorkBuddy / ZCode / OpenCode / Pi … |
| **优先解决这几个 CLI 不提供模型列表的问题** | **已解决**（上一路落地，本轮核对）：Claude Code 出 `sonnet/opus/haiku/opusplan`（来源标注为官方别名文档）；Codex 出 7 个（读 `config.toml` 当前模型 + `models_cache.json` 的 slug）；WorkBuddy 出 4 个别名；ZCode 出原生 `provider.models`。证据在原生菜单里直接可见（见 §2 截图） |
| 设置中看到部分 CLI 供应商模型的**完整列表** | **已有**：`供应商与模型` 栏；本轮明确它是**不受会话上限影响**的完整清单 |
| Qoder / WorkBuddy / Antigravity 只管理登录账号 + 切换 | 管理器面板已存在（`AccountManagersPanel`）；**额度卡**为本轮新增（见上一轮报告） |
| 1. 多账号隔离 | 已披露：Qoder 两档案配置目录 + `.auth/` 均隔离（实测身份不同）；WorkBuddy **配置目录隔离 ≠ 认证存储隔离**（厂商共享槽），界面逐条写明 |
| 2. 独立账号并行（仅 Qoder / WorkBuddy 的国内版 + 国际版） | 已登记 `qoder-cn-a/b`、`qoder-intl-a`、`wb-managed-a`、`wb-managed-ai-b`；**这些目标可以不被用户在会话里主动选择**（作为绑定目标存在） |
| 3. 模型调用：能由 DSH 模型选择并作为独立子代理执行 | 会话侧**本轮实测可搜可选**（§2）；子代理侧走 `pilot-cli` 路由 |
| 4. 每个子代理会话页面显示「哪个外部 CLI + 哪个模型」 | `HarnessSessionIdentity` 注册在 `conversation.session.header.utilities`，仅当路由为外部时显示 `harness · model` 徽章。**本轮未做端到端截图验收** |
| 5. 额度耗尽自动切换 | **用户明确暂缓** —— 本轮起不再列为缺口 |
| UI：会话选模型「改得太乱了，先切回原版」 | **已经是原版**（本轮实测：composer 无任何插件控件，原生 `模型 / 推理等级` 弹层 + 搜索框）。**乱的是菜单内容**，见 §1 |
| UI：给用户选 CLI + 它的模型的权利 | **本轮实测成立**：原生选择器搜 `Claude Code` → 精确筛出该 CLI 的 5 个条目（§2） |
| UI：设置页「外部 harness 管理」太乱 | **未做**。留给下一轮（§4） |

## 1. 「太乱」的真实根因：模型目录被灌了 734 条

**不是** composer 的控件乱 —— 是**菜单内容**乱。根因在 `src/llm-adapter.ts`：

```ts
// 上一路的写法（理由：「原生选择器可搜索，不得静默截断」）
export const MAX_MODELS_PER_TARGET = Number.POSITIVE_INFINITY
```

`listModels()` 对**每个目标**推送它的**全部**模型 ⇒ 本机实测 **734 条扁平条目**
（Pi 98 + OpenCode 486 + …），而且这些条目还跟 DeepSeek 自己的 provider 挤在同一个菜单里。

**修复（本轮）**：改成**可配置**上限，并明确切分口径 —— 这正是用户要求的「两面」：

| 面 | 行为 |
|---|---|
| **会话模型菜单** | 每目标只列前 N 个（`sessionModelLimit`，**默认 10**，0 = 不限） |
| **设置 → 供应商与模型** | **完整清单**，**不受该值影响** |
| 截断**不静默** | 被截目标的「（默认模型）」条目描述里写明：`本目标另有 N 个模型未在会话菜单列出（会话菜单每目标只列前 10 个）—— 完整清单见 设置 → 外部 harness 管理 → 供应商与模型` |

改动点：`settings.ts`（新字段 + 默认 10 + 钳位 0–2000）、`llm-adapter.ts`（deps 新钩子 `sessionModelLimit`
+ `listModels` 按目标截断并写明）、`index.ts`（把 `runtimeSettings.sessionModelLimit` 接进去）、
客户端 `SettingsForm`（新增一行可调）。

**实测结果**：`pilot-cli` 目录 **734 → 106** 条。

| 目标 | 条目数 | 说明 |
|---|---|---|
| `pi` | 11 | 默认 + 前 10 |
| `opencode` | 11 | 默认 + 前 10 |
| `codex` | 8 | 默认 + 7（全部） |
| `claude` | 5 | 默认 + 4 个别名（**全部，未截断**） |
| `wb-managed-a` | 5 | 默认 + 4 个别名（全部） |

## 2. 决定性验证：CLI 模型**搜得到、选得到**

原生模型选择器（原版 UI，带搜索框、按 provider 分组）。在搜索框输入 `Claude Code`，实测筛出：

```
外部 CLI（pilot-cli）
  Claude Code（默认模型）
  Claude Code · sonnet
  Claude Code · opus
  Claude Code · haiku
  Claude Code · opusplan
```

截图：`probe/out/session-model-menu-round/S1-search-claude.png`
（另一张 `M2-submenu.png` 是未搜索时的分组视图：`Pi（默认模型）` / `Pi · …` 共 10 条、
`Codex · …`、`Claude Code · …`、`gemini（默认模型）`、`qwen（默认模型）` …）

⇒ 「目前只能使用原生 DeepSeek harness 的模型」这条**不再成立**：外部 CLI 及其模型
在原生选择器里可搜索、可选中，且**不再是 734 条的无序长列表**。

## 3. 回归（本轮实测）

| 探针 | 结果 |
|---|---|
| `verify-llm-adapter-live` | **PASS** —— `anyStale=false`；目录 **106** 条；部署默认仍是 `opencode-go/deepseek-v4.1-flash`（未被改写）；真实选择器入口 `profileUnchanged=true` |
| `verify-buddy-quota-offline` | **PASS** |
| `verify-actual-identity-offline` | **PASS**（42 断言） |
| 浏览器 `search-model`（本轮新增） | **PASS** —— 搜 `Claude Code` 命中该 CLI 的 5 个条目 |

三工件一致：`client/client.js` = `client.js` = `lib/client.js`（`858704563cc774d6…`）。

## 4. 下一轮（按用户优先级）

1. **设置页 UI 重做**（用户点名的最后一项）：现在「外部 harness 管理」仍是「一个目标列表 +
   三个分栏 + 一堆折叠说明」，信息平摊。目标形态：
   - 左侧窄列表选 harness（只显示名字 + 状态点），右侧只放**该 harness 的一屏**：
     登录账号 / 供应商与模型 / 入口与版本；
   - 说明性文字全部收进 `<details>`，每屏默认只留结论行；
   - 贴合原生 DSH 设置的行高、字号、分隔线，不再用自绘卡片边框。
2. **子代理会话页面的身份徽章端到端验收**（要求 4）：用一个真实外部路由的会话截图证明
   页面上确实出现「哪个 CLI + 哪个模型」。
3. **Qoder / WorkBuddy / Antigravity 收窄为「登录 + 切换」**：把这三家的设置面只保留账号相关项，
   其余（诊断、供应商发现细节）收进高级区。

## 5. 回滚

- 本轮回滚点：`.bak-buddyquota-20261014-170903/`（含本轮改动前的 `src` + `lib`）。
- 只回滚本轮：把 `settings.ts` 的 `sessionModelLimit` 与 `llm-adapter.ts` 的截断逻辑还原，
  或在设置页把「会话模型菜单每 CLI 列出上限」设为 **0**（= 恢复全部列出，**不需要改代码**）。
- 服务端改动靠 HMR 已生效（实测 `anyStale=false`、44 模块）；彻底生效仍建议重启一次 DSH。
