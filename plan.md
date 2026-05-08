# Execution Plan — Extension Migration: `agents/` + `tasks/`

Source PRD: `./prd.md` (big-bang rewrite consolidating `extensions/modes.ts` and `extensions/orchestration/` into `extensions/agents/` and `extensions/tasks/`).

## Strategy

Although the PRD calls for a big-bang cutover, this plan stages the work so each phase leaves the repo in a green, verifiable state. The old `modes.ts` and `orchestration/` remain loaded and authoritative until the new extensions reach parity in Phase 6; the cutover (delete + settings flip + invariants update) happens atomically in Phase 7. This preserves the PRD's "single PR" constraint while letting us run `check-build.sh` + `check-invariants.sh` after every phase.

## Verification primitives (used by every phase)

- `bash scripts/check-build.sh` — TypeScript typecheck must pass.
- `bash scripts/check-invariants.sh` — TUI ownership + stale-name checks must pass.
- `bash scripts/smoke.sh` — manual smoke runner (where applicable).
- Phase-local autonomous checks: a small `scripts/phaseN-verify.sh` script created per phase that greps/asserts the phase's invariants. Each phase's checklist ends with running its own `phaseN-verify.sh`. Together build+invariants+phase-script form an autonomous loop runnable by an agent without human inspection.

## Dependency graph

```
P1 (schema)  ─┬─►  P2 (agents/ loader+primary)  ─┬─►  P3 (subagent tools in agents/)
              │                                  │
              │                                  └─►  P4 (@name dispatch)
              │
              └─►  P5 (tasks/ extension + tools)  ─►  P6 (cascade event wiring)
                                                       │
                                                       ▼
                                                      P7 (cutover: delete old, settings flip, audits)
                                                       │
                                                       ▼
                                                      P8 (full smoke + acceptance)
```

P1 has no deps. P2 depends on P1. P3, P4 depend on P2. P5 depends on P1. P6 depends on P3 + P5. P7 depends on P3, P4, P6. P8 depends on P7.

---

## Chunk 1: Phases 1–3 (schema, agents/ loader, subagent tools)

## Phase 1 — Schema parser (markdown frontmatter + JSON config) with opencode parity

**Depends on:** none.

**Goal:** Introduce a single shared parser for agent definitions that:
- Reads YAML frontmatter from markdown files AND JSON entries from settings.json `agent` map (PRD § Agent Definition Schema).
- Recognizes the opencode-parity discriminator `mode: primary | subagent | all`, defaulting to `all` when absent.
- Recognizes the full opencode option set (`description`, `model`, `prompt` with `{file:...}` resolver, `temperature`, `steps`/`maxSteps`-alias, `disable`/`enabled`-alias, `hidden`, `tools` in BOTH opencode-object and PI-comma-string shapes, `permission` map with shorthand or object-per-pattern values).
- Retains every existing PI-specific field (`prompt_mode`, `display_name`, `extensions`, `skills`, `inherit_context`, `isolated`, `memoryScope`, `thinkingLevel`, `isolation`, `run_in_background`, `enabled`) without behavior change.
- Strict validation: invalid `mode`, unknown `permission` key, or subagent missing `description` → named load error. The extension itself must keep loading other agents.

**Deliverables**

