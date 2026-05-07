# PRD: Replace `pi-undo-redo` with `git-checkpoint`

## 1. Summary

Replace the custom `extensions/pi-undo-redo.ts` (1127 lines, blob-store snapshots wrapping Write/Edit/Bash tools) with a minimal git-backed checkpoint extension modeled after the pi docs example `examples/extensions/git-checkpoint.ts`. Restore is offered on both `/fork` and `/tree` navigation.

## 2. Goals

- Drastically reduce code (~1127 → ~80 lines).
- Use git's object store as the snapshot engine.
- Per-turn granularity; capture untracked files.
- Wire restore into both `/fork` and `/tree` flows.
- Gracefully no-op outside git repos.

## 3. Non-Goals

- Per-tool-call / per-edit granularity.
- `/undo` and `/redo` slash commands.
- Footer or widget UI for checkpoint state (`SLOT_UNDO` is removed).
- Auto-init shadow git repos for non-git cwds.
- Cross-session persistence of the checkpoint map.

## 4. Functional Requirements

### 4.1 New extension: `extensions/git-checkpoint.ts`

- **On `turn_start`:**
  - If cwd is not inside a git repo (`git rev-parse --git-dir` fails): no-op. (See 4.2.)
  - Snapshot all working-tree state including untracked files. Implementation: `git add -A` to stage everything, `git write-tree` to capture a tree object, then `git reset` (mixed) to unstage. (Alternative implementations such as `git stash create` are acceptable provided untracked files are captured.)
  - Store `entryId → tree-ish` in an in-memory `Map`. The `entryId` is captured from the latest `tool_result` event's leaf entry, mirroring the docs example.

- **On `session_before_fork` and `session_before_tree`:**
  - Look up `event.entryId` in the map. If absent, return.
  - If `!ctx.hasUI`, return (no auto-restore in non-interactive mode).
  - Prompt via `ctx.ui.select("Restore code state?", ["Yes, restore code to that point", "No, keep current code"])` with **"Yes" as the default**.
  - On Yes: restore the working tree to that tree-ish (`git read-tree -u --reset <ref>` or equivalent stash apply). Notify `"Code restored to checkpoint"`.

- **Lifetime:** The checkpoint map persists for the entire pi session. It is **not** cleared on `agent_end`, so `/tree` navigation after a turn finishes still works. Map is naturally GC'd when the process exits.

### 4.2 Non-git directories

- Detect once at first `turn_start` (cache the result).
- If not a git repo, emit a single `ctx.ui.notify("git-checkpoint disabled: not a git repository", "warn")` and become a no-op for all subsequent events in the session.

### 4.3 Removals

- Delete `extensions/pi-undo-redo.ts`.
- Remove `+extensions/pi-undo-redo.ts` from the package's `extensions` list in `~/.config/pi/agent/settings.json`; add `+extensions/git-checkpoint.ts`.
- Remove `SLOT_UNDO` constant, its `publishUndo` producer, and any consumer code in `extensions/ui/bus.ts` and `extensions/ui/index.ts`.
- Remove any `/undo` and `/redo` slash-command registrations.
- Remove the `getAgentDir()/pi-undo-redo/` blob directory cleanup is **not** required (orphaned data is fine; user can rm manually).

## 5. Technology Stack

- **Language:** TypeScript, loaded directly by pi (no build step at runtime).
- **Runtime APIs:** `ExtensionAPI` from `@mariozechner/pi-coding-agent`. Uses `pi.exec`, `pi.on`, `ctx.ui.select`, `ctx.ui.notify`, `ctx.sessionManager.getLeafEntry`, `ctx.hasUI`.
- **External tooling:** `git` CLI (any version with `add`, `write-tree`, `read-tree`, `reset`, `rev-parse`).
- **No new npm dependencies.**

## 6. Verification

- `bash scripts/check-build.sh` passes (TS type-check).
- `bash scripts/check-invariants.sh` passes (no orphaned `SLOT_UNDO` references; no chrome calls outside `ui/`).
- Manual smoke:
  1. In a git repo with both tracked + untracked files, run a turn that edits files; `/fork` from a prior user message; choose "Yes" → working tree matches the pre-turn state including untracked files.
  2. Same scenario via `/tree` after `agent_end` — restore still works.
  3. In a non-git directory, first turn emits a single warn notification; no further notifications; no errors.
  4. Choose "No" at the prompt → working tree unchanged.

## 7. Risks & Open Questions

- **Object DB growth:** every turn writes a tree (and any new blobs). Acceptable; user can `git gc` periodically. No automatic cleanup.
- **Submodules / LFS / sparse checkout:** untested; out of scope.
- **Concurrent git ops:** if the user runs `git` commands in another terminal during a turn, snapshot/restore may race. Out of scope.
- **`entryId` capture timing:** relies on a `tool_result` having fired before `turn_start`; for the very first turn of a session there may be no entryId yet, in which case that turn is simply not checkpointed (matches example behavior).

---

**Next step:** Start a new session with `/new` before generating the execution plan.
