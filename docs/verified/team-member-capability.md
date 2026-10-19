# 外部 Harness 作为「原生智能体团队成员」：契约核查与可行性结论

- **核查对象**：运行版 DSH `0.2.0-rc.2`，模块树 `D:\Project\_dsh-host-0.2.0-rc.2\node_modules\@deepseek-ai\`
- **核查方式**：只读。读源码 + `cordis_inspect_*`（platform=host）查**运行中**的 loader 装配。**没有**发起任何模型请求。
- **核查者**：调研子代理（只读）。唯一写入的文件是本文件。
- **日期**：以工作区当前状态为准。

> **阅读须知**：本文档严格分档。凡标 **确证** 的结论都指到 `file:line`；标 **推断** 的写清依据；标 **未查** 的明确说没查。
> 本项目对把推断写成确证零容忍，因此**下面第 5 节请先读**。

---

## 0. 一句话结论

**`prepareContinuable` 可以实现，而且宿主只要求它返回一个可选的 `seed`（`ContinuableCreateSpec` 只有 `seed` 一个字段）。
但实现它并不会让外部 CLI 成为团队成员** —— 因为可继续子代理的 **Agent 本体由宿主在进程内创建**（`ownerCtx.agents.create/resume`），
provider 名在该路径上**只被当作一个观测标签**。实现它只会得到一个「**顶着 `harness-xxx` 名字的进程内 DSH 子代理**」，
即把失败换成了一句谎话。真正的卡点不是「能力没开」，而是**「可继续子代理」这条契约里根本没有把子代理交给 provider 的接口**。

---

## 1. `prepareContinuable` 的精确契约

### 1.1 签名与类型（**确证**）

从运行版模块树读出，非猜测：

```ts
// dsh-subagent/lib/typert.host.js:759
export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
```

```ts
// dsh-subagent/lib/typert.host.js:334-335  ← 入参
export interface ContinuableCreateRequest {
  readonly sessionId: SessionId
  readonly parent: Agent
  readonly signal: AbortSignal
}

// dsh-subagent/lib/typert.host.js:338-339  ← 返回值（注意：只有一个字段，且可选）
export interface ContinuableCreateSpec {
  readonly seed?: readonly SessionEvent[]
}

// dsh-subagent/lib/typert.host.js:342-343  ← 调用方拿到的返回
export interface ContinuableStart {
  readonly childId: SessionId
  readonly messageId: MessageId
}

