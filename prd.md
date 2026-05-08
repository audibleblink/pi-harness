# PRD — Extension Migration: `agents/` + `tasks/`

## Summary
Big-bang rewrite consolidating the current `extensions/modes.ts` and `extensions/orchestration/` into two new, single-purpose extensions:

- `extensions/agents/` — unified agent system (primary modes + subagents), agent-definition loader, primary-mode switching, subagent spawning tools, `@name` user-side dispatch, UI bus producers for `mode` / `orchestration` / `subagentUsage`.
- `extensions/tasks/` — TaskStore, `Task*` tools, auto-clear, cascade-on-completion driven by an event from `agents/`.

The old `extensions/modes.ts` and `extensions/orchestration/` are deleted in the same change. No staged deprecation period.

Reference for agent-definition conventions: <https://opencode.ai/docs/agents.md>. The PI agent surface adopts the opencode.ai interface and usage (mode values, option names, `@`-mention dispatch, Tab cycling, JSON+markdown configuration, `hidden`, `permission` map) **and additionally retains every existing PI-specific frontmatter field** so all current `agents/*.md` files keep working without rewrites beyond the explicit `mode:` declaration covered in Migration.

## Goals
1. One coherent place to define and run agents (primary or subagent), backed by a single frontmatter schema with a `mode` discriminator.
2. Tasks become a standalone, observably-decoupled extension that reacts to agent lifecycle events.
3. Preserve every user-facing capability of the current system: primary cycling, `/agent[s]`, subagent tools, task tools, cascade, resume.
4. Add `@name` inline dispatch as the new user-facing entry to subagents.

## Non-Goals
- No changes to `ui/` chrome ownership or to the UIBus envelope shape.
- No changes to existing skill loader, ghost completion, or other extensions.
- No persistence/format change to existing task storage on disk beyond what the rewrite naturally requires.
- No backwards compatibility shim for legacy settings keys (see Migration).

## End State

### File layout
```
extensions/
  agents/                # NEW — agent loader, primary switching, subagent spawning, @dispatch
    index.ts
    ...
  tasks/                 # NEW — TaskStore, Task* tools, auto-clear, cascade
    index.ts
    ...
  ui/                    # unchanged (sole TUI chrome owner)
  ...                    # other extensions unchanged
```
Deleted in the same change:
- `extensions/modes.ts`
- `extensions/orchestration/` (entire directory)

### settings.json
- Update `extensions` array: remove `+extensions/modes.ts` and `+extensions/orchestration/index.ts`; add `+extensions/agents/index.ts` and `+extensions/tasks/index.ts`.
- Load order MUST keep all UIBus publishers before `+extensions/ui/index.ts`. Concretely: `agents/` and `tasks/` (both publishers) load before `ui/`.
- Rename setting key `defaultAgent` → `defaultPrimaryAgent` in any settings.json tracked in this repo. **Hard break:** at runtime, the legacy `defaultAgent` key is ignored; users must update `~/.config/pi/agent/settings.json` themselves. (Surface a clear "no primary agent configured" message if neither key resolves.)

## Agent Definition Schema

Agents may be defined two ways, both supported simultaneously (opencode parity):

