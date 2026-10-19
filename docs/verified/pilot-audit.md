# `@dsh-external/dsh-harness-pilot` 0.1.1 — Verified Capability Audit (read-only)

> Purpose: an upgrade will add a *federation* layer. This document is the **preserve list**: what already
> works, exactly where, what its public surface is, and what breaks if it is rewritten.
>
> Method: every structural claim below was read out of the real sources under `D:\Project\dsh-harness-pilot`
> (the junction target of `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-harness-pilot`
> → verified junction, `LinkType: Junction`, `Target: D:\Project\dsh-harness-pilot`). Runtime liveness was
> confirmed by listing the host Tool registry from inside the running 0.2.0-rc.2 session: **all ten
> `harness_*` tools are present and callable** (`harness_list`, `harness_models`, `harness_dispatch`,
> `harness_agent`, `harness_open`, `harness_send`, `harness_sessions`, `harness_task_start`,
> `harness_task_status`, `harness_task_list`, `harness_task_cancel`).
> Anything I could not verify is written `unconfirmed` and is not used as a premise.
>
> Audit date: see the delivery message. Sources are unmodified (read-only audit).

## 0. Corrections to the pre-existing plan doc

`docs/harness-federation-plan.md` is partially wrong; do not treat it as ground truth.

| Claim in plan | Verified reality | Evidence |
|---|---|---|
| Install root `D:\DeepSeek harness\resources\app.asar` (plan:17, plan:30) | **Wrong.** `D:\DeepSeek harness` does not exist. The install root is `D:\DeepSeek` (`DeepSeek Harness.exe`, `resources/`, `version`). | `Test-Path 'D:\DeepSeek harness'` → `False`; directory listing of `D:\DeepSeek` |
| `settings.plugins.tab` "not declared in this build, use `plugins.item`" (plan:191) | **Wrong — the slot exists.** The plugin-side registration is valid: `docs/verified/host-api-0.2.0-rc.2.md:29,59-65` records the host declaration (`dsh-client-ui-settings-plugins/lib/client.js:208-211`, `kind:"list"`, `scope:"root"`), and that report also notes at `:31` that `settings.plugins.item` does **not** exist (the real key is `plugins.item`). Not re-verified by me — client Inspect timed out; provenance is the teammate's asar extraction. | `client/client.js:682-687`; `probe/client-register-check.mjs:62`; `docs/verified/host-api-0.2.0-rc.2.md:29,31,59-65` |
| "provider object shape `{name, capabilities, inheritsParentContext, agentRouteDefaults?, start(), prepareContinuable?()}`" (plan:136) | The **host interface** does declare `agentRouteDefaults?` and `prepareContinuable?` as optional (`docs/verified/host-api-0.2.0-rc.2.md:267,269`). This plugin implements **only** `name`, `capabilities`, `inheritsParentContext`, `start()` — the entire continuable half is absent. | `src/provider.ts:49-59`, `src/provider.ts:61`; repo-wide grep for `startContinuable\|prepareContinuable\|sendMessage\|agentRouteDefaults` in `src/` returns **zero** matches |
| Capability table rows 1.4 are otherwise **correct** | cross-checked line-by-line below | — |

Also: the plugin has **no git repository**, and `lib/*.js` (mtime 2026-10-09 13:48) is newer than `src/*.ts`
(mtime 2026-10-03/04). Compiled output matches current sources on every spot check
(`lib/index.js:41,67,135` export `clearStaleRoutes` / `registerApiRoute` / `createApiHandler`; the hardcoded
`version: '0.1.0'` at `lib/sessions.js:484` matches `src/sessions.ts:615`).

---

## 1. Dispatch ladder — `acp → headless → pty → cdp → window`

**Implementation**
- Ladder constant: `src/types.ts:12` (`DEFAULT_TRANSPORT_ORDER`); duplicate list `src/sessions.ts:54`; API-side copy `src/index.ts:79`; tool-side copies `src/tools.ts:751-752`, `src/task-tools.ts:89`, `src/index.ts:298`.
- Per-target default order in the Schemastery schema: `src/config.ts:76`; literal default in the builder: `src/config.ts:151`.
- **Pre-flight** `SessionRegistry.preflight(kind, target, {killFirst})`: `src/sessions.ts:222-262` — `headless` 224-227, `acp` 228-233, `pty` 234-238, `cdp` 239-244, `window` 245-258 (helper `ensure()` + real window search), unknown 259-260.
- **One-shot dispatch** `dispatch(spec, {transport})`: `src/sessions.ts:265-296`.
  - candidate list built once: forced transport → single-element list, else `target.order` filtered to known kinds (`:268-272`);
  - sequential preflight loop, `break` at first available (`:276-283`);
  - honest failure when nothing is usable (`:284-292`, `stopReason:'error'`, diagnostic lists every rung);
  - **exactly one** `run(chosen, request)` (`:294`), ladder outcome recorded in `facts.ladder` (`:295`).
- Transport dispatch switch `run()`: `src/sessions.ts:298-324`.
- **Interactive open** `open(target, {transport, killFirst, killForce, launch})`: `src/sessions.ts:345-393`
  — forced transport validated `:352-365` (rejects `headless` at `:361-363`), per-rung preflight with
  `killFirst` passed through `:371`, `create()` `:375`, and an **explicit** downgrade warning when the landed
  transport is not the preferred one `:377-386`; total failure throws with all attempts `:392`.
- Pre-flight surfaces: HTTP `GET /harness-pilot/api/probe?target=` `src/index.ts:291-307`; `harness_list probe=true` `src/tools.ts:750-757`.

**Confirmed claim — downgrade only at pre-flight, never a silent mid-run re-dispatch.**
- For `dispatch()`: the ladder loop ends in a `break` before any execution (`src/sessions.ts:279-282`), and
  `run()` (`:298-324`) dispatches exactly one transport per call. No transport module can re-enter the
  registry: the ladder lives **only** in `sessions.ts`; the five transport modules import nothing from it
  (`src/transports/acp.ts:17-29`, `headless.ts:8-11`, `pty.ts:11-14`, `cdp.ts:19-27`, `window.ts:20-21` —
  `acp.ts`/`cdp.ts` borrow only `killTree` from `headless.ts:14`). `acp`/`cdp`/`window` are lazy dynamic
  imports (`src/sessions.ts:144,184-213`), never a fallback chain.
- Nuance (not a violation): **`open()` does walk rungs** (`src/sessions.ts:367-391`). Each rung is
  pre-flight-gated, the walk stops at the first successful `create()` (`:376-379`), and any downgrade is
  reported in `InteractiveSession.warning` (`:83,381-386`) which `harness_open` prints
  (`src/tools.ts:978-981`). That is attach-time selection, not a re-run of an already-started task.

**Would break if rewritten**: `DispatchOutcome.facts.ladder` (`src/sessions.ts:295`) and the per-rung
`attempts` strings are the only machine-readable downgrade evidence; the `warning` field on
`InteractiveSession` (`src/sessions.ts:79-83`) is what makes silent downgrade impossible — both must survive.
`tools.ts:751-757`, `index.ts:298-306` and `index.ts:79` each duplicate the ladder list; a rewrite that
changes the ladder in one place silently desynchronises the other three.

---

## 2. Task ledger — `harness_task_start|status|list|cancel`

**Implementation**
- `TaskManager` class `src/tasks.ts:147-543`; tools `src/task-tools.ts:77-205`; wiring `src/index.ts:735-745`.
- Types: `TaskStatus` `src/tasks.ts:17`; `TERMINAL` `:15` = `completed|error|timeout|aborted|interrupted`
  (`stalled` deliberately excluded); `TaskKind` `:27` = `task|subagent`; `CallbackStatus` `:30` =
  `pending|sending|delivered|failed|skipped|uncertain`; `TaskView` `:46-64`; `TaskResult` `:66-72`.
