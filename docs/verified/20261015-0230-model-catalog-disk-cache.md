# 2026-10-15 · 第二十轮：模型目录**落盘缓存**（把重载后首建目录 14.8s → 1.4s）

## 1. 问题：上一轮修完「完整」，代价是「慢」

上一轮把「冷启动时选择器里只剩 CLI 默认模型」修好了，但代价是**首建目录要等整轮预热**：
实测每条 CLI 的模型列举命令 `agy 7.3s / pi 4.7s / qoder-cn 4.6s / qodercli 3.5s / mimo 2.6s`，
整轮 **14.8s**（并发 6）。而插件**每次重载缓存都丢** ⇒ 每次重载都要重付这笔钱。

## 2. 本轮实现：把上次发现落盘

| 位置 | 改动 |
|---|---|
| `src/sessions.ts` | 缓存条目新增 `name`（键是哈希，不存名字就无法按名回填）与 `seeded`；新增 `exportModelCache()` / `seedModelCache(rows, {maxAgeMs, scope})`；`targetModels(target, {force})`；`SEEDED_MODEL_TTL_MS = 6h` |
| `src/index.ts` | 挂载时 `loadModelCacheFromDisk()` 回填；预热对每条目标 **`force: true`** 刷新；整轮预热跑完 `persistModelCache()` 落盘；`awaitModelsFor` **命中缓存就立即返回**（只有真的什么都没有才等预热）；`/llm-adapter` 新增只读诊断 `modelCache {file, persistedRows, seededOnMount, inMemory}` |
| `probe/verify-model-cache-persistence.mjs` | 文件形状 + 键算法同源 + 来路标注 + 超龄丢弃 + 预热 force 刷新（7 条不变量 + 文件断言） |

**四条纪律（都不许放松）**
1. **只回填 6 小时以内的条目**：更老的在加载时直接丢掉 —— 不能拿一天前的清单冒充「现在能选」；
2. **回填条目必须标注来路**：note 追加「本地缓存：N 分钟前发现；插件重载后先展示它，后台正在刷新」；
3. **预热 `force` 刷新**：否则回填会一直命中、永远不刷新（展示的就永远是「上次发现」）；
4. **只导出带 `entries` 的非空条目**：空条目回填时也会被丢，写进去白占体积。

## 3. ⚠️ 中途踩的坑：键算法不一致（回填了却读不到）

第一版实现后实测**没有任何改善**（仍 16.5s）。原因：
- **写入**落盘时按**未加账号作用域**的目标算缓存键；
- **读取**路径（`syncModelsFor` → `modelScopedTarget`）会往 `modelsArgs` 里加 `--config-dir` ⇒ **键不同**；
- ⇒ 回填的条目**读不到**（带账号的组尤其明显）。

修法：`seedModelCache` 接受 `scope` 变换，调用方传的就是读取路径那同一个 `modelScopedTarget`（算不出来时退回未作用域目标，键仍自洽）。

**为什么这次能发现**：我给 `/llm-adapter` 加了只读诊断，把「落盘多少 / 回填多少 / 内存多少」摆出来 ——
修前 `seededOnMount` 是 0（键不匹配），修后 **16**。这条诊断留在代码里，下次同类故障不必再靠猜。

## 4. 实测

```
重载后**第一件事**就读模型目录（不先打开设置页）：
  持久化之前：  14.8s（更早的版本 48.4s）
  持久化之后：   1.4s        ← 且 16 个分组完整（antigravity 7 / claude 8 / codex 8 /
                              mimo 67 / opencode 485 / pi 99 / qoder-cn 14 / qoder-intl 2 /
                              workbuddy-cn 10 / workbuddy-intl 5 …）
  第二次读：     1.2s（走内存缓存）

回填条目的来路标注（挑最慢的 pi，重载后**立刻**读，抢在刷新之前）：
  pi note（重载后立刻）: pi --list-models（本地缓存：2 分钟前发现；插件重载后先展示它，后台正在刷新）
  pi note（预热刷新后）: pi --list-models          ← 刷新后变回原始查询，不再声称是缓存
  /llm-adapter.modelCache = {persistedRows: 21, seededOnMount: 16, inMemory: 16}
```
（注：`persistedRows` 是**加载时**读到的旧文件条数，`inMemory` 是当前导出条数 —— 新文件写 16 条，
把 `entries` 为空的 5 条去掉了。）

## 5. 三态清单

- **已实现且实测通过**：落盘 + 回填 + 来路标注 + 超龄丢弃 + `force` 刷新；首建目录 14.8s → **1.4s** 且完整；
  键算法不一致这个坑已修并有诊断位守；探针 7 条不变量 + 文件断言；回归 27 项。
- **已实现但未验证**：真浏览器里「重载后第一次打开模型选择器」的观感（live API 已验 1.4s，未做真点击）。
- **尚未实现（下一轮候选）**：
  1. `relatedModels` 的「别名 → 底层模型」界面展示；
  2. `harness_send` 的 CDP `model` 路径与 `resolveModelRequest` 归并（那条路仍不校验、不比对）；
  3. 设置页长列表「按需展开」（名册 55/30 条一次性铺开时加个「显示全部」）。
- **受上游限制**：宿主 `listModels` 只接受模型 id（名册的上下文/输出上限进不了原生目录，只能留在设置页）；
  ACP 通道不追加自定义参数（只能报偏差并引导到 headless/pty）。

## 6. 复现

```powershell
node scripts/build.mjs          # 触发插件重载
# 重载后**立刻**读（不要先打开设置页）
$sw=[Diagnostics.Stopwatch]::StartNew()
(Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/overview' -TimeoutSec 240).dsh.providers |
  Where-Object { $_.id -like 'harness-*' } | Select-Object id, @{n='models';e={$_.models.Count}}
"$([math]::Round($sw.Elapsed.TotalSeconds,1))s"     # 期望 ≈1–2s（持久化前 14.8s）

(Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/llm-adapter').modelCache   # 落盘/回填/内存
node probe/verify-model-cache-persistence.mjs
node probe/_regression-suite.mjs
```
