# Host extension points — verified against the RUNNING DSH 0.2.0-rc.2 build

Verification basis (all three facts independently re-derived in this session):

| Fact | Value | How it was checked |
|---|---|---|
| Running host | `@deepseek-ai/dsh-desktop` / `dsh-desktop-runtime` **0.2.0-rc.2**, commit `04f392c9ddd144fa426da2045178797da6db6c11`, `dshBuildDirty=false` | parsed `/package.json` and `/dsh/package.json` straight out of `D:\DeepSeek\resources\app.asar` (121,348,951 bytes) with an inline node asar reader |
| Evidence tree freshness | `D:\Project\_dsh-asar\host` matched the live asar **byte-for-byte (SHA-256) for 333/334 files**; `host2` 277/277; `host3` 200/201 | hashed every extracted file against the asar entry |
| Known extraction gap | `dsh-client-ui-chat/lib/client.js` (565,053 B) was never extracted; `host3/cordis/package.json` differs in 4 bytes | re-read directly from the asar when needed |

Stale copies (`C:\Users\Administrator\.dsh\dist\...0.1.1-rc.1`, `C:\dsh\...0.2.0-rc.1`, `D:\Project\deepseek-harness-master\...0.1.0-rc.8`) were **not** consulted as evidence.

Two build-generated, in-asar catalogues were used as primary sources and are themselves part of the running build:

- `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` — generated **client Slot catalogue**: 90 declared slots with `kind`, `scope`, `doc`, `registerOptions`, `ownerProps` (exact TS), `declaredBy`, `source` (`packages/.../src/client/contract/slots.ts:LINE`). [not in the extraction → read from asar; line numbers are asar line numbers]
- `@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js` — generated **Host API catalogue**: every Service method signature + referenced type declarations. Present in `host2`.

Live runtime confirmation used where possible: the Host `Service` / `Event` / `Config` / `Tool` inspect providers answered. The **Client** providers (`Slots`, `Service`, `Event`, `Builtin`, `Theme`) **timed out** (`Client inspect query … timed out after 10000ms; Open or reconnect the Harness page`) — so client slot topology below is verified from the byte-identical rc.2 client bundles and the generated catalogue, **not** from a live topology dump. That distinction is carried in every verdict.

Labels: `VERIFIED` = quoted rc.2 code from the running build. `UNCONFIRMED` = no quoting evidence.

---

## 1. Settings UI slots — verdict: **supported** (with one corrected key)

| Slot key | Declared in 0.2.0-rc.2? | kind / scope | Evidence |
|---|---|---|---|
| `settings.section` | yes | `list` / `root` | `host/dsh-client-ui-settings-general/lib/client.js:1136-1139` |
| `settings.plugins.tab` | yes | `list` / `root` | `host2/dsh-client-ui-settings-plugins/lib/client.js:208-211` |
| `settings.general.item` | yes | `list` / `root` | `host/dsh-client-ui-settings-general/lib/client.js:1177-1180` |
| **`settings.plugins.item`** | **NO — does not exist** | — | asar-wide regex found **0** occurrences; the real key is `plugins.item` |
| `plugins.item` | yes | `list` / `root` | `host2/dsh-client-ui-plugin-manager/lib/client.js:3725-3728` |
| `settings.onboarding` | yes | `list` / `root` | `host/dsh-client-ui-settings-general/lib/client.js:1140-1143` |
| `settings.models.provider-card` | yes | `keyed` / `root` | `host/dsh-client-ui-settings-models/lib/client.js:4066-4069` |
| `settings.models.footer` | yes | `list` / `root` | `host/dsh-client-ui-settings-models/lib/client.js:4070-4073` |
| `settings.models.sign-in` | yes | `single` / `root` | `host/dsh-client-ui-settings-models/lib/client.js:4085-4088` |
| bare `settings.models` | **NO slot** | — | the only `"settings.models"` literal is the i18n/config namespace `const NS = "settings.models"` (`.../settings-models/lib/client.js:3976`); the slot catalogue has no such key |

Declaration site (one entry's `children` table declares the whole settings surface), `host/dsh-client-ui-settings-general/lib/client.js:1111-1146`:

```js
const disposeSlot = ctx.slots.register({
    name: "sidebar.settings",
    locale: NS,
    store: shellStore,
    children: {
        "settings.launcher": { kind: "single", scope: "root" },
        "settings.trigger":  { kind: "single", scope: "root" },
        "settings.header":   { kind: "single", scope: "root" },
        "settings.action":   { kind: "list",   scope: "root" },
        "settings.close":    { kind: "single", scope: "root" },
        "settings.section":  { kind: "list",   scope: "root" },
        "settings.onboarding": { kind: "list", scope: "root" }
    },
    inject: shellInjected
}, SettingsRoot);
```

`settings.plugins.tab` / `settings.general.item` / `settings.models.*` are declared as children of a **settings.section entry**, `host2/dsh-client-ui-settings-plugins/lib/client.js:201-212`:

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "plugins", order: 15, label: () => t("nav"), locale: NS,
    inject: sectionInjected,
    children: { "settings.plugins.tab": { kind: "list", scope: "root" } }
}, PluginsSettingsSection));
```

and `host/dsh-client-ui-settings-general/lib/client.js:1171-1181`:

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "general", order: 0, label: () => t("general.nav"), locale: NS,
    children: { "settings.general.item": { kind: "list", scope: "root" } }
}, GeneralSection));
```

### Props each slot receives (from the owners' `renderSlot` call sites)

