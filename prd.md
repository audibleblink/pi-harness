# PRD: Consolidate pi-harness extensions into UI + Orchestration

**Status:** Draft for execution
**Scope:** `pi-harness/extensions/` only
**Compat:** None. Old session entries from removed extensions are not migrated.

---

## 1. Problem

Eight extensions in `extensions/` cooperate informally and step on each other:

- `zentui.ts` hardcodes status keys owned by `modes.ts` (`agent-mode-banner`) and `pi-undo-redo.ts` (`@kmiyh/pi-undo-redo/status`). A rename in either silently breaks the footer.
- `pi-subagents` and `pi-tasks` each call `setWidget` / `setStatus` independently. Order is undefined; widgets race.
- `pi-subagents/agent-widget.ts` and `pi-tasks/ui/task-widget.ts` each spin their own `setInterval(80)` widget tickers.
- `pi-tasks` reaches into `pi-subagents` through three coordination channels at once: a `Symbol.for("pi-subagents:manager")` global singleton, a `pi.events`-based RPC layer (`cross-extension-rpc.ts`) with a hand-rolled protocol-version handshake, and event-name strings (`subagents:started`, `subagents:completed`, `subagents:failed`).
- The same data is modeled twice: `agentActivity` in pi-subagents, `activeTaskIds` in pi-tasks, and `agentTaskMap` exists on both sides.
- Widget keys, status keys, and event names are bare strings with no namespace; collisions are avoided only by convention.

The split between `pi-tasks` and `pi-subagents` exists for no benefit visible in the code — they were written together and only ship together in this harness.

## 2. Goal

Two structural moves, executed together:

1. **One UI owner.** A new `extensions/ui/` extension is the only place in the repo that calls `setStatus`, `setWidget`, `setFooter`, `setWorkingMessage`, `setWorkingIndicator`, or `setEditorComponent`. Other extensions publish typed-ish state to a UIBus that ui subscribes to.
2. **One orchestration owner.** `pi-subagents/` and `pi-tasks/` collapse into a single `extensions/orchestration/` extension. The cross-extension RPC, the global Symbol singleton, the protocol-version handshake, the duplicate `agentTaskMap`, and the dual widget tickers all disappear because they have no boundary to span.

`modes.ts` and `pi-undo-redo.ts` stay as separate extensions; they only change to publish via the UIBus instead of calling `setStatus` directly.

## 3. Non-goals

- No changes to pi core (`@mariozechner/pi-coding-agent`).
- No changes to `themes/`, `prompts/`, `agents/`, or top-level config.
- `ask-user-question.ts` and `vim-quit.ts` are not touched.
- `modes.ts` and `pi-undo-redo.ts` internals (state model, undo blob storage, mode lifecycle, etc.) are not refactored. Only the lines that publish to the TUI surface change.
- No test suite is added. The repo has no tests today; the user has accepted manual smoke verification.
- No backward compatibility with old session entries from `pi-subagents` or `pi-tasks`. Old sessions that contain those custom entry types may render the entry as unknown/raw or be ignored. Migration code is explicitly **not** written.

## 4. Architecture

### 4.1 Final extension layout

```
extensions/
  ui/                      # NEW. Sole TUI-chrome owner. Merges zentui.ts + working-messages.ts.
    index.ts               # Extension entry point.
    bus.ts                 # UIBus: thin typed wrappers over pi.events. Producer-facing helpers.
    footer.ts              # Footer composition (lifted from zentui.ts).
    editor.ts              # Custom editor component (lifted from zentui.ts).
    working.ts             # Working message + indicator (lifted from working-messages.ts).
    widget.ts              # The single combined orchestration widget (agents + tasks).
    ticker.ts              # Single 80ms ticker driving widget animation.
  orchestration/           # NEW. Merges pi-subagents/ + pi-tasks/. Flat layout.
    index.ts               # Extension entry point. Wires events, registers tools/commands.
    agent-manager.ts       # (lifted from pi-subagents)
    agent-runner.ts
    agent-types.ts
    custom-agents.ts
    default-agents.ts
    group-join.ts
    invocation-config.ts
    memory.ts
    model-resolver.ts
    output-file.ts
    prompts.ts
    skill-loader.ts
    worktree.ts
    context.ts
    env.ts
    types.ts
    conversation-viewer.ts  # (lifted from pi-subagents/ui/)
    agent-widget.ts         # DELETED. Replaced by extensions/ui/widget.ts.
    task-store.ts          # (lifted from pi-tasks)
    process-tracker.ts
    auto-clear.ts
    tasks-config.ts
    settings-menu.ts        # (lifted from pi-tasks/ui/)
    task-widget.ts          # DELETED. Replaced by extensions/ui/widget.ts.
  modes.ts                 # Unchanged except: setStatus(...) calls swapped for UIBus publishMode(...).
  pi-undo-redo.ts          # Unchanged except: setStatus(...) calls swapped for UIBus publishUndo(...).
  ask-user-question.ts     # Untouched.
  vim-quit.ts              # Untouched.

  # DELETED:
  zentui.ts
  working-messages.ts
  pi-subagents/
  pi-tasks/
```

