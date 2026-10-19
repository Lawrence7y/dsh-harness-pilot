# 2026-10-14 22:3x · 第十三轮：多账号真隔离验收（需求 ④ 收尾）

## 1. 本轮验的三件事（全部真派发；argv 取 **CLI 自己的 run manifest**）

headless 路径的 `/dispatch.facts` 现在不回报 argv（改成 `argvChars`），所以本轮的 argv 证据一律取自
`…\.dsh\harness-accounts\<账号>\logs\runs\<时间戳>\manifest.json` —— 那是**CLI 自己写的**，
不是插件的自述。账号 id 在插件输出里是**脱敏标签**（`acct:…-xx`），比对用插件自己的 `redactAccount()` 换算。

### ① 四路并发（2 WorkBuddy + 2 Qoder）— 既有探针，本轮复跑
```
wb-managed-a       completed 22395ms  own-marker=YES foreign=[] identity=wb-managed-a/acp/01a13a9e…
wb-managed-ai-b    completed 17783ms  own-marker=YES foreign=[] identity=wb-managed-ai-b/acp/01a13a9e-783c…
qoder-cn-acct-a    completed 15367ms  own-marker=YES foreign=[] identity=qoder-cn-acct-a/headless
qoder-cn-acct-b    completed 13783ms  own-marker=YES foreign=[] identity=qoder-cn-acct-b/headless
PASS — 4 条并发真实任务各自只含自己的标记，身份互不相同
```

### ② 认证隔离 + 「空认证不回退」
```
A1 已登录国际账号：/dispatch {target:'qodercli', accountId:'qoder-intl-a'} → completed
   manifest argv = bun … --config-dir C:\Users\Administrator\.dsh\harness-accounts\qoder-intl-a -p
   该账号目录 manifest 84 → 85（CLI 自己记的）
A2 不带账号对照：→ error，qodercli 输出 `Not logged in · Please run /login`（默认根未登录）
   ⇒ 合起来证明「凭据可见性跟着配置目录走」，而不是插件借了别的身份
A3 反向对照（**真空认证**）：新建临时账号 r7-probe-intl-****（fresh 空目录）→ dispatch → error
   manifest argv = … --config-dir …\harness-accounts\r7-probe-intl-**** -p
   ⇒ 既没回退到已登录的 qoder-intl-a，也没回退到默认根；测试后账号已删、目录已清（.auth 下只有
     machine_id 这种脚手架文件，无凭据才删）
```

### ③ 切默认账号**不影响在跑任务**（需求 ④ 原文）
```
池默认 = qoder-cn-a  →  启动 T1（不带 accountId，启动那一刻捕获账号）
T1 started 13:39:17.284 → 改默认账号为 qoder-cn-b 13:39:17.317（**运行期间**，相隔 33ms）→ 结束 13:39:29.399
T1：status=completed  actual=acct:…-aa（= qoder-cn-a）
    manifest 增量：qoder-cn-a 589→590；qoder-cn-b 313→**313（零增量）**
T2（切换后新起）：actual=acct:…-ba（= qoder-cn-b）；manifest qoder-cn-b 313→314
池默认已还原为空
```
⇒ 在跑任务保持「启动时捕获」的账号；新任务用新默认账号。两条都由**两个账号目录的 manifest 增量**独立佐证。

## 2. 顺手把实测结论写回档案披露（不夸大）

`src/federation/accounts.ts` 的 qoder-intl 隔离档案原先写着「认证隔离及双账号并行尚未验收」。
本轮拿到了**正向对照**，于是改成：

> 认证可见性**已实测**跟着 `--config-dir` 走（默认根未登录 / 账号目录成功；空认证账号不回退到任何别的目录），
> 但「两个**已登录**国际账号并行」仍未验证，凭据文件是否另有机器级副本未查 —— 不继承国内版两账号实测结论。

`authStoreIsolated` 仍保留 `false`（那是保守口径：不等于已验证「任意数量国际账号可并行」），
新增的是 `evidence[]` 里的两条实测记录 —— **结论跟着证据走，而不是把未验证说成已验证**。

## 3. 三态清单

- **已实现且实测通过**：
  ① 四路并发（2 WB + 2 Qoder）各自标记不串、身份互不相同；
  ② Qoder 国际：账号目录成功 / 默认根 `Not logged in` ⇒ 认证随配置目录；空认证账号**不回退**（argv 指向自己）；
  ③ 在跑任务切默认账号不受影响（含 33ms 时间窗 + 两个账号目录 manifest 增量双向佐证），新任务用新默认账号；
  ④ 测试现场已还原（池默认空、临时账号删除、临时目录清除、账号登记表无残留）。
- **已实现但未验证**：两个**已登录**的国际账号并行（本机只有一个已登录国际账号，第二个需要用户交互登录）；
  WorkBuddy 两条并行时的**认证槽**仍为厂商共享（已有披露，本轮未新增证据）。
- **尚未实现（下一轮）**：① Antigravity 共享认证槽边界在设置页的**显式说明**（现在只在隔离档案/接口里）；
  ② `harness_agent` / 任务工具的 `model` 收敛到新分组 id；③ 设置页「模型来源与四类」真浏览器点击验收。
- **受上游限制**：WorkBuddy 认证槽在厂商共享目录 ⇒ 同区域不能真多账号（只能如实拒绝）；
  Qoder 国际的第二个已登录账号必须由用户完成原生登录。

## 4. 复现

```powershell
node scripts/build.mjs
node probe/verify-concurrency-acceptance.mjs        # 四路并发（真任务）
node probe/verify-account-isolation-acceptance.mjs  # 本轮新增：A 认证隔离/不回退 · B 切默认账号
node probe/_regression-suite.mjs                    # 19 项
```
