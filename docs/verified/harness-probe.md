# Harness capability probe — measured on this machine

**Probe run:** 2026-10-13T17:11:13+08:00 (09:11:13Z) on `win-b7kic1tnl6r\administrator`, pwsh 7.6.6.
**Scope:** real, locally installed AI CLI harnesses, probed **read-only**.
**Companion file:** [harness-probe.json](harness-probe.json) — same facts, machine-readable, with raw argv + trimmed output per harness.

Every fact below is tagged **measured** / **inferred** / **unknown**. Nothing is promoted from one to the other.

---

## 0. Safety statement

| Constraint | Status |
|---|---|
| Ran a login / logout / auth-switch command | **No** |
| Wrote, moved, renamed or deleted a credential, token, keyblob or auth file | **No** |
| Printed a token *value* into these deliverables | **No** (see caveat) |
| Modified a vendor installation | **No** |
| Touched the four live DSH accounts | **No** — only their directory *names* were listed |
| Isolation tests | Used fresh directories under `%TEMP%\hp-iso*` only |

**Caveat, stated plainly:** while reading raw config files, two secret values appeared in *tool output during probing* — the `ANTHROPIC_AUTH_TOKEN` value from `~/.claude/settings.json`, and the `apiKey` value from `~/.zcode/cli/config.json`. Both are **deliberately not reproduced** anywhere in `harness-probe.json` or this file. Only key *names* and presence are recorded. Flagging it so the operator can rotate if that console transcript is retained.

**What "no live model request" means:** no harness was sent a prompt. Exit code 0, a readable identity, a non-empty model catalog, or an ACP-capable flag are **not** treated as proof that any harness can complete a model request. The JSON records `liveModelRequestIssued: false`.

---

## 1. Master matrix

