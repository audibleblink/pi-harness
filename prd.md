# PRD: Surface subagent token & cost usage in the UI

**Status:** Draft for execution
**Scope:** `pi-harness/extensions/ui/` and `pi-harness/extensions/orchestration/` only
**Compat:** None required. No persisted state, no session-format changes, no public API.

---

## 1. Problem

The footer's usage widget (`extensions/ui/footer.ts`) shows token totals (`↑in ↓out`) and dollar cost (`$cost`) for the **parent session only**. It walks `ctx.sessionManager.getBranch()` and sums `assistant.usage.{input,output,cost.total}` over parent assistant messages.

Subagents spawned via the `Agent` tool (and via `TaskExecute`) run their own `AgentSession` instances. Each carries real token consumption and real dollar cost — surfaced internally via `record.session.getSessionStats()` (returns `tokens.{input,output,cacheRead,cacheWrite,total}` and `cost`). These numbers are visible in completion notifications but **never reach the footer**, so the user has no live view of total session burn when subagents are active. With up to 4 background subagents running concurrently (`DEFAULT_MAX_CONCURRENT = 4` in `agent-manager.ts`), real-world spend can be many times the footer's number.

Additionally, once a subagent finishes its `AgentRecord` is kept for ~10 minutes (`cleanup()` in `AgentManager`) but its session is disposed almost immediately on completion in some paths, and the record itself does not persist `tokens`/`cost`. So even retroactive accounting is fragile.

## 2. Goal

The footer's `$cost` and `↑in ↓out` totals reflect **parent + all subagents (running and completed-this-session) combined**, in real time. The orchestration widget gains a single compact aggregate line `⊕ agents: <tokens> $<cost>` summarizing all active and completed-this-session subagents. No per-agent cost is shown on individual agent rows.

This is achieved through a new UIBus slot — orchestration is the producer (it owns subagent state), the footer and widget are consumers. No direct cross-extension imports.

## 3. Non-goals

- No changes to pi core (`@mariozechner/pi-coding-agent`).
- No changes to `modes.ts`, `pi-undo-redo.ts`, `ask-user-question.ts`, `vim-quit.ts`.
- No new persisted files. Subagent totals are in-memory and reset on `session_start` (matches existing orchestration behavior — `clearCompleted()` is called on session start).
- No changes to existing completion notifications, the `AgentManager` API, the `AgentRecord` shape beyond two added fields, or the `Agent`/`get_subagent_result`/`steer_subagent`/`TaskExecute` tool surfaces.
- No per-agent cost display on individual agent rows in the widget. (Considered and rejected — see §10 Alternatives.)
- No tooltips, no hover states, no expand/collapse interactions. The TUI doesn't have them.
- No tests. The repo has no test suite; verification is manual smoke + `bash scripts/check-build.sh` + `bash scripts/check-invariants.sh`.

## 4. Architecture

### 4.1 New UIBus slot

A new slot is added to `extensions/ui/bus.ts`:

```ts
export const SLOT_SUBAGENT_USAGE = "subagentUsage";

export interface SubagentUsageState {
  /** Sum of tokens.total across all running + completed-this-session subagents. */
  tokens: number;
  /** Sum of cost across all running + completed-this-session subagents. */
  cost: number;
  /** Count of running subagents (not including completed). Used for aggregate line text. */
  runningCount: number;
}

export function publishSubagentUsage(pi: ExtensionAPI, state: SubagentUsageState | null): void { ... }
```

The envelope is the existing `{ slot, value }` shape on topic `harness.ui:publish`. `null` means "no subagent activity this session" — consumers should treat null/absent identically to `{tokens:0,cost:0,runningCount:0}`.

Slot listing in `AGENTS.md` is updated: `mode`, `undo`, `orchestration`, `working`, **`subagentUsage`**.

### 4.2 Producer: `extensions/orchestration/`

Orchestration owns the new slot. Two sources contribute to the totals:

1. **Live running agents.** For each `record` in `manager.listAgents()` with `status` ∈ {`running`, `queued`}, read `record.session?.getSessionStats()` (already wrapped by `safeTotalTokens` — extend pattern with a `safeTotalCost` and a combined `safeUsage` helper). Queued agents have no session yet → contribute 0/0.
2. **Completed-this-session agents.** Two new fields are added to `AgentRecord` (`extensions/orchestration/types.ts`):

   ```ts
   /** Final token total stashed at completion before session disposal. */
   finalTokens?: number;
   /** Final cost stashed at completion before session disposal. */
   finalCost?: number;
   ```

   These are populated in `AgentManager.startAgent()` inside both the `.then(...)` and `.catch(...)` branches, **before** any session disposal path. The values come from `session.getSessionStats()`. Once stashed they are immutable.

   Completed totals are summed across **all** records in `manager.listAgents()` whose `status` is *not* in {`running`, `queued`} and which have `finalTokens`/`finalCost` populated. Records aged out by `cleanup()` (10-minute window) are removed from the map and therefore drop out of the sum — accepted; the alternative (a separate accumulator) is more state and the user accepted "session-scoped, reset on session_start" semantics.

   **However:** to ensure `cleanup()` does not drop totals during an active session, a separate session-scoped accumulator `completedSubagentTotals: { tokens: number; cost: number }` is maintained on the orchestration extension instance. Each completion adds to it; it is reset to `{0, 0}` on `session_start`, mirroring `manager.clearCompleted()`. This avoids relying on records that may be evicted.

   **Final rule:** the published totals = `completedSubagentTotals` + sum over `running`/`queued` records' live `getSessionStats()`.

A new helper `buildSubagentUsageState(): SubagentUsageState | null` is added next to `buildOrchestrationState()`. It returns `null` only if `completedSubagentTotals` is `{0,0}` AND there are zero running/queued agents (i.e. the session has had no subagent activity at all).

A new debounced publisher `scheduleSubagentUsagePublish()` is added, mirroring `scheduleOrchestrationPublish()` (50 ms debounce). It is called from the same call sites as `scheduleOrchestrationPublish()` — every spawn, completion, abort, tool activity tick, turn end, and `session_start`. The two publishers may share a single timer; implementation decides.

### 4.3 Consumer: footer (`extensions/ui/footer.ts`)

The setup function `setupFooter(ctx, slots)` already receives the `slots` map (used for `SLOT_UNDO`). It will additionally read `slots.get(SLOT_SUBAGENT_USAGE)` on each render.

`getUsageTotals(ctx)` is renamed to `getParentUsageTotals(ctx)` (internal). A new `getCombinedUsageTotals(ctx, sub)` returns:

```ts
{
  parent: { input, output, cost },
  combined: {
    input:  parent.input,                        // tokens shown in footer remain parent-only for ↑↓
    output: parent.output,                       // (see §5 Display rules)
    cost:   parent.cost + (sub?.cost ?? 0),
  },
  subTokens: sub?.tokens ?? 0,
  subCost:   sub?.cost ?? 0,
}
```

The `costLabel` rendered in the footer becomes `Σ$0.245` (Greek capital sigma prefix) **whenever** `subCost > 0`. Otherwise it stays `$0.245` (no sigma) — i.e. when no subagents have run, the footer is visually identical to today.

The token label `↑in ↓out` stays parent-only. Rationale: combining input/output across parent + subagents is misleading (subagent input ≠ parent input — they have different system prompts and contexts), and the dollar figure is the actionable number. This is a deliberate scoping choice; documented in §5.

### 4.4 Consumer: widget (`extensions/ui/widget.ts`)

`renderWidget(state, frame)` gets a second optional argument — the `SubagentUsageState` from the UIBus slots map. The widget owner (`extensions/ui/index.ts` or wherever `renderWidget` is invoked) passes it through.

When the state is non-null AND `cost > 0`, an extra line is appended at the bottom of the widget:

```
⊕ agents: 16.3k $0.05
```

Format details:
- `⊕` is dimmed.
- The label `agents:` is dimmed.
- Tokens are formatted via the existing `formatCount` helper from `footer.ts` (export it, or reimplement — implementation decides).
- Cost is formatted as `$X.XXX` (3 decimals, matching footer convention).
- No `(N running)` suffix. Live agent rows already show running agents individually with spinners; the count would be redundant. (Re-add later if user wants.)

When `cost === 0` the line is omitted entirely (free-model rule, §5.3). When the state is `null` the line is omitted. When `cost > 0` but there are zero running agents and only completed-this-session totals, the line is still shown — that's the user's running session-spend on subagents.