| Slot | Props passed by the owner | Evidence |
|---|---|---|
| `settings.section` | `{ close }` (plus `{only: activeId}` render option) | `settings-general/lib/client.js:337`: `renderSlot("settings.section", { close: onClose }, { only: active })` |
| `settings.onboarding` | `{ stepId, explicit, complete, openSection }` (+ `{only: id}`) | `settings-general/lib/client.js:489-496` |
| `settings.general.item` | **none** — `renderSlot("settings.general.item", {})` | `settings-general/lib/client.js:638`; catalogue doc: "the owner passes no props at all" |
| `settings.plugins.tab` | **none** — `renderSlot("settings.plugins.tab", {}, { only: single.id })` | `settings-plugins/lib/client.js:68,124` |
| `plugins.item` | `{ view: 'summary' }` and `view: 'page'`-style dispatch by `only: id` | `plugin-manager/lib/client.js:2266,2322,2330` |
| `settings.models.provider-card` | keyed dispatch by `entryKey = settingsNs`, `ProviderCardExtrasOwnerProps` (`provider: ProviderDirectoryEntry`, …) | client slot catalogue entry `settings.models.provider-card` |
| `settings.models.sign-in` | none (`ownerProps: []`) | client slot catalogue entry |
| `settings.models.footer` | none (`list` seat, "Without a registrant the area renders nothing") | client slot catalogue entry |

Registration shape for all of them (from the catalogue): `settings.section` takes `id` (required), `order?`, `label?`; `list` slots take `id` (required), `order?`, `label?`; `keyed` slots take `key` (required); `single` slots take **no** register options.

Framework props are uniform: every registered component additionally receives the five framework shares (`owner`, `renderSlot`, `renderFactorySlot`, store selector/actions, injected face) — `host/dsh-client-ui-slots/README.md:38`.

---

## 2. `conversation.input.model` — verdict: **supported**, kind = `single`

Declaration, `host2/dsh-client-ui-conversation/lib/client.js:18293-18333`:

```js
const registerComposerBar = () => slots.register({
    name: "conversation.composer.bar",
    locale: NS,
    children: {
        "conversation.input.attachments": { kind: "single", scope: "session-maybe" },
        "conversation.input.overlay":     { kind: "list",   scope: "session" },
        "conversation.input.permission":  { kind: "single", scope: "session" },
        "conversation.input.left":        { kind: "list",   scope: "session" },
        "conversation.input.plan":        { kind: "single", scope: "session" },
        "conversation.input.right":       { kind: "list",   scope: "session" },
        "conversation.input.model":       { kind: "single", scope: "session" },
        "conversation.input.activity":    { kind: "single", scope: "session" },
        "conversation.composer.dock":     { kind: "list",   scope: "session" }
    },
```

Conflicting `single` registration behaviour — `host/dsh-client-ui-slots/lib/index.js:163-173`:

```js
register(options, component) {
    const rec = this.records.get(options.name);
    if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
    const spec = rec.spec;
    const priority = options.priority ?? 0;
    const occupantHint = (occupant) => `at priority ${priority}${occupant.registrant !== void 0 ? ` (registered by ${occupant.registrant})` : ""} — register at a different priority to shadow it (lowest renders)`;
    switch (spec.kind) {
        case "single": {
            const occupant = rec.entries.find((e) => (e.options.priority ?? 0) === priority);
            if (occupant) throw new Error(`single slot "${options.name}" already has a registration ${occupantHint(occupant)}`);
            break;
        }
```

and the resolution side — `…/slots/lib/index.js:220-221` (ascending sort) + `278-293`:

```js
next.sort(spec.kind === "list" ? (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0) || (a.options.order ?? 0) - (b.options.order ?? 0) : (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0));
```

```js
entriesOfSlot(key) {
    const rec = this.records.get(key);
    if (!rec?.spec) return NO_ENTRIES;
    const kind = rec.spec.kind;
    if (kind === "chain") return rec.entries;
    const heads = [];
    const seenCells = new Set();
    for (const entry of rec.entries) {
        if (this.abdicated.has(entry)) continue;
        const cell = kind === "keyed" ? entry.options.key : kind === "list" ? entry.options.id : void 0;
        if (seenCells.has(cell)) continue;
        seenCells.add(cell);
        heads.push(entry);
    }
    return heads;
}
```

**Exact answer:** a second occupant at the *same* priority **throws** at registration time (`single slot "conversation.input.model" already has a registration at priority N …`). At a *different* priority it is accepted and **shadowed** — the **lowest priority wins and renders**; the higher-priority entry stays on the ledger but is not projected (`entriesOfSlot` keeps the first live entry per cell in ascending-priority order). A render-time crash can also abdicate the winner for the rest of its registration's life (`reportEntryError`, `slots/lib/index.js:455-463`).

---

## 3. Adjacent open composer slots — verdict: **supported**

All confirmed by both the generated client slot catalogue (kind/scope) and the shipped declaration table above:

| Key | kind / scope | Doc (catalogue) | Render site / order |
|---|---|---|---|
| `conversation.input.overlay` | `list` / `session` | "Floating entries rendered inside the resident composer card." | `conversation/lib/client.js:17450-17453` — **first child of the composer card**, inside `overlayAnchor` |
| `conversation.input.left` | `list` / `session` | "Compact controls at the left of the composer tool row." | `:17524` — after the `modes` block (permission, plan) in the `tools` row |
| `conversation.input.right` | `list` / `session` | "Compact controls before the composer submit action." | `:17532` — first child of `standardControls`, before `conversation.input.model` |
| `conversation.input.dock` | `list` / `session` | "Full-width entries above the composer card." | `:16309` — `zone !== void 0 && renderSlot("conversation.input.dock", zone)` **above** `inputBar` in `composerStack` |
| `conversation.composer.dock` | `list` / `session` | "Ambient entries below the composer card." | `:17615` — `variant === "composer" && … ? renderSlot("conversation.composer.dock", {}) : null` inside the bar |

