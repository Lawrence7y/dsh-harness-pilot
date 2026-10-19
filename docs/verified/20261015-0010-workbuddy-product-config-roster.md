# 2026-10-14 · 第十七轮：WorkBuddy 完整名册接入（参考 GitHub 同类实现后的选择）

## 1. 用户给的仓库与检索结果

**先纠正一条**：用户给的 `Ebony-Vinyl/dsh-our-free-model`（DSH 免费模型网关插件）**全源码没有一处提到 workbuddy/codebuddy**
（git 归档 grep 0 命中）—— 它与 WorkBuddy 无关。它有两条值得抄的思路：
① 「选择器只广播**可用**模型」+ 被网关拒的模型移出下拉、只在设置页留拒因，且区分「网关 5xx/429/超时**不算**对模型的判定」；
② 思考强度用**输出 token 预算**（2048/8192/模型上限，思考不可关的模型翻倍）+ 每张模型卡标注实际下发上限。

**真正的 WorkBuddy ↔ DSH 仓库**（GitHub 网页检索 + search API；`web_search` 通道当时 401 不可用）：

| 仓库 | ★ | 路线 |
|---|---|---|
| `corrinehu/dsh-workbuddy-connect` | 851 | 复用桌面 App 登录态；CN/INTL 两个分组；积分速览；模型显隐**按账号分别保存** |
| `dingminhua/dsh-connect-workbuddy` | 124 | 双 provider（`workbuddy` / `workbuddy-global`）；账号池；可整体摘除某版供应商；模型可用性测试（真发 ~25k 请求） |
| `ardeyouxipianyi/workbuddy2api-hub` | 1282 | Python 网关：OAuth 加号 / **Windows 从运行中客户端导入（加密 token 就地解密）**；设备指纹隔离；限额护栏 |
| `Ianzhyh/workbuddy-to-dsh` 15 · `dsh-plugin-lab/dsh-workbuddy-bridge` 8 · `ChaYeWuu/dsh-hyperworkbuddy` 4 · `chengzhi-c/dsh-wtq-pool` 1 · `AndroidSix/dsh-multi-router` 1 · `evlon/dsh-codebuddy-models` 0 | | 多为本地 OpenAI 兼容端点 + 账号池 + 自动换号 |

**共同架构**：本机 `127.0.0.1` HTTP shim + `ctx.llm.registerAdapter` + **直连厂商 HTTP**
（`/v2/enterprises/personal/models` 拉名册），凭据来自桌面客户端（导入 token / OAuth / 粘贴）。
⇒ 它们是「**持有 token 的网关**」，本插件是「**起 CLI 子进程的适配器**」。
所以它们能列出完整名册并做多账号；本插件上一轮说的「WorkBuddy 认证槽厂商共享 ⇒ CLI 路线同区域不能真多账号」**对 CLI 路线仍然成立**。

**用户选择：A —— 不碰凭据，先把「官方模型缓存」接上。**（B 走网关/读 token、C 两者都做，均未选。）

## 2. 本机实测：名册一直在，只是插件从没读它

```
~/.workbuddy/cache/acc-product-config-v3.json      models[] = 55   endpoint=workbuddy.cn   isDefault=fast-model
~/.workbuddy-ai/cache/acc-product-config-v3.json   models[] = 30   endpoint=workbuddy.ai   isDefault=default-model
每条字段：id / name / vendor / isDefault / maxInputTokens / maxOutputTokens /
          supportsToolCall / supportsReasoning / supportsImages / credits / relatedModels
```
插件源码 grep `acc-product-config` = **0 处引用** ⇒ 需求 ② 的「官方模型缓存」这一级从未接上，
「模型数量不全」的根就在这里。

## 3. 本轮实现（只读 `models`，绝不碰凭据）

| 位置 | 改动 |
|---|---|
| `src/types.ts` + `src/config.ts` | 目标新增 `productConfigFile`；`wb-managed-a` → 国内那份、`wb-managed-ai-b` → 国际那份（**按目标显式指定**，不靠猜） |
| `src/native-model-catalog.ts` | 新增 `readProductConfigRoster()`：**只取 `models` 数组**，每个条目走白名单字段（id/name/vendor/isDefault/max*Tokens/supports*/relatedModels）；名册 id 一律 `selectable:false` + 来源 `native-cache`；`isDefault` → `role:'default'`；新增 `NativeCatalogEntry.meta` |
| `src/model-sources.ts` | `SourceObservation`/`ModelEntry` 增加 `meta`（厂商元数据）并合并透传 |
| `src/models.ts` | `modelEntriesFor()` 把 `meta` 带进观测 |
| `client/client.js` | 设置页模型清单每条显示厂商名称 / `vendor` / **输出上限（k）** |
| `src/tools.ts` | `harness_models` 输出：可选模型带元数据；另列「仅展示」条目（带 k 值）；新增「**厂商默认模型**」一行并提醒「有默认 ≠ 可作为 --model」 |

## 4. 实测（live `/api/models`）