### 4.5 No other surfaces touched

- `WorkingState`, `ModeState`, `UndoState`, `OrchestrationState` — unchanged.
- The "Other ext statuses" 2nd footer line — unchanged.
- The orchestration widget's per-agent rows — unchanged.
- Completion notification XML and `<task-notification>` text — unchanged. Subagent tokens already appear there.

## 5. Display rules

### 5.1 Sigma prefix on footer cost
- `subCost > 0` → render `Σ$0.245` (sigma is dimmed muted; cost color unchanged).
- `subCost === 0` → render `$0.245` (current behavior).
- The sigma is the **only** visual cue that the cost is summed. No tooltips exist in the TUI.

### 5.2 Aggregate line in widget
- Shown only when `cost > 0`.
- Always at the bottom of the widget (after orphan tasks).
- Rendered as a single dim line, no leading spinner.

### 5.3 Free-model rule (Q3 = `aggregate_zero`)
- The aggregate line is hidden when **total** subagent cost across all running + completed-this-session is `0`.
- Per-agent rows do not show cost at all (Option C scope), so no per-row free-model check is needed.
- Tokens accumulate normally for free models — they're real consumption — but the aggregate line is gated on cost, not tokens. If a session runs only on Ollama, the aggregate line never appears even though tokens climb. Accepted: if cost is 0 the user does not need a line about it.

### 5.4 Persistence (Q4 = `memory_session`)
- `completedSubagentTotals` is in-memory only.
- Reset on `session_start` (same hook that calls `manager.clearCompleted()`).
- Lost on pi restart.
- Not written to `.pi/`.

## 6. Implementation contract

### 6.1 Files modified

```
extensions/ui/bus.ts           +SLOT_SUBAGENT_USAGE, +SubagentUsageState, +publishSubagentUsage
extensions/ui/footer.ts        consume slot; rename getUsageTotals → getParentUsageTotals; add Σ prefix logic
extensions/ui/widget.ts        renderWidget(state, frame, sub?) — append aggregate line; export or import formatCount
extensions/ui/index.ts         pass SLOT_SUBAGENT_USAGE value into renderWidget calls
extensions/orchestration/types.ts        +finalTokens, +finalCost on AgentRecord
extensions/orchestration/agent-manager.ts  stash final stats in .then/.catch before any disposal
extensions/orchestration/index.ts          +completedSubagentTotals, +buildSubagentUsageState, +scheduleSubagentUsagePublish, reset on session_start, call publish at all existing scheduleOrchestrationPublish sites
AGENTS.md                       update slot list to include subagentUsage
```

No other files in the repo are touched.

### 6.2 Invariants to preserve

- TUI chrome calls (`setStatus`, `setWidget`, `setFooter`, `setWorkingMessage`, `setWorkingIndicator`, `setEditorComponent`) remain only inside `extensions/ui/`. New code in orchestration must not call them. (`bash scripts/check-invariants.sh` enforces this.)
- All cross-extension state moves through the UIBus envelope `{ slot, value }` on topic `harness.ui:publish`. Orchestration never imports footer/widget directly.
- `bash scripts/check-build.sh` passes (TypeScript strict, no emit).

### 6.3 New tech / dependencies

**None.** Everything uses existing primitives: `pi.events.emit`, the `slots` map already wired in `extensions/ui/index.ts`, the existing 50 ms debounce pattern, `session.getSessionStats()` already in pi-coding-agent's public API.

## 7. Edge cases

| Case | Behavior |
|---|---|
| Subagent crashes before session created (queued → error) | `finalTokens`/`finalCost` remain `undefined`; not added to `completedSubagentTotals`. Live sum sees status≠running, contributes 0. Net: 0 contribution, correct. |
| Subagent aborted via `manager.abort()` | `.catch` branch stashes `getSessionStats()` if `record.session` exists, else 0/0. |
| Subagent runs on a free model (cost = 0) | Tokens accumulate; cost stays 0. Aggregate line hidden (5.3). Footer shows `$0.000` without sigma. |
| Worktree cleanup runs after agent | Stats stashed before `cleanupWorktree` call → unaffected. |
| Resume of a completed agent (`AgentManager.resume`) | Resume reuses the existing session; on completion the new totals overwrite the old ones. To avoid double-counting, on resume start: subtract the existing `finalTokens`/`finalCost` from `completedSubagentTotals` (move record back to "active" accounting), then re-stash on completion. |
| `cleanup()` evicts a completed record after 10 min | Already debited into `completedSubagentTotals`; eviction does not re-debit. Correct. |
| `manager.clearCompleted()` called on session_start | `completedSubagentTotals` is reset to `{0,0}` in the same call site. Both must reset together. |
| Slot value is `null` (no subagent activity ever) | Footer renders today's exact UI (no sigma). Widget omits aggregate line. |
| Session has subagents that all finished + 0 currently running | Aggregate line still shows totals (cost > 0). Footer keeps sigma. |