Note the two similarly named keys are **different slots** declared by different owners: `conversation.input.dock` is declared by the `conversation.content` **factory** (`declaredBy: "factory 'conversation.content' (client-ui-conversation)"`), `conversation.composer.dock` by an entry in `conversation.composer.bar`.

Full composer-card render order (top → bottom), `conversation/lib/client.js:17449-17540`: `conversation.input.overlay` → `conversation.input.attachments` → `DraftEditor` → tool row `[command button, file input, {conversation.input.permission, conversation.input.plan}, conversation.input.left]` → trailing `[{conversation.input.right, conversation.input.model}, conversation.input.activity]` → stop button. `conversation.input.dock` sits above the card; `conversation.composer.dock` inside the bar after it. The whole composer is itself replaceable through the `conversation.composer` **chain** slot (`select`-elected, `declaredBy: factory 'conversation.content'`).

---

## 4. Model-selection data contract — verdict: **supported**, with one important nuance

Props handed to an occupant — from the generated catalogue entry `conversation.input.model` (`source: packages/client/ui-conversation/src/client/contract/slots.ts:223`):

```ts
/** Owner share of the named plan, permission, and model controls. */
export interface InputControlOwnerProps {
  /** Whether the composer currently refuses interaction. */
  locked: boolean
}
```

Render site passes exactly that: `conversation/lib/client.js:17532` → `renderSlot("conversation.input.model", { locked: modelSeatLocked })`.

**Nuance (verified):** the richer `{ available, directory, load, select }` face belongs to the *shipped occupant's own* `inject` face, not to the slot contract — `host/dsh-client-ui-model-selection/lib/client.js:1248-1263`:

```js
scope.slots.inject("conversation.input.model", () => scope.slots.register({
    name: "conversation.input.model",
    locale: NS,
    inject: (sessionId) => {
        const directory = models.directoryFor(sessionId);
        const available = sessions.subagentAddress(sessionId) === void 0;
        return {
            available,
            directory: directory.store,
            load: () => { if (available) directory.load().catch(() => {}); },
            select: (selection) => available ? directory.select(selection) : Promise.resolve(void 0)
        };
    }
}, ModelSelect));
```

A replacement occupant gets only `locked` from the slot and must build its own data path (e.g. `scope.modelDirectories`, `scope.sessions`, `useSessions`).

`select(selection)` → `sessions.selectModel(...)` call path — `dsh-client-ui-model-selection/lib/client.js:235-251`:

```js
async select(selection) {
    this.assertAvailable();
    const previous = this.store.getSnapshot().current;
    const previousEffort = previous?.reasoningEffort ?? (previous === null ? void 0 : this.catalog.reasoningFor(previous)?.defaultEffort);
    const nextEffort = selection.reasoningEffort ?? this.catalog.reasoningFor(selection)?.defaultEffort;
    const generation = ++this.generation;
    this.store.update((s) => { s.status = "selecting"; s.pending = selection; s.error = null; });
    const result = await this.sessions.selectModel({
        sessionId: this.sessionId,
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
    });
```

Shapes — `host2/dsh-tool-cordis/lib/types/api-catalog.js:6775-6781`:

```ts
export interface SessionSelectModelRequest extends ModelSelection { readonly sessionId: SessionId; }
export interface SessionSelectModelValue { readonly selected: ModelSelection; }
```

```ts
export interface ModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
```

`ModelSelection` was recovered from the generated typert catalogue `host/dsh-permission-presets/lib/typert.host.js:390-391` (same declaration also in `host/dsh-subagent/lib/typert.host.js:554-555`, `host2/dsh-agent-preset-registry/lib/typert.host.js:558-559`). The host Remote signature is `@Remote('selectModel') selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue>` (`api-catalog.js:1873`).

---

## 5. Subagent provider registration — verdict: **supported** (out-of-process capability claim: **conditional**)

`ctx.subagents.registerProvider(provider): () => void` — live Host inspect of service `subagents`:

> `registerProvider(provider: SubagentProvider): () => void` — "Register a provider under its name. Registration is effect-scoped and HMR safe; removing a provider blocks new starts but does not revoke runs that were already returned to their holders."

Exact provider interface — `host2/dsh-tool-cordis/lib/types/api-catalog.js:7200`:

```ts
export interface SubagentProvider {
    readonly name: string;
    readonly capabilities: SubagentCapabilities;
    readonly inheritsParentContext: boolean;
    readonly agentRouteDefaults?: Readonly<{ provider: string; model: string; }>;
    start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
    prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>;
}
```

```ts
export interface SubagentCapabilities {
    readonly agentOptions: boolean;
    readonly outputSchema: boolean;
    readonly depthLimit: boolean;
    readonly toolFilter: boolean;
    readonly persona: boolean;
}
```
(`api-catalog.js:7156`)

Out-of-process helper seam — `host/dsh-subagent/lib/types/out-of-process.js` (also re-exported from `dsh-subagent/lib/index.js:3201`):

```js
/**
 * The capability advertisement of an out-of-process backend: NONE. A child in
 * another process cannot honor parent-enforced start features
 * (`agentOptions`/`outputSchema`/`maxDepth`/`toolFilter`/`persona`), so the service rejects a
 * request needing any of them before `start` runs — never accepted-then-ignored.
 */
export const NO_START_CAPABILITIES = Object.freeze({
    agentOptions: false,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
});
```
(`out-of-process.js:43-55`)