### 4.2 UIBus contract

Per the user's choice: **open pub/sub** transport, **owned by `extensions/ui/`**, **carried over `pi.events`**.

- `extensions/ui/bus.ts` exports producer-side helpers that wrap `pi.events.emit`. Producers import these helpers and never touch `pi.events` directly:
  ```ts
  // illustrative — exact names finalized during implementation
  export function publishMode(state: ModeState | null): void;
  export function publishUndo(state: UndoState | null): void;
  export function publishOrchestration(state: OrchestrationState): void;
  export function publishWorking(state: WorkingState | null): void;
  ```
- The transport is a single `pi.events` topic, namespaced (e.g. `harness.ui:publish`) with a `{ slot: string, value: unknown }` envelope. Open pub/sub: any future producer can publish under any string slot.
- `extensions/ui/` is the **only subscriber**. It maintains an internal `Map<slot, value>` and re-renders footer/widget when any slot changes.
- `null`/`undefined` value clears the slot.
- Producers do not assume ui is loaded. If ui isn't subscribed, publishes are dropped silently — same semantics as today's `setStatus` when no consumer renders it.
- ui must tolerate stale slots after `/reload` by clearing its slot map on `session_start` with `reason: "reload"`.

### 4.3 Orchestration extension

- All in-process state lives in `extensions/orchestration/index.ts` and helper modules. **No** `Symbol.for` global, **no** RPC.
- Single `agentTaskMap` (was duplicated). Single `agentActivity` map (unchanged from pi-subagents side).
- `pi-tasks` was calling pi-subagents through `pi.events` RPC (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`). After merge these become **direct function calls** to the agent manager. The RPC handlers, the protocol-version handshake, and the `subagentsAvailable` feature flag are deleted.
- Lifecycle event names (`subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:created`, `subagents:steered`, `subagents:ready`) are no longer emitted on `pi.events`. Internal coordination is direct in-process calls. Anything externally observable (e.g. notifications shown to the user) goes through the UIBus or `ctx.ui.notify` as today.
- The two widget files (`agent-widget.ts`, `task-widget.ts`) are deleted. Orchestration computes a combined `OrchestrationState` (active agents with their per-agent metrics, active tasks, cascade hints, etc.) and publishes it via `publishOrchestration(state)`. `extensions/ui/widget.ts` renders it.
- The two 80ms tickers are deleted. `extensions/ui/ticker.ts` runs one ticker that drives the combined widget's animation when ui has live orchestration state.

### 4.4 modes.ts and pi-undo-redo.ts

Surgical change only:

- Replace each `ctx.ui.setStatus(KEY, text)` with the corresponding UIBus producer call (`publishMode(...)` / `publishUndo(...)`). Replace clearing calls (`setStatus(KEY, undefined)`) with publishing `null`.
- Remove the now-unused status-key constants.
- Everything else (state machines, custom message renderer in pi-undo-redo, undo blob storage, mode banner logic, pi.appendEntry calls) stays exactly as it is.

### 4.5 Working message / indicator

`working-messages.ts` is folded into `extensions/ui/working.ts`. ui calls `setWorkingMessage` / `setWorkingIndicator` directly (it owns chrome). The "pick a random working message" logic is preserved verbatim.

## 5. Deletion checklist (must all be true at the end)

- [ ] `extensions/pi-subagents/` directory does not exist.
- [ ] `extensions/pi-tasks/` directory does not exist.
- [ ] `extensions/zentui.ts` does not exist.
- [ ] `extensions/working-messages.ts` does not exist.
- [ ] `extensions/pi-subagents/cross-extension-rpc.ts` (and its concept) is gone — no RPC over `pi.events` between extensions.
- [ ] `Symbol.for("pi-subagents:manager")` is not referenced anywhere.
- [ ] `agentTaskMap` exists in exactly one place.
- [ ] `subagentsAvailable` feature-detection flag is gone.
- [ ] Protocol-version handshake / mismatch warning is gone.
- [ ] No code reads or writes pre-existing custom session entries from the deleted extensions (e.g. `subagents:*` customTypes from pi-subagents). Old sessions are not migrated.

## 6. Definition of done (verifiable invariants)

The implementing agent must verify each before declaring done:

1. **No TUI chrome calls outside `extensions/ui/`.** Grep across `extensions/` (excluding `extensions/ui/`) for `setStatus(`, `setWidget(`, `setFooter(`, `setWorkingMessage(`, `setWorkingIndicator(`, `setEditorComponent(`. Zero matches.
   - `ctx.ui.notify(...)`, `ctx.ui.confirm(...)`, `ctx.ui.select(...)`, `ctx.ui.input(...)`, `ctx.ui.editor(...)`, `ctx.ui.custom(...)`, `ctx.ui.setEditorText(...)`, `ctx.ui.setTitle(...)` are **allowed** outside ui — they are user-interaction helpers, not chrome ownership. (`setTitle` is borderline; if any extension besides ui calls it, leave it but note in the implementation plan.)
2. **No bare-string `subagents:*` event names** anywhere in the repo. Grep `subagents:` returns zero hits in `*.ts`.
3. **Exactly one widget animation ticker.** Grep for `setInterval(` in `extensions/` returns at most one match for the widget animation loop (in `extensions/ui/ticker.ts`). Other `setInterval` uses (cleanup intervals, debounce timers) are fine but should be reviewed and called out in the implementation plan.
4. **`extensions/pi-subagents/` and `extensions/pi-tasks/` directories are gone.** `ls extensions/` shows neither.
5. **Smoke scenarios pass** (manual, run by the user after implementation):
   - **S1 — Mode banner.** Switch to a non-default mode via the modes extension. Footer shows the mode banner. Switch back. Banner clears.
   - **S2 — Undo status.** Edit a file via the agent. Footer shows `↶N ↷M`. Trigger undo. Counters update.
   - **S3 — Spawn a subagent.** Use the agent tool that spawns a subagent. Combined widget shows the agent with live metrics. On completion, widget clears the agent (after the existing linger window).
   - **S4 — Task lifecycle.** Create a task, mark it in_progress, then completed. Combined widget reflects each transition.
   - **S5 — Task spawns agent (cascade).** A task whose agent type runs an agent: widget shows both the task and its agent simultaneously, linked. Completion of the agent updates the task per existing cascade rules.
   - **S6 — Working indicator.** During streaming, the working indicator and working message render exactly as before the refactor.
   - **S7 — Custom editor.** zentui's polished editor component is still active (was set via `setEditorComponent`).
   - **S8 — `/reload`.** Run `/reload`. ui resubscribes cleanly; orchestration resets in-memory state; no stale widget content remains.

## 7. Implementation constraints

- **Producer/consumer order independence.** ui may load before or after producers. Producers must not assume ui is subscribed. ui must initialize its slot map empty and accept publishes in any order.
- **No new npm dependencies.** The bus is a thin wrapper over `pi.events`.
- **TypeScript types are advisory but enforced.** Producer helpers are typed (`publishMode(state: ModeState | null)`); the on-the-wire envelope is open (`{ slot: string, value: unknown }`). ui validates shape narrowly per slot before rendering.
- **Preserve current visual output.** Footer composition, widget appearance, working message text pool, custom editor rendering — all visually identical to the pre-refactor state. This is a structural refactor, not a redesign.
- **Hot-reload (`/reload`) should keep working.** Not a hard blocker on done, but if a smoke test of `/reload` shows broken state (orphan widgets, dead subscriptions), the implementer must fix it before declaring done.
- **Cleanup on `session_shutdown`.** Both ui and orchestration register `session_shutdown` handlers that clear timers, subscriptions, and the UIBus slot map. Order between the two extensions is irrelevant after this refactor (no shared singletons).

## 8. Risks

| Risk | Mitigation |
|---|---|
| Visual regressions in the footer (zentui's composition is intricate). | Lift `footer.ts` from zentui as a near-verbatim copy; only swap input source from hardcoded status keys to UIBus slot map. |
| Subtle ordering bugs in orchestration after merging two event streams (was: pi-tasks listens to pi-subagents events). | Replace event listening with direct function calls. The merge eliminates the asynchrony, not just papers over it. |
| Old sessions containing pi-subagents/pi-tasks custom session entries throw on load. | The deleted extensions' `pi.appendEntry` customTypes are no longer registered. pi core ignores unknown customTypes — verify on first run with an old session. If pi core crashes on unknown customTypes (it doesn't, per docs), that is the user's choice per "don't care on compat". |
| `setInterval` audit (DoD #3) is fuzzy because cleanup intervals exist. | The implementation plan must list every remaining `setInterval` and what it drives, so the reviewer can confirm only one is for widget animation. |

## 9. Out-of-scope decisions deferred to implementation plan

- Exact UIBus slot names (`mode` vs `modes`, `undo` vs `undo-redo`, etc.).
- Exact module split inside `extensions/ui/` (the layout above is illustrative).
- Whether the combined widget shows agents-above-tasks or interleaved.
- Whether `OrchestrationState` is a single fat object or one publish per sub-slot. Default: single object, publish on any change.

These are tactical and the executing agent decides them when writing the plan or the code, with the constraint that they don't change the externally observable behavior captured in §6.
