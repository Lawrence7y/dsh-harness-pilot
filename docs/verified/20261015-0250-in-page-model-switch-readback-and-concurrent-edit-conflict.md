# 2026-10-15 · 第二十一轮：页面内换模型的「请求值 vs 实际值」回读 + **并发编辑冲突记录**

## 0. ⚠️ 本轮现场发现：**另一个会话正在同一个仓库里改代码**

时间线（全部为今天 2026-10-15）：

| 时间 | 文件 | 归属 |
|---|---|---|
| 00:13–00:18 | `probe/verify-model-cache-persistence.mjs`、`src/sessions.ts`、`_regression-suite.mjs`、`src/llm-adapter.ts`、上一轮文档 | **本会话**（落盘缓存那一轮） |
| 00:25:31 | `src/tools.ts` | **本会话**（本轮的回读改动） |
| 00:25:55 | `probe/verify-model-switch-readback.mjs` | **本会话**（本轮新探针） |
| 00:26:30 | `client.js` + `client/client.js` | **另一会话** |
| 00:28:34 / 00:28:36 | `src/index.ts` / **`src/model-visibility.ts`（新文件）** | **另一会话** |
| 00:29:13 | `probe/verify-model-picker-visibility.mjs` | **另一会话** |

`src/model-visibility.ts` 是本会话**从未创建**的文件（注释写着「2026-10-15 用户要求」），
它实现了「会话模型选择器显示哪些模型」（`/api/model-visibility` + `model-visibility.json` + 概览每组 `picker` 摘要），
并已接进 `src/index.ts`（`index.ts:201/2612/5791` 等）与 `src/llm-adapter.ts:121`。

**它的树当前编译不过**（两条 TS 错误，属于它编辑中的中间态）：
```
src/index.ts(2679,25): error TS2783: 'providerId' is specified more than once, so this usage will be overwritten.
src/model-visibility.ts(276,66): error TS2345: Argument of type 'readonly string[]' is not assignable to parameter of type 'readonly { readonly id: string; }[]'.
```
后果：**本会话无法构建**（`src/tools.ts` → `src/llm-adapter.ts` → `src/model-visibility.ts` 的依赖链被拉进同一个编译单元），
因此本轮改动**尚未通过构建**，`lib/tools.js` 里还是旧实现（已核对：`lib/tools.js:666` 仍是旧函数体）。

**本会话的处理纪律（不越界）**：
1. **不碰** `src/model-visibility.ts` / `src/index.ts` / `client/client.js` / 对方的探针 —— 不修、不覆盖、不回退；
2. 本轮只改自己的 `src/tools.ts` 与自己的探针/文档；
3. 在对方把树修到可编译之前，**不声称**本轮改动已实测（下面第 2 节明确区分「已实现」与「已构建验证」）；
4. 后续若要动 `_regression-suite.mjs` / `index.ts` 这类共享文件，先确认对方是否在写。

## 1. 本轮实现：页面内换模型路径的**回读**（需求 ⑧）

`harness_send(model=…)` 有两条路径，之前的诚实性并不对称：

| 路径 | 之前 | 现在 |
|---|---|---|
| CDP 真实鼠标 `switchModel()` | **已经**以回读为准：`ok = modelMatches(after, wanted)`，不一致时 detail 写明「clicked X but the trigger now reads Y」 | 不动（本来就对） |
| 页面内合成事件 `switchModelInPage()` | 只信**页面自述**的 `ok` —— 「点中了」就算成功，「点中的是不是请求的那个」**从未独立核验** | 切换后**回读** `readModelStateSnippet()` 的当前模型，按三态判 |

**三态（不许把「读不到」当一致）**
1. 读到且与请求一致 ⇒ `ok: true, matches: true`，note 写「与请求一致」；
2. 读到但**不一致** ⇒ `ok: false, matches: false`，note 指出实际读到的是什么（页面点中了别的行/档位）；
3. **读不到**（元素缺失/页面刚崩）⇒ `ok: false, matches: false`，note 写「读不到当前模型 —— 不把『读不到』当成成功」；
   回读本身抛错时同样判失败并留下原因。

