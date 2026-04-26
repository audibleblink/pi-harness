# Execution Plan: Consolidate pi-harness extensions into UI + Orchestration

This plan executes the PRD in `prd.md`. The refactor is structural: collapse `zentui.ts` + `working-messages.ts` into a new `extensions/ui/`, collapse `pi-subagents/` + `pi-tasks/` into a new `extensions/orchestration/`, and route all TUI-chrome writes through a UIBus owned by `extensions/ui/`.

The repo has no automated test suite. Each phase therefore defines an **autonomous feedback loop** built from grep invariants, a TypeScript build check, and a scripted `pi` smoke run that exits non-zero if expected log markers are missing. Manual smoke scenarios from PRD §6 are the final gate, but each intermediate phase is self-checkable without a human in the loop.

## Conventions used by every phase

- **Build check.** `npx tsc --noEmit -p .` (or `pi --check` if a project script exposes it) must succeed. If no tsconfig exists yet at repo root, Phase 0 adds a minimal one scoped to `extensions/`.
- **Grep invariants.** A phase is not done until its listed `rg` commands return the expected count. Each phase encodes them as a shell script (`./scripts/check-phase-N.sh`) so the agent can run a single command to verify.
- **Smoke harness.** `./scripts/smoke.sh` (added in Phase 0) drives a real interactive `pi` session inside a `tmux` session. The harness:
  - Starts pi: `tmux new-session -d -s pi-smoke -x 200 -y 50 'cd $REPO && PI_HARNESS_DEBUG=1 pi 2>&1 | tee /tmp/pi-smoke.log'`.
  - Sends keystrokes via `tmux send-keys -t pi-smoke …` (text + `Enter`, slash commands, escape sequences).
  - Captures the scrollback via `tmux capture-pane -t pi-smoke -p -S -3000` for visual assertions.
  - Asserts on the tee'd log file `/tmp/pi-smoke.log` for deterministic `PI_DBG …` debug-marker lines.
  - Tears down with `tmux kill-session -t pi-smoke` on exit (trap).
  Producers and ui emit one-line debug markers behind `PI_HARNESS_DEBUG=1` so the smoke script can assert on them without screen-scraping ANSI. These markers are removed in the final phase.
- **Rollback unit.** Each phase commits as one git commit on a branch `refactor/ui-orchestration`. If a phase fails verification, revert the commit — earlier phases remain green.

---

## Phase 0 — Scaffolding & verification harness

**Depends on:** nothing.
**Leaves working:** repo unchanged behaviorally; `./scripts/check-*.sh` and `./scripts/smoke.sh` exist and pass against current code.

### Tasks

- [x] Add `tsconfig.json` at repo root if absent, covering `extensions/**/*.ts`, `noEmit: true`, `strict: true`, matching the style pi expects (peek at `node_modules/@mariozechner/pi-coding-agent` for ambient types if needed).
- [x] Add `scripts/check-build.sh`: runs `npx tsc --noEmit -p .` and exits non-zero on error.
- [x] Add `scripts/check-invariants.sh`: contains all final DoD greps from PRD §6 wrapped as `rg` calls with expected counts. In Phase 0 it is allowed to **fail** (we record a baseline). Each later phase tightens one invariant.
- [x] Add `scripts/smoke.sh`: launches `pi` with `PI_HARNESS_DEBUG=1` against a throwaway session dir, drives it through scenarios S1–S8 from PRD §6 using a `.expect`/heredoc-style script, captures stdout+stderr, and greps for required markers. In Phase 0 it asserts only the **current** behavior (mode banner, undo status, working indicator, custom editor). New markers are added as later phases land.
- [x] Add a `harness:debug` event helper that `console.error`s `PI_DBG slot=… kind=…` lines when `PI_HARNESS_DEBUG=1`. Place it in `extensions/_debug.ts` (deleted in the final phase). Wire it into `zentui.ts`, `modes.ts`, `pi-undo-redo.ts`, `working-messages.ts`, `pi-subagents/ui/agent-widget.ts`, `pi-tasks/ui/task-widget.ts` — one-line emission per render so smoke can assert.
- [x] Commit. Tag baseline: `git tag refactor-baseline`.