- Public methods: `start()` `:201-230` (concurrency gate `:202-205`, cwd validation `:206-208`),
  `track()` `:239-314` (externally-driven runs), `status()` `:431-450`, `list()` `:452-470` (memory ∪ disk, max 100, newest first),
  `progress()` `:473-490` (offset/limit read of `.log`), `result()` `:493-505`, `cancel()` `:507-517`,
  `wait()` `:520-536`, `setMaxConcurrent()` `:166-168`, `shutdown()` `:538-542`, `path()` `:170-173`
  (uuid regex guard `^[0-9a-f-]{36}$`).

**On-disk layout** — `pluginHome()/tasks` = `~/.dsh/plugins/harness-pilot/tasks` (`src/settings.ts:37-41`,
joined at `src/index.ts:736`), created in the constructor (`src/tasks.ts:163`). Per task, three files named
by a `randomUUID()`:
- `<id>.json` — `JSON.stringify(TaskView, null, 2)`, written on every state change (`:175-177`, `:226`, `:269`, `:393`, `:405`, `:411`, `:427`);
- `<id>.log` — created empty at `:225` / `:255`, appended process output (`:279`, `:356`);
- `<id>.result.json` — `TaskResult`, written on **every** terminal settle and never skipped on failure (`:266-268`, `:390-392`).
- Live state (current on-disk): **84 tasks × 3 files** (168 `*.json` of which 84 are `*.result.json`, 84 `*.log`); largest `.log` 5,574,890 bytes. **No retention/pruning exists** — unbounded growth (see risks).

**`kind=task` vs `kind=subagent`**
- `start()` hardcodes `kind:'task'` (`src/tasks.ts:211`); `track()` takes `input.kind` (`:242`) and the
  provider passes `'subagent'` (`src/provider.ts:79-85`).
- `harness_agent` reuses the ledger id *as* the subagent run id (`src/provider.ts:133-136`,
  `id: tracked.id as unknown as SubagentRun['id']`), so `harness_task_status task_id=<runId>` resolves
  without an id mapping — that is the documented P7 contract (`src/tools.ts:866-873`, `:927-929`).

**Terminal-state persistence & crash recovery** — `status()` `src/tasks.ts:431-450`:
- disk-only tasks get `kind:'task'` backfilled when the field is absent (`:440-441`) — the pre-`kind` file format is load-bearing for existing users' history;
- `callback.status === 'sending'` is rewritten to `uncertain` with `error:'process ended during callback delivery; not resent'` (`:443-445`);
- any non-terminal stored status becomes `interrupted` with diagnostic `'harness-pilot process ended; task was not resumed'` (`:446-448`). No auto-resume.

**Stall detection** — `armStallWatch()` `src/tasks.ts:322-336`; armed **only** from `track()` (`:257`), so
`stalled` applies to `kind=subagent` runs, not to `harness_task_start` tasks. Default
`DEFAULT_STALL_TIMEOUT_MS = 120_000` (`src/provider.ts:27`), passed at `src/provider.ts:84`; the timer fires
every `clamp(1000..15000)`ms (`src/tasks.ts:333`), sets `stalled` + a diagnostic (`:328-331`) and re-delivers
(`:332`). `progress()` pulls `stalled` back to `running` and clears the diagnostic (`:283-286`).
`kind=task` instead gets a hard deadline that aborts the controller (`:341-344`) and rewrites the status to
`timeout` (`:377-381`).

**Receipt bookkeeping** — `deliver()` `src/tasks.ts:399-429`; `plugins/harness-pilot/remedies/` (kill_first
scripts) is a separate directory produced by `src/remedies.ts:124-127`.

**Would break if rewritten**: task ids are the join key between `harness_task_start`/`harness_agent` output,
`harness_task_status`, the HTTP `/task` endpoints, the client Tasks panel and the on-disk filenames. Any
rewrite that changes `<id>.json`'s field names or the `kind` backfill orphans all 84 existing records. The
`.result.json`-on-failure guarantee (`:390-392`) is the fix for "silent failure"; a rewrite that writes it only
on success re-introduces the original defect.

---

## 3. Completion receipts — run → session

**Chain**
1. `TaskManager` terminal state → `deliver()` (`src/tasks.ts:399-429`), which is a no-op when
   `callback === null || callback.notify === false` (`:400-401`).
2. `onComplete(view, callback, result)` → `buildReceipt(...)` → `waker.wake(callback.sessionId, receipt)`
   (`src/index.ts:739-743`).
3. Receipt text `buildReceipt()` `src/wake.ts:61-96`: header, receipt id/target/model/final state
   (`:69`), workspace + `result_path` + `log_path` (`:70`), diagnostic (`:71`), the "verify independently"
   instruction (`:72`), continuation instruction (`:73`), the "failure/timeout/cancel/interrupt is not
   success" clause (`:74`), then the delivered body truncated to `settings.maxResultChars`
   (`:76-84`) or an explicit "nothing to deliver" line (`:85-87`).
4. Wake chain `createSessionWaker()` `src/wake.ts:108-148`:
   - ① `sessionController.resolveAgent(sessionId)` → `agent.followup(createUserMessage({content, source:{kind:'user'}}))`
     → `sessions.flush(agent.session)` (`:117-127`); a missing agent becomes an explicit rejection (`:120-123`);
   - ② fallback `agents.get()` → `agents.resume({resumeSessionId})` → `followup` → `flush` (`:130-143`);
   - ③ otherwise throw (`:145`).
   - `flushQuietly()` `:151-156` swallows flush errors — "enqueue already stands".
   - Lazy service resolution `WakerDeps.resolve` `src/wake.ts:52-58`, built in `src/index.ts:722-734`
     (`sessionController` / `agents` / `sessions` read at delivery time, never snapshotted).

**`callback.status` semantics** (state machine at `src/tasks.ts:414-426`)
| status | when | evidence |
|---|---|---|
| `pending` | set at `start()`/`track()` | `src/tasks.ts:221`, `:251` |
| `sending` | written to disk immediately before calling `onComplete` | `:414-415` |
| `delivered` | `onComplete` resolved; also stores `receipt` + `deliveredAt` | `:418-420` |
| `skipped` | empty `sessionId` (`:402-407`) or no `onComplete` wired (`:408-413`) | — |
| `failed` | `onComplete` threw and the error was **not** `deliveryUncertain` | `:421-425` |
| `uncertain` | `err.deliveryUncertain === true && err.explicitRejection !== true` (`:423`), **or** crash recovery of a `sending` record (`:443-445`) | — |

**Precision (defect-shaped, must be preserved verbatim in the upgrade):**
- `deliveryUncertain` is **read but never set anywhere in this plugin** (`src/tasks.ts:422` is the only
  occurrence in `src/`). The waker only ever throws `explicitRejection` errors (`src/wake.ts:98-102`), so
  `failed` is what normal wake failures produce. `uncertain` is effectively reachable **only** through
  process-restart recovery (`src/tasks.ts:443-445`).
- `delivered` means "the follow-up turn was queued", not "the session processed it" — `flushQuietly`
  swallows persistence errors (`src/wake.ts:151-156`).

**Would break if rewritten**: `callback.status` vocabulary is a documented cross-tool contract shared with the
Codex-side port (`src/tasks.ts:5-7`) and is rendered verbatim in the client (`client/client.js:511-513,562`)
and in `harness_task_status` output (`src/task-tools.ts:59-60`). The `sending → uncertain` recovery rule is the
only thing preventing double-wake after a crash; removing it risks duplicate `followup` turns.