- `resolveChildCwd(prefix, configured, parentCwd)` — `out-of-process.js:137-144`: deployment override else the delegating parent session cwd, fail-loud when neither exists.
- `settleRunResult(parts)` — `out-of-process.js:163-194`: `result` never rejects after publication; a rejection flattens to `stopReason: 'error'`, or `'aborted'` when cancellation already settled; diagnostic byte-limited to 4096.
- `subprocessRunHandle(parts)` — `out-of-process.js:203-218`: `{ id, localAgent: undefined, result, dispose() }`; `dispose()` is idempotent, removes the abort listener, settles local cancellation, then awaits backend teardown.

**Is `agentOptions: false` *required* for an out-of-process provider?** **No — not enforced.** The enforcement is capability-agnostic; `host/dsh-subagent/lib/types/index.js:456-470`:

```js
assertCapabilities(provider, request) {
    const needs = [
        { when: request.agentOptions !== undefined, cap: 'agentOptions' },
        { when: request.outputSchema !== undefined, cap: 'outputSchema' },
        { when: request.maxDepth !== undefined, cap: 'depthLimit' },
        { when: request.toolFilter !== undefined, cap: 'toolFilter' },
        { when: request.persona !== undefined, cap: 'persona' },
    ];
    for (const { when, cap } of needs) {
        if (when && !provider.capabilities[cap]) {
            throw new SubagentError(`subagent provider "${provider.name}" does not support the "${cap}" capability`, 'UNSUPPORTED_CAPABILITY');
        }
    }
}
```

So the answer is two-sided and both sides are verified:

- Declaring `agentOptions: false` makes per-child model/reasoning-effort **impossible through that provider** — a request carrying `agentOptions` (or `persona`) is rejected with `UNSUPPORTED_CAPABILITY` *before* `start` runs.
- Nothing forces an out-of-process provider to declare `false`. The out-of-process seam *ships* `NO_START_CAPABILITIES` as the correct advertisement and documents that a foreign-process child cannot honour parent-enforced start features. A provider that declares `agentOptions: true` must honour the override itself — `agentOptions` is delivered **to the provider** inside `ResolvedSubagentStartRequest`. The shipped **in-process** providers do exactly that: `host2/dsh-subagent-spawn-in-process/lib/index.js:24` and `host2/dsh-subagent-fork-in-process/lib/index.js:38` both declare `agentOptions: true` (`inheritsParentContext` false / true respectively).
- Downstream consequence in the tool layer (`host/dsh-tool-subagent/lib/index.js:377-379`):

```js
if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== void 0 && !subagentProvider.capabilities.depthLimit) throw new Error(`tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`);
if (config.agentOptions !== void 0 && !subagentProvider.capabilities.agentOptions) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`);
if (modelSelectionCapable && !subagentProvider.capabilities.agentOptions) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child model selection`);
```

`dsh-subagent/README.md:59`: "A start request may override the child Agent's provider, model, reasoning effort, and output-token limit through `agentOptions`; every requested option requires the provider's matching capability." `README.md:67`: "Requests that need a capability the chosen provider lacks fail loudly at start rather than being silently ignored."

**No out-of-process subagent backend ships in this build** — the asar has no `dsh-subagent-acp` / SDK / Codex / Claude-Code provider package (289 `@deepseek-ai` dirs enumerated; only `dsh-subagent-spawn-in-process`, `dsh-subagent-fork-in-process`, `dsh-subagent-in-process-driver` exist).

---

## 6. Cancellation & resumption — verdict: **supported**

Cancellation is **`request.signal`**; there is **no `cancel()`** anywhere in the provider/run contract.

```ts
export interface SubagentStartRequest {
    readonly label?: string;
    readonly prompt: ContentBlock[];
    readonly parent: Agent;
    readonly signal: AbortSignal;
    readonly agentOptions?: AgentOptions;
    readonly outputSchema?: ObjectJsonSchema;
    readonly maxDepth?: number;
    readonly toolFilter?: ToolRestriction;
    readonly persona?: string;
}
```
(`api-catalog.js:7232`)

```ts
export interface SubagentRun {
    readonly id: SessionId;
    readonly localAgent: Agent | undefined;
    readonly result: Promise<SubagentResult>;
    dispose(): Promise<void>;
}
```
(`api-catalog.js:7208`) — `dispose()` is the only teardown verb; it is documented as "implements the caller's cancellation".

```ts
export interface ContinuableCreateRequest {
    readonly sessionId: SessionId;
    readonly parent: Agent;
    readonly signal: AbortSignal;
}
```
(`api-catalog.js:4795`)

Provider-side signal wiring is explicit in the out-of-process handle: `parts.signal.removeEventListener('abort', parts.onAbort); parts.requestCancel();` (`out-of-process.js:212-213`). The service's own interrupt path is `interrupt(targetSessionId, authority)` / `interruptByParent(childSessionId, parentSessionId, 'continuable')` — see the SubagentRuntime declaration at `api-catalog.js:7224`; neither is named `cancel`.

Resumption is exactly `startContinuable` + provider `prepareContinuable` + `sendMessage`:

```ts
export interface ContinuableStartSpec {
    readonly provider: string;
    readonly label: string;
    readonly childId?: SessionId;
    readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>;
    readonly signal: AbortSignal;
}
```
(`api-catalog.js:4807`) → `async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>` returning `{ childId, messageId }`.

Provider sides:
```js
if (provider.prepareContinuable === undefined) throw new SubagentError(`subagent provider "${provider.name}" does not support continuable children (no prepareContinuable capability)`, "UNSUPPORTED_CAPABILITY");
```
(`host/dsh-subagent/lib/index.js:3151`, identical source at `host/dsh-subagent/lib/types/index.js:429-430`)

