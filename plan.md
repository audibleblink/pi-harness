# Execution Plan: Replace `pi-undo-redo` with `git-checkpoint`

Spec: `./prd.md`

Phases are sequentially dependent: **Phase 2 → 1**, **Phase 3 → 2**, **Phase 4 → 3**. Each phase ends with a buildable, invariant-clean tree.

---

## Chunk 1: Phases 1–4

### Phase 1 — Author `extensions/git-checkpoint.ts` (no wiring yet)

Create the new extension file alongside the existing `pi-undo-redo.ts`. Do **not** touch settings.json or `ui/bus.ts` yet — this phase ends with a file that type-checks in isolation.

**Tasks**

- [x] Create `extensions/git-checkpoint.ts` (~80 lines) implementing PRD §4.1 + §4.2.
- [x] Reference `examples/extensions/git-checkpoint.ts` in the upstream package for shape, but adapt per PRD.

**Verification (autonomous)**

- [x] tsc --noEmit clean.
- [x] `bash scripts/check-invariants.sh` exits 0.
- [x] `wc -l extensions/git-checkpoint.ts` = 69 (≤ 100).

---

### Phase 2 — Wire new extension; remove old extension file (depends on Phase 1)

Switch the loader to the new extension and delete the old implementation file. The slot/footer cleanup happens in Phase 3 — to keep this phase green we must therefore also strip the now-dead `publishUndo` *call sites* from `pi-undo-redo.ts` removal, but leave `SLOT_UNDO`/`publishUndo` *defined* in `bus.ts` and consumed in `footer.ts`. (They become unused but type-check fine.)

**Tasks**

- [ ] Edit `~/.config/pi/agent/settings.json`: in this package's `extensions` array, replace `"+extensions/pi-undo-redo.ts"` with `"+extensions/git-checkpoint.ts"`.
  - [ ] Verify ordering: any producers required before `+extensions/ui/index.ts` are unchanged; `git-checkpoint` does not publish to UIBus so position relative to `ui/index.ts` is unconstrained.
- [ ] Delete `extensions/pi-undo-redo.ts`.
- [ ] Search for any other references to the deleted file (`grep -rn 'pi-undo-redo' extensions/ scripts/ AGENTS.md`); leave README mentions for Phase 3 cleanup.

**Verification (autonomous)**

- [ ] `test ! -f extensions/pi-undo-redo.ts`.
- [ ] `bash scripts/check-build.sh` exits 0 (no remaining importers of the deleted file; `bus.ts` `publishUndo` is unused but defined → still compiles under `noEmit`).
- [ ] `bash scripts/check-invariants.sh` exits 0.
- [ ] `grep -rn 'extensions/pi-undo-redo' .` returns no hits in code or settings.json.
- [ ] `jq '.packages[].extensions' ~/.config/pi/agent/settings.json | grep git-checkpoint` finds the new entry.

---

### Phase 3 — Remove `SLOT_UNDO` plumbing and `/undo` `/redo` commands (depends on Phase 2)

Strip dead UIBus producers/consumers and any leftover slash-command registrations.

**Tasks**

- [ ] `extensions/ui/bus.ts`: remove `SLOT_UNDO` constant, the `UndoState` type (if exported only for this slot), and `publishUndo` function. If `UndoState` is referenced elsewhere, remove only what becomes unused.
- [ ] `extensions/ui/footer.ts`:
  - [ ] Remove `SLOT_UNDO` and `UndoState` from the `./bus.js` import.
  - [ ] Remove the `slots.get(SLOT_UNDO)` lookup at line ~721 and any rendering logic that consumes `undoState` (footer segment for undo/redo counts).
- [ ] `extensions/ui/README.md`: delete the `undo` row from the slot table and the `publishUndo` mention in the helpers list. Update any reference to `pi-undo-redo.ts`.
- [ ] Search the codebase for `/undo` and `/redo` slash-command registrations (they lived inside `pi-undo-redo.ts` only — confirm via `grep -rn "registerSlashCommand\|/undo\|/redo" extensions/`); remove any orphans found outside the deleted file.
- [ ] `AGENTS.md`: remove `pi-undo-redo.ts` from the layout listing and the UIBus slot list (`undo`).

**Verification (autonomous)**

- [ ] `grep -rn 'SLOT_UNDO\|publishUndo\|UndoState' extensions/` returns nothing.
- [ ] `grep -rn 'pi-undo-redo' .` (excluding `.git/`) returns nothing.
- [ ] `bash scripts/check-build.sh` exits 0.
- [ ] `bash scripts/check-invariants.sh` exits 0 (the invariants script lists slot names; if it pins `undo`, update the script accordingly in this phase and re-run).
- [ ] `bash scripts/smoke.sh` (if present and previously passing) still passes.

---

### Phase 4 — Manual smoke verification (depends on Phase 3)

Per PRD §6, exercise the four manual scenarios. Each is scripted as a reproducible bash check.

**Tasks**

- [ ] **Scenario A — git repo, /fork restore "Yes":**
  - [ ] In a scratch git repo with one tracked file `a.txt` and one untracked `b.txt`, run a pi session: turn 1 sends a user message → assistant edits `a.txt` and creates/edits `c.txt`.
  - [ ] After the turn completes, `/fork` from the user message; choose "Yes".
  - [ ] Assert: `a.txt` matches pre-turn contents; `b.txt` still present unchanged; `c.txt` removed (because `read-tree -u --reset` restores the recorded tree).
- [ ] **Scenario B — /tree after `agent_end`:** Same setup, wait for `agent_end`, run `/tree`, navigate to the pre-turn entry, choose "Yes" → identical assertions to A. Confirms checkpoint map is **not** cleared on `agent_end`.
- [ ] **Scenario C — non-git directory:** `cd` into `/tmp/not-a-repo` (`rm -rf .git` if needed). Start pi, run one turn, then a second turn. Assert: exactly **one** `warn` notification appears across both turns; no errors in the log; subsequent `/fork`/`/tree` are no-ops.
- [ ] **Scenario D — choose "No":** Repeat Scenario A but answer "No" at the prompt; assert working tree unchanged from post-turn state.
- [ ] Capture each scenario's outcome (pass/fail + observed behavior) in a temporary `./smoke-results.md`; delete that file once all four pass.

**Verification (autonomous feedback loop)**

- [ ] All four scenarios pass; if any fails, return to Phase 1/2/3 to fix the offending behavior, then re-run all four scenarios.
- [ ] Final gate: `bash scripts/check-build.sh && bash scripts/check-invariants.sh` both exit 0.
- [ ] `wc -l extensions/git-checkpoint.ts` confirms ≤ ~100 lines (PRD goal: 1127 → ~80).