---

## 4. Session resume / continuity — **not implemented**

This is the single largest gap, and the task's premise ("how `startContinuable` / `prepareContinuable` /
`sendMessage` are wired") is **refuted by the code**:

- `HarnessProvider` exposes exactly four members: `name` (`src/provider.ts:54`),
  `capabilities = NO_START_CAPABILITIES` (`:50`), `inheritsParentContext = false` (`:51`), `start()` (`:61`).
- Repo-wide grep in `src/` for `startContinuable|prepareContinuable|sendMessage|agentRouteDefaults` → **0 matches**.
  Only the out-of-process helpers are imported (`src/provider.ts:9-12`) and used at `:50,63,93,133`.
- Native session ids are **never persisted**:
  - ACP: `sessionId = session.sessionId` (`src/transports/acp.ts:336`) is used only inside that one run —
    `facts.sessionId` (`src/transports/acp.ts:197`), and the same id is used for the cancel notification
    (`:243-249`). Nothing writes it to disk.
  - CDP: the readback session id is read per dispatch from the page (`src/transports/cdp.ts:1613-1623`) and
    the expression lives in config (`src/config.ts:540-546`); it is not stored.
  - `InteractiveSession` ids are in-memory only (`src/sessions.ts:166`, minted at `:523-526`) and die with the process.
- Per-call model cannot travel through the provider: `capabilities = NO_START_CAPABILITIES` means the host
  rejects per-child model options, which is exactly why `harness_agent(model=…)` bypasses the provider and
  uses `registry.dispatch` directly (`src/tools.ts:891-908`, with the reason stated at `:892-893` and echoed
  in the tool description at `:878`).

**Insertion point for the upgrade**: `src/provider.ts:49-59` (add optional `prepareContinuable` /
`agentRouteDefaults`) plus a persistence store — deliberately absent today, so adding it disturbs nothing.

---

## 5. Subagent-provider registration

- Registration happens in a **child fiber** that declares `inject: ['subagents']`, deliberately deferred
  because service order is not guaranteed (`src/index.ts:756-766`). Note the comment at `:753-755`: this fiber
  must stay **after** `TaskManager` because every run is recorded in the ledger.
- `registerProviders(registry, sessions, tasks, targets, defaultTarget)` `src/provider.ts:167-187`:
  - one provider per target named `harness-<name>` (`providerNameFor` `:149-151`, registered `:183`);
  - **extra default alias `harness-pilot`** for the target whose name equals `config.defaultTarget`
    (`:184-185`) — on this machine that is `opencode` (see §7);
  - idempotent: existing names come from `registry.list?.()` and are skipped (`:175-182`); the same guard
    exists for tools (`src/tools.ts:711-718`).
- Lazy access facades used by `harness_agent`: `subagentsFacade` `src/index.ts:705-717`
  (`registerProvider` / `list` / `start`, each resolving `ctx.subagents` on demand).
- Provider object shape actually registered: `{name, capabilities: NO_START_CAPABILITIES,
  inheritsParentContext: false, start(request)}`.
- `start()` `src/provider.ts:61-145`: text-only prompt guard (`textTask()` `:30-40`), cwd resolution via
  `resolveChildCwd` (`:63`), abort plumbing (`:65-70`), ledger `track({kind:'subagent', stallTimeoutMs})`
  (`:79-85`), dispatch through `sessions.dispatch` with `onProgress` feeding `tracked.progress`
  (`:95-105`), `settleRunResult` wrapping non-`completed` stop reasons into `error`/`aborted` with partial
  output (`:109-121`, `:122-131`), and `subprocessRunHandle` for the run handle (`:133-144`).
- Non-text prompts (images/files) are rejected (`src/provider.ts:33-35`) — an honest limitation to keep.

**Would break if rewritten**: provider **names** are the addressing contract used by the host
`tool-subagent` (`provider: harness-<name>`, documented in `cordis.patch.yml:17-26`), by `harness_agent`, and
by Agent Teams `freshProvider`/`forkProvider`. Renaming to the plan's `hx-<harness>-<account>` scheme
(plan:353) invalidates every existing user's team/agent config and any saved `provider: harness-opencode`.

---

## 6. Settings page + HTTP API

### Client half
- Single self-contained browser file, no build step: `client/client.js` (691 lines) loaded through
  `window.__ModuleLoader__.load({id:'@dsh-external/dsh-harness-pilot', factory(require){…}})` (`:12-14`),
  the only dependency being host-provided `react` (`:15`).
- `apply(ctx)` / `inject: ['slots']` at `:673-689` registers two seats:
  - `settings.section` → `{id:'harness-pilot', order:30, label:'外部 Harness'}` (`:677-680`);
  - `settings.plugins.tab` → `{id:'harness-pilot', order:40, label:'Harness Pilot · 外部 harness'}` (`:684-687`).
- Endpoints the client calls: `GET /harness-pilot/api/overview` (`:19`), `POST /harness-pilot/api/settings/save` (`:21,429-433`),
  `GET /harness-pilot/api/task?id=&result=1` (`:22,530`), `POST /harness-pilot/api/task/cancel` (`:23,538-542`).
  It sends **no** `x-harness-pilot-token` header (`:93,429-433`) — a configured `apiToken` breaks the whole page.
- Fields consumed from `/overview`: `plugin.{name,version}`, `defaultTarget`, `targets[].{name,description,transport,order,command,commandPath,available,model,models,modelsNote,reason|missingReason|note|error|detail}`,
  `sessions[].{id,target,transport,detail,openedAt}`, `dsh.providers[].{id,name,models}`,
  `runtimeSettings.{notifyOnComplete,deliverResult,maxResultChars,maxConcurrent,defaultTaskTimeoutMs,resumeInstruction}`,
  `tasks[].{task_id,target,model,status,cwd,elapsed_ms,output_chars,diagnostic,result_path,callback}` (`:133-201`, `:403-416`, `:504-521`).
- Every field is treated as optional; failures only render empty/error states (`:88-113`, `:215-218`) — no throw. The two halves share one `fetch` via a module-level store (`:64-129`), no polling.
- Colour tokens are host theme aliases only (`--dsw-alias-*` → `--dsh-color-*` → literal, `:30-40`).

### Host half — routes (all under `const API_PATH = '/harness-pilot/api'`, `src/index.ts:76`)
Registered as a **prefix** route by `registerApiRoute()` (`:125-151`) inside a child fiber with
`inject: ['webServer']` (`:796-812`), with a self-heal retry that pokes the Service's private
`exact`/`prefixes`/`upgrades` maps (`clearStaleRoutes()` `:99-115`, typed via `WebServerLike` `:67-73`).
Handler factory `createApiHandler(registry, config, extras)` `:226-662`; optional extras `ApiExtras` `:220-224`
(`tasks`, `settings()`, `applySettings()`).
Global guards: constant-time token check on `x-harness-pilot-token` when `config.apiToken` is non-empty
(`:247-257`, `tokensMatch` `:191-198`); JSON body reader with a 64 KiB cap and 413/400 handling
(`API_MAX_BODY_BYTES` `:78`, `readJsonBody` `:154-188`); `405` + `allow` helper (`:269-272`); `404` fallback (`:657`); `500` catch-all (`:658-660`).

