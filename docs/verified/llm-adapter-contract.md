# LLM adapter contract — verified against the RUNNING DSH 0.2.0-rc.2

> **Question this document answers:** how does a plugin register an LLM adapter so that a session's
> model requests are genuinely produced by an *external CLI* instead of by the host's own provider
> transports?
>
> **Method.** Every structural claim was read out of the **running version's module tree** at
> `D:\Project\_dsh-host-0.2.0-rc.2\node_modules\@deepseek-ai\` (extracted from `D:\DeepSeek\resources\app.asar`,
> package versions stamped `0.2.0-rc.2`), and cross-checked against the **live** Host Inspect providers
> (`Service`, `Event`, `Config`) of the running Electron host. Stale trees
> (`C:\Users\Administrator\.dsh\dist\...`, `D:\Project\deepseek-harness-master\...`) were **not** consulted.
>
> **Labels.** `VERIFIED` = quoted rc.2 code from the running build, with `file:line`.
> `INFERRED` = a conclusion drawn from VERIFIED facts, explicitly marked.
> `NOT CHECKED` = not investigated; not a premise.
> A conclusion that could not be pinned to a file and line is written `NOT CHECKED` — never upgraded.
>
> **Read-only.** No file under `src/`, `lib/`, `client/`, `probe/` or any profile was modified, and no
> model request that would spend account quota was issued. No credential value was read or printed.

---

## 0. Verification basis

| Fact | Value | How it was checked |
|---|---|---|
| Live host | Electron PID 48968, WebUI `http://127.0.0.1:4200` | supplied context, not re-derived here |
| Live `ctx.llm` contract | `registerAdapter`, `stream`, 13 public methods | `cordis_inspect_query(host, Service, listService{service:"llm"})` answered from the running instance |
| Live `llm/stream` event | waterfall, `options.provider` selects the adapter | `cordis_inspect_query(host, Event, listEvents{event:"llm/stream"})` |
| Live `credentials` contract | 9 abstract methods | `listService{service:"credentials"}` |
| Live `subprocess` contract | `spawn` / `spawnTerminal` / `resolveExecutable` | `listService{service:"subprocess"}` |
| Static source of the same contract | `@deepseek-ai/dsh-llm` **0.2.0-rc.2** | `dsh-llm/package.json` `version`; `main: lib/index.js`, `types: lib/types/index.d.ts` |
| Reference adapters | `dsh-llm-deepseek`, `dsh-llm-pi-ai` — both `0.2.0-rc.2` | `lib/index.js` read directly |
| Consumer | `dsh-agent-loop` `0.2.0-rc.2` | `lib/index.js` read directly |

**Important limitation of the Service Inspect provider.** `listService{service:"invariants"}` answers with a
full contract, but **no `invariants` plugin is mounted in this profile**. A negative control
(`listService{service:"totallyNotARealServiceXyz"}` → `Error: no catalogued Service named …`) shows the
provider is **catalogue-gated**: it renders the build-generated Host API catalogue
(`dsh-tool-cordis/lib/types/api-catalog.js`, which contains `key: 'invariants'` at line 1194) and cannot by
itself prove a service is live. Therefore the Service provider is authoritative for **signatures** and was
**not** treated as proof of liveness for anything. Liveness questions below were settled from the profile
composition instead.