and `async sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId>` with `SubagentSendMessageOptions = { readonly signal: AbortSignal }` (`api-catalog.js:7228`).

---

## 7. Agent-team integration — verdict: **supported** (creation + role), **unsupported** (extending `TeamMemberView`)

Teammates are created **by provider name**, `host/dsh-experimental-tool-agent-team/lib/index.js:16-19`:

```js
const Config = z.object({
	freshProvider: z.string().default("spawn"),
	forkProvider: z.string().default("fork")
});
```

```js
return { member: modelMember((await ctx.agentTeams.spawnTeammate(agent, {
    name: args.name,
    description: args.description,
    prompt: [ { type: "text", text: `<system-reminder>…` }, { type: "text", text: args.prompt } ],
    context,
    provider: context === "fork" ? config.forkProvider : config.freshProvider,
    signal: exec.signal
})).member) };
```
(`tool-agent-team/lib/index.js:270-292`) — `context` comes from the tool args (`const context = args.context ?? "fresh"`, line 270).

```ts
export interface SpawnTeammateRequest {
    readonly name: string;
    readonly description: string;
    readonly prompt: ContentBlock[];
    readonly context: 'fresh' | 'fork';
    readonly provider: string;
    readonly signal: AbortSignal;
}
```
(`api-catalog.js:7040`)

The `role: 'lead' | 'teammate'` model — `api-catalog.js:7352` and `:7356`:

```ts
export interface TeamMembership {
    readonly root: Agent;
    readonly id: TeamId;
    readonly role: 'lead' | 'teammate';
    readonly name: string;
}
```
```ts
export interface TeamMemberView {
    readonly id: SessionId;
    readonly name: string;
    readonly role: 'lead' | 'teammate';
    readonly status: 'running' | 'inactive' | 'provisioning' | 'failed';
    readonly description?: string;
    readonly provider?: string;
    readonly context?: 'fresh' | 'fork';
    readonly model?: string;
    readonly diagnostics: string[];
}
```

Runtime lead construction: `host/dsh-experimental-agent-team/lib/types/roster.js:81,90` → `return { root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' };`.

**Is `TeamMemberView` extensible or closed?** **Closed — no extra columns are possible through a plugin API.** Two independent runtime gates:

1. Persisted snapshot schema is `strict()` — `host/dsh-experimental-agent-team/lib/index.js:1146-1158`:

```js
const teamMemberSnapshotSchema = z$1.object({
	id: sessionIdSchema,
	name: z$1.string(),
	description: z$1.string(),
	provider: z$1.string(),
	context: z$1.enum(["fresh", "fork"]),
	phase: z$1.enum(["provisioning", "active", "failed"]),
	error: z$1.string().optional()
}).strict();
```

(with `host/dsh-experimental-agent-team/lib/index.js:1302-1303`: `if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) throw new Error(\`teammate "${member.id}" changed immutable identity fields\`);`)

2. The model-facing roster row schema is closed — `host/dsh-experimental-tool-agent-team/lib/index.js:35-71`: `MEMBER_VIEW_SCHEMA` has `additionalProperties: false` and properties `{ target, role, status, description, provider, context, model, diagnostics }` (`target` is the member **name**; `modelMember` renames `id`→`target`, `index.js:72-79`).

So even though `modelMember` spreads `...details`, any extra column added to the service's returned object would be rejected by the closed tool output schema. `spawn_teammate`'s value schema is likewise `additionalProperties: false` (`index.js:133-139`).

---

## 8. LLM adapter / real routing — verdict: **supported**

`ctx.llm.registerAdapter(providers, adapter)` — live Host inspect of service `llm`: "Register an adapter for the given provider routes. Throws `LlmError` with code `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing). Disposed with the fiber." Returns `AdapterRegistrationHandle { (): void; replace(providers: string[]): void }`. Source: `host/dsh-llm/lib/index.js:1833` (`registerAdapter(providers, adapter) {`), `:1845` (`}, "llm.registerAdapter()")`).

`LlmAdapter` — `host/dsh-llm/lib/types/index.js:141-208`, class-level JSDoc at `:135-140`:

```js
/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove the headers are added in the wire request or library header hook. …
 */
export class LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider }; }          // :147
    providerRetryPolicy(_provider) { return undefined; }                          // :155
    imageRequestPricing(_provider, _model) { return undefined; }                  // :167
    listModels(_provider) { return Promise.resolve([]); }                         // :178
    resolveModel(provider, model, _signal) { return Promise.resolve({ provider, id: model, name: model }); }  // :190
    async prepareCall(provider, model, signal) { … }                              // :202
}
```

The one **abstract** member is the stream, erased at runtime and recorded in the generated catalogue `host/dsh-llm/lib/typert.host.js:337`:

```ts
export abstract class LlmAdapter {
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
    imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
```

`ctx.llm.registerConfigurableProviders(entries)` — `dsh-llm/lib/index.js:1910`; service doc: "Declare provider routes an adapter plugin can activate through configuration. Registration is all-or-nothing … Returns a handle that withdraws all of them, and can atomically replace them."

`ctx.llm.registerModelDiscovery(settingsNs, discover)` — `dsh-llm/lib/index.js:1974`:

```ts
registerModelDiscovery(
    settingsNs: string,
    discover: (request: LlmModelDiscoveryRequest, signal?: AbortSignal) => Promise<readonly LlmDiscoveredModel[]>,
): () => void
```

Also present and useful: `resolveCallConfig` / `prepareCall` (`dsh-llm/lib/index.js:2161`, `:2203`), `providerRetryPolicy`, `imageRequestPricing`, `listModels`, `resolveModelInfo`.

