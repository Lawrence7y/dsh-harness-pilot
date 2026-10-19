# LLM adapter integration — the two blocking unknowns, resolved

> **Question this document answers.** Two facts were left `NOT CHECKED` by
> [`llm-adapter-contract.md`](./llm-adapter-contract.md) §6.3, and both block implementation:
>
> 1. **How does a plugin obtain an agent-scoped cordis `Context` for an *arbitrary live session*?**
>    (Needed if the pilot wants to install its own per-session `agent/request` override.)
> 2. **What does the session page's model picker actually read to build its list?**
>    (Decides whether a purely additive route such as `pilot-cli` shows up by itself.)
>
> It ends with the **Path A / Path B** recommendation requested by the parent.
>
> **Method.** Read out of the **running version's module tree**
> `D:\Project\_dsh-host-0.2.0-rc.2\node_modules\@deepseek-ai\` (all packages stamped `0.2.0-rc.2`),
> plus the **live** Host Inspect providers (`Service`, `Event`) of the running Electron host, plus the
> live profile composition `C:\Users\Administrator\.dsh\profiles\desktop\cordis.yml`.
>
> **Labels.** `VERIFIED` = quoted rc.2 code, with `file:line`. `INFERRED` = a conclusion reasoned from
> VERIFIED facts, explicitly marked. `NOT DETERMINED` = not established; not a premise.
>
> **Read-only.** No file under `src/`, `lib/`, `client/`, `probe/` and no profile was modified. No model
> request that would spend quota was issued. No credential value was read or printed.
>
> **Depends on:** `llm-adapter-contract.md` for the adapter/chunk/`registerAdapter` contract. This
> document does not repeat it; where it leans on a prior finding it says so.

---

## 0. Verification basis

| Fact | Value | How it was checked |
|---|---|---|
| Live host | Electron, WebUI `http://127.0.0.1:4200` | supplied context |
| `agent/request` live contract | `waterfall`, payload `{agent, turn, step, signal}`, `this: Scoped<Agent>` | `cordis_inspect_query(host, Event, listEvents{event:"agent/request"})` — answered by the running instance |
| `agents` live contract | `ctx.agents`, 13 methods incl. `get(id): Agent \| undefined` | `cordis_inspect_query(host, Service, listService{service:"agents"})` |
| `sessions` live contract | `ctx.sessions` = SessionStore; **10 methods, no `scope()`** | `listService{service:"sessions"}` |
| `typert` live contract | `ctx.typert`, schema/invocation registry | `listService{service:"typert"}` |
| Agent-scope production | `createScope(loopCtx, this)` with the agent as key | `dsh-agent-loop/lib/index.js:778-779` |
| Context-host registration | `registerHost("agent", { resolve: sessionId => agent.ctx })` | `dsh-agent/lib/index.js:341-345` |
| Picker's data source | `ctx.remote.session.modelCatalog()` | `dsh-client-ui-model-selection/lib/client.js:118` |
| Catalog builder | `listProviders()` → `listModels()` → `resolveModelInfo()`, empty groups dropped | `dsh-api-session-controller/lib/index.js:500-548` |
| Live profile composition | routes `opencode-go` / `deepseek(-account)`; **no invariant entry**; pilot mounted at `1319` | `profiles\desktop\cordis.yml` |

**Carried over from the prior document, not re-derived here:** the adapter registry contract, the
7-variant chunk protocol, `DUPLICATE_ADAPTER` exclusivity, "no tool-call block ⇒ DSH tools inert", and
the absence of the strict chunk-grammar companion. One of those was independently re-confirmed: a
`grep` for `invariant` over the live profile returns **nothing**, so the grammar is indeed not enforced
on this instance.

**A trap worth recording.** `grep` for `llm/stream` over the module tree also hits
`dsh-repeat-tool-reminder/lib/index.js:1419` and `dsh-tmux-context/lib/index.js:1420`, each preceded by
`super(ctx, "llm")` (`:849` / `:850`). Those are **bundled copies of `LlmRuntime` that neither package
exports** — both `lib/index.js` end with `export { Config, apply, … }` only
(`dsh-repeat-tool-reminder:1597`, `dsh-tmux-context:1630`), and neither constructs the class. They are
dead code, **not** a second `llm` service. Do not cite them as evidence.

---

## 1. Unknown 1 — getting an agent-scoped `Context` for a live session

### 1.1 What `apply(ctx, config)` receives