1. **Markdown files** with YAML frontmatter — the existing PI mechanism. Discovery locations are unchanged from today (global `agentDir/agents/`, this package's `agents/`, project-local `.pi/agents/`). Filename without `.md` is the agent name.
2. **JSON config** under an `agent` map in settings.json (e.g. `"agent": { "review": { "mode": "subagent", ... } }`). Map key is the agent name. Same option set as markdown frontmatter. JSON entries override markdown entries with the same name.

### Discriminator
- `mode: primary | subagent | all`
- **Default when absent: `all`** (matches opencode). `all` means eligible for both primary cycling and subagent invocation.
- Existing in-repo `agents/*.md` files that should NOT appear in primary cycling MUST be updated to declare `mode: subagent` explicitly as part of this PR (see Migration). Files that should be primaries declare `mode: primary`.

### Recognized fields (opencode parity)
- `description` (string) — **required for subagents**; surfaced in `@` autocomplete and Agent-tool descriptions.
- `mode` — see above.
- `model` (string `provider/model-id`) — overrides global model for primaries; for subagents, falls back to invoking primary's model when omitted.
- `prompt` (string) — system prompt. Supports `{file:./relative/path.txt}` template; path is relative to the defining file (markdown file's dir, or the settings.json file's dir for JSON entries). When `prompt` is absent for markdown agents, the markdown body below the frontmatter continues to be used as today.
- `temperature` (number).
- `steps` (number) — max agentic iterations. Legacy `maxSteps` is accepted as a deprecated alias.
- `disable` (boolean) — hides agent entirely. Legacy `enabled: false` is an accepted alias.
- `hidden` (boolean) — for `mode: subagent`, hides from `@` autocomplete; the agent remains invokable by the model via the Agent tool. No effect on `primary`/`all`.
- `tools` — accepts both opencode shape (`{ "write": false, "bash": true, "mymcp_*": false }`) AND the existing PI comma-string shape (`tools: read, bash, grep`). The comma string is treated as a deny-by-default allowlist (only listed tools enabled), preserving today's PI semantics. Marked deprecated in favor of `permission` for new configs.
- `permission` — full opencode permission map. Keys: `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `todowrite`, `webfetch`, `websearch`, `lsp`, `skill`, `question`, `doom_loop`. Each accepts either a shorthand `"allow" | "ask" | "deny"` or, for the keys opencode documents as object-capable (`read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `lsp`, `skill`), an object of glob/pattern → action. `permission.task` gates which subagents this agent may spawn via the Agent tool (glob match against subagent name).

### Retained PI-specific fields (no opencode equivalent)
All continue to parse and function exactly as today:
`prompt_mode`, `display_name`, `extensions`, `skills`, `inherit_context`, `isolated`, `memoryScope`, `thinkingLevel`, `isolation`, `run_in_background`, `enabled`. They coexist with the opencode fields above on the same agent.

### Validation — strict
- Invalid/unknown `mode:` value → fail to load that agent with a clear, named error surfaced via the standard agent-load error path. The extension as a whole must keep loading.
- Subagent missing `description` → load error for that agent (opencode parity).
- Unknown `permission` key → load error for that agent.
- Cross-mode invocation is rejected at the call site with a user-visible message:
  - Switching primary to a `mode: subagent` agent → refused.
  - Spawning a `mode: primary` agent as a subagent (Agent tool or `@name`) → refused.
  - `mode: all` is accepted by both call sites.
- Spawn calls also enforce the invoker's `permission.task` rules (deny/ask/allow) before any cross-mode check.

## Migration (performed in this PR)
1. Audit every `agents/*.md` in this repo. For each that is currently used as a primary mode, add `mode: primary`. For each currently used as a subagent only, add `mode: subagent` (explicit — required because the new default is `all`, which would otherwise add subagent-only files to primary cycling). Use `mode: all` only where intentional.
2. Update any settings.json tracked in this repo to rename `defaultAgent` → `defaultPrimaryAgent`.
3. Users' personal `~/.config/pi/...` is out of scope; document the rename in the PR description / changelog.

## UX

### Keybindings
- **Tab** cycles primary agents (those with `mode: primary` or `mode: all`) — opencode parity. The legacy `Ctrl+Shift+M` binding is retained as an alias so existing muscle memory keeps working. Both bindings are wired through a single `switch_agent` action.
- The cycle skips `disable: true` agents and never includes pure `mode: subagent` agents.

### Slash commands
- `/agent` and `/agents` are both kept; routing by singular/plural matches today's behavior. Implementation moves into `extensions/agents/` but the surface is unchanged.

