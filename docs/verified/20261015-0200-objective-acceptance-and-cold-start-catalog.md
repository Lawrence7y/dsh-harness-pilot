# 2026-10-15 · 第十九轮：整目标验收 + 冷启动目录缺失（真缺陷）与计数表形状

## 1. 本轮先做「整目标验收」，它立刻抓出一个真缺陷

新增 `probe/verify-objective-acceptance.mjs`：把需求 ①–⑨ 逐条变成**可复现断言**
（只读 live API + 源码不变量，零额度、不 spawn 外部 CLI）。第一遍跑出 3 条失败，其中：

| 失败 | 判定 |
|---|---|
| ⑥ `分组「Qoder（国际）」provider=2，成员最多可选=0` | **真缺陷的线索**（下面第 2 节） |
| ⑨ `账号池默认账号=undefined` | **我的断言写错**：`/pool` 在没有默认账号时**不含**该字段（不是空串）⇒ 改成容错断言 |
| ⑤ `客户端没有「只影响新会话」` | **我的断言写错**：真实文案是「新会话使用所选账号；已有子代理保持原账号。」⇒ 按真实文案断言 |

（⑥ 那次还让我发现：用「逐目标直接查 `/models`」当判据本身就不对 —— 它**不带该组的账号作用域**，
所以 Qoder 国际会显示成员 0 个模型而 provider 有 2 个。权威判据是
`/llm-adapter.harnessRoutes[].modelsPerTarget`（与账号上下文同源）。）

## 2. 真缺陷：**冷启动时选择器里看不到该 harness 的模型**

线索是 ⑥ 那条失败。顺着 `listModels()` 查下去：

- `listModels(provider)` 原来**只读同步缓存** `modelsFor`；
- 缓存只由**后台预热**填充，而预热是 fire-and-forget、**挂载即开始**；
- 宿主**第一次**建模型目录常常早于预热完成（代码注释早就承认这一点）；
- ⇒ 那一次目录里该分组**只剩「CLI 默认模型」一条**，要等下一次目录刷新才恢复。

**实测复现（插件重载后第一件事就读目录）**：
```
harness-qoder-cn     14 → 1
harness-qoder-intl    2 → 1
harness-antigravity   7 → 1
（其它分组同理受时序影响）
```
对用户就是「点开折叠看不到该 harness 的模型」，而且是**随机**的（取决于预热与目录构建谁先）。

### 修法（三处，全部有实测对照）

| 改动 | 说明 |
|---|---|
| 预热改成**可等待** | `warmModelsOnce()` 返回 promise（每条目标一个句柄，已完成则立即 resolve）；`warmDone` 记录 |
| `listModels` **等整轮预热的同一个 promise** | 新增依赖 `awaitModelsFor`；预算**全局一个截止时刻**（`MODEL_AWAIT_BUDGET_MS = 20s`） |
| 预热并发 2 → **6** | 见下表的实测对照 |

**⚠️ 中途踩的两个坑（都靠端到端实测发现）**：
1. 第一版让各 provider **各自**等自己那条目标，并且**各自** 12s 竞速 ⇒ 宿主是**逐 provider** 建目录的，
   于是「每条目标的首查时间」被**求和**：首建目录 **48.4s**；而且**第一个被建的** provider 会先超时
   （`harness-antigravity` 只剩 1 个模型）。改成「等同一个总预热 + 同一个截止时刻」后消失。
2. 并发不是越高越好 —— 实测：

| 预热并发 | 首建目录耗时 | 分组完整度 |
|---|---|---|
| 2（原值） | **48.4s** | 16/16（但代价是求和式等待） |
| **6（采用）** | **14.8s** | **16/16** |
| 10 | 21.3s | **9/16**（antigravity 掉回 1）—— 10 个 CLI 同时起互相拖慢，`agy` 错过预算 |

**修后（冷启动第一件事就读目录）**：
```
首建耗时 14.8s（此前 48.4s）
harness-antigravity 7   claude-code 5   codex 8     command-code 1
gemini 1   grok 1   kimi 1   mimo 67    opencode 485   pi 99
qoder-cn 14   qoder-intl 2   qwen 1    workbuddy-cn 10   workbuddy-intl 5   zcode 1
第二次读目录 1.4s（走缓存）
```
14.8s 是「每条 CLI 自己的模型列举命令各查一次」的真实代价（agy 7.3s / pi 4.7s / qoder 4.6s+3.5s / mimo 2.6s），
只在**冷启动**付一次；用户真正打开选择器时预热通常已完成。