### Done when

- [x] `bash scripts/check-build.sh` exits 0.
- [x] `bash scripts/smoke.sh` exits 0 against the **current** unrefactored code (S1, S2, S6, S7 markers detected).
- [x] `bash scripts/check-invariants.sh` runs and prints a baseline report (does not need to pass yet — used as before/after diff).

---

## Phase 1 — Introduce UIBus + `extensions/ui/` shell, no producers migrated yet

**Depends on:** Phase 0.
**Leaves working:** `zentui.ts` and `working-messages.ts` still own chrome. New `extensions/ui/` exists, subscribes to a UIBus topic, but renders nothing yet (no slots are populated). Behavior is identical to Phase 0.

### Tasks

- [x] Create `extensions/ui/bus.ts`. Defines the envelope `{ slot: string; value: unknown }`, the topic name `harness.ui:publish`, and typed producer helpers: `publishMode`, `publishUndo`, `publishOrchestration`, `publishWorking`. Each helper is a one-liner that calls `pi.events.emit(TOPIC, { slot, value })`. Importing `bus.ts` does **not** require ui to be loaded; emission is fire-and-forget.
- [x] Create `extensions/ui/index.ts`. Registers as a pi extension. On activate: subscribes to `harness.ui:publish`, maintains `slots: Map<string, unknown>`, on each publish stores or deletes (when value is `null`/`undefined`), then triggers a debounced re-render hook (initially a no-op that just logs `PI_DBG ui:slot-changed slot=…`). On `session_start` with `reason: "reload"`: clears slots. On `session_shutdown`: unsubscribes.
- [x] Decide slot names (PRD §9 deferred): `mode`, `undo`, `orchestration`, `working`. Document them in `extensions/ui/bus.ts` as a const map.
- [x] Register `extensions/ui/` in whatever pi extension manifest the harness uses (check `extensions/index` or pi config). Do **not** delete `zentui.ts` / `working-messages.ts` yet.
- [x] Add new smoke marker: when ui receives a publish, it logs `PI_DBG ui:received slot=…`. This is what later phases will assert on.

### Verification (autonomous)