**VERIFIED.** The pilot is a plain loader entry —
`profiles\desktop\cordis.yml:1319-1320`:
```yaml
- id: harness-pilot
  name: '@dsh-external/dsh-harness-pilot'
```
(inserted by the plugin's own `cordis.patch.yml`). So `apply(ctx, config)` receives an ordinary loader
fiber context. It declares `inject = ['tools', 'llm', 'subprocess']`
(`dsh-harness-pilot/src/index.ts:107`), so those three are hard dependencies; everything else must go
through `ctx.get(...)` (the "服务时序纪律" comment at `src/index.ts:102-106`).

**VERIFIED — the pilot's ctx carries no scope tag.** Scope tags are written only by
`createScope`, and only onto a ctx derived from a fresh no-op fiber
(`dsh-scope/lib/index.js:296-306`):
```js
function createScope(ctx, key, options) {
	if (options?.parent !== void 0) bindScopeParent(key, options.parent);
	const fiber = ctx.plugin(scope);
	const scoped = fiber.ctx.extend({ [kScope]: key });
	…
}
```
with `kScope = Symbol("dsh.scope")` (`:229`) and `scopeOf(ctx) === ctx[kScope]` (`:312-314`). A loader
entry never goes through `createScope`, so `scopeOf(pluginCtx)` is `undefined`. **This single fact is
what makes the recommended path below work.**

### 1.2 How agent scoping actually routes

Three code sites, all `VERIFIED`, and they fit together exactly:

1. **The agent mints a scope whose key is the agent object itself** —
   `dsh-agent-loop/lib/index.js:777-779`:
   ```js
   this.dispatch = agentEvents(loopCtx, this);
   this.scope = createScope(loopCtx, this);
   this.ctx = this.scope.ctx;
   ```
2. **The dispatch carrier for every agent event is keyed by the same object** —
   `dsh-agent/lib/index.js:230-232` (twin at `lib/types/dispatch.js:19-21`):
   ```js
   function agentCarrier(agent) { return scopeTarget(agent, agent) }
   ```
3. **`agent/request` is dispatched through that carrier, with `agent` fused into the payload** —
   `dsh-agent/lib/types/dispatch.js:37-42, 68-72`:
   ```js
   const fused = (payload) => ({ ...payload, agent })
   …
   waterfall(name, payload, ...rest) {
       const waterfall = ctx.waterfall
       return waterfall(carrier, name, fused(payload), ...rest)
   }
   ```
   consumed by the loop at `dsh-agent-loop/lib/index.js:1179-1183`.

**The admission rule** — `dsh-scope/lib/index.js:327-338`:
```js
function scopeTarget(base, key) {
	const baseFilter = base[Context.filter];
	const carrier = { [Context.filter](ctx) {
		if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
		const tag = scopeOf(ctx);
		if (tag === void 0) return true;                       // ← unscoped listener: admitted
		for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor))
			if (cursor === tag) return true;                   // ← same scope or an ancestor
		return false;
	} };
	carrierKeys.set(carrier, key);
	return carrier;
}
```
`base` here is the `ReactLoopAgent` instance, which is a plain class
(`dsh-agent-loop/lib/index.js:747` — `var ReactLoopAgent = class {`, no `extends`), so
`base[Context.filter]` is `undefined` and that arm never fires.

**And cordis applies that admission filter verbatim** — `cordis/lib/index.js:262-263`:
```js
const filter = thisArg?.[Context.filter];
return (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx))
```
where `hook.ctx` is the **registering** context (`cordis/lib/index.js:337-344`) — the `events` service is
tracked (`:233-236`), so `this.ctx` inside `on()` is the caller's ctx, not the service owner's.

### 1.3 Verdict — **it can be done, and the cheapest way needs no scope at all**

| # | Path | Verdict | Evidence |
|---|---|---|---|
| **P1** | **Plain `ctx.on('agent/request', …)` on the plugin's own ctx, branching on `payload.agent`** | **WORKS — recommended** | `scopeOf(pluginCtx) === undefined` ⇒ admitted globally (`dsh-scope:332` + `cordis:263`); live payload signature carries `agent` |
| P2 | `ctx.agents.get(sessionId).ctx` | **WORKS**, but `ctx` is past the declared type | `ctx.agents.get` VERIFIED public (`dsh-agent/lib/index.js:594-596`); `agent.ctx` set at `dsh-agent-loop/lib/index.js:779`; but the public `Agent` interface is `{ readonly id: SessionId }` only (live Inspect) |
| P3 | `ctx.typert.contexts.getHost('agent').resolve(sessionId)` | **WORKS — the documented read seam for exactly P2's value** | registration `dsh-agent/lib/index.js:341-345`; reader `dsh-typert-registry/lib/index.js:388-390` → `265-274` → `275-285` |
| P4 | Mint one with `createScope` / `bindScopeParent` | **Possible but pointless and invasive** | `createScope`/`bindScopeParent` are public exports (`dsh-scope/lib/index.js:296,256,357`), and `createScope(loopCtx, this)` passes no `options`, so `scopeParents` has no entry for an agent and a bind would *succeed* — but you must already hold the agent object as the key, so P4 is strictly worse than P2 |
| P5 | `installModelSelection(agentCtx, selection)` | **WORKS, publicly exported** — but still needs an `agentCtx` | `dsh-agent/lib/index.js:166-210`, exported at `:700`; the controller itself calls it as `installModelSelection(agent.ctx, selection)` (`dsh-api-session-controller/lib/index.js:310`) |
| — | Any API that mints/resolves an agent scope **from a `sessionId` alone, without the agent object** | **DOES NOT EXIST** | host `ctx.sessions` is `SessionStore` with 10 methods and **no `scope()`** (live Inspect); the client-side `sessions.scope(sessionId)` seen in `dsh-client-ui-model-selection/lib/client.js:394` is a **browser-half** construct |
| — | `ctx.agents.resume({resumeSessionId, setup})` to get a typed `agentCtx` | **Not usable for a live session** | `AgentSetup = (agentCtx: Context, agent: Agent) => …` is typed (live Inspect) and the pilot already calls `resume` (`src/wake.ts:134`) — but `enter()` rejects a duplicate id (`dsh-agent/lib/index.js:512-514`), and the GUI's session is live while you are using it |

**So, the explicit answers to the three sub-questions asked:**

- **Can it be done?** **Yes.** Two independent ways, both VERIFIED: a globally-admitted unscoped
  listener (P1) or `agent.ctx` reached through `ctx.agents.get` / the typert context host (P2/P3).
- **"Only by a workaround"?** **No for the listener itself** — P1 is the *ordinary, intended* event
  mechanism, not a workaround. The `{global: true}` option exists precisely to force admission
  (`cordis/lib/index.js:263`), and a shipped plugin already uses it on `llm/stream`
  (`dsh-session-title/lib/index.js:262-268`). **One caveat:** `agent.ctx` is a runtime property *absent*
  from the published `Agent` interface, so P2 is the only variant that reaches past a declared type.
- **Is there a supported per-session alternative inside `llm/stream`?** **Yes — and it is stronger
  evidence than P1.** Two shipped plugins in this very profile already do exactly that.

### 1.4 The `llm/stream` + `options.sessionId` alternative — shipped precedent

`dsh-session-checkpoint-policy`, mounted at `profiles\desktop\cordis.yml:370-371`, `VERIFIED`,
`dsh-session-checkpoint-policy/lib/index.js:60-65`:
```js
function apply(ctx) {
	ctx.on("llm/stream", (options, next) => {
		if (options.sessionId === void 0) return next();
		const session = ctx.sessions.get(options.sessionId);
		return session === void 0 ? next() : afterCheckpoint(ctx, session, next);
	});
```
An **unscoped, plain `ctx.on`** on a plugin root context, branching on `options.sessionId`. This is the
prior document's §4.6 "per-session via `options.sessionId`" claim, confirmed by a shipped consumer.
`options.sessionId` is populated on every loop-built request (`dsh-agent-loop/lib/index.js:1274`, read
directly). `afterCheckpoint` is `await ctx.sessions.flush(session)` then `next()`
(`dsh-session-checkpoint-policy/lib/index.js:26-28`).

### 1.5 Ordering — the one sharp edge, for both `agent/request` and `llm/stream`

`VERIFIED`, `cordis/lib/index.js:317-325, 336`:
```js
waterfall(...args) {
	const cbs = this.dispatch("waterfall", args);
	const inner = args.pop();
	const next = () => (cbs.shift() ?? inner)(...args);
	…
}
register(label, hooks, callback, options) {
	const method = options.prepend ? "unshift" : "push";
	…
}
```
Listeners run **outermost-first**; `prepend: true` unshifts to the front; a listener that never calls
`next()` vetoes everything downstream including the built-in behaviour (`cordis:310-312`).

Two consequences that must be designed for, not discovered:

- **`agent/request`.** `installModelSelection` registers with **default push** on the *agent-scoped* ctx
  (`dsh-agent/lib/index.js:181-192`, no options object). A pilot listener registered with
  `{ prepend: true }` is guaranteed outermost, so `await next()` hands it the config **already carrying
  the GUI's chosen route** — which is what you want if the pilot must overrule or observe it. Without
  `prepend`, the order depends on `_hooks` array position, i.e. on plugin load order. **Use
  `{ global: true, prepend: true }`.**
- **`llm/stream`.** `prepend: true` on a *short-circuiting* pilot listener would skip
  `dsh-session-checkpoint-policy`'s pre-request `session/flush` — the durable request log would not be
  flushed before the external CLI runs. **Do not prepend.** The desired arrangement is: checkpoint
  policy outermost (it flushes, then `next()`), pilot inner (it short-circuits before
  `adapterStream`). On this profile that is what plain push yields, because checkpoint-policy loads at
  `cordis.yml:370` and the pilot at `:1319`. **`INFERRED`:** that the loader instantiates entries in
  file order; if the pilot is ever moved earlier in the profile, this arrangement silently inverts.

---

## 2. Unknown 2 — what the session page model picker reads

### 2.1 The read chain, end to end

**VERIFIED.** Every hop:

| Hop | Code | Source |
|---|---|---|
| The picker is the composer seat | `scope.slots.inject("conversation.input.model", …)` | `dsh-client-ui-model-selection/lib/client.js:1248-1249` (doc `:480`) |
| Its data source | `this.ctx.remote.session.modelCatalog()` | `client.js:118` — **not** a direct `llm.listProviders()` call |
| It renders `catalog.value.groups` verbatim | `groups: catalog.value.groups` | `client.js:325, 339`; menu `:536-551` |
| Ordering only, no filtering | `orderModelProviders(groups)` → `deepseek-account`=0, `deepseek-official`=1, rest=2 | `client.js:474-476, 536` |
| Per-model routability | `groups.some(g => g.id===provider && g.models.some(m => m.id===model))` | `client.js:334` |
| **Host** entry | `modelCatalog() { return buildModelCatalog(this.ctx) }` | `dsh-api-session-controller/lib/index.js:3002-3004` |
| **Host** builder | `ctx.llm.listProviders()` → `ctx.llm.listModels(provider.id)` → `ctx.llm.resolveModelInfo(provider.id, model.id)` | `dsh-api-session-controller/lib/index.js:501, 504, 506` |
| Group label | `name: provider.name` | `:526` |
| **The gate** | `…flatMap(group).filter((group) => group.models.length > 0)` | `:541` |
| Provider list is the adapter registry | `listProviders() { return [...this.adapters.values()].map(({provider}) => ({...provider})) }` | `dsh-llm/lib/index.js:1899-1901`; registry `:1797`, write `:1890` |

So the answer to *"which interface does it read?"* is: **`remote.session.modelCatalog()` → `ctx.llm.listProviders()` + `ctx.llm.listModels(provider)`**, projected through the adapter registry. It does **not** read the configurable-provider directory (`listConfigurableProviders` appears only in `hasProviderApiKey`,
`dsh-api-session-controller/lib/index.js:578`, an unrelated onboarding check), and it does **not** read
the profile's `models` configuration directly.

### 2.2 Conclusion — **does a new route appear automatically?**

**Yes — automatically, and with exactly one requirement: the adapter must advertise at least one model
via `listModels(provider)`.** No profile edit, no `registerConfigurableProviders` entry, and no
client-side contribution is needed. `VERIFIED`:

- `listProviders()` is a pure projection of the adapter registry, so any registered route is listed
  (`dsh-llm/lib/index.js:1899-1901`).
- `buildModelCatalog` drops every group whose `models` array is empty
  (`dsh-api-session-controller/lib/index.js:541`) — **so a route whose `listModels` returns `[]` is
  invisible in the picker, in `routableProviders`, and everywhere else in the catalog.**
- The default `LlmAdapter.listModels` returns `[]` (`dsh-llm/lib/index.js:1706-1708`).
- **The running build states this in its own source, at `dsh-llm/lib/index.js:1698-1702`:**
  > *"List models this adapter can currently advertise for one owned provider. Core routing accepts
  > unlisted model ids; catalog-driven entry points such as the GUI may require membership. Adapters
  > used there must advertise their available models; the base empty catalog offers no GUI selection."*

**And the second, harder gate is at selection time** — `VERIFIED`,
`dsh-api-session-controller/lib/index.js:900-905`:
```js
async requireModel(selection) {
	if (!await modelAvailable(this.ctx, selection)) throw new RemoteError("session/model-unavailable",
		"Select an available model before sending a message.", { provider, model });
}
```
with `modelAvailable` (`:555-567`) requiring `listProviders().some(id===provider)` **and**
`listModels(provider).some(id===model)`. It is called from `selectModel` (`:724`). `INFERRED`: therefore a
route that lists no models cannot be selected **even programmatically** through
`remote.session.selectModel` — the failure is `session/model-unavailable`, not a silent fallback.

**What must be true of the pilot's adapter for Path A, exactly:**

| Requirement | Source | Failure if unmet |
|---|---|---|
| `providerInfo(route).id === route` and non-empty `.name` | `dsh-llm/lib/index.js:1864-1865` | `INVALID_ADAPTER` at registration; nothing registered |
| route not already owned | `:1863` | `DUPLICATE_ADAPTER` at registration |
| `listModels(route)` returns ≥1 model with `provider === route`, non-empty `id`/`name`, no duplicate ids | `dsh-llm/lib/index.js:2073-2088`, gate at session-controller `:541` | group silently dropped → **invisible in picker**; `INVALID_CATALOG` on a malformed entry |
| `resolveModel(route, model)` echoes `provider`/`id`, non-empty `name` | `:2098-2108` | whole provider group becomes a `failure` entry (`session-controller:530-539, 546`) → dropped from groups |
| `resolveModel` must not throw for any model `listModels` advertised | same | `session/model-unavailable` on selection |

`resolveModel` has a correct default (`{provider, id: model, name: model}`, `dsh-llm/lib/index.js:1718-1724`),
so **only `listModels` actually has to be written.** `providerInfo`'s default already satisfies the
validator (`:1676-1681`).

### 2.3 Refresh — does the picker notice a newly registered route without a page reload?

**VERIFIED, yes.** `dsh-client-ui-model-selection/lib/client.js:368-383`:
```js
ctx.on("connection/reset", () => { this.catalog.resetGeneration(); … });
ctx.remote.$on("llm/adapters-updated", () => { this.catalog.refresh(); });
ctx.remote.$on("settings/document-updated", () => { this.catalog.refresh(); });
ctx.remote.$on("credentials/record-updated", () => { this.catalog.refresh(); });
ctx.remote.$on("credentials/reference-updated", () => { this.catalog.refresh(); });
```
and `llm/adapters-updated` is emitted by `commitRoutes` on **every** registration and `replace`
(`dsh-llm/lib/index.js:1893`, emitter `:1804-1819`). `INFERRED`: an already-open session page picks up a
newly registered `pilot-cli` route on the next catalog read, without a browser refresh.

### 2.4 What to change if a route must *not* be offered for selection

Not required for this project, recorded for completeness: **there is no "appears in picker but is not
selectable" state.** `listModels` is the single switch — advertised means visible *and* selectable,
empty means invisible *and* unselectable. Hiding a route from the picker while still routing to it is
precisely the Path B shape (§3.2).

### 2.5 A real side effect of Path A: the picker writes the **profile's deployment default**

**VERIFIED.** `selectModel` ends with (`dsh-api-session-controller/lib/index.js:736`):
```js
this.ctx.agentDefaultModel.saveSelection(selected).catch(…)
```
and `saveSelection` (`dsh-agent-default-model/lib/index.js:53-66`) writes through the config editor into
**the plugin's own composition entry**:
```js
const entry = this.ownerContext.fiber.entry;
if (entry === void 0) return;
const editor = this.ctx.get("configEditor");
if (editor === void 0) return;
const config = { provider: next.provider, model: next.model, … };
const saved = this.saves.then(() => editor.edit(entry, () => config));
```
That entry is `agent-default-model` in the live profile, currently
`provider: opencode-go, model: deepseek-v4.1-flash, reasoningEffort: max`
(`profiles\desktop\cordis.yml:48-53`).

**Consequence, `INFERRED` from the two VERIFIED sites:** choosing `pilot-cli/<model>` once in the picker
persists `pilot-cli` as the **deployment default** — it is what `buildModelCatalog` reports as `default`
(`session-controller:500, 543`) and what `selectionFor` falls back to for a session with no logged
`request/header` (`:288-298`). Webhook sessions with no explicit `model` also take it
(`dsh-webhook/lib/index.js:89-94`). This is a **durable profile write**, which is the single largest
rollback asymmetry between Path A and Path B (§3.5). It is not fatal: unloading the plugin makes the
stored default unroutable, which surfaces as a per-turn `NO_ADAPTER` terminal error chunk rather than a
crash, because `prepareRequest` catches `NO_ADAPTER` and proceeds with the unresolved config
(`dsh-agent-loop/lib/index.js:1189-1194`).

---

## 3. Recommendation: **Path A (new route) — with `listModels` implemented**

### 3.1 Path A — `registerAdapter(['pilot-cli'], adapter)`

The user picks `pilot-cli` in the composer seat. `VERIFIED` chain, no pilot-side scope work anywhere:

1. Registration → `llm/adapters-updated` → picker group appears (§2.2, §2.3).
2. Selection → `remote.session.selectModel` (`client.js:246`) → `requireModel`/`modelAvailable`
   (`session-controller:900-905, 555-567`) → `selectForNextRequest` (`:319-322`).
3. `selectionFor(agent)` → `installModelSelection(agent.ctx, selection)` (`:281-312`, install at `:310`)
   → the **shipped, agent-scoped** `agent/request` override (`dsh-agent/lib/index.js:181-192`).
4. The loop's waterfall (`dsh-agent-loop/lib/index.js:1179-1183`) yields
   `{provider:'pilot-cli', model:…}` → `llm.prepareCall` (`:1189`) → `adapterStream` → the pilot's
   `stream` (`dsh-llm/lib/index.js:2323`).

**Cost.** The pilot writes only an adapter class; the host performs every piece of routing. Two
side effects: the picker choice rewrites the deployment default (§2.5), and the picker becomes the
only way to enter/leave the route — which is honest and visible, and produces a durable
`[model changed: …]` notice in the transcript (`dsh-agent/lib/index.js:133-147, 193-204`).

### 3.2 Path B — short-circuit `llm/stream` for the `deepseek` route

No adapter registration. A listener like:

```js
ctx.on('llm/stream', (options, next) => {
  const target = pilotTargetFor(options.sessionId)   // the pilot's own binding store
  if (target === undefined || options.purpose !== undefined) return next()
  return pilotCliStream(options, target)             // never call next()
})
```
`INFERRED` from the live event contract (*"call `next()` to reach the resolved adapter's stream, or
yield your own chunks to short-circuit"*) plus `cordis/lib/index.js:310-325`, and `VERIFIED` as a
mechanism by `dsh-session-checkpoint-policy/lib/index.js:61-65` — a shipped unscoped listener keyed on
`options.sessionId`. It requires **no scope and no route**, and the pilot's existing
`POST /session/binding` store (`dsh-harness-pilot/src/index.ts:839, 1502`) is already the right key set.

### 3.3 Comparison

| | Path A — new route | Path B — short-circuit `deepseek` |
|---|---|---|
| Pilot must implement | `stream` + `listModels` | `stream` only |
| Needs Unknown 1 at all? | **No** — the shipped `installModelSelection` does the routing | **No** — `options.sessionId` suffices |
| How the route is entered | user picks it in the picker (visible, reversible) | invisible; pilot-internal policy |
| Transcript attribution | honest: `source = {provider:'pilot-cli', model:…}` | **false**: logged as the DeepSeek provider/model the request was resolved to |
| Mixed-route history | handled: `forAdapter` strips `replayState` from turns owned by a different adapter (`dsh-llm/lib/index.js:2242-2263`, called at `:2323`) | **not** handled: `source.provider` stays `deepseek`, so `forAdapter` sees the *same* adapter and keeps `replayState` from genuine DeepSeek turns |
| Token accounting | attributed to `pilot-cli` | charged to DeepSeek by `dsh-token-meter` (`NOT DETERMINED` in detail — prior doc §6.3) |
| Auxiliary calls (`compaction`, `session-title`) | follow the selected route; gate them with `options.purpose` (`dsh-agent-loop/lib/index.js` request build; prior doc §2.1) | must be skipped explicitly by `options.purpose`, or the CLI answers them |
| Interferes with a shipped listener | no | **yes, ordering-sensitive** — see §1.5: must not `prepend`, or `dsh-session-checkpoint-policy`'s pre-request `session/flush` is skipped |
| Duplicate-registration risk | low: `pilot-cli` is free (`cordis.yml:74-78, 438, 440` register `opencode-go` / `deepseek` / `deepseek-account`); `DUPLICATE_ADAPTER` would fail loudly at plugin load (`dsh-llm:1863`) | none (no registry write) |
| **Rollback** | **two steps, one of them durable**: disable the plugin *and* re-pick a real model — otherwise the stored default `pilot-cli` is unroutable and every new session turns `NO_ADAPTER` errors (`§2.5`) | **one step**: remove the listener; the DeepSeek route is untouched and the next turn is genuinely DeepSeek. Residue is historical attribution only |

### 3.4 Effect on DSH's own toolchain — **identical for both paths**

Carried over from the prior document and **not** modified by anything found here: DSH tool execution is
triggered by the **presence of `tool-call` blocks in the assembled assistant message**, not by
`finish.reason.kind` (`dsh-agent-loop/lib/index.js:1151-1155`). An external CLI that emits only
`text`/`reasoning` blocks ⇒ `{kind:'completed'}` ⇒ `executeToolCalls` is never called ⇒ **every DSH tool
is inert for those turns**, and `options.tools` / `options.toolHistory` degrade to inputs the adapter
must render into the CLI's own prompt. Both paths feed the same `stream()`-shaped seam, so neither is
better here; the choice is a product decision (CLI drives its own tools vs. DSH drives them).

### 3.5 Recommendation

**Take Path A.** Reasons, in order of weight:

1. **It makes Unknown 1 irrelevant.** The routing is performed by `installModelSelection`, a shipped
   mechanism that the GUI's own picker drives (`dsh-agent/lib/index.js:166-210`; installed at
   `dsh-api-session-controller/lib/index.js:310`). Path A therefore avoids `agent.ctx` — the one
   candidate that reaches past the published `Agent` interface (`{ readonly id: SessionId }`) — entirely.
   Path B also avoids it, but only by giving up honest routing.
2. **Attribution stays truthful**, and mixed-route history is handled by design rather than by luck
   (`forAdapter`, `dsh-llm/lib/index.js:2242-2263`). Path B makes the session log assert that DeepSeek
   produced text it never produced, and keeps `replayState` for turns the CLI generated.
3. **The failure mode is loud and early.** Collisions and metadata errors surface as
   `DUPLICATE_ADAPTER` / `INVALID_ADAPTER` / `INVALID_CATALOG` at load or registration, and a
   missing `listModels` has one obvious symptom (route absent from the picker), rather than silent
   misrouting.
4. **Path B's only real advantage is rollback** — one step, no durable profile write — and its
   invisibility. If the operator's priority is "try it on one session and undo it instantly without
   touching the profile", Path B is the better engineering choice *for that priority*. It also happens
   to be the right shape for a **pilot-internal** policy ("this session is bound to opencode → route it
   there automatically, without the user choosing"), which Path A cannot express, because Path A makes
   the user's picker choice the trigger.

**A hybrid is available and is probably the end state:** Path A to expose `pilot-cli` in the picker for
explicit, attributed use, *plus* an `llm/stream` listener (Path B's seam) that redirects a session only
when the pilot's own binding store says so and the resolved route is a configured passthrough. The
listener must be registered **without** `prepend` (§1.5), and must skip `options.purpose !== undefined`
if auxiliary calls should stay on the host provider.

### 3.6 Rollback, stated plainly

- **Path A.** Disable the plugin (routes disappear via `ctx.effect`, `dsh-llm/lib/index.js:1843`;
  the picker group disappears on the next `llm/adapters-updated` → `catalog.refresh()`), **then** set the
  default model back to a host route — the picker works for this, or edit
  `profiles\desktop\cordis.yml:48-53`. Skipping the second step leaves a durable unroutable default.
  No session log is rewritten.
- **Path B.** Remove the listener. Nothing was registered and nothing was persisted, so the immediately
  following turn is a genuine DeepSeek turn. The residue is irreversible but harmless: assistant turns
  already logged under `provider:'deepseek'` stay misattributed.
- **Neither path rolls back a session's already-written history**, and neither can: DSH session events
  are append-only (`dsh-session` `SessionEvent`, live Inspect).

---

## 4. Not determined

- Whether the plugin loader instantiates profile entries strictly in file order (the §1.5 ordering
  arrangement rests on it). **`INFERRED`, not verified.**
- Whether `installModelSelection`'s agent-scoped `agent/request` listener is installed for **every**
  live agent, or only for agents the session controller has adopted (`selectionFor` is lazy and keyed by
  agent, `dsh-api-session-controller/lib/index.js:281-312`; called at `:468` and `:871`). For a
  GUI-created session it is installed; for a subagent-created session this was not traced.
- Behaviour after the pilot is unloaded while the profile default still names `pilot-cli`: the
  `NO_ADAPTER` path at `dsh-agent-loop/lib/index.js:1189-1194` was read, but the end-to-end turn was
  not run.
- Whether a `pilot-cli` route name could ever collide with a user-named `dsh-llm-pi-ai` profile key
  (`dsh-llm-pi-ai` registers `[...profiles().keys()]`, prior doc §4.2). The live profile names it
  `opencode-go` (`cordis.yml:78`); the collision is possible in principle and would fail loudly.
- `dsh-token-meter` behaviour for externally produced chunks under either path (prior doc §6.3).
- Compaction / `session-title` interaction with a CLI adapter (prior doc §6.3).

## 5. Index of VERIFIED claims used here

| Claim | file:line |
|---|---|
| `createScope` mints `fiber.ctx.extend({[kScope]: key})` | `dsh-scope/lib/index.js:296-306, 229, 312-314` |
| Unscoped listener admitted; tagged listener admitted for key or ancestor | `dsh-scope/lib/index.js:327-338` |
| `bindScopeParent` / scope chain are public exports | `dsh-scope/lib/index.js:239-280, 356-357` |
| cordis admission: `hook.global \|\| !filter \|\| filter.call(thisArg, hook.ctx)` | `cordis/lib/index.js:262-263` |
| `hook.ctx` is the registering context; `prepend` → `unshift` | `cordis/lib/index.js:335-344` |
| Waterfall is outermost-first; skipping `next()` vetoes downstream | `cordis/lib/index.js:307-325` |
| Agent scope key **is** the agent object | `dsh-agent-loop/lib/index.js:747, 777-779` |
| Carrier is `scopeTarget(agent, agent)`; payload fused with `agent` | `dsh-agent/lib/index.js:230-232`; `lib/types/dispatch.js:37-42, 68-72` |
| `agent/request` dispatched from `prepareRequest` | `dsh-agent-loop/lib/index.js:1179-1183` |
| Live `agent/request` signature carries `payload.agent`, `this: Scoped<Agent>` | host Inspect `listEvents{event:"agent/request"}` |
| `ctx.agents` service; public `get(id): Agent \| undefined` | `dsh-agent/lib/index.js:322, 332, 594-596`; live Inspect |
| public `Agent` interface = `{ readonly id: SessionId }` | live Inspect `referencedTypes` |
| typert host-context `"agent"` → `agent.ctx` | `dsh-agent/lib/index.js:341-345` |
| typert read path `contexts.getHost(key).resolve(id)` | `dsh-typert-registry/lib/index.js:388-390, 265-274, 275-285` |
| `AgentSetup = (agentCtx: Context, agent: Agent)` | live Inspect; call site `dsh-agent-loop/lib/index.js:1889` |
| `installModelSelection(agentCtx, selection)` public export | `dsh-agent/lib/index.js:166-210, 700` |
| controller installs it on `agent.ctx` | `dsh-api-session-controller/lib/index.js:310` |
| host `ctx.sessions` has no `scope()` | live Inspect `listService{sessions}`; `dsh-session/lib/index.js:1621` |
| shipped unscoped `llm/stream` listener keyed on `options.sessionId` | `dsh-session-checkpoint-policy/lib/index.js:26-28, 60-65` |
| shipped `{global:true, prepend:true}` on `llm/stream` | `dsh-session-title/lib/index.js:262-268` |
| `options.sessionId` on loop requests | `dsh-agent-loop/lib/index.js:1274` |
| `llm/stream` is a waterfall; short-circuit by not calling `next()` | `dsh-llm/lib/index.js:2370-2372`; live Inspect `listEvents` |
| picker = slot `conversation.input.model` | `dsh-client-ui-model-selection/lib/client.js:480, 1248-1249` |
| picker reads `remote.session.modelCatalog()` | `dsh-client-ui-model-selection/lib/client.js:118` |
| picker renders `catalog.groups`; ordering only | `client.js:325, 334, 339, 474-476, 536-551` |
| picker refresh on `llm/adapters-updated` and 3 more events | `client.js:368-383` |
| `modelCatalog()` → `buildModelCatalog(this.ctx)` | `dsh-api-session-controller/lib/index.js:3002-3004` |
| catalog = `listProviders` → `listModels` → `resolveModelInfo`; empty groups dropped; name from `provider.name` | `dsh-api-session-controller/lib/index.js:500-548` (esp. 501, 504, 506, 526, 541, 544) |
| `listProviders()` is the adapter registry projection | `dsh-llm/lib/index.js:1797, 1890, 1899-1901` |
| `providerInfo` validation; `DUPLICATE_ADAPTER` | `dsh-llm/lib/index.js:1862-1873` |
| `listModels` validation (`INVALID_CATALOG`) | `dsh-llm/lib/index.js:2073-2088` |
| default `listModels` returns `[]`; build documents the GUI requirement | `dsh-llm/lib/index.js:1698-1708` |
| `resolveModel` default + `normalizeModelInfo` validation | `dsh-llm/lib/index.js:1718-1724, 2098-2150` |
| selection gate: `selectModel` → `requireModel` → `modelAvailable` | `dsh-api-session-controller/lib/index.js:720-748, 900-905, 555-567` |
| `selectForNextRequest` → `selectionFor` → `installModelSelection(agent.ctx, …)` | `dsh-api-session-controller/lib/index.js:281-322` |
| picker writes the deployment default through the config editor | `dsh-api-session-controller/lib/index.js:736`; `dsh-agent-default-model/lib/index.js:53-66`; `profiles\desktop\cordis.yml:48-53` |
| `forAdapter` drops `replayState` across adapters; called inside `adapterStream` | `dsh-llm/lib/index.js:2242-2263, 2312, 2323` |
| tool execution triggered by `tool-call` blocks | `dsh-agent-loop/lib/index.js:1151-1155` |
| pilot mounted as a plain loader entry; unscoped ctx | `profiles\desktop\cordis.yml:1319-1320`; `dsh-scope/lib/index.js:296-306` |
| pilot already uses `ctx.agents.get(sessionId)` / `resume` | `dsh-harness-pilot/src/wake.ts:30-34, 131, 134` |
| live routes: `opencode-go`, `deepseek`, `deepseek-account`; no `pilot-cli` | `profiles\desktop\cordis.yml:74-78, 438, 440` |
| no invariant entry in the live profile (grammar unenforced) | `grep invariant` over `profiles\desktop\cordis.yml` → 0 hits |
| bundled `LlmRuntime` copies are dead code, not a second `llm` service | `dsh-repeat-tool-reminder/lib/index.js:849, 1597`; `dsh-tmux-context/lib/index.js:850, 1630` |

---

*Read-only audit. The only file created is this document. No file under `src/`, `lib/`, `client/`,
`probe/` or any profile was modified; no model request was issued; no credential value was read.*
