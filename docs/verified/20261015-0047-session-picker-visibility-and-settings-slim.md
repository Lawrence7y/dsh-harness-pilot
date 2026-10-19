# 会话模型选择器可见性 + 设置页第四版（2026-10-15 00:4x 实测版）

> 用户需求（2026-10-15 原话）：
> ① 「设置界面优化：让它在设置中符合 DeepSeek 类似原版的特征，信息要明确，不要把大量信息都堆积在页面中。」
> ② 「模型选择优化：现在在 DeepSeek 的（选择器）中选择模型，会显示好长一列外部 CLI 的模型。……让模型选择列表不要这么长、这么臃肿。并且，我希望在设置中能够选择哪些 CLI 的哪些模型不显示在模型列表中。」
> 纪律沿用 `docs/verified/` 既有口径：不给百分比；「已验证」带复核手段与产物路径；不把安装/构建成功当行为验收。

---

## 1. 改了什么（一句话版）

1. **会话模型选择器可见性**（新能力，`src/model-visibility.ts`）：每条 harness 分组可配置
   「每组显示上限（默认 10，0=不限）/ 整组隐藏 / 组内隐藏模型」。`PilotCliAdapter.listModels`
   按它裁剪宣传面；**隐藏 ≠ 不可用**（执行校验走全量实时清单，已选中的会话照常执行；
   子代理白名单候选不过这里）。设置页每条 harness 的展开体首块就是「选择器显示」管理面
   （整组开关 + 上限 + 逐模型勾选 + 恢复默认），数据源 `GET/POST /api/model-visibility`。
2. **设置页第四版**：正文只留「一条 harness 一行」折叠列表（行头新增「选择器 M/N」）；
   每条目标的「模型发现与供应商目录」收进默认关闭的 details；两条重复说明合并为一条；
   「高级与诊断」（注册表 / 任务 / 会话 / 进程 / DSH 供应商 / 自动切换 / 插件设置）
   **整块搬到 设置 → 插件 → 「外部 harness 管理」**（`HarnessPilotCard` 页面视图）——搬家不是删除。

## 2. 语义边界（必须按此对外表述）

- **上限/隐藏只影响选择器的展示面**：`streamForProvider` 的模型校验用 `mergeHarnessModels`
  的**全量实时清单**（`llm-adapter.ts` `streamForProvider`，与 `listModels` 无关），
  已选了后来被隐藏的模型的会话**照常执行**；只是菜单不再列出它。
- **子代理候选不受影响**：`candidatesFor`（`subagent-models.ts`）直接调 `mergeHarnessModels`。
- **完整清单没有藏起来**：设置页「逐个模型控制显示」列的是「合并清单 ∪ 已配置隐藏项」
  （`known:false` 标注该 CLI 当前已不再报的 id，否则用户无法取消隐藏）。
- **口径变更声明**：2026-10-14 的「展开后是该 harness 全部模型、不截断」被用户本轮指示取代
  —— 现在是「选择器显示子集（可配），完整清单在设置页」。`sessionModelLimit` 仍保持作废
  （那是全局静默截断；现在是逐组、可见、可关的显式配置）。

## 3. 改动清单（全部相对回滚基线 P41）

| 文件 | 内容 |
|---|---|
| `src/model-visibility.ts`（**新增**） | 文档模型/归一化/原子落盘（写前留 `*.prev.json` 撤销档）/`pickerVisibilityFor`/`filterPickerModels`/`applyVisibilityPatch`/`pickerProviderSummary`/`ModelVisibilityFacade` |
| `src/llm-adapter.ts` | `PilotCliDeps.pickerVisibility`（可选 dep）；`listModels` 应用 整组隐藏⇒`[]`、逐模型隐藏、上限截取（保序）；`cli-default` 仅显式隐藏才消失；未挂 dep ⇒ 行为与本轮之前逐字节等价（可回滚） |
| `src/index.ts` | 门面 `modelVisibilityFacade`（read/write/providers）+ `POST/GET /api/model-visibility` 路由（未知 providerId 400）+ 概览每组 `picker` 摘要 + adapter dep 接线 |
| `client/client.js` | `useModelVisibility` + `PickerVisibilityPanel`；`HarnessGroupRow` 首块挂面板、行头加「选择器 M/N」、模型发现收进 details、两条说明合一；`HarnessPilotSection` 移除「高级与诊断」；`HarnessPilotCard` 承载全部高级面板 |
| `probe/verify-model-picker-visibility.mjs`（**新增**） | 本轮离线验收（见 §4） |
| `probe/verify-native-ui-layout-offline.mjs` | 同步到第四版契约（**既有过期**：徽章 inject 形状 `modelDirectory→modelDirectories`、第二版版面断言、缺 `useSubagentPolicy` 桩 —— P41 上同样失败，非本轮引入） |
| `probe/verify-ui-smoke.mjs` | 同步到第四版：高级面板断言改打在卡片渲染上；新增「选择器显示」面板的真实数据断言 + `visibilityFixture` + 报告字段 |

## 4. 验收证据（全部为最终构建上的复跑）