- [x] `bash scripts/check-build.sh` passes.
- [x] `bash scripts/smoke.sh` still asserts S1, S2, S6, S7 markers from the **old** path (they haven't moved yet).
- [x] New assertion: a unit-style probe inside `smoke.sh` calls `publishMode({label:"X"})` from a one-shot extension hook and greps for `PI_DBG ui:received slot=mode`. If absent, smoke fails.
- [x] `rg -n "harness.ui:publish" extensions/` shows the topic only in `extensions/ui/bus.ts` and `extensions/ui/index.ts`.

---

## Phase 2 — Migrate `modes.ts` and `pi-undo-redo.ts` to UIBus

**Depends on:** Phase 1.
**Leaves working:** Mode banner and undo status text still display in the footer **via the old zentui code path**, because zentui still reads `extStatuses`. We dual-publish: producers call **both** `setStatus(...)` (existing) **and** `publishMode/publishUndo(...)` (new). This keeps the footer working while we cut over.

> Why dual-publish: it lets us prove the bus delivers correct content for these slots before we rewrite the footer. The duplication is removed in Phase 4.

### Tasks

- [x] In `extensions/modes.ts`, around lines 349–356: keep the existing `ctx.ui.setStatus(AGENT_BANNER_WIDGET, …)` calls, **and** add `publishMode({ label, model })` (or `publishMode(null)` for the clear case). Import from `./ui/bus.ts`.
- [x] In `extensions/pi-undo-redo.ts` lines 342 and 958: same pattern — add `publishUndo(state)` / `publishUndo(null)` next to the existing `setStatus` calls. The exact `UndoState` shape mirrors what `STATUS_WIDGET_ID` text encodes (counters, icon hints) so ui can re-render identical text in Phase 4.
- [x] Both files: do **not** remove `setStatus` yet, do **not** remove the `STATUS_WIDGET_ID` / `AGENT_BANNER_WIDGET` constants. That happens in Phase 4.

### Verification

- [x] `bash scripts/check-build.sh` passes.
- [x] `bash scripts/smoke.sh`: scenarios S1 and S2 still pass via the old footer. **Additionally** assert that `PI_DBG ui:received slot=mode` and `PI_DBG ui:received slot=undo` appear during S1/S2. If they don't, Phase 2 is incomplete.
- [x] `rg -n "publishMode|publishUndo" extensions/` shows hits in exactly `modes.ts`, `pi-undo-redo.ts`, and `extensions/ui/bus.ts`.

---

## Phase 3 — Lift footer + editor + working from `zentui.ts` / `working-messages.ts` into `extensions/ui/`

**Depends on:** Phase 2.
**Leaves working:** `extensions/ui/` now renders the footer and owns `setEditorComponent` + working message/indicator. `zentui.ts` and `working-messages.ts` are reduced to **stubs** that no-op (still registered, but their old chrome calls are commented out / removed). Mode + undo render through the new path. Subagent/task widgets still come from the old `pi-subagents/ui/agent-widget.ts` and `pi-tasks/ui/task-widget.ts` — those move in Phase 5.

### Tasks

- [x] Create `extensions/ui/footer.ts`. Lift the `setFooter(...)` body from `zentui.ts` lines ~824–900 verbatim, then replace its input source: instead of reading `extStatuses` keyed on `AGENT_STATUS_KEY` / `UNDO_STATUS_KEY`, read from ui's `slots` map (`slots.get("mode")`, `slots.get("undo")`). For "extra" status texts that aren't mode/undo, keep them flowing from the existing `extStatuses` channel for now — those are residual `setStatus` callers that will disappear once orchestration also migrates.
- [x] Create `extensions/ui/editor.ts`. Lift `editorFactory` and the `setEditorComponent` registration from `zentui.ts` lines ~920–930. ui calls `setEditorComponent(editorFactory)` on activate.
- [x] Create `extensions/ui/working.ts`. Lift the entire body of `working-messages.ts` (132 lines) verbatim. ui calls `setWorkingMessage` / `setWorkingIndicator` from inside ui, which is allowed because ui owns chrome. Preserve the message pool and the random pick logic exactly.
- [x] Reduce `extensions/zentui.ts`: delete `setFooter` block, the editor factory, and the two hardcoded status-key constants (`AGENT_STATUS_KEY`, `UNDO_STATUS_KEY`). What remains of `zentui.ts` should be either (a) zero non-trivial code (file deleted), or (b) any keymap/theme-only logic that wasn't chrome. Inspect the file end-to-end and decide. Per PRD §4.1 the file should be deleted entirely — confirm nothing else is hiding in there.
- [x] Reduce `extensions/working-messages.ts`: delete the file. Unregister it from the extension manifest.
- [x] Remove the dual-publish from Phase 2: in `modes.ts` and `pi-undo-redo.ts`, delete the `setStatus(...)` lines and the now-unused status-key constants. **Only** the `publishMode/publishUndo` calls remain.

### Verification

- [x] `bash scripts/check-build.sh` passes.
- [x] `rg -n "setFooter\(|setEditorComponent\(|setWorkingMessage\(|setWorkingIndicator\(" extensions/` returns hits **only** under `extensions/ui/`. Encode in `check-invariants.sh`.
- [x] `rg -n "setStatus\(" extensions/` still has hits — but only from `pi-subagents/` / `pi-tasks/` (those migrate in Phase 5). Document the remaining count; it must monotonically decrease.
- [x] `ls extensions/zentui.ts extensions/working-messages.ts 2>/dev/null` returns empty.
- [x] `bash scripts/smoke.sh`: S1, S2, S6, S7 all pass through the new ui code path (assert `PI_DBG ui:rendered-footer`, `PI_DBG ui:editor-installed`, `PI_DBG ui:working-tick` markers).

---

## Phase 4 — Merge `pi-subagents/` + `pi-tasks/` into `extensions/orchestration/` (no widget yet)

**Depends on:** Phase 3.
**Leaves working:** Subagents spawn, tasks run, lifecycle hooks fire — all from the merged extension. The combined widget still does **not** render through ui yet; widgets are temporarily disabled (or rendered via a stub publish to `slots.orchestration` that ui only logs). The combined widget UI is Phase 5.

> This phase is the largest. It is intentionally split from Phase 5 because the merge itself (deleting RPC, deleting Symbol.for, unifying maps) is a self-contained correctness change. Visual parity for the widget is added on top in Phase 5.

### Tasks (collapse pi-subagents → orchestration)

- [x] Create `extensions/orchestration/` directory.
- [x] Move every file from `extensions/pi-subagents/` (except `cross-extension-rpc.ts`, `ui/agent-widget.ts`) into `extensions/orchestration/` flat layout per PRD §4.1. Move `ui/conversation-viewer.ts` to `extensions/orchestration/conversation-viewer.ts`.
- [x] Delete `extensions/pi-subagents/cross-extension-rpc.ts`.
- [x] In `extensions/orchestration/index.ts` (was `pi-subagents/index.ts`), delete:
  - The `Symbol.for("pi-subagents:manager")` block (around line 409–435).
  - All `pi.events.emit("subagents:…")` calls (started/completed/failed/created/steered/ready). Their consumers move into the same module; they become direct method calls on `agentManager`.
  - The `subagentsAvailable` flag and the protocol-version handshake.
- [x] Keep `agentManager.cleanupInterval` (line 77) — it is not the widget ticker, it's a 60s GC sweep. Note it in the `setInterval` audit (DoD #3).

### Tasks (collapse pi-tasks → orchestration)

- [x] Move every file from `extensions/pi-tasks/` (except `ui/task-widget.ts`) into `extensions/orchestration/`. Move `ui/settings-menu.ts` to `extensions/orchestration/settings-menu.ts`.
- [x] In what was `pi-tasks/index.ts`:
  - Delete `rpcCall`, `checkSubagentsVersion`, the `subagents:rpc:*` emits/listens (lines 120, 126, 138, 156, 160).
  - Replace the `pi.events.on("subagents:completed" | "subagents:failed", …)` handlers with **direct callbacks** registered on the agent manager. The agent manager exposes `onAgentCompleted(cb)` / `onAgentFailed(cb)` (already exists internally — wire to it).
  - Delete the inner `unsubOk`/`unsubFail` event subscriptions inside the spawn helper (lines 752–755). Replace with a promise that resolves from the manager's direct completion callback for that agent id.
- [x] Unify state: there is now **one** `agentTaskMap` in `orchestration/index.ts`. Delete the duplicate that was on the pi-tasks side.

### Tasks (orchestration index wiring)

- [x] In `extensions/orchestration/index.ts`, the `activate` hook:
  - Constructs `AgentManager`, `TaskStore`, `ProcessTracker` directly.
  - Registers task tools (was `pi-tasks/index.ts`) and agent tools (was `pi-subagents/index.ts`) — all in one extension's tool list.
  - Registers `session_shutdown` to clear `cleanupInterval`, the spinner interval (line 915), the stop poll loop, and any TaskStore timers.
- [x] Add a single `publishOrchestration(buildState())` call wherever state changes (agent created/updated/completed, task created/updated/completed, cascade link added/removed). Bracket the publish behind a tiny dirty-flag debouncer (microtask) so a single user action doesn't fan out 10 publishes.
- [x] In Phase 4 the publish is purely diagnostic: ui will log `PI_DBG ui:received slot=orchestration agents=N tasks=M` but render nothing.
- [x] Delete `extensions/pi-subagents/` and `extensions/pi-tasks/` directories.
- [x] Remove the old extension entries from the harness manifest; add `extensions/orchestration/`.

### Verification

- [x] `bash scripts/check-build.sh` passes.
- [x] `rg -n "Symbol\.for\(\"pi-subagents:" extensions/` → 0 hits.
- [x] `rg -n "subagents:" extensions/ -g '*.ts'` → 0 hits.
- [x] `rg -n "cross-extension-rpc|rpcCall|subagentsAvailable" extensions/` → 0 hits.
- [x] `ls extensions/pi-subagents extensions/pi-tasks 2>/dev/null` → empty.
- [x] `rg -n "agentTaskMap" extensions/` → hits in **one** file only (`extensions/orchestration/index.ts` or its dedicated state module).
- [x] `bash scripts/smoke.sh` runs S3, S4, S5 with widgets disabled and asserts only that lifecycle markers fire (`PI_DBG orch:agent-created`, `PI_DBG orch:agent-completed`, `PI_DBG orch:task-transition`, `PI_DBG ui:received slot=orchestration`). No visual widget yet — that's Phase 5. S1, S2, S6, S7 still pass.

---

## Phase 5 — Combined widget + single ticker in `extensions/ui/`

**Depends on:** Phase 4.
**Leaves working:** The combined widget renders agents and tasks together, animated by a single 80ms ticker, fed only by the `orchestration` slot. `agent-widget.ts` and `task-widget.ts` are deleted.

### Tasks

- [x] Create `extensions/ui/widget.ts`. It is the consumer of `slots.orchestration`. Its render output is whatever `OrchestrationState` describes: list of active agents (with per-agent metrics: status, elapsed, current activity, model badge), list of active tasks (with status, owner, cascade link to agent if any), and any cascade hint lines. Visual layout: agents-above-tasks (PRD §9 default), grouped by cascade link.
- [x] Lift the rendering helpers (color/badge/elapsed-formatter/spinner-frame logic) from `pi-subagents/ui/agent-widget.ts` and `pi-tasks/ui/task-widget.ts` into `extensions/ui/widget.ts`. Where they overlap, dedupe — preserving exact visual output.
- [x] Create `extensions/ui/ticker.ts`. Single `setInterval(80)`. Only runs when `slots.orchestration` has at least one active agent or task with an animated state (spinner/elapsed). Auto-stops when the slot is empty/idle. On each tick: triggers a `setWidget(...)` call from inside ui with the re-rendered widget body.
- [x] In `extensions/orchestration/`, define `OrchestrationState` shape (single fat object per PRD §9 default). Build it from `agentActivity`, `agentTaskMap`, `taskStore.list()`, and any cascade metadata. Ensure shape is stable enough that ui can render without backchannel queries.
- [x] Delete `extensions/pi-subagents/ui/agent-widget.ts` (already gone after Phase 4 directory removal — verify) and `extensions/pi-tasks/ui/task-widget.ts` (same).
- [x] Confirm: the only `setInterval(...)` for animation is in `extensions/ui/ticker.ts`. Other survivors (agent manager 60s GC, any task auto-clear timer) are documented in `setInterval` audit comments.

### Verification

- [x] `bash scripts/check-build.sh` passes.
- [x] `rg -n "setInterval\(" extensions/` → audit each match. Expected: one in `extensions/ui/ticker.ts` (the animation ticker), one in `extensions/orchestration/agent-manager.ts` (60s cleanup), possibly one in `extensions/orchestration/auto-clear.ts` and the orch `index.ts` spinner. Each non-animation interval gets a comment `// non-animation: <purpose>`. Encode the count + locations in `check-invariants.sh`.
- [x] `rg -n "setWidget\(" extensions/` → hits only inside `extensions/ui/`.
- [x] `bash scripts/smoke.sh`: S3, S4, S5 now assert visual widget output (markers `PI_DBG ui:widget-rendered agents=N tasks=M`). Compare against pre-refactor baseline (captured in Phase 0): same agent count, same task count, same cascade linkage at equivalent timestamps.

---

## Phase 6 — Final invariants, debug-marker cleanup, manual smoke gate

**Depends on:** Phase 5.
**Leaves working:** Production-ready refactor. All PRD §6 invariants pass. Debug markers removed.

### Tasks

- [x] Remove `extensions/_debug.ts` and every `PI_DBG …` log call across the codebase. They served the autonomous feedback loop in Phases 1–5; production code does not need them.
- [x] Re-run `scripts/check-invariants.sh` with all PRD §6 greps as **hard fails**:
  - [x] `rg -nF "setStatus(" extensions/ -g '!extensions/ui/**'` → 0
  - [x] `rg -nF "setWidget(" extensions/ -g '!extensions/ui/**'` → 0
  - [x] `rg -nF "setFooter(" extensions/ -g '!extensions/ui/**'` → 0
  - [x] `rg -nF "setWorkingMessage(" extensions/ -g '!extensions/ui/**'` → 0
  - [x] `rg -nF "setWorkingIndicator(" extensions/ -g '!extensions/ui/**'` → 0
  - [x] `rg -nF "setEditorComponent(" extensions/ -g '!extensions/ui/**'` → 0
  - [x] `rg -n "subagents:" extensions/ -g '*.ts'` → 0
  - [x] `rg -n "Symbol\.for\(\"pi-subagents:" extensions/` → 0
  - [x] `rg -n "agentTaskMap" extensions/` → matches in exactly one file.
  - [x] `ls extensions/{pi-subagents,pi-tasks,zentui.ts,working-messages.ts} 2>/dev/null` → empty.
- [x] `setTitle` audit per PRD §6 note: `rg -n "setTitle\(" extensions/`. If hits exist outside `extensions/ui/`, document them in `extensions/ui/README.md` (allowed but noted), do not move them.
- [x] Verify `/reload` cleanup: smoke script triggers `/reload`, then re-runs S1+S3, asserts no orphan widget content from before reload (use a marker `PI_DBG ui:slots-cleared reason=reload` … wait — debug markers are removed in this phase. So this check moves earlier: keep the reload check in Phase 5's smoke and **only** remove markers after `/reload` is verified. Adjust task order if needed.)
- [x] Verify session entry compatibility per PRD §5 last bullet: open a saved session that contains old `subagents:record` customTypes; confirm pi core ignores unknown customTypes and does not crash. If it does crash, that's a pi-core issue (out of scope per PRD §3) — document and stop.
- [x] Hand off to user for manual run of S1–S8 from PRD §6.

### Done when

- [x] `bash scripts/check-build.sh` exits 0.
- [x] `bash scripts/check-invariants.sh` exits 0 with **all** PRD §6 greps as hard checks.
- [x] Manual smoke: user confirms S1–S8 all pass (this is the final acceptance per PRD).
- [x] Branch `refactor/ui-orchestration` is rebased clean and ready to merge.

---

## Phase dependency graph

```
0 ── 1 ── 2 ── 3 ── 4 ── 5 ── 6
```

Strictly linear. Each phase is committed and revertible. Phases 1, 2, 4 are the structurally interesting ones; Phases 3, 5 are mostly file moves with verbatim lifts; Phase 0 is harness; Phase 6 is cleanup + acceptance.

## Open tactical decisions resolved here (PRD §9)

- **Slot names:** `mode`, `undo`, `orchestration`, `working`. Documented in `extensions/ui/bus.ts`.
- **`extensions/ui/` layout:** matches PRD §4.1 illustrative layout exactly: `index.ts`, `bus.ts`, `footer.ts`, `editor.ts`, `working.ts`, `widget.ts`, `ticker.ts`.
- **Combined widget order:** agents-above-tasks, with cascade-linked task+agent grouped under one header.
- **`OrchestrationState` shape:** single fat object, published on any change with microtask debounce.

## Risks specific to this plan (in addition to PRD §8)

- **tmux-driven smoke is timing-sensitive.** Keystrokes can race pi's startup or model latency. Mitigations: (a) assertions target `PI_DBG …` markers in the tee'd log file, not screen state — markers are deterministic; (b) smoke script polls the log file with a bounded retry (`for i in {1..50}; do grep -q MARKER /tmp/pi-smoke.log && break; sleep 0.2; done`) instead of fixed sleeps; (c) tmux sessions are torn down via `trap` so a failed assertion never leaks a running pi.
- **Phase 4 is large.** If it cannot land in one commit, split into 4a (move files, no behavior change) and 4b (delete RPC + Symbol + unify maps). Both halves verifiable independently via the same grep checks.
