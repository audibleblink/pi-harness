# Execution Plan: Surface subagent token & cost usage in the UI

Source PRD: [`prd.md`](./prd.md)
Scope: `extensions/ui/` and `extensions/orchestration/` only.

The plan is organized into **5 phases**. Each phase ends in a buildable, type-checking, invariant-clean state with a clearly defined autonomous check. Phases are strictly sequential — every phase depends on the previous one.

The two repo-level autonomous feedback loops are:
- `bash scripts/check-build.sh` → TypeScript strict typecheck (must exit 0).
- `bash scripts/check-invariants.sh` → grep-based structural rules (must exit 0).

A third loop, `bash scripts/smoke.sh`, is referenced by the project but only used for manual smoke. It is invoked at the end of phase 5 as a final sanity boot.

---

## Phase 1 — UIBus slot contract (foundation)

**Depends on:** nothing.

Add the new slot constant, type, and publisher to `extensions/ui/bus.ts`. No producer or consumer wiring yet — this phase only establishes the shared contract so subsequent phases can import a stable name. The slot is unused at end of phase, which is fine.

### Tasks
- [x] Read `extensions/ui/bus.ts` and identify the existing slot pattern (`SLOT_MODE`, `SLOT_UNDO`, `SLOT_ORCHESTRATION`, `SLOT_WORKING`) and `publish*` helper shape.
- [x] Add `export const SLOT_SUBAGENT_USAGE = "subagentUsage"` next to the existing slot constants.
- [x] Add `export interface SubagentUsageState { tokens: number; cost: number; runningCount: number }`.
- [x] Add `export function publishSubagentUsage(pi: ExtensionAPI, state: SubagentUsageState | null): void` that emits `harness.ui:publish` with envelope `{ slot: SLOT_SUBAGENT_USAGE, value: state }`, mirroring the existing publish helpers exactly.
- [x] Update `AGENTS.md` slot list to read `mode`, `undo`, `orchestration`, `working`, `subagentUsage`.

### Autonomous check (end of phase)
```bash
bash scripts/check-build.sh        # must exit 0
bash scripts/check-invariants.sh   # must exit 0
grep -q "SLOT_SUBAGENT_USAGE" extensions/ui/bus.ts
grep -q "publishSubagentUsage"  extensions/ui/bus.ts
grep -q "subagentUsage"         AGENTS.md
```
All five commands must succeed (exit 0 / grep matches). End state: contract present, nothing imports it yet.

---

## Phase 2 — Producer: orchestration stashes final stats per agent

**Depends on:** Phase 1 (uses no slot symbol yet, but keeps producer changes isolated before publishing).

This phase modifies only `extensions/orchestration/types.ts` and `extensions/orchestration/agent-manager.ts` to capture a subagent's final tokens/cost into `AgentRecord` at completion (success and failure paths), **before** any session disposal. No publishing yet — values are captured but unused.

### Tasks
- [x] Add to `AgentRecord` in `extensions/orchestration/types.ts`:
  - `finalTokens?: number`
  - `finalCost?: number`
- [x] In `extensions/orchestration/agent-manager.ts`, locate `startAgent()` and the `.then(...)` / `.catch(...)` branches (and any equivalent completion paths used by `resume()`).
- [x] Add a small local helper `safeStashFinalStats(record)` that calls `record.session?.getSessionStats()` inside try/catch (mirroring the existing `safeTotalTokens` pattern) and writes `record.finalTokens` and `record.finalCost`. Missing/failed stats → leave fields `undefined`. Never throw out.
- [x] Invoke `safeStashFinalStats(record)` in both `.then` and `.catch` **before** any worktree cleanup, session disposal, or notification dispatch. Verify by reading the surrounding code that no disposal occurs earlier.
- [x] Confirm `manager.resume()` flow re-uses the same `.then/.catch`; if it has its own completion handler, stash there too.

### Autonomous check (end of phase)
```bash
bash scripts/check-build.sh        # must exit 0
bash scripts/check-invariants.sh   # must exit 0
grep -q "finalTokens" extensions/orchestration/types.ts
grep -q "finalCost"   extensions/orchestration/types.ts
grep -q "finalTokens" extensions/orchestration/agent-manager.ts
grep -q "finalCost"   extensions/orchestration/agent-manager.ts
# Stash must precede any dispose/cleanup call in agent-manager.ts:
awk '/finalTokens *=/{stash=NR} /(cleanupWorktree|\.dispose\()/{disp=NR} END{exit !(stash && disp && stash<disp)}' extensions/orchestration/agent-manager.ts
```
All commands must succeed. End state: every completed/failed agent record carries final stats; nothing reads them yet.