| Harness | Real entry path (resolved) | Version | Transports (evidence-backed) | Model-selection mechanism | Conf. |
|---|---|---|---|---|---|
| **DSH native** | *in-process — no CLI entry into the running build* | 0.2.0-rc.2 (given ground truth) | in-process only | host-side service (out of scope) | measured |
| **Codex** | `C:\Users\Administrator\.codex\plugins\.plugin-appserver\codex.exe` (native exe, **not on PATH**) | `codex-cli 0.160.1` | headless `exec` (+`--json`); **app-server JSON-RPC** (`--listen stdio://\|unix://\|ws://IP:PORT\|off`); `exec-server`; `remote-control`; TUI; GUI `codex app`; `mcp`. **No ACP.** | `-m/--model`; list = `codex debug models` → **10** | measured |
| **Claude Code** | `…\22.22.2\node_modules\@anthropic-ai\claude-code\bin\claude.exe` via `claude.cmd` (plain passthrough, no node) | `2.1.291 (Claude Code)` | headless `-p/--print` + `--output-format text\|json\|stream-json`; background sessions `--bg`/`agents`/`attach`; gateway; TUI; `mcp`. **No ACP, no app-server.** | `--model`; **no list command exists** (312-line help enumerated) → 0 | measured |
| **OpenCode** | `…\22.22.2\node_modules\@opencode\cli\bin\opencode.exe` via `opencode.cmd` (+ identical `opencode2.cmd`) | `opencode v2.0.14` | **ACP** (`opencode acp`); headless `opencode run` (`--format default\|json`); HTTP `opencode serve` (`--hostname --port --cors --service --stdio`); background service; TUI; `opencode api` | `-m/--model provider/model#variant`; `opencode models` → **returned EMPTY (0 bytes, exit 0)** | measured |
| **Pi** | `…\22.22.2\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js` via `pi.cmd` — **needs node** | `1.1.0` | headless `-p`; `--mode text\|json\|rpc` (**rpc mode exists**); TUI; `--export` HTML. No ACP. | `--model`; `--list-models [search]` → **96** across 5 providers | measured |
| **Qoder CN** | `C:\Users\Administrator\.qodersec\bin\qoderclicn.exe` (native exe) | `1.1.41` | headless `-p/--print` + `-o/--output-format`; `--remote-control`; TUI. **No ACP, no app-server.** | `-m/--model`; `--list-models` → **blocked: "Not logged in"** (exit 1) | measured |
| **WorkBuddy + CodeBuddy** | app `D:\workbuddy\WorkBuddy.exe`; CLI **`…\cli\dist\codebuddy-headless.js`** via `bin\codebuddy` (**launcher broken**, see §2) | app `37.10.3-24`; CLI `2.156.0` | **ACP** (`--acp`, `--acp-transport stdio\|streamable-http`); `--serve` HTTP (Web UI/REST/**ACP over SSE**); headless `-p`; background sessions; sandbox; GUI | `--model` (+ aliases `fast-model/balanced-model/primary-model/deep-model`); catalog file `~/.codebuddy/models.json` → **11** | measured |
| **WorkBuddy.AI + CodeBuddy** | app `D:\workbuddy ai\WorkBuddyAI\WorkBuddyAI.exe`; CLI `…\cli\dist\codebuddy-headless.js` (launcher SHA256 **identical** to WorkBuddy) | app `37.10.3-24`; CLI `2.156.0` | same CLI surface (inferred from byte-identical bundles) | same CLI (inferred) | measured (entry/version), inferred (rest) |
| **MiMo** | `C:\Users\Administrator\.mimocode\bin\mimo.exe` (native exe) | `0.1.4` | **ACP** (`mimo acp`); headless `mimo run` (`--format default\|json`); `mimo serve`; `mimo attach`; TUI; `mcp` | `-m/--model provider/model`; `mimo models` → **7** | measured |
| **Kimi** | `C:\Users\Administrator\.kimi-code\bin\kimi.exe` (native exe) | `0.26.0` | **ACP over stdio** (`kimi acp`); headless `-p/--prompt` + `--output-format text\|stream-json`; `kimi server` (REST+WS+web UI); TUI | `-m/--model`; no list command; `kimi provider list` → **"No providers configured."** | measured |
| **Grok** | `C:\Users\Administrator\AppData\Local\grok\grok.exe` (native exe) | `grok 0.2.103 (89c3d36fb6)` | headless `-p/--single` + `--output-format plain\|json\|streaming-json`; **`grok agent stdio\|headless\|serve\|leader`** (stdio + WebSocket server); leader socket; TUI. No ACP. | `-m/--model`; `grok models` → **1** and prints **"You are not authenticated."** | measured |
| **Antigravity (agy)** | `C:\Users\Administrator\AppData\Local\agy\bin\agy-core.exe` via `agy.cmd` (plain passthrough) | `1.3.3` | headless `-p/--print` + `--output-format text\|json\|stream-json` + `--input-format stream-json` (NDJSON); `--remote-control`; TUI; `mcp`; `plugin`; `mic-serve`. **No ACP.** | `--model`; `agy-core models` → **6** | measured |
| **ZCode** | **NOT FOUND.** GUI only: `D:\zai\ZCode\ZCode.exe` (Electron, `@zcode/desktop`, no `bin` field) | **unknown** (installers on disk suggest 3.x) | GUI/CDP only (inferred). No CLI flags measurable. | config key `model` = `default-mimo/mimo-v2.5-pro`; `models/api.json` present but **not parsed** | **unknown** |

### Confidence tally (harness level)

| Level | Count | Harnesses |
|---|---|---|
| **measured** | 11 | dsh-native, codex, claude-code, opencode, pi, qoder-cn, workbuddy, workbuddy-ai, mimo, kimi, grok, antigravity-agy *(12 entries — see note)* |
| **inferred** | 0 | — |
| **unknown** | 1 | zcode |

> Note: `workbuddy` and `workbuddy-ai` are listed as separate targets (as requested) but share a byte-identical CLI payload, so their counts are not independent. **12 measured / 0 inferred / 1 unknown** at the target level; if the two WorkBuddy entries are collapsed into one shared-CLI finding it is 11 / 0 / 1.

Per-field confidence (auth, isolation, reasoning values, ZCode everything) is recorded field-by-field in the JSON — the harness-level tag above is the *weakest link* across the fields that matter most for a launcher.

---

## 2. Two defects worth acting on

### 2.1 The shipped CodeBuddy launcher is broken in both WorkBuddy installs

`resources\app.asar.unpacked\cli\bin\codebuddy` resolves `require('../dist/codebuddy')`, but `dist/` contains **only**:

```
lazy-headless/   lazy-lite-wb/   codebuddy-headless.js (11938885 B)   codebuddy-lite-wb.mjs (8567703 B)
```

The full TUI bundle `dist/codebuddy` is **absent**. Consequence, measured:

| Command | Exit | Result |
|---|---|---|
| `<node> bin\codebuddy --version` | 0 | `2.156.0` (short-circuits before the require) |
| `<node> bin\codebuddy --help` | 0 | full 12612-char surface |
| `<node> bin\codebuddy config list` | **1** | `Error: Cannot find module '../dist/codebuddy'` |
| `<node> bin\codebuddy config get theme` | **1** | same |
| `<node> dist\codebuddy-headless.js --version` | 0 | `2.156.0` |
| `<node> dist\codebuddy-headless.js --help` | 0 | 12624-char surface — **the working non-interactive entry** |

Both installs fail identically. **Recommended launcher entry:** `node "<install>\resources\app.asar.unpacked\cli\dist\codebuddy-headless.js" [args]`.

### 2.2 Four Node harnesses share WorkBuddy's bundled Node prefix

`claude.cmd`, `opencode.cmd`, `pi.cmd` and `dsh.cmd` all resolve into

```
C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\
    node.exe (87074816 B)
    node_modules\@anthropic-ai\claude-code\…
    node_modules\@opencode\cli\…
    node_modules\@earendil-works\pi-coding-agent\…
    node_modules\@deepseek-ai\dsh\…          ← 0.1.7-rc.2
```

This is **vendor-shared storage, not a per-harness isolated install**. WorkBuddy owns the runtime and the module tree; a WorkBuddy upgrade can move or delete another harness's entry point. Pin these paths absolutely rather than relying on PATH resolution.

*Also observed (additive to the task's list of three stale copies, not a correction of it):* a **fourth** non-running `@deepseek-ai/dsh` **0.1.7-rc.2** lives at the `dsh.cmd` shim target above. It is **not** the running version.

---

## 3. Multi-account isolation — what was actually tested

| Harness | Switch | Tested? | Result |
|---|---|---|---|
| **codex** | `CODEX_HOME` | **YES** | ✅ **WORKS.** temp dir → exit 1 `Not logged in`; default → exit 0 `Logged in using ChatGPT` |
| **claude-code** | `CLAUDE_CONFIG_DIR` | **YES** | ✅ **WORKS.** temp dir → `loggedIn:false, authMethod:"none"`, `configDirectory` moved; default → `loggedIn:true, authMethod:"oauth_token"` |
| **pi** | `PI_CODING_AGENT_DIR` | **YES** | ✅ **WORKS.** temp dir → `No models available. Use /login…`; default → 96 models. Temp dir received `auth.json` + `models-store.json` |
| **opencode** | `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB` | **YES — all five** | ❌ **NOT ACHIEVED.** `auth list` returned the identical 3 stored providers every time, including `--standalone`. Probable cause (inferred): a shared background service is live — `PID 11792  opencode.exe serve --service` |
| **mimo** | `MIMOCODE_CONFIG_DIR`, `MIMOCODE_HOME` | **YES** | ⚠️ **PARTIAL.** `CONFIG_DIR` → no change (7 models). `HOME` → 4 models instead of 7. Neither reached a credential-free state |
| **workbuddy / workbuddy-ai** | `CODEBUDDY_CONFIG_DIR` | **YES** | ⚠️ **INCONCLUSIVE.** The literal exists in the bundle, but the behavioural test (`config list`) fails identically with and without it (§2.1). DSH instead isolates WorkBuddy by *data root*: `.dsh\harness-accounts\workbuddy-a` mirrors the `~/.codebuddy` layout |
| **qoder-cn** | `--config-dir <dir>` (flag, not env) | **NO** | Documented only. A redirect test is uninformative while the default root already reports `logged_in:false` |
| **kimi**, **grok**, **antigravity-agy**, **zcode**, **dsh-native** | not identified | **NO** | No config-dir override is documented in their `--help`. Candidate naming was **not** guessed-and-tested, because a negative result would be indistinguishable from a wrong guess |

**Read-only auth status measured**

| Harness | Command | Result |
|---|---|---|
| codex | `codex login status` | ✅ `Logged in using ChatGPT` (stderr), exit 0. **No identity fingerprint printed.** |
| claude-code | `claude auth status` | ✅ `loggedIn:true, authMethod:oauth_token, apiProvider:firstParty`. **No user id/email printed.** |
| qoder-cn | `qoderclicn status -o json` | ❌ `{"logged_in": false, "version": "1.1.41", "allow_byok": 0}` |
| opencode | `opencode auth list` | 3 providers **stored**: OpenCode Console (Default), OpenRouter, Xiaomi. No boolean, no fingerprint |
| grok | `grok models` | ❌ `You are not authenticated.` — **even though `~/.grok/auth.json` exists (1742 B)**. File existence ≠ login |
| kimi | `kimi provider list` | ❌ `No providers configured.` (inferred not-logged-in) |
| pi, workbuddy(+AI), mimo, antigravity-agy, zcode | — | **unknown** — see §4 |

---

## 4. What I could NOT verify

1. **ZCode's CLI entry point does not exist on this machine as far as I could measure.** `where zcode` fails, there are no App Paths entries, `resources\app.asar` declares `@zcode/desktop` with **no `bin` field**, and the install manifest contains no CLI shim. Yet `C:\Users\Administrator\.zcode\cli\` is unmistakably a coding-agent CLI data root (`config.json`, `models\api.json` 2.35 MB, `exec\sess_<uuid>\`, `agents\`, `rollout\`, `db\db.sqlite` 779 MB). The launcher that wrote that tree was not found. `ZCode.exe --help` was **deliberately not run** — it is a GUI Electron app and could open a window or hang.
2. **CodeBuddy's login state (WorkBuddy and WorkBuddy.AI).** There is no `login` or `auth status` subcommand, and the only read-only surface (`config list` / `config get`) is dead because of the missing `dist/codebuddy` bundle. `~/.codebuddy/user-state.json` exists (128 B) but its content was not read.
3. **Pi's authentication state.** `pi auth` is documented as *"Print credentials or check provider readiness"* — running it risks printing an API key or bearer token, which this probe is forbidden to do. **Not executed.** The 96-model catalog is a catalog, not proof of a working request.
4. **MiMo's authentication state.** `mimo providers` is aliased to `auth` and manages credentials; not executed for the same reason. File-level observation only: `.local\share\mimocode\auth.json` is **2 bytes** (consistent with an empty JSON object).
5. **Any working multi-account isolation for opencode.** Five documented env switches were tested and **none** changed the credential result — the shared `opencode serve --service` process is the suspected cause but that is **inference, not measurement**. No working switch was found.
6. **Antigravity's provider config location and auth state.** `agy-core` exposes no `login`/`status` subcommand and no config root (`~/.antigravity` etc.) was identified. `agy-core models` returned 6 models, which proves nothing about authentication.
7. **Config-isolation env vars for kimi, grok, antigravity and zcode.** No override is documented in their help. I declined to guess-and-test names, because a negative result from a wrong guess looks identical to a real negative.
8. **Full model catalogs for opencode (0), qoder-cn (0) and kimi (0).** opencode's `models` returned empty output with exit 0 both plain and with `--standalone`; qoder-cn is blocked behind a login I am not permitted to perform; kimi has no list command and reports no providers.
9. **Reasoning-effort value sets** for codex, claude (`--effort`), pi (`--thinking`), grok (`--reasoning-effort`), qoder-cn (`--reasoning-effort`) — the flags are measured; the allowed values are printed as free text in help for most of them. Codex's `supported_reasoning_levels` is an array-of-objects in the catalog JSON and was not projected.
10. **The ACP handshake itself.** `opencode acp`, `mimo acp`, `kimi acp` and CodeBuddy's `--acp` are **measured as flags that exist**. No ACP session was started, so protocol version, capabilities and framing are all unverified.
11. **Whether any harness can actually complete a model request.** No prompt was sent to anything. See §0.

---

## 5. Entry-point resolution cheat-sheet

```
codex        C:\Users\Administrator\.codex\plugins\.plugin-appserver\codex.exe        (native exe; not on PATH)
claude       <nodeprefix>\node_modules\@anthropic-ai\claude-code\bin\claude.exe      (native exe; claude.cmd is passthrough)
opencode     <nodeprefix>\node_modules\@opencode\cli\bin\opencode.exe                (native exe)
pi           <nodeprefix>\node.exe <nodeprefix>\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js
qoderclicn   C:\Users\Administrator\.qodersec\bin\qoderclicn.exe                     (native exe)
codebuddy    <node.exe> "D:\workbuddy\resources\app.asar.unpacked\cli\dist\codebuddy-headless.js"
             <node.exe> "D:\workbuddy ai\WorkBuddyAI\resources\app.asar.unpacked\cli\dist\codebuddy-headless.js"
mimo         C:\Users\Administrator\.mimocode\bin\mimo.exe                           (native exe)
kimi         C:\Users\Administrator\.kimi-code\bin\kimi.exe                          (native exe)
grok         C:\Users\Administrator\AppData\Local\grok\grok.exe                      (native exe)
agy          C:\Users\Administrator\AppData\Local\agy\bin\agy-core.exe               (native exe; agy.cmd is passthrough)
zcode        — none found — GUI only: D:\zai\ZCode\ZCode.exe

nodeprefix = C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2
```

`ELECTRON_RUN_AS_NODE=1` was **not needed by any harness on this machine** — every vendor CLI resolves to either a native `.exe` or an ordinary Node script.