## 8. Acceptance criteria

A reviewer can verify each by running pi against this repo and observing the TUI:

1. **Baseline preserved.** With no subagents spawned, the footer's right side is byte-identical to current behavior. No `Σ`, no aggregate widget line.
2. **Live update.** Spawn one background agent (`Agent` tool, run_in_background: true). Within ~100 ms of the agent's first turn, the footer cost gains a `Σ` prefix and the orchestration widget grows an `⊕ agents: <tokens> $<cost>` line. Both update on every tool activity tick.
3. **Multi-agent aggregation.** Spawn 3 background agents. The aggregate line shows the sum of all 3 sessions' tokens and cost. Footer cost = parent cost + sum of all 3.
4. **Persistence after completion.** All 3 agents finish. Per-agent rows disappear from the widget. The aggregate line remains, showing the final summed totals. Footer still shows `Σ$<combined>`.
5. **Session reset.** Trigger `session_start` (e.g. `/new`). Aggregate line disappears. Footer cost drops the sigma. `completedSubagentTotals` is `{0,0}`.
6. **Free model.** Run a subagent on Ollama. Tokens accumulate internally but the aggregate line never appears (cost = 0). Footer cost stays without sigma.
7. **Resume path.** Spawn agent, let it complete, resume it via `get_subagent_result`-then-`steer`-equivalent, let it complete again. Aggregate cost reflects only the *current* final stats of that agent — not double-counted.
8. **Build clean.** `bash scripts/check-build.sh` exits 0.
9. **Invariants clean.** `bash scripts/check-invariants.sh` exits 0. New `setStatus`/`setWidget`/etc. calls do not appear outside `extensions/ui/`.

## 9. Risks

- **Cost field on `SessionStats` is a number, not a structured object.** Confirmed in `pi-coding-agent/dist/core/agent-session.d.ts:129–146`. Direct sum is safe.
- **`session.getSessionStats()` may throw if called after dispose.** Already wrapped by `safeTotalTokens` pattern; new helpers must use the same try/catch pattern.
- **Resume double-count.** Mitigated by the documented subtract-before-rerun rule (§7). Implementation must handle this; missing it leaks money over resumes.
- **Race between completion stash and cleanup eviction.** Eliminated by using a separate accumulator that does not depend on record retention.
- **Sigma character (Σ, U+03A3) rendering.** Standard Greek; renders fine in every monospace font shipped with mainstream terminals. Falls back to box if not — acceptable, the cost number is still readable.

## 10. Alternatives considered

- **Per-agent cost on each widget row** (Option B from brainstorm). Rejected by user (Q5 = `aggregate`). Wider rows on already-busy spinner lines, redundant with aggregate.
- **Footer-only display, no widget line** (purer Option C). Rejected as too hidden — the orchestration widget is where users look during active work.
- **Persisted totals across restarts** (Q4 alternatives). Rejected; matches "in-memory, session-scoped" answer.
- **`Σ` prefix everywhere vs. only when subCost > 0.** Conditional chosen so a no-subagent session's footer is byte-identical to today.
- **Combined `↑↓` tokens in footer.** Rejected — input/output across parent and subagents are different prompt contexts; summing is misleading. Cost is the actionable scalar.

## 11. Out of scope (future work, not this PRD)

- A `/usage` slash command that prints a per-agent breakdown.
- Cost color thresholds (e.g. red at $1.00, yellow at $0.50).
- Persisting cumulative session cost to `.pi/` for retrospective analysis.
- Per-model cost rollups (e.g. "this session: $0.18 sonnet, $0.06 haiku").
- Surface `cacheRead`/`cacheWrite` tokens.