---

## 9. Reasoning effort — verdict: **supported**

```ts
export type ReasoningEffortId = Branded<'ReasoningEffortId'>;
```
(`host/dsh-llm/lib/typert.host.js:453`; live inspect of `llm` and `subagents` both report the identical declaration) — a **branded string**, not a global enum. The brand constructor is runtime code: `host/dsh-llm/lib/types/brand.js:50` → `export function ReasoningEffortId(id) { … }`.

Efforts are **declared per model**:

```ts
export interface LlmModelReasoningInfo {
    efforts: readonly LlmReasoningEffortInfo[];
    defaultEffort?: ReasoningEffortId;
}
export interface LlmReasoningEffortInfo { id: ReasoningEffortId; name: string; description?: string; }
```
(`dsh-llm/lib/typert.host.js:381`, `:389`), reached through `LlmResolvedModelInfo.reasoning?`.

Rejection happens **before I/O, with no clamping or aliasing** — `host/dsh-llm/lib/index.js:2168-2188`:

```js
/** Validate request controls against one already-bound exact model result. */
resolveCallWithInfo(config, info) {
    const defaulted = config.maxTokens === void 0 && info.defaultMaxTokens !== void 0 ? { ...config, maxTokens: info.defaultMaxTokens } : config;
    const reasoning = info.reasoning;
    const requested = defaulted.reasoningEffort;
    let resolvedConfig = defaulted;
    if (reasoning === void 0) {
        if (requested !== void 0) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
    } else {
        const effective = requested ?? reasoning.defaultEffort;
        if (effective !== void 0) {
            if (!reasoning.efforts.some((effort) => effort.id === effective)) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`, "UNSUPPORTED_REASONING_EFFORT");
            if (requested !== effective) resolvedConfig = { ...defaulted, reasoningEffort: effective };
        }
    }