| Method | Path | Params (exact) | Response shape | Line |
|---|---|---|---|---|
| GET | `/overview` | `?models=1` (slow, spawns CLIs) | `Overview` (`plugin`, `defaultTarget`, `targets[]`, `sessions[]`, `dsh.providers[]`, `generatedAt`) + `runtimeSettings` + `tasks[0..30]` when wired | `:275-288` |
| GET | `/probe` | `?target=` | `{target, ladder:[{transport,available,detail}]}` | `:291-307` |
| POST | `/models` | `{target?, refresh?}` | `{target, models[], note, mechanism}` | `:310-326` |
| POST | `/dispatch` | `{target, prompt(req), model?, transport?, timeout_ms?, cwd?}` | `{target, transport, stopReason, text, diagnostic?, facts?}` | `:329-378` |
| POST | `/send` | open: `{target, model?, cwd?, launch?}` → `{sessionId, transport, currentModel, detail, warning?, modelSwitch?, notes[]}`; write: `{sessionId, text?, submit?, wait_ms?}` → `{sessionId, target, transport, action, text, source, diagnostic?}` | `:381-496` |
| GET | `/settings` | — | `{settings, tasksDir, settingsFile}` | `:499-510` |
| POST | `/settings/save` | any subset of `RuntimeSettings` | `{settings}` (500 if not wired) | `:513-529` |
| GET | `/tasks` | — | `{tasks: TaskView[]}` | `:532-543` |
| GET | `/task` | `?id=<uuid>&result=0|1&log_offset=N` | `TaskView & {text, offset, next_offset, has_more, progress_note}` + `result` when terminal | `:546-573` |
| POST | `/task/start` | `{target, prompt(req), model?, transport?, timeout_ms?, cwd?, notify?, session_id?, instruction?}` | `{task: TaskView}` | `:576-627` |
| POST | `/task/cancel` | `{task_id}` | `{view, cancellation_requested}` | `:630-655` |

`POST /dispatch` aborts on client disconnect (`:356-360`). Id validation `^[0-9a-f-]{36}$` at `:556` and `:645`.

**Would break if rewritten**: `/overview`'s `targets[].reason` is probed under **five** fallback key names by
the client (`client/client.js:148`) — dropping any of them blanks the "unavailable" column. `runtimeSettings`
and `tasks` on `/overview` are additive ("缺省省略，老客户端不受影响", `src/index.ts:283-285`), so removing them
silently degrades the settings form to the "needs a newer host" message (`client/client.js:419-424`).

---

## 7. Runtime settings

- Type `RuntimeSettings` `src/settings.ts:12-25`; defaults `DEFAULT_SETTINGS` `:27-34`
  (`notifyOnComplete:true`, `deliverResult:true`, `maxResultChars:20000`, `maxConcurrent:4`,
  `defaultTaskTimeoutMs:600000`, `resumeInstruction:''`).
- Path: `pluginHome()` `:37-41` = `HARNESS_PILOT_HOME` env override, else `~/.dsh/plugins/harness-pilot`;
  `settingsPath()` `:43-45` = `<home>/runtime-settings.json`.
- Normalisation `normalizeSettings()` `:53-64` (clamps `maxResultChars` 500–200000, `defaultTaskTimeoutMs`
  5000–86400000, `resumeInstruction` ≤4000 chars, `maxConcurrent` ≥0, type errors fall back to base).
- IO: `loadSettings()` `:67-74` returns defaults on missing/corrupt file; `saveSettings()` `:77-85` is atomic
  (`*.tmp` + `renameSync`). Applied live at `src/index.ts:746-751` (`tasks.setMaxConcurrent`).

**Current on-disk values** (`C:\Users\Administrator\.dsh\plugins\harness-pilot\runtime-settings.json`):
```json
{ "notifyOnComplete": true, "deliverResult": true, "maxResultChars": 20000,
  "maxConcurrent": 0, "defaultTaskTimeoutMs": 600000, "resumeInstruction": "" }
```
(`maxConcurrent: 0` = unlimited.)

**Defect to fix, not to inherit:** `notifyOnComplete` is defined, defaulted, normalised (`src/settings.ts:14,28,56`),
rendered as the first form row labelled "完成后唤醒会话" (`client/client.js:448-454`) — and **read nowhere in the
delivery path**: `deliver()` keys off the per-task `callback.notify` only (`src/tasks.ts:400-401`), which
`harness_task_start` sets from the tool argument (`src/task-tools.ts:114`). Users who set it to `false` are
still woken. Grep for `notifyOnComplete` in `src/` returns only the three settings.ts lines above.

**Third state file:** `~/.dsh/plugins/harness-pilot/unlimited-live.json`
(`{pid:42164, appliedAt:"2026-10-13T07:31:35.068Z", maxConcurrent:0, taskModule:"D:/Project/dsh-harness-pilot/lib/tasks.js", preservesExistingTasks:true}`)
is **not read by anything in this repository** — a repo-wide grep for `unlimited-live` returns zero matches.
It records a live monkey-patch of the running process' `TaskManager`. Treat as an orphan marker; do not build on it.

**Default-harness selection mechanism:** it is **not** a runtime setting. It lives in the Cordis Config
(`src/config.ts:83 defaultTarget: z.string().default('')`) and resolves at
`src/config.ts:592-594`: explicit `config.defaultTarget`, else `resolvedTargets[0].name`, and since
`KNOWN_TARGETS[0]` is `opencode` (`src/config.ts:223-225`), the effective default on this machine is
`opencode`. `findTarget()` is case-insensitive (`:608-611`); `SessionRegistry.target()` throws a helpful
"known targets" error (`src/sessions.ts:554-562`).

---

## 8. Transports (5) — wire needs, discovery/launch, pre-flight, failure modes

Shared launcher: `resolveLauncher()` `src/launcher.ts:64-89` (`where.exe` on PATH `:48-53`, extension ranking
`:25`, `.cmd`/`.bat` → `cmd.exe /d /s /c` `:79-83`, `.ps1` → pwsh/powershell `:84-87`), `buildArgv()`
`:116-129` (dual form: plain argv for node-pty, `verbatimArgv` + `windowsVerbatimArguments` for
`child_process` `:98-105`), cmd quoting `:132-135`, `probeCommand()` `:138-145` (never throws), and
`launchEnv()` `:41-45` which **deletes inherited `ELECTRON_RUN_AS_NODE`** (documented real incident `:27-40`).

### 8.1 `acp` — `src/transports/acp.ts`
- **Needs on the wire:** `@agentclientprotocol/sdk` 1.4.0 (`:19`), `target.command` + `target.acpArgs`
  (spawn at `:270-277`, stdio pipes, `NO_COLOR=1 TERM=dumb` `:272`).
- **Sequence:** `initialize {protocolVersion: PROTOCOL_VERSION, clientCapabilities:{}}` (`:326-332`) →
  `buildSession({cwd, mcpServers:[]}).start()` (`:334-336`) →
  `session/set_config_option {configId:'model', value: target.acpModel}` (`:342-353`) →
  `session.prompt(text)` (`:355`) → loop `session.nextUpdate()` collecting `agent_message_chunk` text
  (`:359-381`), `agent_thought_chunk` counted only (`:378-380`).
- **Pre-flight** `probeAcp()` `:65-89`: `probeCommand` + `buildArgv` dry-run; **never spawns**.
- **Must-have client handler:** `session/request_permission` auto-allows `allow_once|allow_always`
  (`:305-315`); with no `allow_*` option it cancels, and every decision is recorded in diagnostics.
- **Failure modes encoded:** every exit kills the process tree (`killTree` `:224-227`); abort sends
  `session/cancel` then settles `aborted` (`:238-256`); timeout `:262-264`; stderr tail is appended to
  diagnostics only on non-`completed` exits (`:213-216`, `:55-59`); stop-reason mapping table `:92-115`
  (`end_turn→completed`, `cancelled→aborted`, `max_tokens|refusal|max_turn_requests|unknown→error`).
  Module never rejects (`:13-15`, `settle()` `:206-235`).
