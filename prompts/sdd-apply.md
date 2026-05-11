---
description: Implement the feature
---

Implement the feature by parsing the execution plan into a task DAG and executing it via Task* tools.

**Input**: optional paths to context files (PRD, plan, spec dir). If a directory is given (e.g. `./specs/001-feature-x`), use `<dir>/plan.md` as the plan. If no paths are given, default to `./plan.md`.

## Steps

1. **Resolve paths and read context**

   Read the files:
   - $ARGUMENTS

   Determine the plan path from the inputs (rules above). Call it `PLAN_PATH`.

2. **Build the task DAG**

   Parse `PLAN_PATH`. For each `## Phase N: <name>` heading:
   - Read its `**Depends on:**` line to find blocking phases.
   - Call `TaskCreate` with:
     - `subject`: the phase name
     - `description`: the full phase body from the plan (the checklist, verification steps, autonomous feedback loop — everything the executing subagent needs), prefixed with a line `Plan file: <PLAN_PATH>` so the subagent knows where to tick checkboxes
     - `agentType: "general-purpose"`
   - Record the returned task ID against the phase number.

   After all phases are created, call `TaskUpdate` on each to wire `addBlockedBy` with the task IDs of its declared dependency phases.

3. **Launch the roots**

   Call `TaskExecute` with the IDs of all phases that have `**Depends on:** none`. Cascade-on-completion will fan out dependents automatically as each phase finishes.

   Pass `additional_context` to TaskExecute with:
   > Implement this phase using TDD. Make minimal, focused changes. Run the phase's autonomous feedback loop until it passes. When the phase is complete, mark each `- [ ]` checkbox for this phase in the plan file (path given in the description) as `- [x]`, then commit all changes with a message naming the phase.

4. **Wait for completion**

   Use `TaskOutput` with `block: true` on each root and (as cascade releases them) each dependent. Surface failures immediately; on failure the cascade will mark the task back to `pending` — do not retry blindly, report the failure and stop.

5. **On completion, show status**

   Use `TaskList` to confirm all phases `completed`. Display:
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
- Build the **entire** DAG upfront before calling TaskExecute — do not interleave creation and execution.
- Never spawn an `Agent` tool call for phase work; phases run exclusively through TaskExecute.
- The executing subagent (not this session) is responsible for editing plan.md checkboxes and committing.
- If a phase fails (task reverts to `pending`), stop and surface the failure rather than re-executing.