```
wb-managed-a      条目 69 = 可选(别名) 9 + 仅展示 59 + 当前默认 1      厂商默认 fast-model
                  名册 55 条，53 条带元数据；样本 hy3 vendor=j maxOut=64000
wb-managed-ai-b   条目 41 = 可选(别名) 4 + 仅展示 36 + 当前默认 1      厂商默认 default-model
                  名册 30 条，30 条带元数据；样本 default-model vendor=e maxOut=24000 name=Auto
可传给 --model 的仍是 CLI 自己列的那 9 / 4 个（名册**没有**冒充可选）
```
对比本轮之前：CN 只有 11 条 `r-*`（来源不明的底层 id）可看，国际 **连 `default-model` 都没列过**。

**纪律（离线探针 `probe/verify-workbuddy-roster.mjs`，四条全过）**
- A 源码里**不得访问** `authentication`（只查 `.authentication` 与 `['authentication']` 两种访问形态 ——
  说明文案里**应该**保留「未读取该字段」的交代，第一版断言按词匹配把它误判成越界，已修正）；
- B 可选清单必须仍等于 CLI 别名，**不得**被名册撑大；
- C 元数据与厂商默认要真的带出来；
- D 国内/国际**各读各的**（文件不同、默认不同），不得混用。

## 5. 顺带查出的**真洞**：模型被拒时厂商 CLI 以 **0** 退出

「名册 id 到底能不能喂给 CLI」不能靠推测，直接调厂商 CLI 实测（INTL）：

```
> WorkBuddyAI.exe <managed-wrapper> workbuddy-ai-b -p --model gpt-6-astra "Reply with exactly: WB-ROSTER-OK"
400 model [gpt-6-astra] service info not found (01a13af4dada743e94090cb3083d5c8d/01a13af4-d608-7219-9dfc-53f57943bfa6)
Currently supported models for your account:
  - fast-model
  - balanced-model
  - primary-model
  - deep-model
Please use --model <model_id> to specify a valid model.
exit=0        ← ⚠️ 模型被拒，退出码却是 0
```

两条结论：
1. **名册 id 不能作为 `--model`** ⇒ 本轮的「仅展示」归类**被厂商自己证实**（若把它们提升为可选，就是用户最反感的「拿目录冒充可选」）。
   同时这条输出给出了**按账号**的权威可用清单（国际 4 个），比静态配置更硬 —— 已加进 diagnostic。
2. **原实现会把它报成 `completed`**（只看退出码）。已修：`dispatchHeadless` 新增 `modelRejectionOf()`
   认这个签名 ⇒ 判 `error`，并把厂商原文的支持清单写进诊断。

**⚠️ 第一版修得不彻底（端到端才发现）**：这条 400 打在 **stderr**（`stdoutChars=0`），
只判 stdout 时端到端**仍然**报 `completed`。改成 `stdout + stderr` 一起判之后：

```
修前：stop=completed  exitCode=0   ← 假成功
修后：stop=error      exitCode=0   diagnostic: harness exited with code 0 但厂商**明确拒绝**了本次模型：
        HTTP 400 model [gpt-6-astra]。… 该账号当前支持的模型（厂商原文）：fast-model, balanced-model, primary-model, deep-model
```
探针 `probe/verify-model-rejection-honesty.mjs` 用上机逐字原文做夹具：正常回答/未登录/429 限流**不得**误判（假阳性会把成功报成失败）。

## 6. 三态清单

- **已实现且实测通过**：名册接入（55/30）；四类计数与厂商默认；元数据（vendor/name/输出上限）显示；
  可选清单未被撑大；凭据边界由源码静态断言 + 探针守住；
  **「模型被拒」不再报成成功**（离线夹具 4 例 + live 端到端 `stop=error`，含修复前后对照）；
  离线探针 + 全量回归。
- **已实现但未验证**：`relatedModels`（厂商别名关系）只带进 `meta`，**还没有**做成界面上的「别名 → 底层模型」展示；
  `supportsToolCall/Reasoning/Images` 同样只展示，未用于任何行为；
  **ACP 路径**的模型拒绝（WB 首选 ACP）未单独验：`modelRejectionOf()` 挂在 headless 终止判定上。
- **尚未实现（下一轮，按价值排序）**：
  1. **别名 → 底层模型**：用 `relatedModels` 把「模型别名」这一类补全成真实映射（现在只说「来自有据别名」）；
  2. 参考 `dsh-our-free-model` 的做法：**思考强度 = 输出 token 预算**（本机名册里就有每条的 `maxOutputTokens`：
     24k/32k/48k/64k/72k），把「拒绝 reasoningEffort」升级成「按档位下发真实预算 + 卡片标注上限」；
  3. `harness_send` 的 CDP `model` 路径归并到 `resolveModelRequest`。
- **受上游限制**：名册里的底层 id **不能**作为 CLI `--model` 取值（实测 CLI 响亮拒绝）⇒ 它们只能「仅展示」；
  想让它们真正可选，只有走参考仓库那条「持有 token 的 HTTP 网关」路线（用户本轮明确不选）。

## 6. 复现

```powershell
node scripts/build.mjs
node probe/verify-workbuddy-roster.mjs     # 名册接入 + 四条纪律（含凭据边界静态断言）
node probe/_regression-suite.mjs           # 23 项

# live
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/models' -Method Post `
  -ContentType 'application/json' -Body '{"target":"wb-managed-ai-b","refresh":true}' |
  Select-Object state,counts,@{n='default';e={($_.entries | Where-Object kind -eq 'current-default').id}}
```
