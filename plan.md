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

- [x] Settings.json: this package is loaded by bare-string source (no explicit extensions list); auto-discovery picks up the new file. No edit needed.
- [x] Delete `extensions/pi-undo-redo.ts`.
- [x] README/AGENTS.md mentions deferred to Phase 3.

**Verification (autonomous)**

- [x] `test ! -f extensions/pi-undo-redo.ts`.
- [x] tsc --noEmit clean.
- [x] `bash scripts/check-invariants.sh` exits 0.

---

### Phase 3 — Remove `SLOT_UNDO` plumbing and `/undo` `/redo` commands (depends on Phase 2)

Strip dead UIBus producers/consumers and any leftover slash-command registrations.

**Tasks**

- [x] `extensions/ui/bus.ts`: removed `SLOT_UNDO`, `UndoState`, `publishUndo`.
- [x] `extensions/ui/footer.ts`: removed import + render logic.
- [x] `extensions/ui/README.md`: pruned undo row + helper mention.
- [x] No orphan `/undo` `/redo` slash commands found outside the deleted file.
- [x] `AGENTS.md`: removed `pi-undo-redo.ts` listing and `undo` slot.

**Verification (autonomous)**

- [x] No remaining `SLOT_UNDO`/`publishUndo`/`UndoState`/`pi-undo-redo` references.
- [x] tsc --noEmit clean.
- [x] `bash scripts/check-invariants.sh` exits 0.

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