```

The only substitution is `requested ?? reasoning.defaultEffort` — i.e. a default is materialised **only when the caller omitted the field**; an explicit but unsupported id always throws `UNSUPPORTED_REASONING_EFFORT`. The service doc states it verbatim (`dsh-llm/lib/index.js:2152-2154`, live inspect of `llm.resolveCallConfig`): "Unsupported explicit efforts reject before provider I/O; no clamping or aliasing is performed."

---

## 10. Permission presets — verdict: **unsupported** (a plugin cannot publish a new preset)

Only one publication method exists — `host2/dsh-tool-cordis/lib/types/api-catalog.js:1513-1517`:

```ts
signature: 'registerAuto(admit: () => void): () => Promise<void>',
description: "Publish the fixed current-session Auto preset for the calling integration's effect lifetime.",
parameters: [{ name: 'admit', description: 'synchronous gate run before live Auto selection or restore.' }],
returns: 'the async effect disposer that removes Auto.',
```

The rest of the service surface is read/select only: `catalog()`, `current(session)`, `resolve(name)`, `optionOf(name)`, `set(session, name)` (`api-catalog.js:1507-1542`). There is **no** `register(preset)` / `contributePreset` / preset-table extension point.

Host README statements (quoted verbatim, `host/dsh-permission-presets/README.md`):

- line 60: "**Callers cannot publish another preset through a generic contribution API**, and they can switch away from `custom` but cannot select or persist a named custom preset through this service."
- line 136 (Known Limitations): "**The configured preset table is fixed for the plugin lifetime** — only the fixed Auto contribution can change the live process catalog without reloading this service."
- line 134: "**Only two mechanism knobs are bundled** — presets select sandbox mode and approval policy; the fixed Auto integration adds admission behavior, but an agent/profile choice is not part of `PresetSpec`."

The Auto contribution is itself fixed: "Auto's identity and knob bundle, Full access sandbox with the `ask` approval policy, are fixed inside this service" (`README.md:60`), and `registerAuto` is "reserved for the Auto review integration" (`README.md:52`).

A plugin can still *select* an existing preset (`set`, `/permission` command) and read the catalog; it cannot add a named entry.

---

## 11. MCP — verdict: **conditional** (config-time only; no runtime add/remove API)

Servers are **plugin config entries, one per server** — `host/dsh-mcp-client/README.md:28-32`: "Add `dsh-mcp-client` when the model should call tools from an external MCP server as if they were native. Give each server a unique name and transport. … Choose stdio for a local program and Streamable HTTP for a service" and `:32` "Add one entry per server; nothing else is required."

Config table (`README.md:55-63`): `transport` required `stdio` or `streamable-http`; `serverName` required; `command`/`args`/`env`/`cwd`; `url`/`headers`; `toolCallTimeoutMs`; `maxInstructionBytes`; `failOnStartupError`; `reconnect.*`. Tool names are `mcp__<serverName>__<rawName>` (`README.md:75`).

Runtime behaviour is lifecycle-driven, not registry-driven (`README.md:93`): "After ten consecutive failed attempts the server's tools are removed and reconnection stops **until you reload the configuration or restart the harness** … **Editing the configuration entry reloads the server connection in place**, and unchanged names stay unchanged."

No `ctx.mcp` add/remove service exists: the live Host service catalogue (the same one that lists `subagents`, `llm`, `sessionProjections`, `permissionPresets`, `tools`, `web`, …) contains no MCP server-management service, and `dsh-mcp-client/lib/index.js` exposes tool registration through `ctx.tools.register`, not a server registry. The package's own source map (`README.md:117-122`) lists only `apply` (Config schema, `serverName` reservation), `connection`, `server-context`, `tools`, `transport` — plus the exported `createMcpToolDefinition(ctx, options)` adapter.

**What a plugin CAN do:** mount `@deepseek-ai/dsh-mcp-client` as one of its own plugin entries with its own `config` (including `!!js` expressions), i.e. add/remove servers by changing **composition config**; and reuse the exported `createMcpToolDefinition(ctx, options)` adapter for its own transport (`README.md:124`). **What it cannot do:** add or remove a running server through an API at runtime.

---

## 12. Session projections & conversation events — verdict: **supported** for projections/metadata; **unsupported** for a custom session-event `type`

`ctx.sessionProjections.register/stateOf/snapshot` — source `host2/dsh-session-projection/lib/index.js`:

```js
register(definition) {                                    // :68
    …
    if (!Number.isSafeInteger(definition.stateVersion) || definition.stateVersion < 0) throw new Error(`session projection ${JSON.stringify(definition.key)} stateVersion must be a non-negative integer, got ${String(definition.stateVersion)}`);
    const dispose = this.ctx.effect(function* () { … }, "sessionProjections.register()");   // :101
    return () => void dispose();
}
stateOf(session, key) {                                   // :127
    const registration = this.registrations.get(key);
    if (registration === void 0) return void 0;
    this.materializeCells(session);
    return this.cellFor(registration, session).state;
}
snapshot(session, keys) {                                 // :142
    const values = {};
    const selected = keys === void 0 ? void 0 : new Set(keys);
    this.materializeCells(session);
    for (const registration of this.registrations.values()) {
        if (registration.def.wire === void 0) continue;
        if (selected !== void 0 && !selected.has(registration.def.key)) continue;
        const cell = this.cellFor(registration, session);
        values[registration.def.key] = this.viewCell(registration, cell);
    }
    return { asOfSeq: cursorBefore(session.seq), values };
```

Live inspect of the service adds the two registration forms (client-visible with `wire`, or **host-only** whose "state is omitted from client snapshots"), the shared-key refcount, and the effect-scoped disposer. `ProjectionDefinition` is `api-catalog.js`-documented: `{ key, stateSchema: ZodType<S>, init(header, inheritedEventCount), apply(state, event), wire?: { viewSchema, view(state) }, stateVersion }`.

**Custom metadata on session / execution cards: YES, via a plugin's own projection key plus a UI slot.**

- Durable data: register your own key with `ctx.sessionProjections.register({ key, stateSchema, init, apply, wire: { viewSchema, view }, stateVersion })`. `SessionProjectionMap` / `SessionProjectionStateMap` are declared as extensible empty interfaces (live inspect of `sessionProjections` returns `export interface SessionProjectionMap { }` and `export interface SessionProjectionStateMap { }`), which is the augmentation point a downstream plugin merges; at runtime `register` accepts any key.
- Cards (rendering): the generated client slot catalogue exposes session/turn card seats — `sidebar.session.row.leading` (`list/root`, "Leading decoration of one Session row, in the 16px cell before the title"), `sidebar.session.row.hover` (`list/root`), `sidebar.workspaces.session.menu.item` (`list/root`), `conversation.chat.turnTail` (`list/session`, "Ordered feature contributions before a completed Turn's action row"), `conversation.chat.assistant-actions` (`list/session`), and `tool.call.toolview` (`keyed/session`, "Keyed Tool call view dispatched by wire Tool name. Any name is allowed, including tools registered by your package. Register with `key: '<tool name>'`").
- Per-tool-call metadata also has a host-side field: `'tool/result'` data includes `meta?: JsonValue` (`SessionEventMap`, below).

**Custom session-event `type`: NO.** The vocabulary is generated, closed, and the persistence read path refuses unknown types unless the writer marked the event `ignorable: true` — `host/dsh-session/lib/types/known-event-types.js:7-21`:

```js
/**
 * Every `SessionEventMap` member declared in this repository — the event
 * vocabulary this build understands. The persistence read path refuses to
 * interpret a log containing a type outside this set unless the event
 * carries the envelope's `ignorable` marker (see `SessionEvent.ignorable`
 * in `./types.ts`): such a log was likely written by a newer harness, and
 * silently skipping a required event would reconstruct a wrong session.
 * Downstream (out-of-repo) plugin events are outside this list by
 * construction. The persisted `SessionEvent.ignorable` marker is the
 * compatibility mechanism; event-name registration was rejected because
 * it does not classify omission safety and would make reads
 * composition-dependent. …
 */
export const KNOWN_SESSION_EVENT_TYPES = new Set([
    'agent-preset/selected', 'agent/inbox/spliced', … 'workspace/changes',
]);
```

The refusal itself — `/dsh/node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js:182-184` (read from the asar; that package is not in the extraction):

```js
function validateStoredEvents(meta, events, location) {
	for (const event of events) {
		if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(`session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`, location);
```

and the retention path for a marked event — `/dsh/node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js:60-69`:

```js
default:
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) {
        const opaque = event;
        return { ...common, type: event.type, ignorable: true, … };
    }
```

Runtime `Session.append` does **not** consult the set — `host/dsh-session/lib/index.js:1441-1461` validates JSON-serializability and the surface-payload rules only (`validateSessionEventData` = `host/dsh-session/lib/types/surface.js:124`, which checks surface event payloads and never rejects an unknown type). So the precise picture:

- A plugin **can** call `session.append('<ns>/thing', data)` and it lands in memory.
- It **persists durably only with `ignorable: true`** — otherwise the session becomes unreadable by the very harness that wrote it (`SessionFormatUnsupportedError`).
- An `ignorable` event is retained **opaquely**: it never enters the surface (`surface.js:211`), never becomes a model message, and cannot participate in `SessionEventMap`-typed APIs or message projections.
- The full `SessionEventMap` (from the generated catalogue `host/dsh-permission-presets/lib/typert.host.js:483`) has 40 members, including the team vocabulary `team/member`, `team/message/queued`, `team/message/delivered`, `team/task`, and `model/selection`, `permission/preset`, `subagent/descriptor`, `subagent/catalog`.

---

## Minimum core modification

Conservative: only requirements proved **impossible** through plugin APIs are listed. Everything else is achievable and is not listed.

| # | Requirement proved impossible via plugin API | Smallest viable core change |
|---|---|---|
| 1 | **Publish a *new* named permission preset** so users can select it (the deployment preset table is fixed for the plugin lifetime; only the fixed Auto entry can be contributed). | `@deepseek-ai/dsh-permission-presets`, `src/index.ts` — `PermissionPresetService`: add a contributor registry beside the existing `registerAuto` (e.g. `registerPreset(spec: PresetSpec & {name, label?}): () => Promise<void>`), fold its entries into the same composition that builds `catalog()`/`resolve()`/`optionOf()` and into the reserved-name guards (`custom`/`auto`). Client side already renders whatever `catalog()` returns, so no client change is needed beyond the service. Alternative with **no** core change: ship the presets as this plugin's own `config.presets` table, which is exactly the supported path — do not modify core if that suffices. |
| 2 | **Register a persisted, first-class custom session-event `type`** that survives a cold read *without* `ignorable: true` and can carry model-visible meaning. | `@deepseek-ai/dsh-session` — add the member to `SessionEventMap` in `src/types.ts`, then regenerate `lib/types/known-event-types.js` via `scripts/gen-persistence-catalog.ts` (`pnpm run gen-persistence-catalog`, verified by `verify-persistence-catalog`). No change is needed in `dsh-session-persistence`: it consults the generated set. Note the plugin-API workaround that avoids core changes entirely: write the event with `ignorable: true` (durable, retained opaquely) and carry model-visible meaning in your own `sessionProjections` unit. |
| 3 | **Add an extra column/field to a Team member row** (`TeamMemberView` / the `list_agents` roster row). | `@deepseek-ai/dsh-experimental-agent-team` — extend `TeamMemberView` in `src/types/roster.ts` **and** the runtime `teamMemberSnapshotSchema` (`.strict()`, `src/index.ts`, mirrored at `lib/index.js:1146-1158`); plus `@deepseek-ai/dsh-experimental-tool-agent-team` — extend `MEMBER_VIEW_SCHEMA` (closed, `additionalProperties: false`, `lib/index.js:35-71`). Both are required: the strict snapshot schema and the closed tool output schema each independently reject extra fields. Only needed if the upgrade genuinely requires extra member columns. |

Explicitly **not** listed (achievable through plugin APIs, no core change):

- Any settings surface addition — `settings.section`, `settings.plugins.tab`, `settings.general.item`, `settings.onboarding`, `settings.models.footer`/`provider-card`/`sign-in`, `plugins.item` are all open slots (note: `settings.plugins.item` **does not exist**; use `plugins.item`).
- Composer/model-seat work — `conversation.input.model` is a normal `single` seat: register at a *lower* priority than the shipped occupant to win, or at a higher one to be shadowed; `conversation.input.left/right/overlay`, `conversation.input.dock`, `conversation.composer.dock` are all open.
- A real LLM adapter/provider route — `ctx.llm.registerAdapter`, `registerConfigurableProviders`, `registerModelDiscovery`.
- Per-child model/persona for **in-process** delegation — `agentOptions: true` + honouring the merged options inside `start()`.
- Cancellation/resumption of delegated and continuable children — `request.signal` + `dispose()` + `startContinuable` + `prepareContinuable` + `sendMessage`.
- Durable custom session metadata and custom card UI — own `sessionProjections` key + card slots (`sidebar.session.row.leading`, `tool.call.toolview`, `conversation.chat.turnTail`, …).
- Adding/removing MCP servers — through the plugin's own composition config (`dsh-mcp-client` entries) and the exported `createMcpToolDefinition` adapter; only a *runtime* add/remove API is absent, and that was not established as a requirement.

## Unconfirmed / limits of this verification

- The **live client Slot topology** could not be dumped: all Client inspect queries (`Slots.listSubTree`, with and without `root`) returned `timed out after 10000ms; Open or reconnect the Harness page`. Slot kinds/declarations above therefore rest on the byte-identical rc.2 client bundles plus the build-generated slot catalogue, not on a live runtime probe. Re-run `cordis_inspect_query(platform=client, provider=Slots, method=listSubTree)` with a connected page to confirm empirically.
- No `.d.ts` ships in the asar, so `SlotMap`/owner-prop *type* augmentation for `settings.*` could not be read from a declaration file; props were read from the owners' `renderSlot` call sites and the generated catalogue's `ownerProps`, and are labelled as such.
- `LlmAdapter`'s `abstract stream` is erased in the compiled JS; it is quoted from the generated catalogue (`dsh-llm/lib/typert.host.js:337`) rather than from executable code.
- Whether the upgrade actually *needs* items 1–3 of the core-modification table was not established here — the table records only what is impossible, not what is required.
- `dsh-session-persistence`, `dsh-session-log-deepseek`, `dsh-cordis-client-runner`, `dsh-client-ui-tool`, `dsh-client-ui-workspace`, `dsh-client-ui-chat` and `dsh-client-ui-deliverables` were read **directly from the asar** (they are not in `D:\Project\_dsh-asar\host*`), so their line numbers are asar-file line numbers, not extraction line numbers. Everything else cited above is a path inside the byte-identical extraction.