## 3. 顺带修掉的形状缺陷：`modelsPerTarget` 混进错误正文与 `-1`

`/llm-adapter` 的 `harnessRoutes[].modelsPerTarget` 原来是 `number | string`：
失败塞 `ERR <一整段多行文本>`（WorkBuddy CN 的 `codebuddy` 实测 **954 字符**），未测量塞 `-1`。
两个问题：**计数表里混错误正文**（消费者无法区分）、**`-1` 是编造的数字**（没测量过就没有计数）。

现在拆成三件：
```
modelsPerTarget: 只放**真的同步到的**数字（没同步到就不出现该键）
modelStates:     synced | unknown | error
modelErrors:     错误正文单独一处（没有就不出现该字段）
```
实测：
```
harness-gemini        计数={}            states=gemini=unknown
harness-qoder-intl    计数={}            states=qoder-cli=unknown qodercli=unknown
harness-workbuddy-cn  计数=wb-managed-a=9 states=codebuddy=error wb-managed-a=synced
                      modelErrors.codebuddy=[954 字符]
```

## 4. 整目标验收结果（97 条断言）

```
PASS ① 4 条（17 条路由 = pilot-cli + 16 harness 分组；harness-* 16 条）
PASS ② 24 条（分组 18 条；不截断（最大分组 > 400）；四态计数与来源齐全；计数只放非负数字）
PASS ③ 9 条（Qoder CN/INTL、WorkBuddy CN、Antigravity 的登录模式与可派发目标；档位别名）
PASS ④ 6 条（18/18 有边界；Qoder CN+INTL 与 WB CN+INTL 配置目录隔离；Antigravity 三 falsy + 依据≥3 条）
PASS ⑤ 7 条（四项内容的数据面 + 客户端「新会话使用所选账号 / 已有子代理保持原账号」）
PASS ⑥ 32 条（16 组：选择器模型数 ≥ 各目标同步到的数量 + 1；无空组）
PASS ⑦ 8 条（WB CN ≥60、INTL ≥40 条目 + 厂商默认；agy 可选 ≥6；目录 id 无占位符/argv 痕迹）
PASS ⑧ 3 条（任务账本有身份结论；子代理可选路由 695 条；harness 路由进 provider 集合）
PASS ⑨ 4 条（自动切号 enabled=false；onModelUnavailable=stop；池 autoSwitchEnabled=false；默认账号已还原）
合计 97 条断言，失败 0
```

## 5. 三态清单

- **已实现且实测通过**：整目标验收探针（97 条）；冷启动目录完整性（真缺陷已修，含 4 次端到端对照）；
  `modelsPerTarget` 形状修正；回归 26 项。
- **已实现但未验证**：真浏览器里打开模型选择器看分组展开（离线渲染 + live API 已验，未做真点击）；
  持久化模型缓存（本轮**未做**：现在冷启动 14.8s，若把上次发现落盘可降到 ~0s）。
- **尚未实现（下一轮候选）**：
  1. **模型缓存持久化**（把上次发现落盘，重载后首建目录即时且仍有后台刷新）；
  2. `relatedModels` 的「别名 → 底层模型」界面展示；
  3. `harness_send` 的 CDP `model` 路径与 `resolveModelRequest` 归并。
- **受上游限制**：宿主 `listModels` 只接受模型 id（名册的上下文/输出上限进不了原生目录，只能留在设置页）；
  ACP 通道不追加自定义参数（只能报偏差并引导到 headless/pty）。

## 6. 复现

```powershell
node scripts/build.mjs
node probe/verify-objective-acceptance.mjs     # ①–⑨ 逐条（97 条断言）
node probe/_regression-suite.mjs               # 26 项

# 冷启动完整性（先让插件重载，再第一件事读目录）
#   重载触发：改 src 后 node scripts/build.mjs
(Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/overview' -TimeoutSec 240).dsh.providers |
  Where-Object { $_.id -like 'harness-*' } | Select-Object id, @{n='models';e={$_.models.Count}}
```
