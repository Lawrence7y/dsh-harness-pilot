# 真实环境中观察到的「额度/限流」错误形状（实测摘录）

> 本文件记录**在真实运行中观察到的原文错误**，用于校准 `src/federation/quota.ts` 的判定器。
> 与 `probe/verify-quota-pool.mjs` 里的**结构化错误注入**不同 —— **这些是真实发生的**，
> 因此可以用来讨论「注入用例是否忠实反映了现实」。
> 来源：`~/.dsh/plugins/harness-pilot/tasks/*.result.json` 与任务账本的 `diagnostic` 字段。

## 观察 1：agy —— 明确声称配额耗尽，但 HTTP 语义是 429

原文字段（`diagnostic` 的 stderr 摘录）：

```
harness exited with code 3 after producing output; stderr tail:
error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h22m59s.
| AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h22m59s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,"error_id":"..."}
```

多次复现，另有变体：`Resets in 4h42m6s`、`Resets in 2h23m0s`（不同模型各自有配额）。

**这暴露了判定器的一个真实边界**：
`quota.ts` 的规则是「**HTTP 429 → 瞬时限流 → 一律 unknown，绝不判 exhausted**」（§1.19 刻意为之）。
而这里 agy **确实**报告了配额耗尽（`RESOURCE_EXHAUSTED`），只是**用 429 承载**。
于是判定器会输出 `unknown`。

**这个取舍本身是有意设计的**（把限流误判成耗尽的代价更大：误停账号、账号间横跳、重复消耗），
但必须**如实记录**：它会漏掉「以 429 表达的**真**配额耗尽」这一族。

可行的改进方向（尚未实施、也**尚未验证**）：
- 当同一个错误里**同时**出现 (a) 显式的配额/资源耗尽语义字段（如 `status: "RESOURCE_EXHAUSTED"`、
  `error_code: 429` **带有** `short_error` 里明确的 quota/reset 语义）与 (b) 明确的重置时间
  （`Resets in …`）时，可以考虑按**结构化信号**而非 HTTP 状态码判定；
- 但**必须**同时保留一个反向保护：**没有明确配额语义、只有 429 的错误仍然一律 unknown**。

**在未完成上述验证之前，当前行为（判为 unknown）不应被改掉** —— 改判需要独立的、
可复现的证据，而不是「看起来像」。

## 观察 2：opencode —— ACP 层的 usage limit

```
acp session ended without reporting a stop reason;
acp session failed: Internal error: Go usage limit exceeded
```

多次复现（`target=opencode transport=acp`，数秒内即失败）。

**注意**：`"Go usage limit exceeded"` **不匹配** `quota.ts` 里的 `QUOTA_WORDS`
（该正则含 `quota|credit|balance|额度|配额|余额`，**不含 `usage limit`**）。
因此它会落到兜底的 `unknown`，且连「疑似」都不会标。

也就是说：**这族错误的文本信号目前完全没被识别**。同样是「保守」方向的漏判，不影响安全，
但会让「额度未知」这一显示缺少可解释性。改进方向：把 `usage limit` / `rate limit` 区分开
（前者偏配额、后者偏限流），但**同样需要先有独立证据**再改。

## 观察 3：回执失败 —— 与额度无关，但值得单独记一笔

```
回执: notify=true session=… status=failed
error=session "…" is owned by subagent routing
```

**子代理发起的任务，其完成回执无法投递** —— 因为目标会话属于「子代理路由」，插件无权唤醒它。
这不是额度问题，而是**子代理 ↔ 回执链路的真实边界**，应在文档与界面上如实说明：
「子代理会话中发起的后台任务，其回执无法送回」。
（本轮观察到大量此类失败，来源是并行运行的子代理。）

## 结论

1. **真实环境中确实存在配额耗尽信号**，且至少有两种形状（agy 的 `RESOURCE_EXHAUSTED`/429、
   opencode 的 `Go usage limit exceeded`）。
2. 当前判定器对这两者**都输出 unknown** —— 这是**有意的保守**，但属于**已知漏判**，
   不能声称「额度判定已完整」。
3. `probe/verify-quota-pool.mjs` 里的 3 个 `exhausted` 用例是**注入**，与上面这些真实形状**并不相同**；
   报告里必须继续把它们区分开。
4. 任何改判都必须先有独立、可复现的证据；**不得因为「看起来像」就放宽判定**。
