# 2026-10-14 22:1x · 第十二轮：修内置 WorkBuddy 档案把「账号 id 当目标名」的老 bug（需求 ③/④）

## 1. 缺陷形态（两处名字对不上，且被旧值互相顶住）

| 位置 | 修前 | 应该是 |
|---|---|---|
| `src/federation/accounts.ts:162`（qoder 那两个是对的，见下） | `workbuddy-a` 档案的 `targetName: 'workbuddy-a'` | **`wb-managed-a`**（`src/config.ts` 里的真实目标名） |
| `src/federation/accounts.ts:224` | `workbuddy-ai-b` 的 `targetName: 'workbuddy-ai-b'` | **`wb-managed-ai-b`** |
| `src/federation/registry.ts` 的 `TARGET_TO_SEED` | 表里**没有** `wb-managed-a` / `wb-managed-ai-b`（也没有 `qoder-cn-acct-a/b`） | 补上（旧名保留兼容） |
| `src/provider.ts` 的 `MANAGED_ALIAS_RECIPES` | `seedTarget: 'workbuddy-a'` | **`wb-managed-a`**（必须与档案逐字一致，否则配对校验失败） |
| `src/federation/accounts.ts` 的 `harnessOfTargetFromCatalog` | 没有 `wb-managed-*` | 补上（账号 CRUD 的身份校验用它） |

**连锁后果**（本轮实测，逐条）：
1. `POST /accounts/manage {kind:'create', targetName:'workbuddy-a'}` → `目标 "workbuddy-a" 不在本 profile 的目标表里（已知：… wb-managed-a, wb-managed-ai-b …）`
   —— 也就是说：**用真实目标名建账号的路径压根不存在**，而内置档案用的又是那个不存在的名字。
2. `seedForTarget('wb-managed-a')` → `undefined`（表里缺项）。
3. `MANAGED_ALIAS_RECIPES` 里 `seedTarget === target` 的假象让配对校验「看起来没问题」，
   于是这个错位一直没被发现；但它让所有「目标 → 档案」的查找失效。
4. 上一轮做「账号池默认账号按目标分域」时**真实咬到一次**：我最初用
   `seedForTarget(target.name)?.id ?? target.name` 判身份，于是唯一正确的配对
   （`workbuddy-a` × `wb-managed-a`）被判成「不是同一个 Harness」——被迫改成走产品身份表。

## 2. 修法（五处一起改，并保留旧名兼容）

- 档案 `targetName` → 真实目标名（`wb-managed-a` / `wb-managed-ai-b`）。
- `TARGET_TO_SEED` 补真实目标名；**同时保留** `workbuddy-a` / `workbuddy-ai-b` / `codebuddy` 等旧形态
  （既有持久化引用、外部脚本、老探针不能断），并补 `qoder-cn-acct-a/b`。
- `MANAGED_ALIAS_RECIPES.seedTarget` 与档案逐字对齐。
- `harnessOfTargetFromCatalog` 补 `wb-managed-*` / `workbuddy-*` / `qoder-cn-acct-*` / `codebuddy`。
- **没有**动受管启动元组本身（argv / env / bootstrap 一行未改）—— 这是纯身份修复。

## 3. 实测

**离线（5 个既有探针 + 1 个新探针全 PASS）**
```
verify-managed-account-alias-offline   assertions=96 pass=true aliases=4
verify-managed-bootstrap-gate          16/16 OK
verify-account-target-unify            53/53 格；受管正控 8/8 完整元组；负控 28 条显式拒绝且 sink=0；基线差异 0
verify-subagent-account-alias          77 条断言通过
verify-managed-account-target-fix      受管正控 4/4、负控 4/4
verify-account-target-identity（新）    档案 targetName 全是真实目标；真实目标名都能解析且产品身份一致；
                                       受管配方 seedTarget === target；旧名仍解析（workbuddy-a→workbuddy 等）
```

**live**
```
① 账号 CRUD：{kind:'create', targetName:'wb-managed-a'} → 目标名校验**已通过**，
   改为撞上另一条**正当**闸门：「WorkBuddy 认证槽位在厂商共享目录里…再新增只会造出假档案」
   （这是既有的诚实隔离闸门，不是身份 bug —— 关键是它不再报「不在目标表里」）
② 反向对照：{targetName:'workbuddy-a'} → 仍被正确拒为「不在本 profile 的目标表里」，
   且拒绝文案里明确列出真实目标名 `wb-managed-a, wb-managed-ai-b`
③ 受管时间线未回归：/dispatch {target:'wb-managed-a', accountId:'workbuddy-a'} → 200 text=WB-R6-E5
   argv=D:\workbuddy\WorkBuddy.exe …\workbuddy-managed.cjs workbuddy-a --acp（note 脱敏 acct:…-ab）
④ 无账号时回落账号固化目标自身：/dispatch {target:'wb-managed-a'} → 200 text=WB-R6-F6，argv 同上
⑤ 既有 verify-federation-accounts 的失败项**逐字未变**（仍是 WorkBuddy 快照证据那 3 条，与身份无关）
```

## 4. 三态清单

- **已实现且实测通过**：档案 `targetName` = 真实目标；`seedForTarget(真实目标名)` 能解析；
  受管配方与档案逐字一致；账号 CRUD 的目标名校验（真实名通过 / 账号 id 形态被拒）；
  受管派发（显式账号 / 无账号两条路径）argv 与 note 未回归；5 个既有探针零回归；
  新探针把「档案名必须是真实目标 + 配方必须与档案一致 + 旧名仍可用」钉成断言。
- **已实现但未验证**：`harness_agent` 走 `(target × account)` 别名的 **live** 一轮（离线 96 条断言已覆盖注册期，
  79 条断言覆盖工具面，但没真花额度跑一轮）。
- **尚未实现（下一轮）**：
  1. **多账号并行任务验收**（Qoder CN/INTL + WorkBuddy CN/INTL 同时跑）+
     空认证环境**不回退全局账号**的反向对照（需求 ④ 的最后一块）。
  2. Antigravity **共享认证槽**边界在设置页的显式说明（现在只写在隔离档案里）。
  3. `harness_agent` / 任务工具的 `model` 收敛到新分组 id（现在仍是自由字符串）。
- **受上游限制**：WorkBuddy 的认证槽在厂商共享目录里（`CodeBuddyExtension/Data/Public/auth/<authentication.id>.info`）
  ⇒ 本插件**不能**为同区域再新增「真多账号」，只能如实拒绝（这轮实测把这条闸门也一并证据化了）。

## 5. 复现

```powershell
node scripts/build.mjs
node probe/verify-account-target-identity.mjs      # 身份一致性（新）
node probe/verify-managed-account-alias-offline.mjs
node probe/verify-account-target-unify.mjs
node probe/_regression-suite.mjs                   # 18 项

# live：账号 CRUD 的真实目标名校验
Invoke-RestMethod 'http://127.0.0.1:4200/harness-pilot/api/accounts/manage' -Method Post -ContentType 'application/json' `
  -Body '{"kind":"create","input":{"id":"r6-probe-wb","harnessId":"workbuddy","targetName":"wb-managed-a","displayName":"探测"}}'
```