`InPageModelSwitchReport` 新增 `after` / `matches`；`harness_send` 的页面内分支也补一行
`[model-ref] via=evaluate requested=… after=… matches=…`，与另外三处入口（dispatch/agent/task）口径一致。

## 2. 验证状态（如实区分）

- **已实现**：`src/tools.ts` 的回读逻辑 + `probe/verify-model-switch-readback.mjs`（stub 单测 7 例：
  一致 / 不一致 / 回读为空 / 回读抛错 / 页面自述失败优先 / 子串匹配语义 / 选择器已打开）。
- **已构建验证**：✅ 对方把树修到可编译后已重建（`lib/tools.js:715/719` 可见回读分支），探针 **PASS**。
- **已实现但未验证**：真浏览器里对**真实 GUI 会话**执行 `harness_send(model=…)` 的观感
  （stub 单测覆盖了逻辑；CDP 鼠标路径本来就以回读为准，未再跑真机点击）。
- **尚未实现**：`relatedModels` 的「别名 → 底层模型」界面展示；设置页长列表「按需展开」。

## 2.1 ⚠️ 两会话**语义冲突**（已对齐，但需要用户拍板）

对方新增的「选择器可见性」把**会话模型选择器**默认限到每组 **10 条**（`defaults.pickerLimit=10`，0=不限），
于是 OpenCode 485 → 选择器 11 条（含 `cli-default`）。这与本目标的 **⑥「展开后是该 harness 全部模型」**
在**默认值**上相撞。对方的契约是自洽且文档化的：

```
GET /model-visibility
  defaults = {"pickerLimit":10}
  note = 语义：这里管的是**会话模型选择器**显示多少 —— 每组上限（0=不限，缺省 10）、整组隐藏、组内隐藏。
         隐藏/超限 ≠ 不可用：已选中该模型的会话照常执行；子代理白名单（/subagent-model-selection）是另一套，不受这里影响。
  providers[].models = 483 条（opencode，**完整目录**）
  providers[].visible / hidden / limit / groupHidden = 选择器实际可见面
当前配置文件 `model-visibility.json` = { groupLimit: { harness-antigravity: 2 }, hiddenModels: { harness-antigravity: [gpt-oss-120b-medium] } }
```
**目录没有被截断**（`/models` 仍 483 条、`/model-visibility.models` 483 条，两条出口一致）。

因此我把**自己的**验收探针口径改成与之对齐（`verify-objective-acceptance.mjs`，145 条断言全 PASS）：
- **目录层（需求 ②「不截断」）**：`/models.selectable` == `/model-visibility.models`，最大分组 > 400；
- **选择器层（需求 ⑥）**：选择器必须是目录的**子集**（排除保留值 `cli-default` 后比较）、不得为空、
  必须含 `cli-default`、不得出现目录里没有的模型；
- 每组的 `limit/total/visible/hidden/groupHidden` **记进证据**（限制**可见**，不靠断言掩盖）。

**需要用户确认的一件事**：⑥ 的默认值要「全部」还是「每组 10 条（可配）」？
我按对方（更新的）用户要求对齐了探针，但**没有改**任何默认值。

## 2.2 我自己的两处探针 bug（已修，记录在案）

1. `verify-model-switch-readback` 第一版按「表达式里出现的子串」判别页面阶段，但真实片段里的
   `[role="option"]` 与我写的转义不一致 ⇒ 计数分支没命中、回读分支被当成「打开选择器」，
   连「回读抛错」那例都抛在 try/catch 之外（**探针自己报错**）。改成**按调用顺序的脚本队列**后稳定。
2. `verify-objective-acceptance` 的 ⑥ 第一版直接拿选择器条数与目录条数比，忘了排除保留值 `cli-default`
   ⇒ 每个分组都报「+1 条编造」的**假失败**。排除后 0 失败。

## 3. 复现（等并发会话的树恢复可编译后执行）

```powershell
node scripts/build.mjs                          # 需要 index.ts / model-visibility.ts 先编译通过
node probe/verify-model-switch-readback.mjs     # 回读三态（stub 单测）
node probe/_regression-suite.mjs
```
