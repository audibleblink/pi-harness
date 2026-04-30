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
        "+extensions/ghost-completion.ts",
        "+extensions/ui/index.ts",
        "+extensions/orchestration/index.ts",
        "+extensions/stealth-skills.ts",
        "+extensions/notify-macos.ts"
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
  stealth-skills.ts # Hide skills from system prompt while keeping /skill:name (config: stealthSkills in settings.json, /skills to toggle)
  ghost-completion.ts # LLM-driven ghost-text suggestions; publishes GhostController on UIBus (must load before ui/)
  notify-macos.ts # macOS desktop notifications on agent_end (terminal-notifier with osascript fallback)
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
- The UIBus topic is `harness.ui:publish` with envelope `{ slot: string, value: unknown }`. Slot names: `mode`, `undo`, `orchestration`, `working`, `subagentUsage`, `ghost`.

## Where new extensions go

Default: **one new extension = one new file at `extensions/<name>.ts`** (or `extensions/<name>/index.ts` for multi-file). Then add it to the `extensions` list in your pi settings.json package config.

**Do NOT add behavior to `extensions/ui/`** unless it is TUI chrome (footer/editor/widget/working indicator). The `ui/` directory is reserved as the sole owner of chrome — see invariants in `scripts/check-invariants.sh`. Examples of things that do **not** belong in `ui/`:

- OS-level integrations (notifications, file watchers, webhooks)
- LLM calls for non-chrome features (autocomplete, summarization, classification)
- Domain logic (git, deploy, project tooling)
- Anything reacting to `agent_end`/`tool_call`/etc. for non-rendering side effects

If your extension needs to influence chrome (status text, widget content, editor behavior), publish state on the UIBus from your own extension and let `ui/` consume it. Add a new `SLOT_*` constant + producer in `extensions/ui/bus.ts`; render/consume it from `ui/index.ts` or the relevant chrome file. The `ghost-completion.ts` extension is the reference pattern: logic lives outside `ui/`, exposes a controller via `SLOT_GHOST`, and the editor reads it from the slot map.

Load order in settings.json matters: producers that publish on `session_start` (e.g. ghost-completion) must be listed **before** `ui/index.ts` so the slot is populated when the editor is registered.

## No test suite

The repo has no automated tests. Verification is via TypeScript build check + grep invariants + manual smoke scenarios defined in `prd.md` §6.