- **Known silent gap:** a failed `set_config_option` is recorded in `acpModelNote` (`:350-352`) and surfaced
  as `facts.acpModelNote` (`:202`) — but `stopReason` stays `completed`, so a `model=` request can be
  silently ineffective.

### 8.2 `headless` — `src/transports/headless.ts`
- **Wire:** `spawn(argv)` with `windowsVerbatimArguments` when `.cmd` (`:59-66`), env
  `{...process.env, ...target.env, NO_COLOR:'1', TERM:'dumb'}` (`:61`). Prompt appended as the **last argv**
  (`:39`) or written to stdin when `promptViaStdin` (`:35-37`).
- **Pre-flight:** `probeCommand(target.command)` — resolvability only (`src/sessions.ts:224-227`).
- **Text extraction:** `cleanOutput(stdout) || cleanOutput(stderr)` (`:77`, `src/text.ts`).
- **Failure modes:** timeout kills the tree (`:96-100`); abort kills the tree (`:102-105`); exit codes `:123-135`
  — nonzero **with** stdout ⇒ `completed` + diagnostic, nonzero **without** stdout ⇒ `error`. `killTree()`
  `:14-29` uses `taskkill /pid <pid> /T /F` on Windows, process group on POSIX. Never rejects.

### 8.3 `pty` — `src/transports/pty.ts`
- **Needs:** host `ctx.subprocess.spawnTerminal` (`TerminalHandleLike`/`TerminalSpawnSpecLike` `:17-38`;
  resolved at `src/index.ts:675-679`), and *optionally* `@xterm/headless` for screen reconstruction
  (`:56-68`, loaded via `createRequire` inside try/catch; absent ⇒ raw fallback).
- **Wire:** 200×50 ConPTY (`:40-41,120-129`), `TERM=xterm-256color` (`:123`), prompt written with a trailing
  `\r` (`:173`), completion by output quietness — first `READY_QUIET_MS=1500` for the first paint (`:43,168`),
  then `target.window.settleMs` (`:177`); `signalForeground('SIGINT')` on abort then `terminate()` (`:187-192`).
- **Pre-flight** `probePty()` `:70-77`: command resolvable, plus a note when no screen emulator exists.
- **Failure modes:** no readable text ⇒ downgraded to `error` with an explicit "may need the window channel"
  diagnostic (`:204-208`); `PtySession.open()` waits for *output then stability* to avoid an immediate empty
  first screen (`:262-273`), 20 s budget.

### 8.4 `cdp` — `src/transports/cdp.ts` (largest file, 1865 lines)
- **Needs:** `ws` loaded via `createRequire` with a hand-written minimal type (`:19,31-46`), `node:http` `get`,
  `node:net` `createConnection`.
- **Discovery:** `probeCdp(port)` `:257-274` GETs `http://127.0.0.1:<port>/json/list` then `/json`
  (1.5 s timeout `:86`), keeps only `type==='page'` entries with a `webSocketDebuggerUrl` (`:236-254`);
  `portTaken()` `:182-201`; page ranking `scorePage()`/`rankPages()`/`pickPage()` `:953-993` honouring
  `cdp.pageMatch` (`:918-951`).
- **Launch:** `launchArgsFor()` `:1061-1080` substitutes `<port>`; `pickLaunchPort(preferred, portBase)`
  `:1050-1059` scans at most 20 ports; `spawnDetached()` `:1087-1126` uses `launchEnv` (`:24`).
- **Pre-flight** `probeCdpTarget(target, port, {killFirst})` `:1373-1418` — the subtle rule: when the target
  is already running **without** a debugging endpoint, the rung is **available iff `killFirst===true`**
  (`:1392-1405`) and unavailable-with-remedy otherwise (`:1406-1411`). Comment `:1387-1391` records the real
  dead-code bug this fixes.
- **`openCdp()`** `:1426-1556`: attach only if the port already serves **this** target
  (`rankPages(...).bestScore > 0` `:1456-1460` — prevents cross-app attach); otherwise port pick `:1477`,
  isolated-profile exception `:1483-1489`, single-instance guard raising `SingleInstanceBlocked`
  (`:1138-1160`) with a copy-paste remedy (`:1496-1512`), `terminateForLaunch()` `:1242-1370` with the
  `NEVER_KILL` allowlist `:1162-1167`, graceful-then-force `:1200-1240`, pid-drift guard `:1180-1186`, and a
  last-second `recheck` that refuses to kill a session that has become usable (`:1521-1527`); endpoint wait
  `:1540-1551` with honest "single-instance only focused the old window" wording.
- **Send/deliver:** `readExpression()` `:437-499`, `locateInputExpression()` `:501-595`, marked-value probe
  `:597-606`, fallback insert `:607-625`, `CdpPageSession.send()` `:893-905` with insertion verification
  `:825-835`, `dispatchCdp()` `:1665-1865` (hydrate wait `:1580-1592`/`:1710-1712`, prompt-echo completion
  criterion `:1738-1745,1784-1800`, busy selector, `readReplyFromService()` `:1604-1659` service-side readback
  with a `^[A-Za-z0-9_-]{4,128}$` session-id whitelist `:1621-1623`, `owned`-only close `:1855-1863`).
- **Known failure modes:** cross-target port collision (documented `:1453-1455`), Electron single instance
  (honest error, never pixel fallback `:11-14`), virtual-list/DOM lag (`:1731-1741`), hydration races
  (`:1569-1578`), `evaluate()` on a replaced execution context.

### 8.5 `window` — `src/transports/window.ts`
- **Needs:** the Python helper — `python/hp_helper.py` (33,225 bytes) driven by `WindowHelper`
  (`src/helper.ts:53-300`: `ensure/info/call/find/waitForWindow/focus/text/type/key/click/launch/close/focusInput/clickByName/elements`),
  interpreter from `config.pythonPath` or auto-detected (`src/index.ts:672`); Python deps documented in
  `package.json:49` (pyautogui + Pillow + pywin32 + uiautomation).
- **Attach:** `openWindow()` `:164-247` — refuses an empty match (would type into the user's foreground
  window, `:171-177`), foreground/area pick `:103-112`, minimized-window wake `:87-100`, launch with
  `mode: gui|terminal` and `HP:<target>` title fallback `:183-211`, focus `:224-228`, initial baseline read `:232-239`.
- **Send:** `sendToWindow()` `:327-417` — `ensureForeground()` gate that refuses to type into a stolen
  foreground `:304-318`, optional `openInputKeys` `:346-358`, UIA `focusInput` click `:366-380`, per-line
  `helper.type` with `newlineKeys` `:388-398`, `submitKeys` `:401-411`.
- **Read:** `readWindow()` `:250-265` passes through `source ∈ uia|console` and the helper's `note`.
- **Deliver:** `dispatchWindow()` `:446-650` — 700 ms polling `:27`, settle on "changed since baseline **and**
  byte-identical for `window.settleMs`" `:544-554`, `POLL_MS`-bounded loop, `screenDelta` progress `:432-438`,
  and an explicit no-fabrication rule: empty text ⇒ `error` with the helper's reason `:574-596`.
- **Pre-flight:** `src/sessions.ts:245-258` — helper `ensure()` then a real window search; a configured
  `window.launch` counts as available even if nothing is running.
- **Cleanup:** `closeWindow()` only closes windows **we** launched (`owned === true`, `:420-429`) — attaching
  never closes the user's app.

**Would break if rewritten:** the `ClickOutcome` normalisation (`src/sessions.ts:64-71`, producers at
`src/tools.ts:111-127` and `src/sessions.ts:499-512`) exists because a page-internal JS miss returns
`{ok:false}` without throwing (`src/tools.ts:105-110`); it is the fix for a real mis-delivery incident and is
asserted by `probe/verify-send-click-guard.mjs`.

