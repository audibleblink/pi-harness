# Changelog

## Unreleased — Extension migration: `agents/` + `tasks/`

Big-bang rewrite consolidating `extensions/modes.ts` and `extensions/orchestration/`
into two new single-purpose extensions:

- `extensions/agents/` — agent loader, primary cycling, `/agent[s]`, subagent tools
  (`Agent`, `get_subagent_result`, `steer_subagent`), `@name` inline dispatch.
- `extensions/tasks/` — `Task*` tools, store, auto-clear, cascade-on-completion via
  the `agents:subagent_end` event.

### Breaking changes (no shim, hard break)

- **`defaultAgent` → `defaultPrimaryAgent`** in `~/.config/pi/agent/settings.json`.
  The legacy `defaultAgent` key is ignored at runtime; if neither key resolves a
  loaded agent the system surfaces a single "no primary agent configured"
  warning and continues. Update your settings.json by hand.
- **Frontmatter `mode:` default flipped from absent → effective-`subagent` to
  absent → `all`** (matches opencode). Every in-repo agent under `agents/*.md`
  has been audited and now declares `mode:` explicitly. External users with
  custom agent files MUST add `mode: subagent` (or `primary` / `all`) explicitly
  to any file that previously relied on the implicit default — otherwise those
  files become eligible for primary cycling.

### New

- `@name` inline dispatch with PRD disambiguation rules (paths, extensions,
  unknown names, `\@` escape, primary-only rejection).
- Tab keybinding cycles primary agents (opencode parity); legacy `Ctrl+Shift+M`
  retained as alias.
- JSON agents under settings.json `agent` map override same-named markdown agents.
- `permission.task` map gates which subagents an agent may spawn (allow/ask/deny).
- `hidden: true` subagents are dispatchable via manually-typed `@name` but excluded
  from `@`-autocomplete.

### Verification

- `bash scripts/check-build.sh` — TypeScript clean.
- `bash scripts/check-invariants.sh` — TUI ownership + event allowlist clean.
- `bash scripts/phase8-verify.sh` — 11/12 PRD smoke scenarios automated, 1 manual
  (session resume).