### `@name` inline dispatch (NEW)
- Parsed from anywhere in the user's message — not just a leading prefix.
- A token matches an agent dispatch only when it is `@<name>` where `<name>` is the exact name of a loaded agent with `mode: subagent` or `mode: all`. Match is case-sensitive against the agent's loader-resolved name. `hidden: true` agents are still dispatchable via `@name` typed manually (per opencode: `hidden` only affects autocomplete visibility, not dispatch).
- Disambiguation from `@path/to/file`:
  - If the token contains a path separator (`/` or `\`) anywhere after the `@`, it is NEVER an agent dispatch.
  - If the token contains a `.` followed by a file-extension-like suffix, it is NEVER an agent dispatch.
  - If the bare name does not resolve to a known agent, it is NEVER an agent dispatch (falls through to whatever existing `@`-handling does, unchanged).
  - Escapes: a leading `\@name` is passed through literally with the backslash stripped (no dispatch).
- Multiple `@name` mentions in one message → spawn one subagent per match, in document order. The textual prompt passed to each subagent is the original user message with all matched `@name` tokens removed and surrounding whitespace collapsed.
- Cross-mode rejection: `@name` resolving to a `mode: primary`-only agent is rejected with a user-visible error and no spawn occurs.

### UI bus
`extensions/agents/` owns and publishes to slots: `mode`, `orchestration`, `subagentUsage`. Envelope shape unchanged (`harness.ui:publish` with `{ slot, value }`). `ui/index.ts` consumes them as today.

## Tools

Owned by `extensions/agents/`:
- `Agent` (spawn subagent)
- `get_subagent_result`
- `steer_subagent`

Owned by `extensions/tasks/`:
- `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute` (names and signatures match today).

## Inter-extension contract: agent lifecycle → tasks cascade

Decoupled via the existing event bus only — no cross-extension imports.

- `extensions/agents/` emits an agent-lifecycle event on subagent completion (success, failure, or stop). Event name and payload shape are defined inside `extensions/agents/` and documented in its file header. Whatever name is chosen MUST be added to `scripts/check-invariants.sh`'s allowed-events list so the "no stale event names" check stays green.
- `extensions/tasks/` subscribes to that event to drive cascade-on-completion of tasks created with `agentType` via `TaskExecute`.
- No shared TypeScript module between the two extensions.

## Auto-clear
Behavior preserved from current `orchestration/` implementation: tasks marked completed are auto-cleared on the same trigger and timing as today. Implementation moves into `extensions/tasks/`.

## Resume
Session resume must restore:
- Current primary agent selection.
- Open subagent list and their last-known status (as today).
- Task list state (as today).

No new persistence format is introduced; the rewrite reuses today's on-disk shapes where present.

## Verification

Required to pass before merge:
1. `bash scripts/check-build.sh` — TypeScript typecheck clean.
2. `bash scripts/check-invariants.sh` — TUI chrome ownership intact (no `setStatus`/`setWidget`/`setFooter`/`setWorkingMessage`/`setWorkingIndicator`/`setEditorComponent` calls outside `extensions/ui/`); no stale event names; allowed-events list updated for the new agent-lifecycle event.
3. Manual smoke checklist:
   - Switch primary agent via **Tab** (and via legacy `Ctrl+Shift+M` alias); verify `mode` slot updates for both bindings.
   - Define an agent in JSON under settings.json `agent` map; verify it loads and overrides a same-named markdown agent.
   - Mark a subagent `hidden: true`; verify it is absent from `@` autocomplete but still spawns when `@name` is typed manually.
   - Configure `permission.task` to deny a specific subagent; verify Agent-tool spawn is refused with a visible error.
   - `/agent` and `/agents` both work and route correctly.
   - Spawn a subagent via the `Agent` tool; verify `orchestration` and `subagentUsage` slots update; `get_subagent_result` and `steer_subagent` work.
   - Spawn via `@name` mention (leading, trailing, and mid-message positions; multiple mentions in one message).
   - Confirm `@path/to/file` is NOT treated as an agent dispatch.
   - Confirm `@unknownname` is NOT treated as an agent dispatch.
   - Confirm `@primaryOnlyAgent` is rejected with a visible error.
   - Create a task with `agentType` via `TaskCreate`, run via `TaskExecute`, and verify cascade fires when the spawned subagent ends.
   - Resume the session: primary selection, subagent list, and tasks all restored.

## Risks / Open Questions
- The schema default flip (`subagent` when `mode:` absent) is an intentional breaking change; mitigated by the in-repo audit step. External users are notified via PR description / changelog only.
- `@name` parsing must be careful around code blocks and inline code in user input — out of scope for this PRD beyond the path/extension/escape rules above; if ambiguity arises in smoke testing, address in a follow-up.

---
**Reminder:** start a new session with `/new` before creating the execution plan for this PRD.