---

## 9. Existing model handling — and the DSH-list defect question

**Three distinct mechanisms, all implemented:**

1. **`harness_models` tool** `src/tools.ts:770-827`.
   - Always prints a **DSH-side** block first: `overview.dsh.providers` produced by
     `listDshModels(ctx.llm)` (`src/models.ts:107-126`, wired at `src/index.ts:681-696`,
     `src/sessions.ts:619`), headed *"DSH profile providers (N) — what this DSH install itself can route to"*
     (`src/tools.ts:785`).
   - Then, for a named target, `registry.targetModels(target)` + `mechanismOf(target)` (`:795-807`); with no
     target, only targets that have a non-empty `modelsCommand` are queried (`:810-820`) plus a closing note
     that others were skipped (`:821`).
2. **`modelsCommand` / `modelsArgs`** per target — executed by `listHarnessModels()`
   `src/models.ts:20-68` (spawn, env `NO_COLOR=1 TERM=dumb`, timeout, stderr-on-nonzero diagnostic) and parsed
   by `parseModels()` `:76-93` (ANSI strip, bullet strip, first token, id-shape regex). Cached per target by
   `modelsCacheMs` in `SessionRegistry.targetModels()` `src/sessions.ts:565-574`, invalidated by
   `clearModelCache()` `:577-579` (HTTP `/models?refresh` `src/index.ts:322`, tool `refresh` `src/tools.ts:783`).
   Configured targets: `opencode` `src/config.ts:232-233`, `mimo-cli` `:270-271`, `qodercli` `:307-308`,
   `qoderclicn` `:317-318`, `grok-cli` `:336-337`, `agy` `:346-347` (150 s timeout), `pi` `:359-360`.
3. **Model selection at dispatch time** — `withModel()` `src/sessions.ts:146-163` rewrites `target.args`
   (substituting `{model}` into `modelArgs`) and sets `target.acpModel = chosen` (`:161`). Note the positional
   guard at `:153-156` (model args are spliced **before** the last `-p`). ACP applies it via
   `session/set_config_option` (`src/transports/acp.ts:342-353`); headless/pty via argv.
   `mechanismOf()` `src/tools.ts:71-78` reports which mechanism a target will use (also used by HTTP `/models`).
   GUI switching is CDP-only: `currentModelOf()` `src/tools.ts:575-577`, `switchModel()` `:590-667` (real CDP
   mouse `Input.dispatchMouseEvent`), `switchModelInPage()` `:676-706` (legacy synthetic-event path with chip
   follow-ups). HTTP `/send` reports `currentModel` and a structured `modelSwitch:{ok,detail}`
   (`src/index.ts:436-485`, `:486-494`); `harness_send` is **fail-closed** on a failed switch unless
   `send_anyway_on_model_fail=true` (`src/tools.ts:1022-1043`).

**The defect question — REFUTED as stated, but a real residual confusion risk exists.**
- Refutation: no code path takes a `ctx.llm` model and presents it as an external CLI's own list. The two
  sources are separate types and separate fields (`DshProviderModels` `src/models.ts:96-100` vs
  `TargetOverview.models` `src/sessions.ts:130`), separate HTTP fields (`Overview.dsh.providers`
  `src/sessions.ts:139` vs `targets[].models` `:130`), separate client sections
  (`client/client.js:633-636` "DSH 已配置供应商" vs `:625-628` "harness 目标" with a per-target model count at
  `:353-363`), and separate `harness_models` blocks with explicit headers (`src/tools.ts:785` vs `:813`).
  `mechanismOf()` never consults `ctx.llm`, and the DSH list is never used to populate a target's `models`.
- Residual risks the upgrade must still fix (these are the honest part of the finding):
  1. The `harness_models` **tool description** fuses the two sources into one sentence —
     *"the provider routes/models configured in this DSH profile, plus the models each harness advertises itself"*
     (`src/tools.ts:772-775`) — and instructs the caller to use "the returned ids" with
     `harness_dispatch(model=…)`/`harness_agent(model=…)` (`:775`). The DSH block is printed **even when an
     external `target` is given** (`:785-793` runs before the target branch), so a model id can be copied from
     the wrong block.
  2. `harness_agent`'s `model` description (`src/tools.ts:878`) and `harness_dispatch`'s (`:840`) both say
     "see harness_models for what each harness offers", while GUI-only targets (zcode, mimo, mimo-ai,
     qoder-cn, cursor, antigravity, workbuddy, minimax, grok, qoder, opencode-desktop) have **no**
     `modelsCommand` and are therefore absent from the listing entirely (`:810`), pushing the caller back onto
     the DSH list.
  3. `harness_send`'s `model` description contains a stray "harness_models/qoder-cn" (`src/tools.ts:1001`).
  4. The plan's four-state discipline (`configured|discoverable|auth-valid|usable`,
     `src/federation/types.ts:166`) is **not** enforced anywhere today; `TargetOverview.canSelectModel`
     is only `modelArgs.length>0 || acpArgs.length>0` (`src/sessions.ts:606`) and does not distinguish
     «advertised» from «actually usable».

---

## 10. Build / verify harness

**`scripts/build.mjs` (105 lines)**
- Locates the running install (`DSH_INSTALL` env → `DSH_CHECKOUT/node_modules` → hardcoded `C:/dsh/node_modules`
  `:20-24`) by probing for `@deepseek-ai/dsh-tools/package.json` `:26`, then junctions seven host peer packages
  plus `node-pty` and three optional deps (`@agentclientprotocol/sdk`, `ws`, `@xterm/headless`) from that
  install (`:52-85`) — junction on Windows `:57`, replacing the link each run `:55`.
- Finds a TypeScript checkout (`DSH_CHECKOUT` → `D:/Project/deepseek-harness-master/deepseek-harness-master`
  → `C:/dsh` → `~/dsh-harness` `:34-45`) purely to borrow `tsc`.
- Compiles `tsc -p tsconfig.json` with `stdio:'inherit'` and propagates the exit code `:92-93`.
- Copies `client/client.js` → package-root **and** `lib/client.js` (injector reload preflight checks the latter)
  `:95-104`. Re-running is idempotent; the script exits 0 explicitly `:105`.
- `tsconfig.json:2-17`: `target ES2023`, `module/moduleResolution NodeNext`, `strict`, `declaration` into
  `lib/types`, `rootDir src`, `outDir lib`, `sourceMap`. `package.json:7-12` exports `.` → `./lib/index.js`
  and `./client` → `./client.js`; `package.json:33-38` maps all four npm scripts onto the same build.
- **Verified:** the three client copies are byte-identical (SHA-256 `6D2101DD…C9DCCC`, 34,111 bytes each).

**Reusable probes** (all under `probe/`, run from the repo root; those marked ✅ are non-interactive
regression checks worth re-running after the upgrade):

