# 2026-10-14 23:3x · 第十五轮：模型引用收敛（需求 ⑧ 最后一环）

## 1. 缺口：工具面的 `model` 是**完全自由的字符串**

`harness_dispatch` / `harness_agent` / `harness_task_start` 的 `model` 以前直接塞进 `-m <model>`，
没有任何校验。三种坏结果实测都可能：
- 过期 id（`gemini-3.7-flash-high` 已从 agy 目录消失）→ 各 CLI 报各不相同的错，很难归因；
- 别家 harness 的 id / 把目标名当模型名 → 同上；
- **目标根本没有模型开关**（GUI 目标）→ 参数被**静默忽略**，即「设了模型其实没生效」。

## 2. 本轮实现

| 位置 | 内容 |
|---|---|
| `src/model-request.ts`（新增，纯函数） | `resolveModelRequest()`：接受 ① `cli-default` 保留值 ② `harness-<id>/<model>`（**原生选择器形态**）③ `<target>::<model>`（历史形态）④ 纯 id；并做**清单核对** |
| `src/tools.ts` | `harness_dispatch` / `harness_agent` 都在**派发前**校验（拒绝即不派发）；`harness_models` 输出升级为「provider id + 四态 + 四类计数 + **可复制粘贴的模型引用**（带类别与来源）+ 保留值 + 仅展示条目警告」 |
| `src/task-tools.ts` | `harness_task_start` 同样在**建任务前**校验（否则账本里会留一条注定失败的 run） |

**校验规则（唯一实现，三处共用）**
1. 清单**真的测过**且非空 ⇒ 名字不在其中 = **显式拒绝**：列出可用清单 + `harness_models(target=…, refresh=true)` + 明确「本次不派发」；
2. 清单**没测过**（未测量 / 该 CLI 无列举能力 / 清单为空）⇒ **放行但标 `verified:false`** —— 「不知道」≠「不存在」；
3. `provider/model` 的 provider 与本次 target 不属同一条 harness ⇒ 拒绝；
4. `<target>::<model>` 的 target 与本次不符 ⇒ 拒绝；
5. 目标无模型开关（无 `modelArgs`/`acpArgs`）⇒ 显式给 model = 无意义 ⇒ 拒绝并指出替代路径（`extra_args` / 换目标）；
   ⚠️ `extra_args` **不豁免**清单核对（两个来源都会真的进命令行）；
6. 拒绝结果里**没有** model 字段 —— 绝不「换一个模型替你跑」。

## 3. 实测

**live（工具面，我自己直接调）**
```
harness_models(target='agy')
  provider（原生模型选择器里的分组）: harness-antigravity
  四态: 就绪 — 有 6 个可以作为 CLI 模型参数的条目
  四类：可选择 6 / 别名 0 / 仅展示 0 / 当前默认 0
  可传给 model=（6 个，纯 id 或 `harness-antigravity/<model>` 两种写法等价）：
    gemini-3.8-flash-high   [可选择模型 · cli-query]
    …（逐条带类别与来源）
  保留值：cli-default（不下发 --model，用该 CLI 自己的默认档）

harness_dispatch(target='agy', model='gemini-3.7-flash-high')   ← 过期 id
  ✗ 模型引用被拒绝（**没有派发**）
  原因：模型「gemini-3.7-flash-high」不在「agy」**当前**报出的可选清单里
  怎么办：可用（6 个）：gemini-3.8-flash-high, … / 先确认 id：harness_models(target="agy", refresh=true)
          / 本次**不派发**：换一个模型替你跑会让「选了 A 实际跑了 B」无法察觉        ← 零额度

harness_dispatch(target='grok', model='grok-build')             ← GUI 目标没有模型开关
  ✗ …目标「grok」没有可用的模型开关（既无 modelArgs 也无 acpArgs）⇒ 这个 model 参数会被它忽略
    怎么办：…要硬塞请改用 extra_args，或换一条有 modelArgs 的目标                  ← 零额度

harness_task_start(target='agy', model='nope-xyz-9')
  ✗ 模型引用被拒绝（**没有建任务**）… 同上                                     ← 零额度、账本无残留

harness_dispatch(target='agy', model='harness-antigravity/gemini-3.8-flash-low')  ← 正向控制（1 次真调用）
  harness=agy transport=headless stop=completed … exitCode=0
  response: "Your support ticket number is **R9-POS-1**.\n\n2 + 2 = **4**.\n"
  [model-ref] form=provider-model verified=true — 已核对可选清单（6 个）
```
⇒ **原生模型选择器的 provider/model 形态现在能直接喂给工具**，且回报了「用了哪种形态、有没有核对过清单」。
（`verified=false` 会如实写出来 —— 未知即未知。）

**离线探针**：`probe/verify-model-request.mjs` 16 例（含 8 条拒绝路径）全 PASS。

## 4. 三态清单

- **已实现且实测通过**：三种引用形态 + `cli-default`；清单核对与拒绝（含恢复指引与「不派发」声明）；
  未测量放行并标 `verified:false`；无模型开关时拒绝；`harness_models` 输出四类/来源/可复制引用；
  任务面在建任务前拒绝（账本零残留）；正向控制真实执行且 form/verified 回报；离线 16 例。
- **已实现但未验证**：`harness_agent` 的**live** 一轮（它的模型经 `agentOptions` 透传，校验已在同一入口，
  但本轮未真跑一次子代理）；`harness_send` 的 CDP `model` 参数仍走「点界面选模型」那条独立路径（未归并）。
- **尚未实现（下一轮）**：① 设置页「模型来源与四类」的真浏览器点击验收；② 会话/子代理页面上
  「请求值 ≠ 实际值」的**提示位**（现在只落在账本与诊断里）；③ `harness_send` 的 CDP 模型路径与
  这份引用解析对齐（它现在不校验、也不走清单）。
- **受上游限制**：无。

## 5. 复现

```powershell
node scripts/build.mjs
node probe/verify-model-request.mjs     # 离线：三种形态 + 清单核对 + 无开关 + 未测量
node probe/_regression-suite.mjs        # 20 项

# live（工具面；前三条零额度，最后一条会真调一次 agy）
harness_models(target="agy")
harness_dispatch(target="agy", model="gemini-3.7-flash-high", prompt="x")     # 过期 id → 拒绝
harness_dispatch(target="grok", model="grok-build", prompt="x")               # 无模型开关 → 拒绝
harness_task_start(target="agy", model="nope-xyz-9", prompt="x")              # 不建任务
harness_dispatch(target="agy", model="harness-antigravity/gemini-3.8-flash-low", prompt="…")
```