**Profile composition used for liveness claims.** `C:\Users\Administrator\.dsh\profiles\desktop\cordis.yml`
(the `desktop` profile's mounted plugin list) plus the live loader-entry directory
(`cordis_inspect_query(host, Config, listConfigs)`, complete at `total: 193`). A `grep` for
`dsh-llm|invariant` over that file returns exactly five LLM entries — lines 15 (`@deepseek-ai/dsh-llm`),
57 (`dsh-llm-retry`), 75 (`dsh-llm-pi-ai`), 438 (`dsh-llm-deepseek-api-key`),
440 (`dsh-llm-deepseek-account`) — and **no invariants package**. The loader directory of 193 entries
likewise contains no `@deepseek-ai/dsh-invariants` and no `@deepseek-ai/dsh-llm/invariant`. This matters
enormously for §3 and §6 and is the single most consequential finding in this document.

---

## 1. `ctx.llm` — the complete service interface

`ctx.llm` is the `LlmRuntime` class, registered under the service key `"llm"`
(`dsh-llm/lib/index.js:1745-1751`, `1800-1802`). `LlmRuntime` extends `TypertRemoteService`. The plugin
already declares `inject = ['llm']` (`dsh-harness-pilot/src/index.ts:107`), so `ctx.llm` is available
without a `ctx.get("llm")` undefined check.

### 1.1 Adapter-registry methods (the ones that matter here)

| Method | Signature | Source |
|---|---|---|
| `registerAdapter` | `registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle` | `dsh-llm/lib/index.js:1833`; manifest `dsh-llm/lib/typert.host.js:122-125` |
| `listProviders` | `@Remote listProviders(): LlmProviderInfo[]` | `dsh-llm/lib/index.js:1899` |
| `registerConfigurableProviders` | `registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle` | `dsh-llm/lib/index.js:1910` |
| `listConfigurableProviders` | `@Remote listConfigurableProviders(): LlmConfigurableProvider[]` | `dsh-llm/lib/index.js:1958` |
| `registerModelDiscovery` | `registerModelDiscovery(settingsNs: string, discover: (request, signal?) => Promise<readonly LlmDiscoveredModel[]>): () => void` | `dsh-llm/lib/index.js:1974` |
| `discoverModels` | `async discoverModels(settingsNs, request, signal?): Promise<LlmDiscoveredModel[]>` | `dsh-llm/lib/index.js:1995` |
| `providerRetryPolicy` | `providerRetryPolicy(provider: string): ResolvedRetryPolicy` | `dsh-llm/lib/index.js:2038` |
| `imageRequestPricing` | `imageRequestPricing(provider: string, model: string): LlmImageRequestPricing \| undefined` | `dsh-llm/lib/index.js:2050` |
| `fileRequestText` | `fileRequestText(ref: FileAttachmentRef): string` | `dsh-llm/lib/index.js:2059` |
| `listModels` | `async listModels(provider: string): Promise<LlmModelInfo[]>` | `dsh-llm/lib/index.js:2073` |
| `resolveModelInfo` | `async resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>` | `dsh-llm/lib/index.js:2098` |
| `resolveCallConfig` | `async resolveCallConfig(config: LlmCallConfig, signal?): Promise<LlmCallConfig>` | `dsh-llm/lib/index.js:2161` |
| `prepareCall` | `async prepareCall(config: LlmCallConfig, signal?): Promise<PreparedLlmCall>` | `dsh-llm/lib/index.js:2203` |
| `stream` | `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` | `dsh-llm/lib/index.js:2367`; manifest `typert.host.js:218-224` |

**`registerAdapter` is NOT `@Remote`.** The only `@Remote`-decorated methods are `listProviders`,
`listConfigurableProviders` and `remoteDiscoverModels` (`dsh-llm/lib/index.js:1754-1756`). `INFERRED`:
a **client** half cannot register an adapter — adapter registration is host-side only.

### 1.2 `registerAdapter` — exact behaviour, field by field

`VERIFIED`, `dsh-llm/lib/index.js:1833-1852`:

```js
registerAdapter(providers, adapter) {
    const owned = new Set();
    let released = false;
    const dispose = this.ctx.effect(function* () {
        if (providers.length === 0) throw new LlmError("an adapter must register at least one provider", "INVALID_ADAPTER");
        this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned));
        yield () => { released = true; for (const p of owned) this.adapters.delete(p); owned.clear(); this.emitAdaptersUpdated(); };
    }.bind(this), "llm.registerAdapter()");
    const handle = (() => void dispose());
    handle.replace = (next) => {
        if (released) throw new LlmError("a disposed adapter registration cannot replace its routes", "REGISTRATION_DISPOSED");
        this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned));
    };
    return handle;
}
```

- **`providers: string[]`** — every provider *route* this one adapter instance serves. A single adapter may
  own many routes; this is the normal multi-model pattern (`dsh-llm-pi-ai/lib/index.js:2617,2623` registers
  `[...profiles().keys()]` at once).
- **`adapter: LlmAdapter`** — see §2.
- **Return value: a disposer that is also a handle.** `handle` is callable (`handle()`) *and* carries
  `handle.replace(providers: string[])`. Declaration: `dsh-llm/lib/index.js:1846-1851`, type manifest
  `typert.host.js:228-230`:
  ```ts
  export interface AdapterRegistrationHandle { (): void; replace(providers: string[]): void; }
  ```
- **A disposer is required — but you do not have to wire it up yourself.** Registration goes through
  `this.ctx.effect(...)`, so it is **disposed with the fiber** (documented at `dsh-llm/lib/index.js:1828`).
  A plugin that is unloaded/HMR-reloaded loses its routes automatically. Calling the returned handle is for
  *early* release; `handle.replace` is the way to change the route set without a gap
  (`dsh-llm/lib/index.js:1847-1850`).
- **Throws (all `LlmError`, all-or-nothing — nothing is written when any entry is rejected):**
  | Code | Condition | Line |
  |---|---|---|
  | `INVALID_ADAPTER` | `providers.length === 0` | `1837` |
  | `INVALID_ADAPTER` | a provider name is empty | `1862` |
  | `DUPLICATE_ADAPTER` | the same name twice in one call, **or** the route is already held by another registration | `1863` |
  | `INVALID_ADAPTER` | `adapter.providerInfo(provider)` does not return `{id === provider, name: non-empty string}` | `1865` |
  | `REGISTRATION_DISPOSED` | `handle.replace` after the registration was released | `1848` |
- **`providerRetryPolicy(provider)` is sampled once, at registration time** (`dsh-llm/lib/index.js:1867`) and
  stored on the registration. This is exactly why `dsh-llm-deepseek` re-runs `registration.replace([provider])`
  when config changes (`dsh-llm-deepseek/lib/index.js:2269-2280`). `INFERRED`: changing the policy without a
  `replace` has no effect.
- **Registry mutation is atomic.** `commitRoutes` (`dsh-llm/lib/index.js:1886-1894`) deletes the old routes and
  adds the new ones in one synchronous section, then emits `llm/adapters-updated`
  (`dsh-llm/lib/index.js:1804-1819`, listener failures are contained and logged, except `INVARIANT`).

### 1.3 Registration is by **provider route string only**

The registry is `adapters = new Map()` keyed by route (`dsh-llm/lib/index.js:1797`), written at `1890`.
`stream()` reaches an adapter with `this.registration(options.provider)` →
`this.adapters.get(provider)` → **throws `LlmError("no adapter registered for provider \"…\"", "NO_ADAPTER")** if absent
(`dsh-llm/lib/index.js:2236-2240`, used at `2286`). **The model id is not a registry key.**

---

## 2. `LlmAdapter` — the exact shape

`dsh-llm/lib/index.js:1670-1740`, exported from the package root (`dsh-llm/lib/index.js:2390`).
The TS manifest renders it as an abstract class (`typert.host.js:336-338`):

```ts
export abstract class LlmAdapter {
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
    imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
```

**Only `stream` is required.** The runtime class body (`dsh-llm/lib/index.js:1670-1740`) implements the other
six with defaults; there is **no `stream` method on the base class**. `VERIFIED`: if a subclass omits
`stream`, the default `prepareCall` calls `this.stream(options)` (`1737`) and fails with a `TypeError`, which
the adapter boundary converts into a terminal `finish{kind:'error'}` chunk (§3.3). Nothing validates the
subclass at registration time — `registerAdapter` only calls `providerInfo` (`1864`).

| Method | Params | Returns | Default when not overridden | Source |
|---|---|---|---|---|
| `providerInfo` | `provider: string` — a route passed to `registerAdapter()` | `{id: string, name: string}`; **`id` must equal `provider`, `name` must be non-empty** | `{id: provider, name: provider}` | `1676-1681`; validated `1865` |
| `providerRetryPolicy` | `_provider` | `ResolvedRetryPolicy \| undefined`; `undefined` ⇒ normal defaults | `undefined` | `1687`; resolved `1867` |
| `imageRequestPricing` | `_provider, _model` | `LlmImageRequestPricing \| undefined`; **must be synchronous, no I/O** | `undefined` | `1690-1697` |
| `listModels` | `_provider` | `Promise<readonly LlmModelInfo[]>`; catalog is **advisory**, core routing accepts unlisted ids | `Promise.resolve([])` | `1698-1708` |
| `resolveModel` | `provider, model, _signal?` | `Promise<LlmResolvedModelInfo>`; `provider`/`id` must echo the request | `{provider, id: model, name: model}` | `1718-1724`; validated `2106-2150` |
| `prepareCall` | `provider, model, signal?` | `Promise<PreparedAdapterCall>` = `{readonly model: LlmResolvedModelInfo, stream(options): AsyncIterable<StreamChunk>}` | `{model: await this.resolveModel(...), stream: (o) => this.stream(o)}` | `1734-1739`; type `typert.host.js:436` |
| **`stream`** | `options: GenerateOptions` | **`AsyncIterable<StreamChunk>`** — an async generator is fine | **none — required** | `1670-1740` (absent); manifest `typert.host.js:336` |

`LlmResolvedModelInfo` (`typert.host.js:392`) is `LlmModelInfo & {context?: {contextWindow}, defaultMaxTokens?,
reasoning?: {efforts, defaultEffort?}, systemPromptUpdate?: 'in-history', toolUpdate?: 'in-history'|'addition-only'}`.
All of it is validated in `normalizeModelInfo` (`dsh-llm/lib/index.js:2106-2150`) — bad metadata throws
`INVALID_MODEL_INFO` / `INVALID_MODEL_CONTEXT` / `INVALID_MODEL_MAX_TOKENS` / `INVALID_MODEL_REASONING`.

**Line index for every referenced type declaration** (all in the generated host type manifest
`dsh-llm/lib/typert.host.js`, which is also what the live Inspect providers render from):

| Type | Line | Type | Line |
|---|---|---|---|
| `AdapterRegistrationHandle` | `228-230` | `PreparedAdapterCall` | `436` |
| `ContentBlockMap` | `272` | `StreamChunk` | `504` |
| `FinishReasonMap` | `308` | `TokenUsage` | `528` |
| `GenerateOptions` | `312` | `ToolCallBlock` | `536` |
| `LlmAdapter` | `336-338` | `ToolSchema` | `560` |
| `LlmCallConfig` | `340` | `llm/stream` event | `605-609` |
| `LlmFailure` | `356` | `LlmModelInfo` | `376` |
| `LlmProviderInfo` | `384` | `LlmResolvedModelInfo` | `392` |

### 2.1 `GenerateOptions` — what the adapter receives

`VERIFIED`, manifest `typert.host.js:312`; built for real by the agent loop at
`dsh-agent-loop/lib/index.js:1269-1276`:

```ts
export interface GenerateOptions {
    provider: string; model: string; reasoningEffort?: ReasoningEffortId;
    messages: RequestMessage[]; system?: string;
    tools?: ToolSchema[]; toolHistory?: ToolHistory;
    temperature?: number; maxTokens?: number; stop?: string[];
    signal?: AbortSignal;
    sessionId?: Branded<'SessionId'>;      // ← present on every agent-loop request
    purpose?: 'compaction' | 'session-title';
}
```

- **`sessionId` is always populated for a loop-built request** (`dsh-agent-loop/lib/index.js:1274`).
- A loop-built request is marked with `markAgentLoopRequest` (`dsh-llm/lib/index.js:377-380`) and **arrives
  deep-frozen**: `deepFreeze(header)` at `dsh-agent-loop/lib/index.js:1261`, every message deep-frozen at
  `1263-1267`, the envelope `Object.freeze`d at `1269`. The `llm/stream` event doc states mutation throws.
  **An adapter must not mutate `options`.**
- `purpose` is set only for auxiliary calls (`'compaction' | 'session-title'`); a normal turn leaves it
  undefined. `INFERRED`: an external-CLI adapter can use `purpose` to keep auxiliary calls on the host
  provider and only reroute real turns.

---

## 3. The chunk protocol

### 3.1 The full chunk type set — 7 variants

`VERIFIED`, manifest `dsh-llm/lib/typert.host.js:504` (`StreamChunk`):

| `type` | Payload | Notes |
|---|---|---|
| `block-start` | `{index: number, blockType: ContentBlockType}` | `ContentBlockType` = `text \| reasoning \| image \| file \| tool-call \| tool-addition \| tool-removal` (`typert.host.js:272`) |
| `text-delta` | `{index, text: string}` | |
| `reasoning-delta` | `{index, text: string}` | thinking output |
| `tool-call-delta` | `{index, id: ToolCallId, name?: string, argumentsDelta: string}` | `name` is sent **once** (with the opening delta); `argumentsDelta` is a JSON *fragment* |
| `block-end` | `{index, block: ContentBlock}` | the finished block; for a tool call, `arguments` is the complete JSON string |
| `usage` | `{usage: TokenUsage}` | `{inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}` — **at most once** |
| `finish` | `{reason: FinishReason, replayState?: ReplayEnvelope}` | **terminal, exactly one** |

`FinishReason` (`typert.host.js:308`) = `{kind:'stop'} | {kind:'tool-calls'} | {kind:'max-tokens'} |
{kind:'aborted', failure} | {kind:'error', failure}`, where `LlmFailure` is
`{message, code, status?, providerRetryAfterMs?, requestId?, offloadImages?}`.

**There is no separate `usage`/`end`/`error` chunk.** Errors and aborts are *finish reasons*.

### 3.2 How chunks are assembled — `BlockAssembler`

`dsh-llm/lib/index.js:954-1103`. Key facts:

- **Delta-only protocols are tolerated** (`950-953`): a `text-delta`/`reasoning-delta`/`tool-call-delta` for an
  index with no prior `block-start` opens a partial implicitly (`ensure`, `1007-1019`).
- An **open block is assembled from its accumulated deltas** (`1020-1039`). An open block of an unknown type
  throws `cannot assemble incomplete block of type "…"` (`1037`).
- Deltas arriving for an index already closed by `block-end` are **ignored** (`979`, `985`, `993`).
- `finish: {kind:'max-tokens'}` **drops all tool-call blocks** (`1051-1053`) — deliberate, so a truncated call
  is never executed.
- **A missing terminal `finish` chunk degrades to `{kind:'stop'}`** (`1100-1103`), and the agent loop reads
  that through `AssistantStreamAttempt.finish` → `this.assembler.finish`
  (`dsh-agent-loop/lib/index.js:464-467`).
- An unknown chunk `type` reaches `assertNever`, which **throws** `Error("unreachable variant in …")`
  (`dsh-util-values/lib/index.js:9-12`, called at `dsh-llm/lib/index.js:1004` and `1227`).

### 3.3 What happens when a chunk is malformed — **this is the surprise**

The package ships a strict grammar validator, `@deepseek-ai/dsh-llm/invariant`
(`dsh-llm/lib/invariant.js`). It installs `ctx.on("llm/stream", (_options, next) => validateStream(next(), fail),
{global: true, prepend: true})` (`dsh-llm/lib/invariant.js:62-66`) and enforces, per `validateStream`
(`19-60`):

- index is a non-negative safe integer (`9-11`, `14`);
- a delta requires an **open block of matching type** (`13-17`) — i.e. `block-start` first;
- no repeated `block-start` index (`28`); `block-end` requires an open block of the **same** type (`43-44`);
- `usage` at most once (`49`);
- nothing after `finish` (`24`); **`finish` with open blocks fails unless the reason is `error`/`aborted`** (`53`);
- **a stream that ends without a terminal `finish` fails** (`59`).

`InvariantFailure = (message: string) => never` (`listService{invariants}`) — `fail` **throws**. Because the
listener is `prepend`ed, its generator wraps `adapterStream` from the outside, so a violation surfaces as a
**thrown error out of the agent loop's `for await`** (`dsh-agent-loop/lib/index.js:1076-1115`) — *not* as a
terminal error chunk, and *not* retryable through `agent/request-error`.

> **But it is not mounted here.** The `invariant` companion is a separate loader entry, and neither
> `@deepseek-ai/dsh-invariants` nor `@deepseek-ai/dsh-llm/invariant` appears in the 193-entry live loader
> directory nor in `profiles\desktop\cordis.yml`. `VERIFIED` (by absence). The package's own comment agrees
> it must be mounted deliberately: `dsh-session/lib/invariant.js:7` — *"companion beside
> `@deepseek-ai/dsh-invariants` to enable the checks."*
>
> **Consequence, `INFERRED`:** on this running instance the grammar is **not** actively enforced. Malformed
> output degrades to `BlockAssembler`'s tolerant behaviour instead of throwing. **Do not build against that
> tolerance** — it is a property of *this profile*, not of the contract, and enabling the companion would turn
> every deviation into a hard thrown failure. The skeleton in §5 emits the strict, fully-closed form.

### 3.4 Where `llm/stream` sits

`VERIFIED`, `dsh-llm/lib/index.js:2367-2372`:

```js
stream(options) { return this.streamWithRegistration(options); }
streamWithRegistration(options, prepared) {
    return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
}
```

`adapterStream` (`2283-2355`) is the **final adapter boundary**: adapter selection, `prepareCall`,
iterator construction and iteration failures all become one terminal `finish` chunk
(`adapterFailureChunk`, `2376-2388`: `kind:'aborted'` when `options.signal.aborted` or code `ABORTED`,
otherwise `kind:'error'`). Middleware, nested-call, cleanup and consumer failures stay **thrown**.
On early termination it calls `iterator.return()` (`2349-2354`) — an adapter's `finally` blocks run.

---

## 4. The key semantic questions

### 4.1 Append or replace? What about equal priority?

**Neither — the registry is exclusive per route, and there is no priority concept at all.**
`VERIFIED`:

- `registerAdapter` has two parameters; there is no priority/order argument (`1833`).
- A route already held by any other registration throws `DUPLICATE_ADAPTER` and registers **nothing**
  (`1863`, and `1838` runs `prepareRoutes` before `commitRoutes`, so rejection leaves the registry untouched —
  documented at `1854-1857`).
- Re-registering a route you already own is allowed only through your own `handle.replace(providers)`
  (`1847-1850`, `1858-1863` treats routes in `owned` as available).

**Practical consequence for this project, `VERIFIED` + `INFERRED`:** `deepseek` is already registered by
`dsh-llm-deepseek-api-key` / `dsh-llm-deepseek-account` (profile lines 438/440). Calling
`ctx.llm.registerAdapter(['deepseek'], …)` from the pilot **throws `DUPLICATE_ADAPTER` at plugin load**. The
pilot can only *add* routes.

**The one supported "priority" mechanism** is ordering among `llm/stream` waterfall listeners, via cordis'
`{prepend: true}` / `{global: true}` options — exactly how the invariant companion installs itself
(`dsh-llm/lib/invariant.js:63-66`). `INFERRED`: a pilot listener registered with `{prepend: true}` runs
outside other middleware; without it, it runs inside.

### 4.2 Can adapter selection be per-session or per-model, or is it global?

**The registry key is the provider route string only — so selection is global per route. But per-model and
per-session routing are both achievable, by three distinct mechanisms.** `VERIFIED`:

1. **Per-model, via many routes on one adapter.** `providers: string[]` is plural, and both shipped adapters
   use it that way: `dsh-llm-pi-ai` registers every configured profile key at once
   (`dsh-llm-pi-ai/lib/index.js:2617,2623`). A pilot can mint one route per external target
   (e.g. `pilot-cli/opencode`, `pilot-cli/codex`) and dispatch inside `stream()` on `options.model`.
   The registry key is an opaque non-empty string — nothing constrains its shape beyond `1862`.
2. **Per-session, inside the adapter.** `options.sessionId` is delivered on every loop request
   (`dsh-agent-loop/lib/index.js:1274`), so an adapter can branch on it. The pilot already tracks a
   per-session binding (`src/index.ts:839` `API_PATH/session/binding`).
3. **Per-session, host-side, via the `agent/request` waterfall.** This is how the GUI's own model picker
   works. `installModelSelection(agentCtx, selection)` registers an **agent-scoped** listener that overrides
   `provider`/`model`/`reasoningEffort` on the resolved config:
   `dsh-agent/lib/types/model-selection.js:61-75`; installed from `dsh-agent/lib/index.js:166` and **exported
   publicly** at `dsh-agent/lib/index.js:700`. Its event is scope-filtered on `payload.agent`
   (`dsh-scope/lib/invariant.js:18`), and the event contract (`listEvents{event:"agent/request"}`) confirms:
   *"Scope-filtered dispatch — agent-scoped listeners receive only that agent."*
   The loop consumes it at `dsh-agent-loop/lib/index.js:1179-1183` and refuses to run without a route
   (`1185`).

   > `INFERRED`: the pilot could install its own agent-scoped `agent/request` listener to pin a session to a
   > pilot route. **`NOT CHECKED`:** how the pilot obtains an agent-scoped `Context` for an *arbitrary live
   > session* (the shipped callers — `dsh-webhook/lib/index.js:127`, `dsh-agent/lib/index.js:181` — already
   > hold one). This is the one integration detail that needs its own investigation.

**Route resolution order, `VERIFIED`:** `route = {provider: this.options.provider ?? "", model: this.options.model ?? ""}`
(`dsh-agent-loop/lib/index.js:1167-1170`) → `agent/request` waterfall (`1179`) → `llm.prepareCall`
(`1189`). A **logged request header wins on resume**: the seed is `requestProposal(persistedHeader)` once a
header exists (`1174-1178`).

### 4.3 The chunk type set

Answered in §3.1. Streaming is **`AsyncIterable<StreamChunk>`**; an `async *stream(options)` generator is the
idiomatic implementation (`dsh-llm-deepseek/lib/index.js:2107-2109` delegates to an `async *generate`,
`2110-2145`).

### 4.4 Tool calls — and what breaks if the external CLI does not speak the tool protocol

**How a tool call is expressed** (`VERIFIED`):

- Open the block with `{type:'tool-call-delta', index, id, name, argumentsDelta: ""}` — `name` is carried on the
  opening delta (`dsh-llm-deepseek/lib/index.js:1954-1960`).
- Stream JSON fragments as further `tool-call-delta` chunks with the same `index` and `id`, `name` omitted
  (`dsh-llm/lib/index.js:1889-1897`).
- Close with `block-end` whose `block` is `{type:'tool-call', id, name, arguments}` where **`arguments` is the
  complete JSON string** (`dsh-llm-deepseek/lib/index.js:1969-1974`; assembled from deltas at
  `dsh-llm/lib/index.js:1031-1036`).
- The reference adapter additionally **`JSON.parse`s every tool-call's arguments and crashes the stream on
  invalid JSON** (`dsh-llm-deepseek/lib/index.js:1983-1992`) — an adapter-side discipline, not a core rule.

**What the host does with them** (`VERIFIED`, `dsh-agent-loop/lib/index.js:1151-1155`):

```js
if (finish.kind === "max-tokens") return { kind: "max-tokens" };          // tool calls already dropped
const toolCalls = message.content.filter((block) => block.type === "tool-call");
if (toolCalls.length === 0) return { kind: "completed" };                  // ← turn ends here
const { concluded } = await executeToolCalls(this.loopCtx, turn, step, toolCalls, signal, …);
```

> **Note the mechanism precisely:** tool execution is triggered by the **presence of `tool-call` blocks in the
> assembled assistant message**, not by `finish.reason.kind === 'tool-calls'`. `VERIFIED` by the code above.
> An adapter that emits well-formed `tool-call` blocks under `{kind:'stop'}` still gets them executed;
> `{kind:'max-tokens'}` is the only reason that suppresses them, and it does so inside `BlockAssembler`
> (`dsh-llm/lib/index.js:1051-1053`).

**If the external CLI does not speak the tool protocol, the DSH tool chain goes inert for those turns.**
`INFERRED` from the VERIFIED code above: no tool-call blocks ⇒ `{kind:'completed'}` ⇒ the loop does not call
`executeToolCalls`, so no DSH tool ever runs and no `role:"tool"` message is ever appended. The adapter cannot
invoke a DSH tool itself — the adapter's only outputs are chunks. Concretely:

- `options.tools` / `options.toolHistory` become **inputs the adapter must render into the CLI's own prompt**;
  they are not enforced by anything downstream.
- The external CLI's *own* tools keep working, but they run inside the CLI's sandbox, not DSH's — and DSH's
  approval, fs-sandbox, spill and retention layers never see them.
- The mirror case is also true: if the CLI never receives DSH's tool schemas, it may answer conversationally
  when the operator expected a DSH tool to fire.

**Tool-schema projection is applied before dispatch, by the host, not by you** (`VERIFIED`):
`projectToolUpdates` (`dsh-llm/lib/index.js:786-837`) runs at `2312-2323`. When the resolved model declares
`toolUpdate` (`'in-history'` or `'addition-only'`), developer messages are filtered and the tool list is
rebuilt from history; when it is `undefined` (the default) developer messages are stripped and `tools` is
passed through as-is, with `deferLoading` flags removed (`787-793`). `resolveModel`/`prepareCall` metadata
also decides how the loop commits the system prompt and detects tool changes
(`dsh-agent-loop/lib/index.js:1052-1055`). `INFERRED`: an external-CLI adapter that wants no projection at all
should leave `toolUpdate` and `systemPromptUpdate` undefined and simply ignore `tools` if it renders its own
prompt.

### 4.5 Authentication and credentials — and can an adapter refuse a session?

**The adapter owns authentication entirely; the `llm` service passes it nothing.** `VERIFIED`: `GenerateOptions`
has no credential field (`typert.host.js:312`), `LlmCallConfig` has none (`typert.host.js:340`),
and `registerAdapter` takes only routes and an adapter (`1833`). The reference adapters resolve auth through
their own injected dependency: `const auth = await this.dependencies.resolveAuth(connection)`
(`dsh-llm-deepseek/lib/index.js:2149`), wired by the provider plugins —
`{headers: {"x-api-key": await resolveApiKey(connection)}}` (`dsh-llm-deepseek-api-key/lib/index.js:61`) or the
account flow (`dsh-llm-deepseek-account/lib/index.js:15,47,52`).

For a pilot adapter, credentials are the plugin's own business. The host offers two seams, both live:

- **`ctx.credentials`** — 9 methods; `resolve(ref): Promise<ResolvedCredential|undefined>`,
  `describe(ref)`, `set/unset`, plus a `CredentialKey` record half
  (`readRecord`/`describeRecord`/`listRecords`/`modifyRecord`/`deleteRecord`). Resolution is **per call** and
  must not be cached across operations (`listService{credentials}`).
- **`ctx.subprocess.resolveExecutable(command, env?, signal?)`** (`listService{subprocess}`) to resolve an
  external CLI's path in the host's execution world.

> `NOT CHECKED`: whether the pilot adapter should reuse the host's DeepSeek API key to feed the external CLI.
> That is a product decision, and reading credential *values* was out of scope for this audit.

**Can an adapter refuse a session? Yes — by throwing.** `VERIFIED`: any throw from `prepareCall`, from
`stream()` at call time, from iterator construction, or from iteration becomes one terminal
`finish{kind:'error', failure}` chunk (`dsh-llm/lib/index.js:2283-2355`, `2376-2388`). The agent loop sees
that, may consult `agent/request-error` for a retry, and otherwise rethrows
`new LlmError(finish.failure.message, finish.failure.code, finish.failure)`
(`dsh-agent-loop/lib/index.js:1117-1134`). Retry policy is the loop's, and the policy the adapter declared is
carried on the event payload (`1129`); the live retry middleware is `@deepseek-ai/dsh-llm-retry`, which
listens on `agent/request-error` (`dsh-llm-retry/lib/index.js:175`, `name = "llm-retry"` at `21`).

There is **no** "decline this session" API and no silent-drop path. There are exactly three behaviours: throw
(terminal error), yield content, or ignore the request (which the host treats as `{kind:'stop'}` with no
tool calls). `INFERRED`: for a per-session opt-out, throwing an `LlmError` with a stable code is the only
honest signal, and it is what the operator will see.

### 4.6 The alternative to registering an adapter at all: intercept `llm/stream`

`VERIFIED` from the live event contract (`listEvents{event:"llm/stream"}`):
*"Waterfall around every streaming model call… call `next()` to reach the resolved adapter's stream, or yield
your own chunks to short-circuit."* Signature:
`'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>`.

`INFERRED`, and worth stating plainly because it changes the shape of the solution: **a `llm/stream` listener
can replace the response for a route it does not own — including `deepseek` — without any adapter
registration and without a `DUPLICATE_ADAPTER` conflict.** Two caveats, both VERIFIED: the options object
arrives deep-frozen and must not be mutated (event doc; `dsh-agent-loop/lib/index.js:1261-1276`), and if the
invariant companion is ever mounted, chunks yielded from a middleware must satisfy the full grammar too
(`dsh-llm/lib/invariant.js:63-66` wraps every `llm/stream` consumer).

---

## 5. Minimal adapter skeleton

**Illustrative only — deliberately NOT written into `src/`.** It shows the shape: DSH request in, external
CLI invocation out, chunks streamed back. Placeholders marked `«…»` need the pilot's real dispatch layer.

```ts
// Pseudocode / sketch. NOT a source file. Illustrates §2 + §3 only.
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const ROUTE = 'pilot-cli'          // must be a route no other plugin owns (§4.1)

class PilotCliAdapter extends LlmAdapter {
  // Only stream() is required (§2). The six others have usable defaults.

  // Optional: make the route visible to catalog-driven surfaces such as the model picker.
  async listModels(provider: string) {
    return [
      { provider, id: 'opencode',      name: 'opencode' },
      { provider, id: 'claude-code',   name: 'Claude Code' },
    ]
  }

  // Optional: mark this route as tool-protocol-native so the loop's prompt/tool
  // bookkeeping stays consistent (§4.4). Omit for an external CLI that renders
  // its own prompt and ignores DSH tools.
  // async resolveModel(provider, model) {
  //   return { provider, id: model, name: model, context: { contextWindow: 200_000 } }
  // }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { provider, model, sessionId, signal } = options

    // 1. Refuse explicitly rather than silently misbehaving (§4.5).
    if (!«isTargetAvailable»(model)) {
      throw new LlmError(`pilot-cli: target "${model}" is not available`, 'TARGET_UNAVAILABLE')
    }

    // 2. Render the DSH request into one CLI invocation. The adapter owns this
    //    entirely: `messages`, `system` and `tools` are inputs, not contracts (§4.4).
    const prompt = «renderPromptFromMessagesAndTools»(options)

    // 3. Launch through the host's subprocess seam, NOT node:child_process —
    //    it owns the execution world, cancellation and teardown. (listService{subprocess})
    const exe = await this.ctx.subprocess.resolveExecutable(«cli.command», undefined, signal)
    const handle = this.ctx.subprocess.spawn({
      argv: [exe, ...«cli.argsFor»(model), ...«cli.promptFlag», prompt],
      cwd: «workspaceDir»,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 5_000,
      signal,                                  // ← cancellation reaches the process
    })

    let index = 0
    let opened = false

    try {
      // 4. Stream stdout into text chunks. block-start first: the strict grammar
      //    requires an open block of the matching type (§3.3).
      yield { type: 'block-start', index, blockType: 'text' }
      opened = true

      for await (const piece of «lineOrTokenIterator»(handle.stdout!)) {
        if (signal?.aborted) throw new LlmError('pilot-cli: aborted', 'ABORTED')
        yield { type: 'text-delta', index, text: piece }
      }

      // 5. Close the block, then settle. Exactly one terminal finish (§3.1).
      yield { type: 'block-end', index, block: { type: 'text', text: «accumulated» } }
      opened = false

      const outcome = await handle.done
      if (outcome.exitCode !== 0) {
        throw new LlmError(`pilot-cli: ${«cli.command»} exited ${outcome.exitCode}`, 'TRANSPORT')
      }

      // usage is optional. If you emit it, emit it at most once, before finish.
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      // adapterStream() also converts a throw into a terminal chunk; throwing is
      // therefore safe, but an open block must never outlive an error finish.
      if (opened) yield { type: 'block-end', index, block: { type: 'text', text: '' } }
      throw error
    } finally {
      // adapterStream calls iterator.return() on early exit (§3.4); terminate here.
      handle.terminate()
    }
  }
}

// 6. Register once, from the plugin's apply(), with inject: ['llm', 'subprocess'].
export function apply(ctx: Context) {
  const adapter = new PilotCliAdapter(ctx)
  ctx.llm.registerAdapter([ROUTE], adapter)   // auto-disposed with the fiber (§1.2)
}
```

**If the external CLI has a structured JSON event stream** (most do), emit one `block-start`/`block-end`
pair per logical block instead of one text block, and express its tool execution as DSH tool-call blocks
(§4.4) if — and only if — DSH should execute those tools. Two mutually exclusive designs exist and the
choice is a product decision, not a technical one:

- **CLI drives its own tools** (DSH tools inert): stream only `text`/`reasoning` blocks. Simplest, and the
  adapter never has to fabricate tool results.
- **DSH drives the tools** (CLI emits `tool-call` blocks, DSH executes and feeds results back through the
  next request's `role:"tool"` messages): requires the CLI to be driven as a *stateless* one-shot model and
  requires the adapter to map CLI tool intent onto DSH's `ToolSchema` names. Much larger scope; `NOT CHECKED`
  here.

---

## 6. Risks and boundaries

### 6.1 VERIFIED — read out of the running rc.2 module tree, with file:line

- `ctx.llm.registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle`;
  the handle is a disposer and carries `.replace()`; registration is `ctx.effect`-scoped, so it dies with the
  fiber. `dsh-llm/lib/index.js:1833-1852`; `typert.host.js:122-125,228-230`.
- `LlmAdapter` needs **only** `stream(options): AsyncIterable<StreamChunk>`; the other six methods have
  defaults. `dsh-llm/lib/index.js:1670-1740`; `typert.host.js:336-338`.
- The registry is a `Map` keyed by the **provider route string**; the model id is never a key; an unknown route
  throws `NO_ADAPTER`. `dsh-llm/lib/index.js:1797,1890,2236-2240`.
- Registration is **exclusive per route** — `DUPLICATE_ADAPTER`, all-or-nothing, no priority parameter.
  `dsh-llm/lib/index.js:1837-1838,1862-1863`.
- `providerRetryPolicy` is sampled **once at registration**. `dsh-llm/lib/index.js:1867`.
- The 7 chunk types and their payloads. `typert.host.js:504,272,308,312,536`.
- Loop-built `GenerateOptions` carries `sessionId` and arrives deep-frozen.
  `dsh-agent-loop/lib/index.js:1261-1276`.
- Tool execution is triggered by **the presence of `tool-call` blocks**, not by `finish.reason.kind`.
  `dsh-agent-loop/lib/index.js:1151-1155`; tool calls are dropped only on `max-tokens`
  (`dsh-llm/lib/index.js:1051-1053`).
- A missing `finish` chunk degrades to `{kind:'stop'}`; an unknown chunk type throws.
  `dsh-llm/lib/index.js:1004,1100-1103`; `dsh-util-values/lib/index.js:9-12`.
- Adapter selection / dispatch / iteration failures become one terminal `finish` chunk; middleware and
  consumer failures stay thrown. `dsh-llm/lib/index.js:2283-2355,2376-2388`.
- The `llm/stream` waterfall can be short-circuited by yielding your own chunks. Live event contract +
  `dsh-llm/lib/index.js:2370-2372`.
- The strict chunk grammar exists as an **unmounted** companion, and is deliberately opt-in.
  `dsh-llm/lib/invariant.js:19-66`; `dsh-session/lib/invariant.js:7`; absent from
  `profiles\desktop\cordis.yml` and from the 193-entry live loader directory.
- Per-session route switching is a real, exported mechanism: `installModelSelection`
  (`dsh-agent/lib/index.js:166,700`; `dsh-agent/lib/types/model-selection.js:61-75`), dispatched
  agent-scoped (`dsh-scope/lib/invariant.js:18`).
- Credentials: the `llm` seam carries none; the adapter resolves its own (`dsh-llm-deepseek/lib/index.js:2149`;
  `dsh-llm-deepseek-api-key/lib/index.js:61`). `ctx.credentials` and `ctx.subprocess` contracts read live.
- Reference registration patterns, for copying: `dsh-llm-deepseek/lib/index.js:2246-2281` (single route +
  `loader/volatile-update` → `replace`) and `dsh-llm-pi-ai/lib/index.js:2588-2636` (multi-route +
  `registerConfigurableProviders` + `registerModelDiscovery`).

### 6.2 INFERRED — reasoned from the VERIFIED facts, not directly observed

- A `llm/stream` listener can substitute the response for an already-owned route such as `deepseek`, with no
  adapter registration. (Stated by the live event contract and by `invariant.js` wrapping every stream, but
  not exercised.)
- Registering `deepseek` from the pilot throws `DUPLICATE_ADAPTER` at plugin load. (Follows from `1863` plus
  the profile mounting the two DeepSeek adapter plugins at `cordis.yml:438,440`.)
- On this instance the chunk grammar is not actively enforced, so malformed output is tolerated rather than
  thrown. (Follows from the companion's absence; the tolerance itself is VERIFIED in `BlockAssembler`.)
- An external-CLI adapter that emits no `tool-call` blocks makes every DSH tool inert for those turns.
  (Follows directly from `1152-1155`, but the end-to-end turn was not run.)
- `@Remote`-less `registerAdapter` means a client half cannot register adapters. (Follows from the decorator
  list at `1754-1756`.)
- Changing retry policy without calling `.replace()` has no effect. (Follows from `1867` + `2269-2280`.)
- `purpose` can be used to keep auxiliary calls (`compaction`, `session-title`) off the external CLI.
  (The field is VERIFIED; the routing behaviour is a design choice.)

### 6.3 NOT CHECKED — no investigation performed; not a premise

- **How the pilot obtains an agent-scoped `Context` for an arbitrary live session**, which is the missing
  piece for the pilot installing its own `agent/request` listener. The shipped callers already hold one
  (`dsh-webhook/lib/index.js:127`, `dsh-agent/lib/index.js:181`); the acquisition path for a plugin was not
  traced. **This is the highest-value next investigation.**
- **What the session-page model picker actually reads** to build its list — presumably
  `llm.listProviders()` + `llm.listModels()` (which the pilot already calls,
  `src/models.ts:5`, `src/tools.ts:836`) plus the configurable-provider directory, but the client half
  (`dsh-client-ui-model-selection`) was not read, and Client Inspect `Slots` was not queried.
- Whether a purely additive route (`pilot-cli`) automatically appears in that picker, or requires a
  `registerConfigurableProviders` directory entry, or a client-side contribution.
- How DSH session history (`assistant/message` with `source: {provider, model, replayState}`) behaves when the
  same session alternates between the host adapter and an external CLI. `replayState` is dropped when the
  historical route is owned by a different adapter (`forAdapter`, `dsh-llm/lib/index.js:2242-2263`) — the
  consequence for an external CLI that has no replay concept was not tested.
- Image/file attachment handling for an external CLI (`ImageBlock`, `FileBlock`,
  `projectFilesToText`/`projectImagesForTextModel` at `dsh-llm/lib/index.js:2310-2311`) — not investigated.
- Token accounting / cost for an external CLI (`TokenUsage`, `imageRequestPricing`,
  `dsh-token-meter`) — not investigated.
- Whether the `invariants` service is mounted in *other* profiles (`headless`, `web`) — only `desktop` was
  inspected. If the pilot is ever loaded elsewhere, §3.3's tolerance may not hold.
- Behaviour under HMR when the pilot's adapter is replaced mid-stream — not tested (and not testable without
  a live plugin edit, which this audit avoided).
- `compaction`, `session-title` and `dsh-llm-retry` interactions with an external-CLI adapter — read only far
  enough to cite, not analysed.

---

*Read-only audit. No file outside this document was created or modified; no model request was issued; no
credential value was read.*