| File | Lines | One-line purpose |
|---|---|---|
| `verify-api-handler.mjs` ✅ | 235 | Drives `createApiHandler` from `lib/index.js` with fake registry/req/res and pins 401/400/413/405/404/200 plus the five endpoints' fields (`:5-7,12`) |
| `verify-route-heal.mjs` ✅ | 93 | Pins `registerApiRoute`/`clearStaleRoutes` self-heal: stale entry cleared + retry, both errors warned on failure, disposer removes the route (`:4-8`) |
| `verify-tasks-wake.mjs` ✅ | 251 | Settings save/get, background `task/start`→terminal→`GET /task`, receipt text w/ truncation, and the `resolveAgent→followup→flush` wake sequence (`:4-8`) |
| `verify-subagent-run-ledger.mjs` ✅ | 137 | `kind=subagent` ledger: view fields, terminal `.result.json` persistence, silent run becomes `stalled` (`:40,44,93-97`) |
| `verify-send-click-guard.mjs` ✅ | 186 | P3 regression: after a failed `click=`, `send()` must never be called (`:11-14`) |
| `verify-open-single-instance.mjs` ✅ | 139 | Remedy text + structured `SingleInstanceBlocked` + the four `kill_first` guards, deliberately non-destructive (`:5-8`) |
| `verify-kill-first-reachable.mjs` ✅ | 110 | Seam test: `preflight(cdp,{killFirst})` must flip to available so `openCdp`'s kill_first branch is reachable (`:3-14`) |
| `verify-launch-env.mjs` ✅ | 62 | GUI launches must strip inherited `ELECTRON_RUN_AS_NODE`, but honour a target's explicit value (`:3-17`) |
| `argv-check.mjs` ✅ | 49 | cmd.exe quoting: a prompt with spaces/colons must arrive as one argv via a self-made `.cmd` (`:2-5`) |
| `acp-spawn-check.mjs` ✅ | 25 | Reproduces `acp.ts`'s spawn form to confirm `.cmd` verbatim passing |
| `verify-api.mjs` | 142 | Hits the **running** DSH HTTP API — must run after `build` + plugin reload (`:4-10`) |
| `client-register-check.mjs` ✅ | 56 | Simulates the browser module table and asserts the client artifact's registration contract incl. `settings.plugins.tab` (`:61-62`) — header comment at `:5` is stale (says `plugins.item`) |
| `verify-models.mjs` / `verify-models2.mjs` | 88 / 139 | Real GUI model switching on MiMo/MiMo AI/ZCode via `lib/tools.js switchModel` + `CdpPageSession.mouse` (needs apps running) |
| `verify-qoder-cn-target.mjs` | 34 | `probeCdpTarget` + page picking for the Quest-window case (`pageMatch`) |
| `verify-qoder-cn-send.mjs` | 66 | End-to-end CDP dispatch through the plugin's own path (nonce marker per run) |
| `verify-opencode-desktop.mjs` / `-tools.mjs` | 99 / 72 | OpenCode-desktop CDP dispatch/readback; and the tool-surface variant driven with a fake ctx |
| `acp-probe.mjs` | 318 | Real `opencode acp` timing probe; primary path imports `lib/transports/acp.js`, `--raw` falls back to the bare SDK (`:9-21`) |
| `cdp-launch-check.mjs` | 193 | Full CDP plumbing against a real Chromium with an isolated `--user-data-dir` (`:2-21`) |
| `cdp-harness-probe.mjs` | 173 | Read-only A/B/C probe of real Electron harnesses + honest-failure demo (`:2-15`) |
| `window-dispatch.mjs` / `helper-smoke.mjs` | 205 / 92 | Window channel e2e and helper primitive smoke, both only touching self-started windows |
| `console-roundtrip.mjs` / `console-shim-roundtrip.mjs` / `console-debug.mjs` / `console-visual.mjs` | 129 / 115 / 53 / 72 | Console-buffer read/type round-trips, incl. the `ctypes.wintypes.COORD` shim and screenshot ground truth |
| `ime-enter-test.mjs` | 120 | Whether Enter submits and whether a Chinese IME mangles injected ASCII |
| `e2e-kill-first.mjs` | 127 | **Destructive** real kill+relaunch E2E; requires `--yes <targets>` (`:5-7`) |
| `type-foreground.mjs` / `input-survey.mjs` / `cleanup-hp-windows.mjs` | 19 / 28 / 14 | Manual utilities: type into the foreground window, list UIA inputs, close leftover `HP*` probe windows |
| `out2.json` / `out3.json` / `out-conhost.json` / `shot-step*.png` | — | Captured probe evidence/artifacts, not scripts |
| `probe/audit/` (60+ files, 15 `.mjs` + 3 reports) | — | One-off model-picker reconnaissance for Qoder CN / Antigravity / MiMo / ZCode; useful as raw evidence, not as regression checks |
| `~/.dsh/plugins/harness-pilot/probe/workbuddy-ai-dispatch.mjs` | 10,313 B | Out-of-repo probe for the WorkBuddy AI target — **unconfirmed** whether it is current |

---

## 11. Exact insertion points for the federation upgrade

| # | Hook | Where | Why it is safe |
|---|---|---|---|
| I1 | New child fiber with `inject: ['subagents']` for provider extras | template at `src/index.ts:756-766` | This plugin already refuses to trust `ctx.get` in the main fiber (`:698-704`); copy the pattern, don't replace it |
| I2 | Extend the HTTP surface | add to `ApiExtras` `src/index.ts:220-224`, pass at `:786`, add branches before the 404 fallback `src/index.ts:657` | Purely additive; `verify-api-handler.mjs` drives `createApiHandler` offline so new routes are testable without reload |
| I3 | New tools | `registerTools` call site `src/index.ts:768-772` / `registerTaskTools` `:774-779` | The `register()` helpers are idempotent (`src/tools.ts:711-718`, `src/task-tools.ts:71-75`) so a double-loaded package cannot fail the fiber |
| I4 | Provider shape additions (`prepareContinuable`, `agentRouteDefaults`, extra `capabilities`) | `src/provider.ts:49-59` | Nothing in the plugin reads those members today, so adding them is additive; **do not rename** existing provider names (§5) |
| I5 | New ledger-backed run kinds / fields | `src/tasks.ts:27` (`TaskKind`) + `view()` `:179-198` | `status()` already backfills missing `kind` (`:440-441`); add fields the same way (optional-with-default) so 84 existing records keep loading |
| I6 | Client sections | `client/client.js:673-689` `apply()` | Add another `ctx.slots.inject`; keep the "every field optional / never throw" rule (`:88-113`) |
| I7 | Federation data model | `src/federation/types.ts` (235 lines, already present) | Verified **dead code today**: a repo-wide grep for `federation` across `*.ts` matches only that file's own header comments (`:2`, `:10`) — nothing imports it, and there is no `probe/verify-federation.mjs` on disk despite `:10` naming one. It is a pure-type module (`:9-11`: implementations may import only these types + `node:*`). Free to extend |
| I8 | New cordis Config fields (registry paths, per-harness version probes, account roots) | `src/config.ts:81-89` schema + `resolveConfig()` `:582-605` | Schemastery defaults make new optional fields backward compatible with every existing profile patch |
| I9 | Runtime-settings additions | `src/settings.ts:12-25,53-64` | `normalizeSettings` supplies per-field defaults, so old `runtime-settings.json` keeps loading |
| I10 | New verifiers | `probe/verify-*.mjs` | Follow the established shape: import from `../lib/*.js`, fake the host boundary, exit non-zero on failure |

---

## 12. Fragile coupling / load-bearing hacks the upgrade must not trip over

**Load-bearing casts and private-surface pokes**
- `src/index.ts:667-671` — `ctx as unknown as {get, effect, plugin}`; the whole deferred-fiber design rests on it.
- `src/index.ts:705-717` — `subagentsFacade` resolving `ctx.subagents` per call.
- `src/index.ts:99-115` — `clearStaleRoutes()` reaches into the webServer Service's **private** `exact`/`prefixes`/`upgrades` Maps (`WebServerLike` doc `:66-73`). Directly dependent on host internals; a host change silently breaks route self-heal (the failure mode is a 404 settings page, warned at `:141-147`).
- `src/index.ts:805` — `?? (ctx2 as unknown as {webServer?}).webServer` fallback: two different host shapes are guessed.
- `src/provider.ts:136` — `tracked.id as unknown as SubagentRun['id']`: run ids are branded host types; the plugin forces its own UUID into that shape. Any host-side id validation change breaks `harness_agent` and the P7 contract at once.
- `src/tools.ts:708`, `src/task-tools.ts:69` — `ctx: any`; tool registration bypasses host typing entirely.
- `src/transports/acp.ts:319` — `Readable.toWeb(...) as unknown as ReadableStream<Uint8Array>`.
- `src/tools.ts:54-58`, `src/provider.ts:43-47`, `src/task-tools.ts:40-50` — three independent re-derivations of the Agent/session shape (`session.header.cwd`, `agent.id`); if the host Agent shape moves, all three fail **silently** (cwd falls back to `process.cwd()`, session id falls back to `''` ⇒ `callback.skipped`).