---

## Phase 3 — Producer: aggregate state, accumulator, debounced publish

**Depends on:** Phase 1 (slot symbols), Phase 2 (final stats on records).

Wire the orchestration extension to compute and publish `SubagentUsageState`. Adds the session-scoped `completedSubagentTotals` accumulator, the resume-aware double-count guard, and calls `publishSubagentUsage` at every site that already calls `scheduleOrchestrationPublish`.

### Tasks
- [x] In `extensions/orchestration/index.ts`, add a module/instance-scoped `completedSubagentTotals = { tokens: 0, cost: 0 }`.
- [x] Implement `safeTotalCost(session)` and `safeUsage(session): { tokens: number; cost: number }` next to the existing `safeTotalTokens`. Same try/catch shape; return zeros on failure.
- [x] On agent completion (the same callback flow used in Phase 2, exposed via a hook from `AgentManager` or polled — match whatever pattern orchestration already uses to learn about completions): add the agent's `finalTokens`/`finalCost` to `completedSubagentTotals`. Do this exactly once per terminal completion.
- [x] On `manager.resume(record)`: if `record.finalTokens`/`finalCost` are populated, subtract them from `completedSubagentTotals` and clear the fields before re-running. This implements the §7 resume rule — without it, money leaks.
- [x] On `session_start` (the existing hook that calls `manager.clearCompleted()`): reset `completedSubagentTotals = { tokens: 0, cost: 0 }` in the same call site.
- [x] Add `buildSubagentUsageState(): SubagentUsageState | null`:
  - Live sum: for each `record` in `manager.listAgents()` with `status` ∈ {`running`, `queued`}, add `safeUsage(record.session)`.
  - Completed: add `completedSubagentTotals`.
  - `runningCount` = count of records with status === `running`.
  - Return `null` iff `completedSubagentTotals` is `{0,0}` AND no running/queued agents exist.
- [x] Add `scheduleSubagentUsagePublish()` mirroring `scheduleOrchestrationPublish` (50 ms debounce). Sharing the same timer is acceptable; either approach is fine as long as both publish after the debounce.
- [x] At every existing call site of `scheduleOrchestrationPublish()` — spawn, completion, abort, tool activity tick, turn end, `session_start` — also call `scheduleSubagentUsagePublish()`.
- [x] Verify: orchestration must not import from `extensions/ui/footer.ts` or `extensions/ui/widget.ts`. Importing the slot constant from `extensions/ui/bus.ts` is allowed (existing pattern for `SLOT_ORCHESTRATION`).

### Autonomous check (end of phase)
```bash
bash scripts/check-build.sh        # must exit 0
bash scripts/check-invariants.sh   # must exit 0
grep -q "completedSubagentTotals"   extensions/orchestration/index.ts
grep -q "buildSubagentUsageState"   extensions/orchestration/index.ts
grep -q "publishSubagentUsage"      extensions/orchestration/index.ts
# No forbidden imports from ui internals (bus.ts is OK):
! rg -n "from ['\"].*extensions/ui/(footer|widget|index)" extensions/orchestration/
# Publish must be co-located with every orchestration publish site:
test "$(grep -c scheduleOrchestrationPublish extensions/orchestration/index.ts)" -le "$(grep -c scheduleSubagentUsagePublish extensions/orchestration/index.ts)"
```
End state: a real `SubagentUsageState` flows on the bus on every relevant tick. No consumer yet — the value is dropped.

---

## Phase 4 — Consumer: footer Σ prefix

**Depends on:** Phase 3 (slot is being published).

Wire `extensions/ui/footer.ts` to read the slot and conditionally prefix the cost label with `Σ`. Token labels stay parent-only per §4.3.