| 套件 | 结果 | 性质 |
|---|---|---|
| `node probe/verify-model-picker-visibility.mjs` | **PASS**（A 纯函数 18 断言 / B `listModels` 6 场景 / C 静态 9 断言） | 离线，零 spawn、零额度 |
| `node probe/verify-ui-smoke.mjs` | **PASS**（真实数据渲染 277,600 字符；16 条 harness 分组全部有模型；「选择器显示」面板按接口数据渲染计数；`conversation.input.model` 未被占用；高级面板在插件页卡片） | 离线渲染 + live 取数 |
| `node probe/verify-native-ui-layout-offline.mjs` | **PASS**（15 断言；含「原生选择器未被占用」「identity 消费 ModelDirectory 服务」「分组缺失时不回退成一行一目标」） | 离线 |
| `node probe/_regression-suite.mjs` | **27/28 PASS**；唯一失败 `verify-federation-accounts`（两条「导入证据措辞」断言）为**既有失败**：`src/federation/accounts.ts` 与回滚基线 P41 **逐字节相同**（sha256 前 12 位 `2da31a5fa1bf`），失败源于 WB 账号运行数据（快照分支 detail 覆盖措辞）与探针 F 段契约的既有错位，与本轮改动无关 | 串行、含少量真实 CLI（零额度） |
| `node probe/verify-llm-adapter-unit.mjs` | PASS（闸门/chunk/路由 146 条断言中该套件部分全过；未挂 `pickerVisibility` 的旧行为不变） | 离线 |
| **live 端到端**（活宿主 0.2.0-rc.2 + HMR） | `POST /model-visibility {limit:2}` ⇒ `/llm-adapter` 目录计数变化符合预期；`POST {groupHidden:true}` ⇒ **`harness-antigravity` 从宿主选择器目录消失**（`/llm-adapter` 的 `catalog.groupIds` 22→21，`catalog.source = ctx.sessionController.modelCatalog()` 与界面选择器同一入口）；`POST {reset:true}` ⇒ 组恢复（21→22） | live HTTP，零 CLI spawn |
| `/diag/loaded` | `anyStale=false`，模块 44（新增 `model-visibility.js`） | live HTTP |

**测试残留清理**：验收用过的可见性配置已 `reset` 并删除 `model-visibility.json`（含 `.prev.json`）——磁盘回到本轮之前的状态。

## 5. 复现

```bash
cd D:\Project\dsh-harness-pilot
node scripts/build.mjs              # 必须 exit 0 且出现 client 拷贝行
node probe/verify-model-picker-visibility.mjs
node probe/verify-native-ui-layout-offline.mjs
node probe/verify-ui-smoke.mjs      # 离线渲染 + live 取数
# live（宿主在跑时）：
curl -s http://127.0.0.1:4200/harness-pilot/api/model-visibility
curl -s -X POST http://127.0.0.1:4200/harness-pilot/api/model-visibility \
  -H "content-type: application/json" -d '{"providerId":"harness-antigravity","groupHidden":true}'
curl -s http://127.0.0.1:4200/harness-pilot/api/llm-adapter | 图 groupIds 不含该组
curl -s -X POST ... -d '{"providerId":"harness-antigravity","reset":true}'   # 还原
```

浏览器侧（用户验收路径）：设置 → 外部 harness 管理 → 展开任一 harness →
「选择器显示」改上限/取消勾选某模型/隐藏整组 → 保存 → 新开会话点开原版模型菜单核对。
（本轮未做真浏览器点击验收，`realBrowser=false` —— 与 ui-smoke 的既有边界一致。）

## 6. 回滚

- **基线**：`D:\Project\_dsh-baseline\dsh-harness-pilot-P41-pre-picker-visibility-20261015-001700.zip`
  （改动前快照：src / client / assets / scripts / package.json / cordis.patch.yml / tsconfig）。
- 步骤：解压覆盖 → `node scripts/build.mjs`（exit 0 + client 拷贝行）→ HMR 或重启宿主 →
  `/diag/loaded` 必须 `anyStale=false` → 删除 `~/.dsh/plugins/harness-pilot/model-visibility.json`（如存在）。
- **运行时数据**：本轮零写入账号池 / 账号档案 / 任务账本 / 会话绑定；唯一新文件
  `model-visibility.json` 已在验收后清除。

## 7. 已知边界与未验证（如实）

- **真浏览器点击验收未做**（离线渲染 + live 目录双证；选择器实际观感请按 §5 用户路径核对一遍）。
- 上限截取是**保序截取**（默认目标先报的在前），不是按使用频率排序——「哪 N 个最该显示」
  由用户用逐模型勾选自己定。
- `verify-federation-accounts` 的两条既有失败（导入证据措辞）本轮**未修**：不在本轮授权范围，
  且 `accounts.ts` 未被本轮触碰；已留档（§4），建议下一轮单独处理。
- `HarnessSessionSelector` 死代码与其「priority -1 接管座位」的过时注释仍在 `client.js`
  （上轮审计已记录的残留，本轮未清理）。
