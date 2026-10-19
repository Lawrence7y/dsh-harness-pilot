# 2026-10-15 · 第十八轮：偏差可见性（ACP 静默丢参数 / 两条偏差互相覆盖 / 工具面不显示）

## 1. 起点：上个洞的邻居

上一轮修掉了「模型被拒但退出码 0」的假成功。顺着 requirement ⑧「请求值 ≠ 实际值时提示」往下查
**ACP 通道**（WorkBuddy 的首选通道）时，一次端到端实测就撞上三件事：

**A. ACP 通道静默丢弃 `extra_args`**
```
harness_dispatch(target='wb-managed-ai-b', transport='acp', extra_args=['--model','gpt-6-astra'], prompt='…')
  → stop=completed
  → facts.argv: …WorkBuddyAI.exe … workbuddy-managed.cjs workbuddy-ai-b --acp     ← argv 里**没有** --model
  → 正文: "ACP-SHOULD-NOT-SUCCEED"（CLI 用**默认模型**正常回答）
```
`harness_dispatch` 的 `extra_args` 文档写的是「追加在目标默认参数之后」，而 `transports/acp.ts` 里
`spec.extraArgs` **一次都没被引用**（只有 `headless.ts:96` 与 `pty.ts:100` 会用）。
⇒ 「要求用某模型/某开关去跑」被**静默忽略**，调用方拿到一份干净的成功。**最坏形态的「请求值 ≠ 实际值」。**

**B. 两条偏差会互相覆盖**：`settle()` 里原本写成条件展开 `...({mismatch:[…]})`，
再加一条同名字段后，**后者把前者整个替换**（对象展开语义）—— 于是「模型没生效」的偏差会消失。

**C. 工具面不显示 `mismatch`**：`formatOutcome()` 只印 facts/diagnostic。记账与回执里有偏差，
**派发方唯一会读的那一屏没有**。

## 2. 本轮实现

| 位置 | 改动 |
|---|---|
| `src/transports/acp.ts` | 新增导出函数 **`acpMismatchOf()`**（两条偏差来源**合并**成一个数组，可单测）；`settle()` 改用它 |
| `src/tools.ts` | `formatOutcome()` 输出偏差段：`⚠️ 请求值 ≠ 实际值（N 条，不得当作「已按请求执行」）` + 逐条 |
| `probe/verify-dispatch-mismatch-visibility.mjs` | **真单测**（4 例：两条同时 / 只有 extra_args / 只有模型 / 无偏差）+ 三处显示面的不变量 + 构建落地检查 |

**为什么不直接把 `extra_args` 追加到 ACP 启动命令**：ACP 是用 `--acp` 起一个**协议服务**，
任意追加 flag 可能破坏握手；而「静默丢弃」是明确的错误。所以选择**如实报偏差**并给出替代路径
（`transport: 'headless'` 会追加）。这符合本仓库的口径：**显式 > 静默**。

## 3. 实测

```
修前（同一调用）：
  harness=wb-managed-ai-b transport=acp stop=completed
  ACP-SHOULD-NOT-SUCCEED                      ← 用默认模型跑完，却看不出参数没生效

修后：
  harness=wb-managed-ai-b transport=acp stop=completed
  ACP-MISMATCH-SHOWN
  ⚠️ 请求值 ≠ 实际值（2 条，不得当作「已按请求执行」）：
    - extra_args 未在 ACP 通道生效：--model gpt-6-astra
    - 原因：ACP 以 `--acp` 启动协议服务，只拼目标自带的 acpArgs，不追加自定义参数。
      要下发请显式用 transport=headless（或在目标配置里改 acpArgs）。
```
离线探针：
```
  4 条     两条偏差同时存在      ← 合并生效（早前会被覆盖成 2 条）
  2 条     只有 extra_args
  no-mismatch 无偏差
  2 条     只有模型偏差
  不变量: acpMentionsExtraArgs=true, toolSurfaceShowsMismatch=true,
          receiptShowsIdentity=true, taskViewShowsMismatch=true, builtLibHasMerge=true
PASS
```

## 4. 三态清单

- **已实现且实测通过**：ACP 偏差不再静默（live 端到端 + argv 事实对照）；两条偏差合并（真单测）；
  工具面/回执/任务视图三处都能看到偏差（不变量 + 前两轮 live 证据）；全量回归。
- **已实现但未验证**：`pty` 通道的 `extra_args`（代码里会追加，未单独实测）；
  `headless` 下 `extra_args` 里放**有效** `--model` 的正向用例（本轮只用它验证了「被拒」方向）。
- **尚未实现（下一轮）**：
  1. `relatedModels`（厂商别名关系）在界面上的「别名 → 底层模型」展示；
  2. **思考强度 = 输出 token 预算**（照 `dsh-our-free-model` 的做法；名册里每条的 `maxOutputTokens` 现成）；
  3. `harness_send` 的 CDP `model` 路径与 `resolveModelRequest` 归并（那条路仍不校验、不比对）。
- **受上游限制**：ACP 通道不追加自定义参数（协议服务形态所限）⇒ 只能报偏差 + 引导到能追加的通道。

## 5. 复现

```powershell
node scripts/build.mjs
node probe/verify-dispatch-mismatch-visibility.mjs   # 偏差合并单测 + 三处显示面不变量
node probe/_regression-suite.mjs                     # 25 项

# live（ACP 丢参数 → 必须显示偏差）
harness_dispatch(target="wb-managed-ai-b", transport="acp",
                 extra_args=["--model","gpt-6-astra"], prompt="Reply with exactly: X")
```