**Implicit host-version assumptions**
- `src/index.ts:47-51` documents that only `tools`, `llm`, `subprocess` are guaranteed; everything else is
  deferred or lazily resolved. This is a workaround for observed service-order races, not a contract.
- `package.json:22-28` peer ranges (`>=0.2.0-rc <3` for four packages, `cordis >=4.0.0-rc <5`, `schemastery ^3.18.0`)
  are wider than what is actually installed: the junctions resolve to **`@deepseek-ai/dsh-* 0.2.0-rc.1`**
  (verified: `dsh-tools`, `dsh-subagent`, `dsh-llm`, `dsh-session`, `dsh-agent` all `0.2.0-rc.1`;
  `cordis 4.0.4`, `schemastery 3.18.4`) while the host process is **0.2.0-rc.2**. `lib/*.js` therefore runs
  rc.1 module instances inside an rc.2 host. Fixing this is P0 in the plan; nothing in the plugin currently
  detects the mismatch.
- `src/sessions.ts:615` — `plugin: {version: '0.1.0'}` is **hardcoded** and already wrong (`package.json:3` says
  `0.1.1`). The client displays it (`client/client.js:206-213,614`).
- `src/sessions.ts:606` — `canSelectModel` and `models` are on one line (`... > 0,        models,`) — cosmetic drift, but it shows the file is hand-maintained.

**Hardcoded absolute paths** (all in `src/config.ts` unless noted)
- Machine-specific constants: `WB_NODE_MODULES` `:164`, `ZCODE_CLI` `:165`, `CODEBUDDY_CLI` `:166`,
  `QODER_CLI` `:167`, `GUI_SCAN_ROOTS = ['D:\\','C:\\']` `:170`.
- Per-target literal paths: `zcode-cli` `:286`, `qoder-cli` `:294`, `qodercli` `:304,307`, `qoderclicn` `:314,317`,
  `kimi` `:324`, `grok-cli` `:333`, `command-code` `:367`, `claude` `:375`, `codex` `:383`, `zcode` `:409`,
  `mimo-ai` `:418`, `mimo` `:427`, `workbuddy` `:436`, `qoder` `:445`, `qoder-cn` `:455-457`, `qoder-cn-app` `:474`,
  `antigravity` `:483`, `minimax` `:492`, `grok` `:501`, `cursor` `:510`, `opencode-desktop` `:530,548`.
  Mitigation for one family only: `resolveRenameableExe()` `:192-213` (rename-proof Qoder exe).
- `scripts/build.mjs:23` defaults `findInstall()` to `C:/dsh/node_modules`; `:37` defaults `findCheckout()` to
  `D:/Project/deepseek-harness-master/deepseek-harness-master`. Both are stale on this machine (the running
  install is `D:\DeepSeek`), so the build works only because the junctions already exist.

**Other invariants worth freezing**
- `src/settings.ts:38` — `HARNESS_PILOT_HOME` overrides the plugin data dir. Moving the default data dir
  without honoring this env var strands every existing user's 84 task records.
- `src/tasks.ts:15` / `:17` — adding a new status to `TaskStatus` without adding it to `TERMINAL` makes
  `status()`, `list()` and the client's running-check (`client/client.js:551`) disagree.
- `src/tasks.ts:400-401` — `notify:false` is the only per-task switch; the global `notifyOnComplete` is inert (§7).
- No retention policy on `tasks/` (see risks).

---

## 13. What would break existing users' configuration, history, or running tasks

1. **Renaming subagent providers** (`harness-<name>` → `hx-<harness>-<account>`, plan:353) invalidates every
   user's `cordis.patch.yml` `provider: harness-opencode` entry (`cordis.patch.yml:17-26`), saved Agent-Team
   `freshProvider`/`forkProvider` config, and any script calling `harness_agent target=…`.
2. **Changing the ledger file names or `TaskView` field names** orphans all 84 existing `tasks/*.json|.log|.result.json`
   records; `harness_task_status` would report `unknown task_id` (thrown at `src/tasks.ts:438`) and the client
   Tasks panel (`client/client.js:523-586`) would render nothing.
3. **Dropping the `kind` backfill** (`src/tasks.ts:440-441`) makes pre-`kind` records fail to render "task" vs
   "subagent" in `harness_task_status` (`src/task-tools.ts:53`).
4. **Moving the plugin data dir** without honouring `HARNESS_PILOT_HOME` (`src/settings.ts:38`) strands tasks
   and `runtime-settings.json` (`maxConcurrent:0` would silently revert to the default 4).
5. **Changing `runtime-settings.json` key names** — `normalizeSettings` (`src/settings.ts:53-64`) falls back to
   defaults per field, so renamed keys silently reset rather than erroring.
6. **Tightening `apiToken` handling** without updating the client: the client sends no token header
   (`client/client.js:93`), so a non-empty `apiToken` already breaks the settings page today (401 at
   `src/index.ts:249-257`). Any new auth requirement compounds this.
7. **Removing the deferred-fiber registration** (`src/index.ts:756-766`, `:796-812`) brings back the observed
   bundle-startup route loss and provider loss (documented `:698-704`, `:781-782`).
8. **Treating `stalled` as terminal** — `probe/verify-subagent-run-ledger.mjs:93-97` and
   `src/tasks.ts:283-286` both rely on `stalled → running` recovery.
9. **Rewriting the `open()` ladder to jump straight to CDP** loses the `killFirst` pre-flight passthrough
   (`src/sessions.ts:369-371`) that makes `kill_first` reachable at all — a bug this codebase already fixed once
   (`probe/verify-kill-first-reachable.mjs:3-14`).
10. **Assuming `harness_open transport=acp` is like the others**: `open()` supports `acp` in the forced enum
    (`src/sessions.ts:357-364`, tool enum `src/tools.ts:955`) but `create()` has no `acp` branch
    (`src/sessions.ts:422-521` handles only `pty|cdp|window`), so an acp session request falls through to
    `undefined` and walks the rest of the ladder. Pre-existing behaviour; do not "fix" it blindly, but note it
    when wiring federation sessions.

---

## 14. Unconfirmed / not verified in this audit

- Host-side existence of the `settings.plugins.tab` slot: **resolved by cross-reference only** — client Inspect
  timed out twice for me, so the host declaration is taken from the teammate report
  `docs/verified/host-api-0.2.0-rc.2.md:29,59-65` (asar extraction), not re-verified independently.
- Whether `~/.dsh/plugins/harness-pilot/probe/workbuddy-ai-dispatch.mjs` is current or a leftover.
- Whether `unlimited-live.json` is written by an external live-patch tool outside this repository (no reader
  exists **inside** the repo).
- Exact runtime behaviour of the `acp` interactive-session path (no `acp` branch in `create()`, §13.10).
- Whether the running host's `ctx.subagents.list()` actually returns provider names (the plugin tolerates a
  missing `list`, `src/provider.ts:175`), so the `harness-pilot` alias registration could not be observed at runtime.
- `lib/*.js` freshness was checked by content spot-check and mtime, not by recompiling (read-only audit).