### Tasks
- [x] Read `extensions/ui/footer.ts` and `extensions/ui/index.ts` to confirm how `slots` is plumbed into `setupFooter`.
- [x] Rename internal `getUsageTotals(ctx)` → `getParentUsageTotals(ctx)`. Update its single in-file caller. Do not change behavior.
- [x] Add `getCombinedUsageTotals(ctx, sub: SubagentUsageState | null)` returning `{ parent, combined: { input, output, cost: parent.cost + (sub?.cost ?? 0) }, subTokens, subCost }` exactly as specified in §4.3.
- [x] In the footer render path, read `slots.get(SLOT_SUBAGENT_USAGE)` (typed as `SubagentUsageState | null | undefined`).
- [x] Compute `costLabel`: when `subCost > 0` prefix the existing dollar string with `Σ` (dimmed to match the muted style; reuse the same dim helper the footer already uses for muted text). Otherwise render exactly today's string.
- [x] Leave `↑in ↓out` untouched — they remain parent-only.
- [x] Export `formatCount` (used in Phase 5) **only if** that ends up being the chosen sharing path; otherwise leave private and Phase 5 reimplements. Decide here, not later.

### Autonomous check (end of phase)
```bash
bash scripts/check-build.sh        # must exit 0
bash scripts/check-invariants.sh   # must exit 0
grep -q "getParentUsageTotals" extensions/ui/footer.ts
grep -q "getCombinedUsageTotals" extensions/ui/footer.ts
grep -q "SLOT_SUBAGENT_USAGE" extensions/ui/footer.ts
grep -q "Σ" extensions/ui/footer.ts
# Original name fully replaced (no stragglers):
! grep -n "getUsageTotals\b" extensions/ui/footer.ts | grep -v "getParentUsageTotals\|getCombinedUsageTotals"
```
End state: spawning a paid subagent visibly causes a `Σ` in the footer cost. Widget unchanged.

---

## Phase 5 — Consumer: widget aggregate line + final smoke

**Depends on:** Phase 4 (which finalized the formatCount export decision).

Add the `⊕ agents: <tokens> $<cost>` aggregate line to `extensions/ui/widget.ts`, gated on `cost > 0`. Run the full repo verification surface.

### Tasks
- [x] Update `renderWidget(state, frame)` signature in `extensions/ui/widget.ts` to `renderWidget(state, frame, sub?: SubagentUsageState | null)`.
- [x] At the very bottom of the widget output (after orphan tasks per §4.4), if `sub && sub.cost > 0`, append a single dim line: `⊕ agents: <formatCount(sub.tokens)> $<sub.cost.toFixed(3)>`. Both `⊕` and `agents:` are dimmed; whitespace and ordering match §4.4 exactly.
- [x] If `cost === 0` or `sub` is null/undefined, render nothing extra (byte-identical to today).
- [x] In `extensions/ui/index.ts`, read `slots.get(SLOT_SUBAGENT_USAGE)` and pass it through every `renderWidget(...)` call site. Search the file for all call sites — there may be more than one.
- [x] If Phase 4 chose to export `formatCount`, import it; otherwise inline a local copy. No third path.
- [x] Run the full check matrix and the smoke boot.

### Autonomous check (end of phase)
```bash
bash scripts/check-build.sh        # must exit 0
bash scripts/check-invariants.sh   # must exit 0
grep -q "SLOT_SUBAGENT_USAGE" extensions/ui/index.ts
grep -q "⊕ agents:"           extensions/ui/widget.ts
# renderWidget signature carries the new param:
grep -E "renderWidget *\([^)]*sub" extensions/ui/widget.ts
# Every renderWidget call in index.ts passes 3 args (heuristic: trailing comma before close):
! rg "renderWidget\([^,]*,[^,]*\)" extensions/ui/index.ts   # 2-arg calls must be gone
# Final smoke boot — must start and exit cleanly:
bash scripts/smoke.sh
```
End state: §8 acceptance criteria 1, 8, and 9 are autonomously verifiable. Acceptance criteria 2–7 require a live pi session and are documented as manual smoke in the PRD.

---

## Phase dependency graph

```
Phase 1 (bus contract)
   │
   ▼
Phase 2 (record stash)
   │
   ▼
Phase 3 (publisher)
   │
   ▼
Phase 4 (footer Σ)
   │
   ▼
Phase 5 (widget line + smoke)
```

Strictly linear. No phase can begin until the previous one's autonomous check passes.

---

## Rollback notes

- Phases 1, 2, and 3 are independently revertible without breaking the build (Phase 1 leaves dead exports; Phase 2 leaves dead fields; Phase 3 publishes to a slot with no consumer).
- Phase 4 alone (without Phase 5) is shippable: footer gets Σ, widget unchanged.
- If Phase 5 regresses the widget, revert just `widget.ts` + the `index.ts` plumbing; the footer keeps working.
