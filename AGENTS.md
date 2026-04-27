# pi-harness

This repo is a **pi package** — it is not a standalone application. It is loaded by a pi instance via `~/.config/pi/agent/settings.json` as a package source:

```json
{
  "packages": [
    {
      "source": "/Users/blink/Code/pi-harness",
      "extensions": [
        "+extensions/ask-user-question.ts",
        "+extensions/modes.ts",
        "+extensions/pi-undo-redo.ts",
        "+extensions/vim-quit.ts",
        "+extensions/ui/index.ts",
        "+extensions/orchestration/index.ts"
      ]
    }
  ]
}
```

**Do not look for extensions, skills, agents, or prompts outside this directory.** All resources are self-contained here. There is no separate pi installation to modify — changes to extensions belong in `extensions/`, agents in `agents/`, prompts in `prompts/`, themes in `themes/`.

---

## Layout

```
extensions/       # TypeScript pi extensions (loaded by pi at startup)
  ui/             # Sole TUI chrome owner — footer, editor, widget, working indicator
  orchestration/  # Merged agent spawning + task tracking (was pi-subagents + pi-tasks)
  modes.ts        # Mode enforcement (agent/auto/etc)
  pi-undo-redo.ts # Undo/redo for file edits
  ask-user-question.ts
  vim-quit.ts
agents/           # Custom agent type definitions (.md files)
prompts/          # Prompt templates injected into sessions
themes/           # UI color themes
scripts/          # Build/verification scripts (check-build.sh, check-invariants.sh, smoke.sh)
tsconfig.json     # TypeScript config for extensions/ (noEmit, strict)
```

## Working on extensions

- Extensions are TypeScript files loaded directly by pi — no compile step needed at runtime (pi transpiles on load).
- Run `bash scripts/check-build.sh` to type-check after editing.
- Run `bash scripts/check-invariants.sh` to verify structural invariants (TUI chrome ownership, no stale event names, etc).
- All TUI chrome calls (`setStatus`, `setWidget`, `setFooter`, `setWorkingMessage`, `setWorkingIndicator`, `setEditorComponent`) must live exclusively in `extensions/ui/`. Other extensions publish state via the UIBus (`extensions/ui/bus.ts`).
- The UIBus topic is `harness.ui:publish` with envelope `{ slot: string, value: unknown }`. Slot names: `mode`, `undo`, `orchestration`, `working`.

## No test suite

The repo has no automated tests. Verification is via TypeScript build check + grep invariants + manual smoke scenarios defined in `prd.md` §6.