- New directory `extensions/_agent-schema/` (leading underscore = not auto-loaded as an extension; both old + new extensions import from it). Files split by responsibility, each ≤ ~250 lines:
  - `types.ts` — `AgentDef` union of opencode + PI-specific fields, `Permission` map type, `ToolsSpec` union (object-shape | comma-string).
  - `parse-frontmatter.ts` — exports `parseAgentFrontmatter(raw: string, sourcePath: string): { ok: true; def: AgentDef } | { ok: false; error: string }`. Splits YAML frontmatter from body; markdown body is preserved as the fallback prompt source.
  - `parse-json.ts` — exports `parseAgentJson(name: string, entry: unknown, sourcePath: string): { ok: true; def: AgentDef } | { ok: false; error: string }`. Used to load entries from settings.json `agent` map.
  - `permission.ts` — normalizes the `permission` map: validates allowed keys (`read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `todowrite`, `webfetch`, `websearch`, `lsp`, `skill`, `question`, `doom_loop`); accepts shorthand `"allow"|"ask"|"deny"` for all and pattern→action object for the documented object-capable subset; emits `unknown permission key` errors. Provides a `checkPermission(perm, key, pattern?)` helper used by call sites.
  - `prompt-resolver.ts` — resolves `{file:./relative/path}` templates in the `prompt` field against the defining file's directory; otherwise returns `prompt` verbatim; if `prompt` is absent and a markdown body was provided, returns the body.
  - `tools-spec.ts` — accepts both PI comma-string and opencode object shape; converts to a normalized `{ allowed: Set<string>, deniedGlobs: string[] }` while keeping the original raw shape for diagnostics. PI comma-string keeps deny-by-default allowlist semantics from today.
  - `defaults.ts` — default `mode` value (`"all"`) and the alias map (`maxSteps` → `steps`, `enabled: false` → `disable: true`).
- Validation rules implemented in `parse-frontmatter.ts` / `parse-json.ts`:
  - Invalid `mode` value → error: `agent <name> at <sourcePath>: invalid mode "<value>" (expected primary|subagent|all)`.
  - `mode: subagent` (or resolved-to-subagent) without `description` → error: `agent <name> at <sourcePath>: subagent requires "description"`.
  - Unknown permission key → error: `agent <name> at <sourcePath>: unknown permission key "<key>"`.
- Wire `extensions/modes.ts` to call `parseAgentFrontmatter`, treating `mode: primary | all` as primary-eligible. To avoid the new default (`all`) auto-promoting today's subagent-only files into primary cycling during P1–P6, the modes loader applies a transitional gate: in-repo `agents/*.md` files without an explicit `mode:` AND lacking any primary-only field (`prompt_mode`, `display_name`) are excluded from primary cycling. This transitional gate is removed in P7 once every file declares `mode:` explicitly.
- Wire `extensions/orchestration/custom-agents.ts` and `agent-types.ts` to delegate to `parseAgentFrontmatter`, treating `mode: subagent | all` (or resolved-to-`all`-by-default) as subagent-eligible.
- Settings reader: add a new helper `extensions/_agent-schema/load-settings-agents.ts` exporting `loadSettingsAgents(settings: unknown, settingsSourcePath: string): { defs: Map<string, AgentDef>; errors: string[] }`. It reads `settings.agent` (object map) and routes each entry through `parseAgentJson`. Both `extensions/modes.ts` and `extensions/orchestration/custom-agents.ts` (and, in P2, `extensions/agents/loader.ts`) call this helper at startup and merge its `defs` over their markdown-loaded map. JSON-defined agents override markdown-defined agents with the same name.
- Both call sites must, on parser error, log via the existing agent-load error path and continue loading other agents.

**Tasks**

- [x] Create the seven files under `extensions/_agent-schema/`.
- [x] Implement `parseAgentFrontmatter` and `parseAgentJson` sharing a common `finalize(def)` step (alias collapse, default-mode application, permission validation, tools normalization, prompt resolution).
- [x] Refactor `extensions/modes.ts` `parseFrontmatter`/local schema usage to delegate to the shared parser; install the transitional primary-cycling gate described above.
- [x] Refactor `orchestration/custom-agents.ts` and `agent-types.ts` to delegate to the shared parser.
- [x] Wire the settings.json `agent` map loader by calling `loadSettingsAgents` from BOTH `extensions/modes.ts` and `extensions/orchestration/custom-agents.ts`; ensure JSON entries override markdown entries by name in each loader's resulting map.
- [x] Add `scripts/phase1-verify.sh` running a tsx harness that asserts (each case as a separate exit-code check):
  - frontmatter without `mode:` → `def.mode === "all"`.
  - `mode: primary` → `def.mode === "primary"`.
  - `mode: bogus` → `ok: false` with the exact `expected primary|subagent|all` error format.
  - JSON entry `{ "review": { "mode": "subagent", "description": "x" } }` → parses; same entry without `description` → error.
  - `permission: { editz: "allow" }` → unknown-permission-key error.
  - `permission: { bash: { "git push": "ask", "*": "allow" } }` → parses; `checkPermission` returns `"ask"` for `git push` and `"allow"` for any other command (last-matching-rule semantics).
  - `prompt: "{file:./p.txt}"` with a sibling fixture `p.txt` → resolves to file contents.
  - `maxSteps: 3` → `def.steps === 3` (alias).
  - `enabled: false` → `def.disable === true` (alias).
  - `tools: "read, bash"` (PI shape) parses to allowlist `{read, bash}`; `tools: { write: false, bash: true }` (opencode shape) parses too; both produce the correct `ToolsSpec`.
  - PI-specific field passthrough: `prompt_mode: planning`, `inherit_context: true`, `memoryScope: session`, etc., all surface unchanged on `def`.
- [x] Confirm pi's extension auto-loader skips leading-underscore directories (consult pi extensions docs at `$PI_CODING_AGENT_DIR/.../docs/extensions.md`). If it does NOT, relocate the schema dir to `lib/agent-schema/` (outside `extensions/`) and update all imports accordingly.
- [x] Run `bash scripts/check-build.sh` — must pass.
- [x] Run `bash scripts/check-invariants.sh` — must pass.
- [x] Run `bash scripts/phase1-verify.sh` — must pass.

**Phase-local verify script (`scripts/phase1-verify.sh`)**

Asserts (autonomously):
1. All seven files under `extensions/_agent-schema/` exist; module exports `parseAgentFrontmatter`, `parseAgentJson`, `checkPermission`.
2. `rg -n "parseAgentFrontmatter\(" extensions/modes.ts extensions/orchestration/` returns ≥2 hits (both old extensions delegated).
3. `rg -n "parseAgentJson\(" extensions/` returns ≥1 hit (settings.json `agent` map is loaded).
4. Runs an embedded `npx tsx` harness that exercises every parser behavior listed in Tasks above and exits non-zero on the first failure.
5. `bash scripts/check-build.sh` returns 0.

**Done when:** All five steps in the verify script pass; existing pi session loads without behavior change (smoke spot-check: `Ctrl+Shift+M` still cycles primaries under the transitional gate, `Agent` tool still spawns).

---

## Phase 2 — `extensions/agents/` skeleton: loader + primary mode + `/agent[s]` + cycling

**Depends on:** P1.

**Goal:** Stand up `extensions/agents/index.ts` so that, when added to settings.json before `ui/`, it OWNS primary-mode behavior identically to today's `modes.ts`. We do NOT yet remove `modes.ts`; in this phase the new extension is added in parallel but disabled by default behind a `agents.enabled: true` settings flag (defaulting to false). When the flag is true, `modes.ts` short-circuits its own activation. This lets us A/B test parity inside the same build.

**Deliverables**

- New directory `extensions/agents/` with files split by responsibility:
  - `index.ts` — extension registration; reads `agents.enabled`; subscribes to `session_start`; resolves `defaultPrimaryAgent`. The legacy `defaultAgent` key is IGNORED at runtime (hard break per PRD). When `defaultPrimaryAgent` is unset, surface a single "no primary agent configured" warning via the standard agent-load error path and continue (no fallback to `defaultAgent`).
  - `loader.ts` — directory walk over the same three locations as today (global user agentDir, package root, `.pi/agents/`), using `parseAgentFrontmatter` from P1; merges JSON entries from `loadSettingsAgents(settings, settingsPath)` (P1 helper) over the markdown map so JSON wins on name collision; returns a `Map<string, AgentDef>` plus an array of load errors. Installs the same transitional primary-cycling gate P1 added to `modes.ts` (exclude in-repo agents lacking explicit `mode:` AND lacking `prompt_mode`/`display_name` from the primary cycle list); the gate is removed in P7 once every file declares `mode:` explicitly.
  - `primary.ts` — primary-agent application (model swap, tool gating, prompt prepend, etc.) — port of `applyAgent` from `modes.ts`.
  - `commands.ts` — `/agent` and `/agents` slash commands (selector + direct switch).
  - `cycling.ts` — registers a single `switch_agent` action bound to BOTH **Tab** (opencode parity) and `Ctrl+Shift+M` (legacy alias); cycles only agents with `mode: primary | all` and not `disable: true`. Tab binding must coexist with editor tab-completion: it only fires when the editor's input is empty / not in completion mode (mirror existing keybinding-precedence patterns in `extensions/ui/`).
  - `bus.ts` (thin) — re-exports `publishMode` from `extensions/ui/bus.ts` and centralizes the producer call so every primary state change funnels through one function.
- `extensions/modes.ts` gets a 5-line guard at top of activation: `if (settings.agents?.enabled) return;` — keeps it loaded but inert when the new extension is in charge.
- `settings.json` (in this repo) gets a non-default `agents: { enabled: true }` toggle ONLY in a tracked `settings.dev.json` (or commented in `settings.json`) for local validation. Production setting is flipped in P7.

**Tasks**

- [x] Create `extensions/agents/{index,loader,primary,commands,cycling,bus}.ts`. Each file should remain under ~250 lines; if `primary.ts` would exceed that when porting `applyAgent`, split tool-gating into `primary-tools.ts`.
- [x] Add the `agents.enabled` short-circuit to `modes.ts`.
- [x] Update `~/.config/pi/agent/settings.json` in dev (NOT tracked) is out of scope; tracked example settings file gets a comment block documenting the flag.
- [x] Run `bash scripts/check-build.sh`.
- [x] Run `bash scripts/check-invariants.sh`.
- [x] Run `bash scripts/phase2-verify.sh`.

**Phase-local verify script (`scripts/phase2-verify.sh`)**

1. All six new files exist; `rg -c "publishMode" extensions/agents/` ≥ 1.
2. `rg -n "agents.enabled" extensions/modes.ts` ≥ 1 hit (short-circuit installed).
3. `rg -n "setStatus|setWidget|setFooter|setWorkingMessage|setWorkingIndicator|setEditorComponent" extensions/agents/` returns 0 hits (chrome ownership preserved).
4. `rg -n "switch_agent|\"Tab\"|key:\s*\"Tab\"" extensions/agents/cycling.ts` ≥ 2 hits (both Tab and the legacy alias bound).
5. `bash scripts/check-build.sh` returns 0.
6. Runs `bash scripts/smoke.sh agents-primary` (a new smoke scenario added in this phase): launches pi with `agents.enabled=true` against a fixture settings dir; sends `/agent` and verifies the selector listed at least the canonical primary agents; sends a Tab key press AND (separately) a `Ctrl+Shift+M` press and asserts each one publishes a `mode` slot update; loads a JSON-defined agent from a fixture settings.json `agent` map and asserts it appears in the cycle. Smoke driver uses pi's existing scripted-input mechanism (extend `scripts/smoke.sh` with an `agents-primary` case calling pi non-interactively).

**Done when:** Toggling `agents.enabled` between true/false yields identical user-visible primary-mode behavior; phase-verify script exits 0.

---

## Phase 3 — Subagent spawning tools in `extensions/agents/`

**Depends on:** P2.

**Goal:** Move `Agent`, `get_subagent_result`, `steer_subagent` tools and the `orchestration` + `subagentUsage` UIBus producers into `extensions/agents/`, gated by the same `agents.enabled` flag. While the flag is off, `orchestration/` continues to own these. While on, `agents/` owns them and `orchestration/index.ts` skips registering them.

**Deliverables**

- New files under `extensions/agents/`:
  - `subagent-tools.ts` — `Agent`, `get_subagent_result`, `steer_subagent` registrations + Typebox schemas (ported from `orchestration/index.ts`, trimmed to only what the tools need).
  - `subagent-runner.ts` — wraps the existing `agent-runner.ts` machinery; for this phase imports `../orchestration/agent-runner.js` directly. This is an EXPLICITLY ALLOWLISTED transitional cross-extension import: `scripts/check-invariants.sh` does not currently enforce a cross-extension-import rule; if it grows one before P7, add `extensions/agents/subagent-runner.ts` to its allowlist. The import is removed in P7 when `orchestration/` is deleted (runner files moved to `extensions/agents/internal/`).
  - `subagent-bus.ts` — calls `publishOrchestration` and `publishSubagentUsage` from `extensions/ui/bus.ts`.
  - `lifecycle-events.ts` — defines and exports the agent-lifecycle event name + payload type that P6's tasks/ will subscribe to. Event name: `agents:subagent_end`. Payload: `{ agentId: string; status: "success" | "failure" | "stopped"; createdByTaskId?: string }`. Documented at top of file.
- `orchestration/index.ts` registers the three subagent tools only when `!settings.agents?.enabled`.
- Add `agents:subagent_end` to the allowed-events list in `scripts/check-invariants.sh` (extend the script's "no stale event names" check to permit this name).

**Tasks**

- [x] Port the three tool registrations into `subagent-tools.ts` (signatures and Typebox schemas verbatim from current `orchestration/index.ts`).
- [x] Add the conditional skip in `orchestration/index.ts`.
- [x] Wire `subagent-bus.ts` calls at the same publish points the orchestration extension uses today.
- [x] Add `lifecycle-events.ts` and emit `agents:subagent_end` from the runner completion path (in `subagent-runner.ts`'s wrapper) on success, failure, and stop.
- [x] Update `scripts/check-invariants.sh` allowed-events to include `agents:subagent_end`.
- [x] Run `bash scripts/check-build.sh`, `bash scripts/check-invariants.sh`, `bash scripts/phase3-verify.sh`.

**Phase-local verify script (`scripts/phase3-verify.sh`)**

1. `rg -nl "name: \"Agent\"|name: 'Agent'" extensions/agents/subagent-tools.ts` returns 1.
2. The Agent-tool registration in `extensions/orchestration/index.ts` is gated by `agents.enabled`. Concrete check: `awk '/registerTool|name: "Agent"/{found=NR} /if \(!settings\.agents\?\.enabled\)/{guard=NR} END{exit (guard>0 && found>0 && found-guard<30 && found-guard>0)?0:1}' extensions/orchestration/index.ts` returns 0 (guard precedes registration within 30 lines).
3. `rg -n "agents:subagent_end" extensions/agents/lifecycle-events.ts extensions/agents/subagent-runner.ts scripts/check-invariants.sh` returns ≥3 hits.
4. Smoke `bash scripts/smoke.sh agents-spawn`: with `agents.enabled=true`, spawn a subagent via the `Agent` tool against a no-op fixture agent, assert the `orchestration` and `subagentUsage` slots receive at least one publish each, and assert `agents:subagent_end` fires within 10s.
5. `bash scripts/check-build.sh` and `bash scripts/check-invariants.sh` both return 0.

**Done when:** With the flag on, all three subagent tools function and publish identical UI-bus state to today's flag-off behavior; the lifecycle event fires; verify script exits 0.

---

(Chunk 1 ends here.)

## Chunk 2: Phases 4–6 (@name dispatch, tasks/, cascade)

## Phase 4 — `@name` inline dispatch

**Depends on:** P3.

**Goal:** Implement user-message preprocessing that detects `@<name>` tokens and spawns subagents per match in document order, with strict disambiguation rules from the PRD.

**Deliverables**

- New file `extensions/agents/at-dispatch.ts`:
  - Exported function `extractAtDispatches(message: string, knownAgents: Map<string, AgentDef>): { strippedMessage: string; dispatches: { name: string; rejected?: "primary-only" | "task-permission-denied"; askRequired?: boolean }[] }`.
  - Tokenizer: scan `@<name>` where `<name>` is `[A-Za-z0-9_-]+` and matches an exact loaded agent name (case-sensitive).
  - Rejection rules (from PRD), in order:
    a. Any `/` or `\` after `@` in the same token → not a dispatch (file path).
    b. Any `.` followed by `[A-Za-z0-9]+` extension-like suffix → not a dispatch.
    c. Bare name not in `knownAgents` → not a dispatch (passthrough).
    d. Leading `\@name` → strip backslash, passthrough literally.
    e. Resolved agent has `mode: primary` → emit dispatch with `rejected: "primary-only"`.
  - `mode: subagent` and `mode: all` are accepted. `hidden: true` does NOT block dispatch (per PRD/opencode: `hidden` only affects autocomplete).
  - Returns the message with all matched tokens removed and surrounding whitespace collapsed (single space, trim).
- New file `extensions/agents/at-autocomplete.ts`:
  - Provides the `@`-mention autocomplete data source consumed by the editor: lists agents with `mode: subagent | all` AND `disable !== true` AND `hidden !== true`. Each entry includes `name` and `description`.
  - Wired into the editor via the existing UIBus mechanism (no direct chrome calls).
- Hook in `extensions/agents/index.ts` on the user-message-submit event; for each non-rejected dispatch, invoke the same code path the `Agent` tool uses (factor that path out of `subagent-tools.ts` into a shared `spawn(name, prompt, opts)` in `subagent-runner.ts`).
- The shared `spawn(name, prompt, opts)` enforces the invoker's `permission.task` rules (using `checkPermission` from P1) before the cross-mode check: deny → user-visible refusal, ask → prompt via `ask-user-question` extension, allow → proceed. The same enforcement applies to Agent-tool calls.
- For each rejected dispatch (`primary-only` or `task-permission-denied`), surface a user-visible message via the standard agent-load error channel and do not spawn.
- Multiple `@name` mentions → one spawn per match, in document order; each receives the same `strippedMessage` as its prompt.

**Tasks**

- [x] Implement `extractAtDispatches` with table-driven unit tests in `scripts/phase4-verify.sh` (tsx harness):
  - `@alice hi` (alice is subagent) → 1 dispatch, prompt `"hi"`.
  - `hi @alice there` → 1 dispatch, prompt `"hi there"`.
  - `@alice and @bob` (both subagents) → 2 dispatches, prompt `"and"`.
  - `look at @src/foo.ts` → 0 dispatches, message unchanged.
  - `see @notes.md` → 0 dispatches.
  - `@unknown hello` → 0 dispatches.
  - `\@alice literal` → 0 dispatches, message becomes `@alice literal`.
  - `@primaryOnly hi` (primary-only) → 1 rejected dispatch (`primary-only`), no spawn, error surfaced.
  - `@hiddenSub hi` (subagent, `hidden: true`) → 1 dispatch, prompt `"hi"` (hidden does not block dispatch).
  - `@allMode hi` (`mode: all`) → 1 dispatch (all is subagent-eligible).
- [x] Implement `at-autocomplete.ts` and verify it excludes `hidden: true`, `disable: true`, and `mode: primary` agents.
- [x] Implement `permission.task` enforcement in the shared `spawn` helper; cover ask/allow/deny via `checkPermission`.
- [x] Wire the dispatcher into the user-message-submit hook of `extensions/agents/index.ts`.
- [x] Factor a single `spawn(name, prompt, opts)` helper used by both `Agent` tool and `@name` dispatch.
- [x] Run `bash scripts/check-build.sh`, `bash scripts/check-invariants.sh`, `bash scripts/phase4-verify.sh`.

**Phase-local verify script (`scripts/phase4-verify.sh`)**

1. tsx harness importing `at-dispatch.ts` runs all 10 cases above, exits 0 only if every case matches expected output.
2. `rg -n "extractAtDispatches\(" extensions/agents/index.ts` ≥ 1 hit.
3. tsx harness importing `at-autocomplete.ts` asserts `hidden: true`, `disable: true`, and `mode: primary` agents are filtered out of autocomplete results.
4. tsx harness asserts `spawn(...)` honors `permission.task`: deny → returns rejection with `task-permission-denied`; ask → emits an ask event; allow → proceeds.
5. Smoke `bash scripts/smoke.sh agents-at-dispatch`: drive pi with a fixture message `"@alice and @bob run a check"`; assert two `agents:subagent_end` events fire and that each subagent received prompt `"and run a check"`. Additionally assert that `@hiddenSub go` spawns successfully and that the autocomplete list returned for `@` does NOT include `hiddenSub`.
6. `bash scripts/check-build.sh` returns 0.

**Done when:** All ten tokenizer cases pass; autocomplete filters `hidden`/`disable`/`primary` correctly; `permission.task` enforcement works for allow/ask/deny; smoke confirms multi-dispatch with correct prompt stripping; primary-only rejection surfaces an error.

---

## Phase 5 — `extensions/tasks/` extension: TaskStore + tools + auto-clear

**Depends on:** P1 (only — does NOT depend on P2/P3 because tasks/ does not import from agents/; cascade wiring is P6).

**Goal:** Stand up `extensions/tasks/` as a parallel owner of all `Task*` tools and auto-clear, gated by `tasks.enabled` flag. While off, `orchestration/` owns tasks; while on, tasks/ does. The cascade-on-completion behavior is still wired through `orchestration/` in this phase (it stays functional); P6 moves the cascade subscription into `tasks/`.

**Deliverables**

- New directory `extensions/tasks/` with:
  - `index.ts` — extension registration; reads `tasks.enabled`; registers `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute`. Each tool is a thin wrapper around `store.ts`.
  - `store.ts` — `TaskStore` ported from `orchestration/task-store.ts` (kept on-disk format identical per PRD).
  - `auto-clear.ts` — ported from `orchestration/auto-clear.ts`.
  - `tools/create.ts`, `tools/list.ts`, `tools/get.ts`, `tools/update.ts`, `tools/output.ts`, `tools/stop.ts`, `tools/execute.ts` — one file per tool to keep each small and single-responsibility. (Schemas + handler only; no business logic beyond delegating to `store.ts` / runner.)
  - `cascade-stub.ts` — placeholder that subscribes to `agents:subagent_end` but does nothing in P5 (logs at debug only). Real cascade in P6.
- `orchestration/index.ts` registers task tools and auto-clear only when `!settings.tasks?.enabled`.

**Tasks**

- [x] Port `TaskStore` and `auto-clear` verbatim into `extensions/tasks/`.
- [x] Create one tool file per Task* tool; each file ≤120 lines.
- [x] Add the conditional skip in `orchestration/index.ts`.
- [x] Run `bash scripts/check-build.sh`, `bash scripts/check-invariants.sh`, `bash scripts/phase5-verify.sh`.

**Phase-local verify script (`scripts/phase5-verify.sh`)**

1. All 7 tool files exist; `rg -c "execute:" extensions/tasks/tools/` returns 7.
2. `rg -nl "name: \"TaskCreate\"" extensions/tasks/tools/create.ts` returns 1.
3. `rg -nl "TaskCreate" extensions/orchestration/index.ts` shows registration is inside `if (!settings.tasks?.enabled)`.
4. Smoke `bash scripts/smoke.sh tasks-crud`: with `tasks.enabled=true`, `TaskCreate` → `TaskList` → `TaskGet` → `TaskUpdate(status: completed)` → wait for auto-clear interval → `TaskList` returns empty. Assert each step succeeds.
5. `bash scripts/check-build.sh` and `bash scripts/check-invariants.sh` return 0.

**Done when:** Toggling `tasks.enabled` yields identical task CRUD + auto-clear behavior; verify script exits 0.

---

## Phase 6 — Cascade event wiring (agents → tasks)

**Depends on:** P3 (event emitter) + P5 (subscriber location).

**Goal:** Replace `cascade-stub.ts` in `extensions/tasks/` with a real subscriber to `agents:subagent_end` that drives task cascade-on-completion for tasks created with `agentType` via `TaskExecute`. No cross-extension imports — wiring is entirely via the event bus.

**Deliverables**

- Replace `extensions/tasks/cascade-stub.ts` with `extensions/tasks/cascade.ts`:
  - Subscribes to `agents:subagent_end`.
  - On event, looks up the task by `agentId` via `TaskStore`'s `agentTaskMap` (the map already exists; ensure it's populated by `TaskExecute` when spawning).
  - If found and the event status indicates terminal completion (success/failure/stopped), marks the task completed and triggers the same cascade rules `orchestration/` implements today (release any tasks blocked by this one).
- Remove the cascade subscription from `orchestration/index.ts` when `tasks.enabled` is true (it was already inert because tools were skipped, but its event subscription could double-fire — explicitly guard against it).
- Confirm `agentTaskMap` lives in exactly one file (the invariants script already enforces this; it must remain in `extensions/tasks/store.ts` after P5).

**Tasks**

- [x] Implement `cascade.ts`; delete `cascade-stub.ts`.
- [x] Guard `orchestration/`'s cascade subscription behind `!settings.tasks?.enabled`.
- [x] Verify `agentTaskMap` invariant still passes (must be in exactly one file — `extensions/tasks/store.ts`).
- [x] Run `bash scripts/check-build.sh`, `bash scripts/check-invariants.sh`, `bash scripts/phase6-verify.sh`.

**Phase-local verify script (`scripts/phase6-verify.sh`)**

1. `rg -l "agentTaskMap" extensions/` returns exactly 1 path (`extensions/tasks/store.ts`).
2. `rg -n "agents:subagent_end" extensions/tasks/cascade.ts` ≥ 1 hit.
3. `rg -n "cascade-stub" extensions/` returns 0.
4. Smoke `bash scripts/smoke.sh tasks-cascade`: create a task with `agentType: explore` via `TaskCreate`, run via `TaskExecute`, wait for the spawned subagent's no-op completion, assert task is marked `completed` within 5s, assert any task added with `addBlockedBy: <thisTaskId>` becomes unblocked.
5. `bash scripts/check-build.sh` and `bash scripts/check-invariants.sh` return 0.

**Done when:** Cascade fires through the event bus with no cross-extension imports; smoke passes; agentTaskMap remains in exactly one file.

---

(Chunk 2 ends here.)

## Chunk 3: Phases 7–8 (cutover + acceptance)

## Phase 7 — Cutover: delete old, settings flip, frontmatter audit

**Depends on:** P3, P4, P6.

**Goal:** Atomically remove `extensions/modes.ts` and `extensions/orchestration/`, flip the tracked `settings.json` to the new extension list, rename `defaultAgent` → `defaultPrimaryAgent`, audit and update every `agents/*.md`, and inline any transitional cross-extension imports.

**Deliverables**

- Delete files:
  - `extensions/modes.ts`
  - `extensions/orchestration/` (entire directory)
- Inline previously-imported modules from `orchestration/` into `extensions/agents/`:
  - Move `agent-runner.ts`, `agent-manager.ts`, `process-tracker.ts`, `model-resolver.ts`, `output-file.ts`, `memory.ts`, `worktree.ts`, `prompts.ts`, `skill-loader.ts`, `env.ts`, `invocation-config.ts`, `group-join.ts`, `agent-display.ts`, `conversation-viewer.ts`, `default-agents.ts`, `settings-menu.ts`, `types.ts` into `extensions/agents/internal/` (keep filenames). Audit each: if a file is exclusively task-related (none currently are; verify), move to `extensions/tasks/internal/` instead.
  - Update imports in `extensions/agents/subagent-runner.ts` and others to point at `./internal/...` instead of `../orchestration/...`.
- Settings flip in tracked settings file (referenced in repo `AGENTS.md`):
  - Replace `+extensions/modes.ts` and `+extensions/orchestration/index.ts` with `+extensions/agents/index.ts` and `+extensions/tasks/index.ts`. Order: both new entries must appear BEFORE `+extensions/ui/index.ts` (UIBus producer-before-consumer rule).
  - Remove `agents.enabled` and `tasks.enabled` flags from the tracked settings file (no longer needed; new extensions are unconditionally on).
  - Rename any `defaultAgent` key to `defaultPrimaryAgent` in tracked settings.
- Frontmatter audit on every file in `agents/*.md` AND any `agents/` directories shipped in this repo:
  - For each file currently used as a primary mode → add `mode: primary` to the YAML frontmatter.
  - For each file currently used as a subagent only → add `mode: subagent` (REQUIRED — the new default is `all`, which would otherwise put these files into primary cycling).
  - For each file used both ways → `mode: all`.
  - For subagents missing a `description:` field, add one (required by the schema).
  - The current set is: `agents/autoresearch.md`, `agents/explore.md`, `agents/general-purpose.md`, `agents/plan.md` — all currently subagent-only, so each gets `mode: subagent` and a verified `description:`. (Confirm at task time by inspecting each file; classify any that declare `prompt_mode` or are referenced from primary cycling as `primary` or `all`.)
- Remove the transitional primary-cycling gate from `extensions/agents/loader.ts` (the gate was installed there in P2 mirroring the P1 gate in `modes.ts`). After P7's audit every agent declares `mode:` explicitly, so the parser's default-`all` is never consulted for in-repo files and the gate is no longer needed. The corresponding gate in `modes.ts` disappears with the file deletion.
- Update `scripts/check-invariants.sh`:
  - Add checks: `extensions/modes.ts gone`, `extensions/orchestration/ dir gone`.
  - Confirm `agents:subagent_end` is still in the allowed-events list.
- Update `AGENTS.md` (repo-level) to reflect the new file layout. Remove the bullet describing `orchestration/` and replace with bullets for `agents/` and `tasks/`.

**Tasks**

- [ ] Move/rename internal modules into `extensions/agents/internal/` (and `extensions/tasks/internal/` if any).
- [ ] Update all imports.
- [ ] Delete `extensions/modes.ts` and `extensions/orchestration/`.
- [ ] Frontmatter audit: edit each `agents/*.md` to declare `mode:` explicitly.
- [ ] Update tracked `settings.json` (extensions list + `defaultPrimaryAgent` rename + remove enabled flags).
- [ ] Remove the transitional primary-detection rule from `loader.ts`.
- [ ] Update `scripts/check-invariants.sh` with the two "gone" checks.
- [ ] Update `AGENTS.md` layout section.
- [ ] Run `bash scripts/check-build.sh`, `bash scripts/check-invariants.sh`, `bash scripts/phase7-verify.sh`.

**Phase-local verify script (`scripts/phase7-verify.sh`)**

1. `test ! -e extensions/modes.ts && test ! -d extensions/orchestration` → both gone.
2. `rg -l "from \"\\.\\./orchestration" extensions/` returns 0 (no stale imports).
3. `rg -wn 'defaultAgent' $(find . -name 'settings*.json' -not -path '*/node_modules/*') | rg -v defaultPrimaryAgent` returns 0 (rename complete; word-boundary match catches end-of-line and end-of-file occurrences).
4. For each `agents/*.md`: `rg -n "^mode:\\s*(primary|subagent|all)\\s*$" agents/<file>` returns ≥1 — fail with the file name if any are missing. For each file declaring `mode: subagent` OR `mode: all` (both are subagent-invocable per PRD), `rg -n "^description:" agents/<file>` returns ≥1.
5. `rg -n "agents.enabled|tasks.enabled" extensions/` returns 0 (transitional flags removed from code).
6. `bash scripts/check-build.sh` and `bash scripts/check-invariants.sh` return 0.

**Done when:** Old files deleted, new structure in place, all agent definitions explicitly declare `mode:`, build + invariants green.

---

## Phase 8 — Full smoke + acceptance against PRD's manual checklist

**Depends on:** P7.

**Goal:** Execute the PRD's manual smoke checklist (12 scenarios) as automated smoke scenarios; produce a single pass/fail report.

**Deliverables**

- `scripts/smoke.sh acceptance` — runs the twelve scenarios end-to-end against pi with the post-cutover settings:
  1. Switch primary agent via **Tab** AND via legacy `Ctrl+Shift+M`; assert `mode` slot updates for both.
  2. `/agent` and `/agents` route correctly (selector opens for both).
  3. Spawn subagent via `Agent` tool; assert `orchestration` + `subagentUsage` slots update; `get_subagent_result` returns the subagent's output; `steer_subagent` delivers a steering message.
  4. `@name` mention in three positions (leading, mid, trailing) and a multi-mention message; assert correct number of spawns and correct stripped prompt.
  5. `@path/to/file` is NOT a dispatch.
  6. `@unknownname` is NOT a dispatch.
  7. `@primaryOnlyAgent` is rejected with a visible error.
  8. `@hiddenSub` typed manually spawns; `@`-autocomplete list does NOT include `hiddenSub`.
  9. JSON-defined agent under settings.json `agent` map loads, appears in `/agent` selector (if primary or all), and overrides a same-named markdown agent. Override is verified for each mode: (a) define a `mode: primary` JSON agent shadowing a markdown one with a different `model` value and assert the active model after switching matches the JSON entry; (b) define a `mode: subagent` JSON agent shadowing a markdown one with a different `prompt`/`description` and spawn it via `@name` — assert the runner uses the JSON entry's prompt.
  10. `permission.task` deny on a specific subagent refuses both Agent-tool spawn and `@name` dispatch with a visible error.
  11. `TaskCreate(agentType=...)` → `TaskExecute` → cascade fires when subagent ends.
  12. Resume the session (kill + restart); assert primary selection, subagent list, and tasks all restored.
- `scripts/phase8-verify.sh` — wraps `scripts/smoke.sh acceptance` and asserts exit 0; also re-runs build + invariants for a final clean check.

**Tasks**

- [ ] Implement each smoke scenario in `scripts/smoke.sh acceptance` (extend the existing smoke runner; one bash function per scenario, all called from a single `case` arm).
- [ ] Run `bash scripts/phase8-verify.sh`. Must exit 0.
- [ ] Update PR description with the changelog note about the `defaultAgent` → `defaultPrimaryAgent` rename and the `mode:` default flip.

**Phase-local verify script (`scripts/phase8-verify.sh`)**

1. `bash scripts/smoke.sh acceptance` returns 0 (all 12 scenarios pass).
2. `bash scripts/check-build.sh` returns 0.
3. `bash scripts/check-invariants.sh` returns 0.

**Done when:** All three checks pass — the migration is complete and the PRD's verification section is satisfied.

---

(Chunk 3 ends here.)
