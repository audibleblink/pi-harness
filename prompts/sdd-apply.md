---
description: Implement the feature
---

Implement the feature by parsing the execution plan into a phase DAG and delegating each phase to a subagent.

The execution plan is typically produced by `sdd-plan`. It contains top-level `## Phase N: <name>` headings, each with a `**Depends on:**` line, a checklist of tasks, and an autonomous feedback loop for verification. This prompt consumes that structure directly.

**Input**: optional paths to context files (PRD, plan, spec dir). If a directory is given (e.g. `./specs/001-feature-x`), use `<dir>/plan.md` as the plan. If no paths are given, default to `./plan.md`.

## Steps

1. **Resolve paths and read context**

   Read the files:
   - $ARGUMENTS

   Determine the plan path from the inputs (rules above). Call it `PLAN_PATH`.

2. **Build the phase DAG**

   Parse `PLAN_PATH`. For each `## Phase N: <name>` heading, record:
   - The phase name
   - The phase body (the checklist, verification steps, autonomous feedback loop — everything the executing subagent needs to do the work)
   - Its dependencies, read from the `**Depends on:**` line
   - Its checkbox state: how many `- [ ]` vs `- [x]` tasks it contains

   The result is a DAG of phases keyed by phase number. Do not start executing yet.

   **Resume semantics.** The plan file is the source of truth for progress and may have been partially completed by an earlier session. Classify each phase:
   - **Complete**: every task checkbox is `- [x]`. Skip it; treat it as a satisfied dependency.
   - **Partial**: some `- [x]`, some `- [ ]`. The next session should pick up at the first `- [ ]` task that makes sense given what's already done. Pass the full phase body to the subagent and instruct it to skip already-checked tasks.
   - **Untouched**: all `- [ ]`. Run normally.

   The set of phases to dispatch is everything not yet Complete, scheduled according to the DAG.

3. **Dispatch phases to subagents**

   Whatever subagent / delegation / subtask mechanism your harness provides, use it to run each phase as an independent subagent task. The dispatch must respect the DAG: a phase only starts once all its dependencies have completed successfully.

   Each subagent invocation must receive:
   - The phase name and full phase body from the plan.
   - The plan path (`PLAN_PATH`) so the subagent knows where to tick checkboxes.
   - Instructions equivalent to:
     > Implement this phase using TDD. Make minimal, focused changes. The plan file may already have some tasks checked off from a prior session — skip those and start at the first unchecked task that makes sense given the current state of the code. As you finish each individual task, immediately mark its `- [ ]` checkbox as `- [x]` in the plan file and save, so progress is durable if the session is interrupted. Run the phase's autonomous feedback loop until it passes. When all tasks for the phase are checked off, commit all changes with a message naming the phase.

   Prefer launching all currently-unblocked phases in parallel rather than serially.

4. **Wait for completion**

   Wait for each dispatched phase to finish. Prefer event-driven notification over polling if the harness supports it.

   - When a phase completes successfully, dispatch any dependents whose dependencies are now all satisfied.
   - If a phase fails, stop and surface the failure. Do not retry blindly.

   Repeat until every phase is complete.

5. **On completion, show status**

   Display:
   - Phases completed this session
   - Overall progress: "N/M phases complete"

## Output During Implementation

```
## Implementing: <change-name>

Built DAG: 7 phases, roots = [Phase 1, Phase 2]
Launched roots.
✓ Phase 1 complete → unblocked Phase 3
✓ Phase 2 complete
✓ Phase 3 complete → unblocked Phase 4, Phase 5
...
```

## Guardrails

- Always read context files before building the DAG.
- Build the **entire** DAG upfront before dispatching any phase — do not interleave parsing and execution.
- Phase work runs exclusively in subagents, not in this session. This session orchestrates only.
- The executing subagent (not this session) is responsible for editing plan.md checkboxes and committing.
- Checkboxes are ticked **per task as each task finishes**, not in a batch at end of phase. The plan file is the durable progress record across sessions.
- On a fresh session, never re-run completed work: trust the checkbox state in plan.md and resume from the first unchecked task that makes sense.
- If a phase fails, stop and surface the failure rather than re-executing.