// dsh-subagent/lib/typert.host.js:346-347  ← 调用方传入的 spec
export interface ContinuableStartSpec {
  readonly provider: string
  readonly label: string
  readonly childId?: SessionId
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
  readonly signal: AbortSignal
}
```

**入参**：只有 `sessionId`（宿主**已经**分配好的子会话 id）、`parent`（**精确的活 Agent**，即 Lead）、`signal`。
**没有** `prompt`、**没有** `label`、**没有** `agentOptions`、**没有** `cwd`、**没有**任何账号字段。
（`ContinuableCreateRequest` 的完整声明就这三行，见 `typert.host.js:335`。）

**返回值**：`{ seed? }`。`seed` 是**父级会话日志的前缀事件数组**，用来给子会话做「继承上下文」的种子。
`ContinuableStartSpec.request` 是 `Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>` ——
**`outputSchema` 在可继续路径上被显式排除**，所以团队路径永远不可能有结构化输出。

**关键否定结论（确证）**：`ContinuableCreateSpec` 里**没有** `run`、**没有** `handle`、**没有** `agent`、**没有** `dispose`、
**没有** `localAgent`、**没有** `result`。**没有任何字段能把一个进程、一个句柄或一个 run 交给宿主。**

### 1.2 生命周期：谁调用、何时调用、几次（**确证**）

`prepareContinuable` 在**整个运行版模块树里只有一个调用点**：

```js
// dsh-subagent/lib/types/continuation.js:134-138（SubagentContinuationManager.startContinuable 内）
const prepared = await this.host.prepareContinuable(spec.provider, {
  sessionId: childId,
  parent,
  signal: spec.signal,
})
spec.signal.throwIfAborted()
```

宿主侧的转发与**抛错点**：

```js
// dsh-subagent/lib/index.js:3149-3153
async prepareContinuable(name, request) {
  const provider = this.expectProvider(name)                    // :3150 未知 provider → NO_PROVIDER
  if (provider.prepareContinuable === void 0)
    throw new SubagentError(
      `subagent provider "${provider.name}" does not support continuable children (no prepareContinuable capability)`,
      "UNSUPPORTED_CAPABILITY")                                 // :3151 ← 本项目的实际抛错点
  return provider.prepareContinuable(request)                   // :3152
}
```

（同一份实现还有一份等价副本在 `dsh-subagent/lib/types/index.js:426-432`，抛错文案一致。以 `lib/index.js` 为准。）

- **谁调用**：`SubagentContinuationManager.startContinuable`（`continuation.js:101`）。
- **何时调用**：在分配 `childId`（`:107`）、快照 descriptor（`:116`）、捕获委派策略（`:128`）、
  `holdOwnership`（`:132`）**之后**，在**任何子 Agent 被创建之前**（`:156` 的 `materialize` 之前）。
- **调用几次**：**一次**，而且是**同步等待**（`await`）。
- **是否要返回常驻句柄**：**不要，也无法返回**。返回值只被读一个字段：
  ```js
  // dsh-subagent/lib/types/continuation.js:141-142
  const inheritedEventCount = SessionLogOffset(prepared.seed?.length ?? 0)
  const seed = prepared.seed
  ```
  **`prepared` 的其余全部内容都被丢弃。**
- **取消**：走 `spec.signal`（`ContinuableCreateRequest.signal`），宿主在 `:139`、`:144` 等处以 `throwIfAborted()` 检查；
  provider 自己若不监听这个 signal，宿主并**不**因此失败。运行期的取消**不**经过 provider（见 §3）。
- **恢复**：**不经过 provider**。`coldResume`（`continuation.js:338-391`）明确写着
  「The descriptor supplies every reconstruction input; **no subagent provider is dispatched**」（`:336`）。
- **通信**：**不经过 provider**。见 §3。

### 1.3 两个在版实现（**确证**）—— 这是最有说服力的一条证据

运行版模块树里**只有两个** `ctx.subagents.registerProvider` 实现（全树 grep `registerProvider(` 所得）：

```js
// dsh-subagent-spawn-in-process/lib/index.js:37-39
prepareContinuable() {
  return Promise.resolve({})          // ← 连参数都不接，返回空对象
}

// dsh-subagent-fork-in-process/lib/index.js:52-55
prepareContinuable(request) {
  const seed = completedTurnPrefix(request.parent)   // 唯一用途：切父级日志前缀
  return Promise.resolve(seed.length > 0 ? { seed } : {})
}
```

**两个在版实现的 `prepareContinuable` 都只是「返回一个 seed（或什么都不返回）」的纯函数。**
它们不持有进程、不持有句柄、不参与子代理的运行、取消、恢复或通信。
`registerProvider` 的另两处（`dsh-subagent/lib/index.js:3076`、`lib/types/index.js:345`）是注册表本身。

> **推论强度说明**：宿主没有为「进程外 provider」提供可继续子代理的**任何**示例实现。
> 而 `out-of-process.js` 这个**专为进程外后端写的模块**（`dsh-subagent/lib/types/out-of-process.js`）
> 导出的三件套 —— `NO_START_CAPABILITIES`（`:49-55`）、`settleRunResult`（`:163-194`）、
> `subprocessRunHandle`（`:203-218`）—— **全部服务于一次性 `start`**；
> `dsh-subagent/lib/index.js:3201` 的导出清单里**没有任何**「进程外 + 可继续」的辅助函数。

### 1.4 为什么 provider 拿不到子代理：`materialize` 走的是进程内 Agent 工厂（**确证**）

`prepareContinuable` 返回后，宿主自己做剩下的一切：

```js
// dsh-subagent/lib/types/continuation.js:156-170（节选）
const activation = await this.activations.materialize({
  childId,
  provider: spec.provider,          // ← 这里传进去的 provider 是个「名字字符串」
  parent,
  create: { seed, meta: childSessionMeta(...), inheritedEventCount, delegatedPolicies, descriptor },
  agentOptions,                     // ← 来自 resolveChildAgentOptions(parent, ...)
  composition: { persona, toolFilter },
  signal: spec.signal,
})
```

在 `ContinuableActivationRegistry.materializeTracked` 里：

```js
// dsh-subagent/lib/types/continuation-activation.js:437-467（节选）
async materializeTracked(inputs, parentLineage, pool, releaseSlot) {
  const { childId, provider, parent, create } = inputs
  ...
  const observer = this.observeActivation(provider, childId, parent)   // :449 provider 仅作观测标签
  const handle = create === undefined
    ? await this.ownerCtx.agents.resume({ resumeSessionId: childId, parentAgent: parent, ... })   // :451-457
    : await this.ownerCtx.agents.create({ sessionId: childId, parentAgent: parent, meta: create.meta,
        ...(create.seed === undefined ? {} : { seed: create.seed }),
        inheritedEventCount: create.inheritedEventCount,
        agentOptions: inputs.agentOptions, signal: inputs.signal, setup })                        // :458-467
  ...
}
```

`observeActivation` 的宿主实现：

```js
// dsh-subagent/lib/index.js:3169-3171
observeActivation(provider, childId, parent) {
  return createActivationObserver(this.emitLifecycle, provider, childId, parent)
}
```

**结论（确证 + 一步推断）**：
- **确证**：`materializeTracked` 里**没有任何 `provider.*` 调用**。`provider` 只出现在 `:449` 的观测器参数里，
  而观测器把它用于生命周期事件（`emitLifecycle`）。
- **确证**：子 Agent 由 `this.ownerCtx.agents.create(...)` / `.resume(...)` 创建 —— 这是**宿主的进程内 Agent 工厂**。
- **推断（依据即上述两条，且穷举了该函数的全部分支）**：因此**无论 `prepareContinuable` 返回什么**，
  团队成员都会是一个**进程内 DSH Agent**。外部 CLI **不可能**被这条路径启动。
  → 「给 provider 加上 `prepareContinuable` 就能让外部 Harness 当团队成员」是**错的**。

### 1.5 子代理的模型路由也不经过 provider（**确证**）

```js
// dsh-subagent/lib/types/child-agent.js:75-93
export function resolveChildAgentOptions(parent, requested, childDepth) {
  const parentOptions = parentAgentOptionsForDelegation(parent)   // :76 全部取自父 Agent
  ...
  const resolved = { ...provider/model/reasoningEffort/maxTokens 来自父, ...requested, subagentDepth: childDepth }
```

`resolveChildAgentOptions` 在 `continuation.js:112` 被调用（可继续路径），父级的 provider/model **原样继承**，
只有 `requested`（即 `request.agentOptions`）能覆盖。**函数内没有任何 `provider` 参数。**

而 `agentRouteDefaults` 在**整个运行版模块树里只被读一处**：

```
grep agentRouteDefaults → 5 hits，其中 4 处是类型声明/README，唯一的**运行时代码**读取点：
dsh-tool-subagent/lib/index.js:394   const providerRouteDefaults = subagentProvider.agentRouteDefaults
                   :496-497   requestedAgentOptions(..., { ...providerRouteDefaults, ... })
                   :504       preflightChildLlmRoute(..., providerRouteDefaults === void 0)
```

—— 那是**一次性 `subagent` 工具**的 `mount()`（`:391`）内部，服务的是 `ctx.subagents.start()` 这条一次性链路。
**可继续（团队）路径从不读 `agentRouteDefaults`。**

> ### ⚠️ 对上级既定前提的一处更正（**确证**）
>
> 既定前提称「进程外 provider 是 `NO_START_CAPABILITIES`，声明 `agentRouteDefaults` 会被 `assertCapabilities` 直接拒」。
>
> **rc.2 代码不支持这个因果**：
> - `assertCapabilities`（`dsh-subagent/lib/index.js:3173-3197`）只检查五个布尔能力 ——
>   `agentOptions` / `outputSchema` / `depthLimit` / `toolFilter` / `persona`（`:3174-3195`）。
>   **它不读、也无法读 `agentRouteDefaults`。** 而且它只在 `start()` 里被调用（`:3117`），
>   可继续路径**根本不会调用它**。
> - 全树 grep `agentRouteDefaults` 的 5 处命中里**没有任何校验逻辑**。
>
> **真实存在的拒绝机制**（如果确实观测到「声明后被拒」）在这两处：
> - `dsh-tool-subagent/lib/index.js:378-380`（`assertSubagentProviderConfiguration`）：
>   `config.agentOptions !== undefined && !capabilities.agentOptions` → 抛错；
>   `modelSelectionCapable && !capabilities.agentOptions` → 抛错「does not support child model selection」；
>   `continuable && prepareContinuable === void 0` → 抛错。
> - 触发条件由**工具条目的 config**（是否开模型选择 / 是否给 `agentOptions` / 是否 `backgroundMode: continuable`）决定，
>   **不是**由 provider 声明 `agentRouteDefaults` 决定。
>
> 结论：**「声明 `agentRouteDefaults` 会被拒」应改写为「若同时把该 provider 绑到开启了
> 模型选择或 `agentOptions` 的 `dsh-tool-subagent` 条目上，会在工具挂载时被拒」**。
> 两者对结论的方向没影响（团队路径都到不了），但**机制必须记对**，否则后续会在错误的点上找原因。

---

## 2. `startContinuable` 的完整调用链

### 2.1 团队路径的完整链条（**确证**）

```
模型调用 spawn_teammate 工具
  └─ dsh-experimental-tool-agent-team/lib/index.js:242-293   defineTool({ name: "spawn_teammate", ... })
       ├─ :270  const context = args.context ?? "fresh"
       ├─ :289  context                              → 'fresh' | 'fork'
       ├─ :290  provider: context === "fork" ? config.forkProvider : config.freshProvider   ← provider 名字来自**工具配置**
       └─ :271  ctx.agentTeams.spawnTeammate(agent, { name, description, prompt, context, provider, signal })
            └─ dsh-experimental-agent-team/lib/types/roster.js:222  spawnAdmitted(caller, request)
                 ├─ :224-226  非 Lead → TEAM_LEAD_REQUIRED
                 ├─ :237      member = { id, name, description, provider: request.provider, context, phase: 'provisioning' }
                 ├─ :241-250  写 journal：'team/member'（此时 phase=provisioning）
                 ├─ :253-262  ⚠️ **本项目的实际入口**
                 │     started = await this.ctx.subagents.startContinuable({
                 │       childId,                       // :232 这里**预先**生成了随机 UUID
                 │       provider: request.provider,    // 'spawn' / 'fork' / （若配置为）'harness-xxx'
                 │       label: description,
                 │       request: { prompt: request.prompt, parent: root },   // :257-260 ⚠️ 只传 prompt 与 parent
                 │       signal,
                 │     })
                 │       └─ dsh-subagent/lib/index.js:2879  SubagentRuntime.startContinuable
                 │            └─ :2880  requireContinuations().startContinuable(spec)
                 │                 ├─ :3162  无 agents 服务 → CONTINUATION_UNAVAILABLE
                 │                 └─ dsh-subagent/lib/types/continuation.js:101  SubagentContinuationManager.startContinuable
                 │                      ├─ :104  activations.assertAdmitting(parent)
                 │                      ├─ :105  requirePersistence()        → 无持久化 → PERSISTENCE_UNAVAILABLE (:441)
                 │                      ├─ :107  childId（已由 roster 传入）
                 │                      ├─ :109  resolveChildDepth
                 │                      ├─ :112  resolveChildAgentOptions(parent, request.agentOptions, childDepth)
                 │                      │        ⚠️ request.agentOptions === undefined（团队路径不传）
                 │                      │        ⇒ **子代理原样继承 Lead 的 provider/model**
                 │                      ├─ :116  snapshotSubagentDescriptor({ mode:'continuable', provider, ... })
                 │                      ├─ :128  captureDelegatedPolicyOverrides(parent)
                 │                      ├─ :132  holdOwnership
                 │                      ├─ :134  host.prepareContinuable(spec.provider, { sessionId, parent, signal })
                 │                      │        └─ dsh-subagent/lib/index.js:3149-3153
                 │                      │             ❌ provider.prepareContinuable === undefined
                 │                      │             ⇒ **throw SubagentError(..., "UNSUPPORTED_CAPABILITY")  ← 抛错点 :3151**
                 │                      ├─ :141-142  prepared.seed   （若能走到这里）
                 │                      ├─ :156  activations.materialize(...)
                 │                      │        └─ continuation-activation.js:437 materializeTracked
                 │                      │             :449  observeActivation(provider, ...)      ← provider 仅作标签
                 │                      │             :450-467 ownerCtx.agents.create/resume    ← **进程内 Agent**
                 │                      ├─ :172  submitMaterialized（把初始 prompt 投进子 Agent 的 inbox）
                 │                      │        :174  establishCatalogChild(...)
                 │                      └─ :176  return { childId, messageId }
                 └─ :265-282  catch (error)      ← **本项目的失败落点**
                      ├─ :266-270  failed = { ...member, phase: 'failed', error: errorMessage(error) }
                      ├─ :272      settleProvisioning(root, failed)    → 写 journal，成员定稿为 failed
                      ├─ :273      stopTeammates(root, [childId])
                      └─ :281      throw error                         → 工具调用报错
```

### 2.2 抛错点与失败可见性（**确证**）

- **抛错点**：`dsh-subagent/lib/index.js:3151`（`UNSUPPORTED_CAPABILITY`）。
  在宿主 `lib/index.js:2879-2880` 只有一层转发，**没有任何前置能力预检** ——
  即团队路径**不会**在 `spawn_teammate` 入口就拒绝，而是**走到 `prepareContinuable` 才抛**。
- **失败被吞成成员状态**：`roster.js:265-282` 捕获后**不重抛给调用方以外的地方**，
  而是把成员**永久定稿为 `phase: 'failed'`**（`:268-269`）并**先把错误写进 journal**（`:272`）。
  所以「成员详情只能看到失败」正是这条路径的**设计行为**，不是渲染缺陷。
- **错误文案能到模型**：`roster.js:131`——
  `diagnostics: member.error === undefined ? [] : [member.error]`，
  即 `UNSUPPORTED_CAPABILITY` 的原文会出现在 `list_agents` 的 `diagnostics` 里。

### 2.3 若实现了 `prepareContinuable`，后续会依次调用什么（**确证**）

按源码顺序，**不会再调用 provider 的任何方法**：

| 步骤 | 调用 | 位置 |
|---|---|---|
| 1 | `provider.prepareContinuable(request)` | `dsh-subagent/lib/index.js:3152` |
| 2 | `spec.signal.throwIfAborted()` | `continuation.js:139` |
| 3 | `SessionLogOffset(prepared.seed?.length ?? 0)` | `continuation.js:141` |
| 4 | `locks.run(childId, …)` → `persistence.stat(childId)`（仅当显式给了 childId） | `continuation.js:143`、`:148` |
| 5 | `activations.materialize(...)` → **`ownerCtx.agents.create({...})`**（或 `resume`） | `continuation-activation.js:458`（或 `:451`） |
| 6 | `setup(childCtx, child)`：`session.append('subagent/descriptor')`、`appendDelegatedPolicyOverrides`、`applyChildComposition` | `continuation-activation.js:440-448` |
| 7 | `new SubagentInbox(handle.agent)`、`resident.set(childId, activation)`、`observer.start(handle.agent)` | `continuation-activation.js:475`、`:482`、`:490` |
| 8 | `submitMaterialized(...)` → `submitAdmitted` → `activation.inbox.deliver(message, 'queue')` | `continuation.js:172`、`:401`、`continuation-activation.js:359` |
| 9 | `establishCatalogChild(parent.session, childHeader, descriptor)` | `continuation.js:174` |

**provider 在 5–9 步里完全不出现。** 唯一的残留影响是第 5 步通过 `agentOptions` 决定的模型路由，
而那个 `agentOptions` 来自**父 Agent**（`:112` → `child-agent.js:75`），与 provider 无关。

---

## 3. 团队通信机制，以及它对进程外 CLI 意味着什么

### 3.1 成员之间如何传消息（**确证**）

```
send_message 工具  dsh-experimental-tool-agent-team/lib/index.js:296-321
  └─ :312  ctx.agentTeams.sendMessage(caller, { target, content, signal })
       └─ dsh-experimental-agent-team/lib/types/mailbox.js:39  send(...)
            ├─ :102-129  写 journal 'team/message/queued'（先落盘，再投递）
            └─ :134/:158 dispatchOnce → 按目标顺序投递
                 ├─ :218  root.steer(input)                                  ← 目标是 **Lead** 本身
                 └─ :230  steerHostSubagentPrompt(this.ctx.subagents, root, message.targetId, content, source, signal)
                          ← 目标是 **teammate**
```

`steerHostSubagentPrompt` 是宿主内部适配器：

```js
// dsh-subagent/lib/types/internal.js:55-57
export function steerHostSubagentPrompt(runtime, parent, childId, content, source, signal) {
  return runtime[deliverSubagentPrompt](parent, childId, content, source, signal, 'steer')
}
```

它落到 `SubagentContinuationManager.steerPrompt`：

```js
// dsh-subagent/lib/types/continuation.js:234-236 → :238-248 deliverToChild → :250-280 deliverFollowup
async deliverFollowup(parent, childId, content, options) {
  while (true) {
    const live = await this.activations.locks.run(childId, async () => {
      const activation = this.activations.get(childId)
      if (activation === undefined)
        return this.coldResume(parent, childId, content, options)   // :255 ← 目标不在内存 → 冷恢复
      ...
      const messageId = this.submitAdmitted(activation, content, options, parent)   // :269 ← 在内存 → 投 inbox
```

**两种投递形态**（这是理解「进程外 CLI 行不行」的关键）：

1. **目标常驻**（`activations.get(childId) !== undefined`）：消息进**进程内 Agent 的 inbox**（`:269` → `:359` `activation.inbox.deliver(...)`）。
2. **目标不常驻**（进程重启过、或已被回收）：`coldResume`（`:338-391`）——
   从**持久化会话**重放 descriptor，再 `materialize` 出一个**进程内 Agent**。
   `:336` 的注释是原话：**"no subagent provider is dispatched"**。

### 3.2 取消与恢复如何传播（**确证**）

```js
// dsh-experimental-agent-team/lib/types/roster.js:190（interrupt_agent 工具 → interrupt）
this.ctx.subagents.interrupt(target.id, { kind: 'ancestor', agent: caller })
  └─ dsh-subagent/lib/types/continuation.js:288-290  interrupt(targetSessionId, authority)
       └─ continuation-activation.js:155  interrupt(targetSessionId, authority)
            └─ :180  activation.handle.agent.cancel(
                       authority.kind === 'user' ? { kind: 'user' } : { kind: 'parent' },
                       { keepInbox: true })
```

- **取消**走的是 **`Agent.cancel()`** —— 一个**进程内 Agent 的方法**（`typert.host.js:231` 的 `Agent` 契约）。
- **释放/停止**成员：`roster.js:218-220` `stopTeammates` → `ctx.subagents.drainContinuableChildren(root, childIds)`
  → `activations.dispose(...)` → `activation.inbox.close(...)` + `activation.handle.dispose()`（`continuation-activation.js:372-374`、`:505`）。
- **自然结算**：`continuation-activation.js:618` 也是 `activation.handle.agent.cancel({ kind: 'parent' })`。

### 3.3 对进程外 CLI 意味着什么（**推断**，依据是 3.1/3.2 的确证事实）

| 团队机制 | 契约要求 | 外部 CLI 是否具备 |
|---|---|---|
| 收消息 | 目标必须是 `ctx.agents.get(id)` 能取到的**活 Agent**，消息进它的 `Inbox` | ❌ CLI 进程不是 `Agent`；宿主**没有任何**「把消息写到 provider」的接口 |
| 冷恢复 | 必须能从**宿主持久化会话**重放出 Agent | ❌ CLI 的会话不在宿主的 session log 里，`foldSubagentDescriptor` 拿不到 `mode:'continuable'` |
| 取消 | `Agent.cancel(cause, { keepInbox: true })` | ❌ 没有 `Agent` 可 cancel；provider 的 `start` 路径靠 `AbortSignal` + `subprocessRunHandle.dispose()`，**可继续路径完全不经过这套** |
| 恢复 | descriptor（`mode/provider/agentProvider/agentModel/persona/toolFilter`）驱动的 `materialize` | ❌ provider 无字段可写入 descriptor |
| 任务分配 | `team_task_*` 工具挂在**成员 Agent 的 scope** 上（`tool-agent-team/lib/index.js:533-546`） | ❌ CLI 进程拿不到 DSH 的 scoped tools |
| 共享工作目录 | 成员与 Lead 同一 cwd（POLICY 明文） | ⚠️ 可以做到（`resolveChildCwd`），但那是 `start` 路径的机制 |

**结论（推断）**：在这条契约下，**require 一个常驻进程并不能解决问题** ——
问题不是「CLI 是否常驻」，而是**「可继续子代理」这条链路根本没有把子代理的所有权交给 provider 的接口**。
即使你让 CLI 常驻并自己实现一个 ACP/stdin 消息通道，宿主的 `send_message`/`interrupt_agent`/`list_agents`
**仍然只会去找一个进程内 `Agent`**，找不到就把成员当作「不常驻」去 `coldResume`，而 `coldResume` 又会
在进程内造一个 Agent 出来。**常驻 CLI 会被彻底绕过。**

**（推断）唯一能让「常驻」有意义的情形**：你**不使用**可继续路径，改用一次性 `start`
（`ctx.subagents.start`，`dsh-subagent/lib/index.js:3115-3143`）—— 那是唯一 provider 真正拥有 run 的路径：
`provider.start(resolved)` → `SubagentRun { id, localAgent, result, dispose() }`（`typert.host.js:767`），
进程外后端用 `localAgent: undefined`（`out-of-process.js:208`）表示「不是我建的 Agent」。
但**一次性路径没有团队语义**：没有 roster、没有 mailbox、没有 `phase`、没有 `team_task_*`。
即：**「团队」与「进程外」在 rc.2 里是两条互斥的链路。**

---

## 4. 可行性结论

### 4.1 能否实现？—— **不能（在当前契约下）**，卡在哪一条（**确证**）

**不能。** 卡点**不是** `TeamMemberView` 不能加列，**也不是** provider 没声明能力，而是：

> **`ContinuableCreateSpec` 只有 `seed` 一个字段**（`dsh-subagent/lib/typert.host.js:338-339`），
> **而子 Agent 的创建被硬编码在宿主侧的 `ContinuableActivationRegistry.materializeTracked`
> 里**（`dsh-subagent/lib/types/continuation-activation.js:450-467`，`ownerCtx.agents.create/resume`），
> **该函数不存在任何 provider 调用分支。**

与之配套的三条**契约级**事实（每条都已确证）：

1. **可继续路径不派发 provider** —— 恢复路径的宿主注释原话：`no subagent provider is dispatched`（`continuation.js:336`）。
2. **通信/取消都绑定在 `Agent` 对象上** —— `activation.inbox.deliver(...)`（`continuation-activation.js:359`）、
   `activation.handle.agent.cancel(...)`（`:180`、`:618`）。
3. **provider 名在可继续路径上只作观测标签** —— `observeActivation(provider, childId, parent)`（`continuation-activation.js:449`）。

**因此「新增能力」这一说法需要修正**：外部独立核查说「需要新增能力」，方向对但不够准 ——
需要的不是「给 provider 加一个能力位」，而是**新增一条把子代理所有权让渡给 provider 的宿主契约**
（例如 `ContinuableCreateSpec` 增加一个可选的 `attach`/`run` 字段，并让 `materialize` 在它存在时
跳过 `ownerCtx.agents.create`，改由 provider 提供 handle + 消息投递 + 取消的适配器）。
**这是宿主改代码，不是插件改代码** —— 插件侧**没有任何**可用的接缝能绕过它。

### 4.2 若能，最小可行实现是什么？（**推断** —— 且是「假成员」警告）

**「能让 `spawn_teammate` 不报错」的最小改动只有一行**：

```ts
// src/provider.ts —— HarnessProvider 类里加
prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
  return Promise.resolve({})     // 与 dsh-subagent-spawn-in-process/lib/index.js:37-39 完全一致
}
```

**但强烈建议不要单独这么做**（**推断**，依据 §1.4）：这会让 `spawn_teammate` **成功**，
成员 `phase` 变 `active`、`provider` 列显示 `harness-xxx`，**可实际上跑的是一个继承 Lead 路由的进程内 DSH 子代理**，
外部 Harness **一次都没被调用**。这把一个**诚实的失败**换成了一个**会骗人的成功** ——
与本项目「不把推断写成确证」的纪律直接冲突。

> 若一定要走「让成员能用外部 CLI 思考」的路，**真正可行的架构不是 provider，而是 LLM 路由**（**推断**，见 §4.4）：
> 成员保持为**进程内 DSH Agent**（团队机制因此**全部原生可用，零宿主改动**），
> 但它的**模型请求**由本插件已有的 llm-adapter 改道给外部 CLI。
> 这不是「进程外 provider」，而是「**进程内 Agent + 进程外推理**」—— 名字上要写清楚，不能混为一谈。

### 4.3 工作量与风险量级（相对本项目已有模块）

| 方案 | 改动面 | 工作量 | 风险 |
|---|---|---|---|
| **A. 只加 `prepareContinuable` 返回 `{}`** | `src/provider.ts` +1 方法 | **~10 行 / 半小时** | 🔴 **高**：产出**假成员**（§4.2），污染 §5 的诚实性基线 |
| **B. 修宿主契约让 provider 拥有可继续子代理** | **不属于本插件**：`dsh-subagent` 的 `typert.host.js`（类型）、`continuation.js`、`continuation-activation.js`、`materializeTracked`；还要为进程外后端定义消息投递/取消/inbox 适配器 | 🔴 **大**：跨包契约演进 + 需要上游接受 | 🔴 **高**：改动宿主核心生命周期，`drain`/settlement/ownership 语义全都要重审 |
| **C. 进程内成员 + LLM 路由改道到外部 CLI**（**推断可行，未验证**） | `src/llm-adapter.ts`（绑定写入时机）+ `src/index.ts`（事件钩子）；provider 侧**只需** `prepareContinuable` 返回 `{}`（让成员能起来） | 🟡 **中**：需新增「子会话 → 绑定」的写入路径与竞态处理 | 🟡 **中**：改道是**每轮** headless 派发，成员**不是常驻 CLI**；`interrupt_agent` 只能 abort 当轮 LLM 调用，杀不掉 CLI 内部已启动的动作；且会话日志仍记为原生 provider（`llm-adapter.ts:956` 已自陈「归因不实」） |

### 4.4 方案 C 的关键依据（**确证**：机制存在；**未查**：接线时机）

插件已有的改道是**绑定驱动、按 `sessionId` 索引**的：

```ts
// src/llm-adapter.ts:940-963（llm/stream 监听器）
ctx.on('llm/stream', (options, next) => {
  const request = options as { provider?: unknown; purpose?: unknown; sessionId?: unknown }
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
  const binding = sessionId.length > 0 ? deps.bindingFor?.(sessionId) : undefined      // :945 ← 按会话 id 查绑定
  const decision = routeDecisionFor({ provider, purpose, sessionId, binding, advertised })
  if (decision.action === 'next' || decision.target === undefined) return next()
  return adapter.streamFor(options, {
    target: decision.target, origin: 'redirect',
    ...(typeof binding?.accountId === 'string' && binding.accountId.length > 0
        ? { accountId: binding.accountId } : {}),                                       // :961 ← **账号在这里生效**
  })
})
```

```ts
// src/llm-adapter.ts:361-378（routeDecisionFor 的判据）
if (binding.harnessKind !== 'external') return { action: 'next', reason: 'binding-is-native' }   // :373
const target = typeof binding.harnessId === 'string' ? binding.harnessId : ''                    // :374
if (!input.advertised.includes(target)) return { action: 'next', reason: `bound-target-not-advertised:${target}` }  // :376
return { action: 'route', reason: 'binding-external', target }                                    // :377
```

**含义（确证 + 推断）**：
- **确证**：只要某个 `sessionId` 存在 `{ harnessKind: 'external', harnessId: <可用目标名> }` 的绑定，
  该会话**每一轮**模型请求都会被改道给那个外部 CLI（`origin: 'redirect'`）。
- **确证**：绑定里的 `accountId` **会被透传**到 `dispatch`（`:756`、`:961`）
  —— **账号档案在这条路径上是真正生效的**（与 §6.1 的 provider 路径相反）。
- **推断**：因此「成员 = 进程内 Agent，路由被改道到外部 CLI」在机制上成立，且**账号可以套用**。
- **未查**：**给新生的子会话写入绑定**的时机是否可靠。团队成员的子会话 id 是 `roster.js:232`
  在插件外部随机生成的，插件拿不到；可行钩子只有 `agent/created` 之类的生命周期事件
  （`tool-agent-team/lib/index.js:544` 用了同一个事件），必须在子代理**第一次 LLM 请求之前**写进绑定。
  **此竞态我本轮没有验证**，属于「未查」，不得当作可行结论使用。

### 4.5 会不会影响已通过的 4 路并发 / 账号隔离验收？（**确证**：不会）

- 头号验收（§1.14 / §1.33：2×WorkBuddy + 2×Qoder 并发真实任务）跑在
  `POST /harness-pilot/api/dispatch` → `sessions.dispatch` 这条**派发链路**上（`docs/00-verified-status-report.md:370`、`:1160`）。
- SubagentProvider 是**另一条入口**（`docs/00-verified-status-report.md:511` 也把「外部 Harness 作为团队成员」
  与派发链路分开记）。且 `provider.ts:126` 的 `start()` 是**独立实现**，与 `/dispatch` 不共用代码路径。
- `prepareContinuable` 是 `SubagentProvider` 上的**可选方法**（`typert.host.js:759` 的 `?`），
  一次性路径 `start`（`dsh-subagent/lib/index.js:3115-3143`）**从不引用它**；
  `assertCapabilities`（`:3173-3197`）也不读它。
- 因此**新增 `prepareContinuable` 对 §1.14/§1.33 的验收结论零影响**（不改变任何被验过的路径）。
- **唯一的间接风险（确证）**：`dsh-tool-subagent/lib/index.js:380`
  —— 若把某个 `dsh-tool-subagent` 条目配成 `backgroundMode: continuable` 且 `provider: harness-*`，
  **插件挂载期就会抛错**（不是运行期）。当前 profile 的 `tool-subagent` 条目用的是 `subagentProvider: spawn`
  （`profiles/desktop/cordis.yml:393`、`:842`、`:1026`、`:1288`），**未受影响**。

---

## 5. 诚实分级

### 5.1 确证（指到 file:line，均由本轮直接读取运行版模块树得出）

| # | 结论 | 证据 |
|---|---|---|
| C1 | `prepareContinuable` 是 `SubagentProvider` 上的**可选**方法，签名 `(request: ContinuableCreateRequest) => Promise<ContinuableCreateSpec>` | `dsh-subagent/lib/typert.host.js:759` |
| C2 | 入参只有 `sessionId` / `parent` / `signal`；**无** prompt / label / agentOptions / cwd / 账号字段 | `dsh-subagent/lib/typert.host.js:334-335` |
| C3 | 返回值 `ContinuableCreateSpec` **只有 `seed?` 一个字段** | `dsh-subagent/lib/typert.host.js:338-339` |
| C4 | 宿主读返回值时**只取 `seed`**，其余丢弃 | `dsh-subagent/lib/types/continuation.js:141-142` |
| C5 | `prepareContinuable` 全树**只有一个调用点**，在 `startContinuable` 内、`materialize` 之前 | `dsh-subagent/lib/types/continuation.js:134-138` |
| C6 | 缺 `prepareContinuable` 时的抛错点在宿主转发层，错误码 `UNSUPPORTED_CAPABILITY` | `dsh-subagent/lib/index.js:3151`（副本 `lib/types/index.js:428-430`） |
| C7 | 团队路径**无前置能力预检**，直接在 `startContinuable` 里抛 | `dsh-subagent/lib/index.js:2879-2880` → `continuation.js:134` |
| C8 | 子 Agent 由**宿主进程内工厂**创建：`ownerCtx.agents.create(...)` / `.resume(...)` | `dsh-subagent/lib/types/continuation-activation.js:450-467` |
| C9 | `materializeTracked` 内**没有** `provider.*` 调用；`provider` 仅作观测标签 | `continuation-activation.js:449` + 全函数 437-500 无其它 `provider` 引用 |
| C10 | 观测器把 provider 用于生命周期事件 | `dsh-subagent/lib/index.js:3169-3171` |
| C11 | 冷恢复**不派发 provider**（宿主注释原话） | `dsh-subagent/lib/types/continuation.js:336`；实现 `:338-391` |
| C12 | 子代理路由**继承父 Agent**，函数无 provider 参数 | `dsh-subagent/lib/types/child-agent.js:75-93`；调用点 `continuation.js:112` |
| C13 | `agentRouteDefaults` 全树**只被读一处**，在一次性 `subagent` 工具的 `mount` 内 | `dsh-tool-subagent/lib/index.js:394`、`:496-497`、`:504` |
| C14 | `assertCapabilities` 只检查 5 个布尔能力，**不读 `agentRouteDefaults`**，且只在 `start` 里被调用 | `dsh-subagent/lib/index.js:3173-3197`、`:3117` |
| C15 | 运行版全树**只有 2 个** `ctx.subagents.registerProvider` 实现，**都是进程内** | `dsh-subagent-spawn-in-process/lib/index.js:42`、`dsh-subagent-fork-in-process/lib/index.js:58` |
| C16 | 两个在版 `prepareContinuable` 只返回 seed 或空对象，不持有进程/句柄 | `dsh-subagent-spawn-in-process/lib/index.js:37-39`、`dsh-subagent-fork-in-process/lib/index.js:52-55` |
| C17 | 进程外词汇表（`NO_START_CAPABILITIES` / `settleRunResult` / `subprocessRunHandle`）**只服务一次性 `start`** | `dsh-subagent/lib/types/out-of-process.js:49-55`、`:163-194`、`:203-218`；导出清单 `dsh-subagent/lib/index.js:3201` 无「进程外+可继续」辅助 |
| C18 | 进程外 run 的 `localAgent` 为 `undefined` | `dsh-subagent/lib/types/out-of-process.js:208` |
| C19 | 团队创建入口：`spawn_teammate` → `spawnAdmitted` → `startContinuable`，**`request` 只传 `prompt` 与 `parent`** | `dsh-experimental-tool-agent-team/lib/index.js:271`、`:289-291`；`dsh-experimental-agent-team/lib/types/roster.js:253-262`（`:257-260`） |
| C20 | 成员的 `provider` 名字来自**工具配置**，不是 provider 自己 | `dsh-experimental-tool-agent-team/lib/index.js:290`；`Config` 默认 `spawn`/`fork`（`:16-19`）；`apply` 解析默认（`:533-537`） |
| C21 | 失败被写成成员 `phase: 'failed'` + `error`，先落 journal 再 rethrow | `roster.js:265-282`（`:268-269`、`:272`、`:281`） |
| C22 | 成员的错误文案经 `diagnostics` 到达模型 | `roster.js:131`（`list()` 行构造）：`diagnostics: member.error === undefined ? [] : [member.error]` |
| C23 | 持久化成员记录是 `.strict()` 闭集 `id/name/description/provider/context/phase/error?` | `dsh-experimental-agent-team/lib/types/projection.js:46-54`（同形于 `lib/invariant.js:191-198`） |
| C24 | 模型可见成员行是 `additionalProperties: false`，字段为 `target/role/status/description/provider/context/model/diagnostics` | `dsh-experimental-tool-agent-team/lib/index.js:35-71`；`modelMember` 把 `name`→`target`（`:73-79`） |
| C25 | 成员消息投递：mailbox → `steerHostSubagentPrompt` → `ctx.subagents.steerPrompt` → `deliverToChild` | `dsh-experimental-agent-team/lib/types/mailbox.js:230`；`dsh-subagent/lib/types/internal.js:55-57`；`continuation.js:234-236`、`:238-248` |
| C26 | 目标不常驻时走 `coldResume`（重放 descriptor 后再 `materialize` 出**进程内** Agent） | `continuation.js:250-280`（`:255`）；`:338-391` |
| C27 | 目标常驻时消息进**进程内 Agent 的 inbox** | `continuation.js:269`、`:401`；`continuation-activation.js:359` |
| C28 | 取消走 `Agent.cancel(cause, { keepInbox: true })` | `dsh-experimental-agent-team/lib/types/roster.js:190`；`dsh-subagent/lib/types/continuation.js:288-290`；`continuation-activation.js:155`、`:180`、`:618` |
| C29 | 释放成员走 `drainContinuableChildren` → `activations.dispose` → `inbox.close` + `handle.dispose()` | `roster.js:218-220`；`continuation-activation.js:372-374`、`:505` |
| C30 | `SubagentStartRequest` **没有**任何账号字段 | `dsh-subagent/lib/typert.host.js:779` |
| C31 | `AgentOptions` **没有**账号字段（只有 `provider/model/reasoningEffort/maxTokens/subagentDepth`） | `dsh-subagent/lib/typert.host.js:243` |
| C32 | `SubagentRun` 有 `localAgent`，但那只属于**一次性** `start` 路径 | `dsh-subagent/lib/typert.host.js:767`；`dsh-subagent/lib/index.js:3129-3130` |
| C33 | desktop profile 的 `tool-subagent` 条目绑定 `subagentProvider: spawn` | `C:\Users\Administrator\.dsh\profiles\desktop\cordis.yml:393`（另见 `:842`、`:1026`、`:1288`） |
| C34 | agent-team **确实在运行中**：loader 有 `include:agent-team` 与 `include:tool-agent-team` 两个 live 条目 | `cordis_inspect_query(platform=host, provider=Config, method=listConfigs)` 返回 `patchId: "agent-team"` / `"tool-agent-team"`，`status: "schema"` |
| C35 | 团队 provider 装配：`freshProvider: spawn`、`forkProvider: fork`（由 bundle 的 patch 写死，Config 默认值相同） | `dsh-experimental-agent-team-profile/cordis.patch.yml:29-30`；`dsh-experimental-tool-agent-team/lib/index.js:16-19`、`:533-537`；bundle 在 `profiles/desktop/package.json:18` |
| C36 | 团队工具**只装进 Team 成员的 scope**：Lead（顶层会话）与 roster 里 `active`/`provisioning` 的 teammate 看得到；**其余**子代理看不到（`tryMembership` 对有 subagent descriptor 的 Agent 返回 `undefined`） | `dsh-experimental-tool-agent-team/lib/index.js:533-546`（`maybeInstall` 由 `ctx.agentTeams.tryMembership(agent)` 把关）；`roster.js:64-98`（`:72-75` 命中 roster → teammate；`:79-80`、`:88-89` 有 descriptor → `undefined`） |
| C37 | 顶层会话（无父、无 subagent descriptor）**自动成为 Lead** | `roster.js:88-90`、`:81` |
| C38 | 本插件的 LLM 改道是**绑定驱动、按 `sessionId` 索引**，且绑定里的 `accountId` **会透传给 dispatch** | `src/llm-adapter.ts:940-963`（`:945`、`:961`）；判据 `:361-378` |
| C39 | 团队路径传的 `request` **不含 `agentOptions`** ⇒ 连 `agentOptions` 能力检查都不会触发 | `roster.js:257-260`；`assertCapabilities` 的触发条件是 `request.agentOptions !== undefined`（`dsh-subagent/lib/index.js:3176`） |
| C40 | `dsh-tool-subagent` 在**挂载期**对 `backgroundMode: continuable` 做硬校验 | `dsh-tool-subagent/lib/index.js:380` |

### 5.2 推断（写清依据）

| # | 推断 | 依据 |
|---|---|---|
| I1 | **给 provider 加 `prepareContinuable` 无法让外部 CLI 成为团队成员**；实现它只会得到一个顶着 `harness-*` 名字的**进程内 DSH 子代理** | C8（`ownerCtx.agents.create/resume` 是唯一创建路径）+ C9（`materializeTracked` 无 provider 调用分支）+ C15+C16（两个在版实现都只是 seed 函数）+ C3（返回值无句柄字段）。**该函数的全部分支已被穷举，因此推断强度接近演绎，但我未实际运行验证。** |
| I2 | **常驻 CLI 解决不了这个问题** —— 宿主的消息/取消只会去找进程内 `Agent` | C27（消息进 Agent inbox）+ C28（取消调 `Agent.cancel`）+ C26（不常驻就 `coldResume` 再造一个进程内 Agent） |
| I3 | **「团队」与「进程外」在 rc.2 是两条互斥链路** | C32（`localAgent` 只属一次性）+ C17（进程外词汇表只服务一次性）+ C26/C28（团队链路全程绑 `Agent`） |
| I4 | 要真正实现需要**改宿主契约**（让 `ContinuableCreateSpec` 能承载一个 provider 侧 handle 与投递/取消适配器），**插件侧无可绕过的接缝** | C3+C5+C8+C9+C11：插件能插入的只有「返回 seed」这一个点 |
| I5 | 「成员 = 进程内 Agent + llm-adapter 改道到外部 CLI」在机制上可行，且**账号能真正套用** | C38（按 sessionId 的绑定改道 + `accountId` 透传）+ C37/C36（成员是原生 Agent ⇒ 团队机制全部原生可用）|
| I6 | 上级既定前提「声明 `agentRouteDefaults` 会被 `assertCapabilities` 直接拒」**不成立**；真实拒绝机制是 `dsh-tool-subagent` 的挂载期 config 校验 | C14（`assertCapabilities` 不看该字段，且不在可继续路径上）+ C13（全树无校验逻辑）+ C40 + `dsh-tool-subagent/lib/index.js:378-379` |
| I7 | 已通过的 4 路并发/账号隔离验收**不受** `prepareContinuable` 影响 | C33（`tool-subagent` 绑的是 spawn）+ C14/C7（一次性路径不引用该方法）+ 该验收跑在 `/dispatch` 链路（`docs/00-verified-status-report.md:370`）而非 provider 链路 |

### 5.3 未查（明确没有验证，**不得**当作结论使用）

| # | 未查项 | 为什么没查 / 影响 |
|---|---|---|
| U1 | **给新生的子会话写入绑定的时机是否可靠**（I5/方案 C 的落地关键） | 需要跑起来并观测 `agent/created` 与首次 LLM 请求的先后。本轮只读、且被要求不发模型请求 ⇒ 无法验证竞态。**这是方案 C 唯一的未知数。** |
| U2 | `agent/created` 事件的**精确 payload 与触发时机**（相对 `materialize` / 首次 inbox 投递） | 同上。`tool-agent-team/lib/index.js:544` 证明该事件存在且被用，但**是否早于子代理第一次 LLM 请求未验证**。 |
| U3 | 「实现 `prepareContinuable` 返回 `{}` 后 `spawn_teammate` 真的会成功」 | **我没有实际跑过**。依据是代码路径（C5→C8→C21 的反面），属推断；且 4.2 已建议**不要**这么做，所以也未去跑。 |
| U4 | 上级已确证的「**从子代理会话发起的任务，其完成回执必然失败**」（宿主原话 `session <id> is owned by subagent routing`）的具体判定代码位置 | 本轮未定位。与本文件主题（团队能力）相关但不相同，未展开。 |
| U5 | 是否存在**第三方/未安装**的进程外 `SubagentProvider`（例如源码注释里提到的 `subagent-acp`） | `dsh-subagent/lib/types/out-of-process.js:60` 以 `subagent-acp` 作为 `assertPositiveFinite` 的示例前缀，但该包**不在**本机 rc.2 的 `@deepseek-ai` 模块树里（目录清单已核对）。**它是别处的插件，我无法读它的实现**，因此不能断言「世上不存在进程外可继续 provider 的先例」。 |
| U6 | `TeamMemberView` 是否有**除 `provider` 外**的插件可写通道（例如 `diagnostics`、`model`） | 本轮确认了模型可见行含 `model`/`diagnostics`（C24），但**没有**追查 `model` 的来源是否可被 provider 影响（`roster.js:117`/`:130` 显示取自 `live.options.model` 或 **Lead 的 model**）。留待需要时再查。 |
| U7 | 方案 C 下 `interrupt_agent` 对「CLI 内部已启动的动作」的实际效果 | 需要真实跑外部 CLI 才能测。理论上只能 abort 当轮 LLM 调用（C28 是 Agent 层 cancel），杀不掉 CLI 已在目标系统里产生的副作用。**属推断，未测。** |

---

## 6. 顺带核查项

### 6.1 子代理路径的账号绑定（**确证**）

**问：`SubagentStartRequest` 是否真的没有任何承载账号的字段？**

**答：是真的，没有任何字段。** 完整声明（`dsh-subagent/lib/typert.host.js:779`）：

```ts
export interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: ObjectJsonSchema
  readonly maxDepth?: number
  readonly toolFilter?: ToolRestriction
  readonly persona?: string
}
```

唯一可能「夹带」路由信息的字段是 `agentOptions`，而 `AgentOptions` 同样没有账号（`typert.host.js:243`）：

```ts
export interface AgentOptions {
  provider?: string; model?: string; reasoningEffort?: ReasoningEffortId
  maxTokens?: number; subagentDepth?: number
}
```

**⇒ 「账号不能走 `SubagentStartRequest`」是契约级事实，不是实现偷懒。**
本插件 `src/provider.ts:171-172` 的注释（「这条路径**没有**套用账号档案……所以这里**不**声明 accountId —— 声明了就是撒谎」）
与 `:97` 的用户可见文案，**与契约一致，是诚实的**。

**问：若要在 provider 路径套用账号档案，唯一可行的接线点在哪？**

分两种语义，**指到具体位置**：

- **（a）一次性 provider 路径**（`subagent` / `subagent_fork` 工具、`harness_agent`）：
  接线点是**注册期**，即
  - `src/provider.ts:254-273` 的 `registerProviders(...)`，以及
  - 它在 `src/index.ts:1939` 的调用（`registerProviders(subagents, registry, tasks, config.resolvedTargets, config.defaultTarget)`）。
  `providerNameFor(target)`（`provider.ts:236-238`）已经在做「**每个 target 一个 provider 名**」，
  同一手法可以扩展成「**每个 (target × account) 一个 provider 名**」，
  把账号**烘进 `HarnessProvider` 实例**（构造函数 `provider.ts:118-124`）——
  这是唯一不需要新增契约的做法，因为 `start(request)` 里**只有 `request` 可用**。
  - **次选**：让 provider 自己从 `request.parent` 反查会话绑定（`src/index.ts:1949` 的
    `bindingFor: (sessionId) => bindingState.bindings[sessionId]` 就是现成的绑定表）。
    但 `provider.ts` 目前**没有**注入 `bindingFor`（其 import 清单见 `provider.ts:8-22`），需要新接线。
  - **结论**：**「注册期注入」是唯一干净的接线点；「provider 自己解析」需要额外注入绑定表，属次选。**

- **（b）可继续 / 团队路径**：**没有可行接线点**。
  `prepareContinuable(request)` 只拿到 `{ sessionId, parent, signal }`（C2），
  且**结果根本不影响执行**（C4、C8、I1）—— 即便你把账号解析出来，也无处可用。
  **（推断 I5）** 若改走「进程内成员 + LLM 路由改道」，账号的接线点是 `src/llm-adapter.ts:961`
  那条**已经实现**的绑定透传通道（C38），此时账号是**真正生效**的。

**⇒（确证）「按账号跑」目前唯一被验证可用的入口是 `harness_task_start accountId=…`**
（`src/task-tools.ts:295`、`:311-326`），与 provider 路径无关。

### 6.2 本 profile 的 agent-team 装配与 `freshProvider`/`forkProvider`（**确证**）

**问：本 profile 是否装了 agent-team 工具？**

**答：装了，而且在运行中。** 证据（**用 live loader 条目，而不是目录存在性**）：

- `cordis_inspect_query(platform=host, provider=Config, method=listConfigs, name="…/dsh-experimental-agent-team")`
  → `{ id: "include:agent-team", patchId: "agent-team", status: "schema" }`
- 同法查 `…/dsh-experimental-tool-agent-team` → `{ id: "include:tool-agent-team", patchId: "tool-agent-team", status: "schema" }`
- 来源：`profiles/desktop/package.json:18` 把 `@deepseek-ai/dsh-experimental-agent-team-profile` 列为 bundle，
  该 bundle 的 `cordis.patch.yml:16-33` 以 `insert:` 挂载了三个条目。

**问：`freshProvider`/`forkProvider` 配成了什么？**

**答：`freshProvider: spawn`、`forkProvider: fork` —— 都是进程内 provider。**

```yaml
# dsh-experimental-agent-team-profile/cordis.patch.yml:26-30
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
```

且 `dsh-experimental-tool-agent-team/lib/index.js:16-19` 的 `Config` 默认值就是 `spawn`/`fork`，
`apply` 在 `:534-537` 兜底同上。**desktop profile 的 `cordis.yml` 里没有覆盖这个条目**
（全文件 grep `freshProvider|forkProvider` 无命中），因此用的是 patch 里的值。

**问：外部核查怀疑「团队详情看到真实 Harness」目前只能靠 `provider` 名承载 —— 请核实。**

**核实结果：方向对，但要分两个可见面，且**不止** `provider`：**

1. **模型可见面**（`list_agents` / `spawn_teammate` 的返回行）
   —— `MEMBER_VIEW_SCHEMA`（`dsh-experimental-tool-agent-team/lib/index.js:35-71`，`additionalProperties: false`）：
   字段为 `target`(必填) / `role`(必填) / `status`(必填) / `description` / **`provider`** / `context` / `model` / `diagnostics`(必填)。
   **不是** `id/name/description/provider/context/phase/error`（那是**持久化**那层的形状，见 C23）。
   - 所以模型能看到的「真实 Harness」确实主要靠 **`provider`** 承载；但 **`model`** 也在
     （`roster.js:117`：`live?.options.model ?? root.options.model` —— **取不到就退回 Lead 的 model**），
     以及 **`diagnostics`**（`roster.js:131` 会把 `member.error` 原文放进去）。
2. **持久化面**：`teamMemberSnapshotSchema`（`projection.js:46-54`，`.strict()`）：
   `id/name/description/provider/context/phase/error?`。

**两个面都是闭集，插件都无法加列**（这一条与上级既定前提一致，**确证**）。
但请注意一处**下级差异**：`phase` **不在**模型可见行里 —— 模型看到的是把
`phase` 映射成 `status`（`roster.js:122-126`：`failed`→`'failed'`、`provisioning`→`'provisioning'`、
`active`→`availability(live)` 即 `running`/`inactive`），
**失败原因则走 `diagnostics`**。所以「成员详情只能看到 `phase=failed/error`」这句话
只在**持久化面**成立；在**模型面**应表述为 `status: "failed"` + `diagnostics: ["…UNSUPPORTED_CAPABILITY…"]`。

**另外一条可能影响后续决策的发现（确证）**：`freshProvider`/`forkProvider` 是
**`tool-agent-team` 条目的 config**，不是 provider 的属性。
因此「把团队成员指向外部 Harness」的配置入口是
**profile 里给 `tool-agent-team` 覆盖 `freshProvider: harness-<target>`**（`cordis.patch.yml:26-30` 那一块），
而**不是**改插件的 provider 注册。
—— 但这**仍然解决不了问题**，因为 `harness-<target>` 没有 `prepareContinuable`（§1.2），
而一旦补上，成员就变成进程内 Agent（§1.4）。**配置能改的是「名字」，改不了「谁在跑」。**

### 6.3 一处已排除的干扰源（**确证**：本轮未将其当作证据）

按要求核查并**主动排除**：`dsh-repeat-tool-reminder` 与 `dsh-tmux-context` 内各有一份
**打包进来但未导出、未实例化**的 `LlmRuntime` 副本。本轮所有关于 LLM 路由的结论
**只引用** `src/llm-adapter.ts`（本插件）与 `dsh-subagent/lib/typert.host.js:243` 的 `AgentOptions` 类型，
**没有**引用那两份副本，也**没有**把它们当成「第二个 llm 服务」。**上一节的 grep 命中已被人工甄别。**

---

## 7. 给后续工作的三条建议（按代价从低到高）

1. **不要把 `prepareContinuable` 返回 `{}` 当成修复**（§4.2）。它把**诚实的失败**换成**会骗人的成功**，
   与「不把推断写成确证」的项目纪律直接冲突。若确实需要让 `spawn_teammate` 可用，
   **必须在同一批改动里**让成员的执行身份真正是外部 CLI，否则宁可不做。
2. **若要做，走方案 C（进程内成员 + 路由改道）**，并**先只验证一个未知数**：
   能不能在新子会话的**第一次 LLM 请求之前**写进 `{ harnessKind:'external', harnessId:<target> }` 绑定（U1/U2）。
   这一个问题的答案决定方案 C 成立与否 —— **在它被验证之前，方案 C 只能算推断**。
3. **不要把「新增 provider 能力位」当成解法**。真正的改动面在宿主的可继续子代理契约
   （`ContinuableCreateSpec` + `materializeTracked`，§4.1），那**不属于本插件**；
   在向上游提出之前，本插件的正确表述是
   **「可继续子代理契约不支持进程外后端，团队成员无法由外部 Harness 承担」**，
   而不是「插件缺一个能力声明」。
