# extensions/ui — TUI chrome owner

`extensions/ui/` is the **sole owner** of all TUI chrome calls in this harness. No other extension may call `setStatus`, `setWidget`, `setFooter`, `setWorkingMessage`, `setWorkingIndicator`, or `setEditorComponent` directly. This invariant is enforced by `scripts/check-invariants.sh`.

## UIBus contract

Other extensions publish state changes by calling helpers from `extensions/ui/bus.ts`. These helpers emit a `harness.ui:publish` event that `extensions/ui/index.ts` subscribes to.

### Slot names

| Slot            | Publisher                               | Content shape          |
|-----------------|-----------------------------------------|------------------------|
| `mode`          | `extensions/modes.ts`                   | `ModeState \| null`    |
| `undo`          | `extensions/pi-undo-redo.ts`            | `UndoState \| null`    |
| `orchestration` | `extensions/orchestration/index.ts`     | `OrchestrationState \| null` |
| `working`       | `extensions/ui/working.ts` (internal)   | `string \| null`       |

Slots are cleared on `session_start` with `reason: "reload"`.

## File layout

| File          | Responsibility                                                          |
|---------------|-------------------------------------------------------------------------|
| `index.ts`    | Extension entry, UIBus subscription, slot map, ticker coordination      |
| `bus.ts`      | Typed publish helpers (`publishMode`, `publishUndo`, `publishOrchestration`, `publishWorking`) |
| `footer.ts`   | Footer renderer — reads `mode` and `undo` slots, calls `setFooter`      |
| `editor.ts`   | Editor factory registration — calls `setEditorComponent` on activate   |
| `working.ts`  | Working message/indicator pool — calls `setWorkingMessage` / `setWorkingIndicator` |
| `widget.ts`   | Combined agent+task widget renderer — reads `orchestration` slot, calls `setWidget` |
| `ticker.ts`   | Single 80ms animation ticker — starts/stops based on animated slot state |

## setInterval audit

Three `setInterval` calls exist in the codebase. Only one is the animation ticker:

| Location | Interval | Purpose |
|----------|----------|---------|
| `extensions/ui/ticker.ts:15` | 80ms | **Animation ticker** — drives widget re-renders while agents/tasks are active. Auto-stops when no animated state exists. |
| `extensions/orchestration/agent-manager.ts:77` | 60s | Non-animation GC sweep — cleans up stale agent entries. |
| `extensions/orchestration/index.ts:989` | ~100ms | Non-animation foreground spinner — shown during `spawnAndWait`, cleared immediately after. |

## setTitle note

No extensions currently call `setTitle`. If added in future, it is allowed outside `extensions/ui/` (it sets the terminal window title, not a harness chrome slot) but should be noted here.
