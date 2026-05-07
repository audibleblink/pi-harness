# orchestration

Subagent spawning + task tracking, merged into a single pi extension.

## What it provides

**Tools (LLM-callable):**
- `Agent` — spawn a subagent (foreground or background)
- `get_subagent_result` — retrieve/wait on a background agent
- `steer_subagent` — send a steering message to a running agent
- `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate` — task CRUD
- `TaskOutput`, `TaskStop` — process control for task-backed agents
- `TaskExecute` — start agent execution for tasks with `agentType` set

**Slash commands:**
- `/agents` — manage agent types (view, edit defaults, configure invocation)
- `/tasks` — view/create/clear tasks
- `/usage` — token+cost breakdown for parent and subagents

**UI:** publishes `orchestration` and `subagentUsage` slots on the UIBus
(`extensions/ui/bus.ts`). All chrome rendering lives in `extensions/ui/`.

## Agent type discovery

On every `Agent` call (and at extension load) the registry is rebuilt from these
sources, in increasing priority (later wins on name collision):

1. **Built-in defaults** — `default-agents.ts` (`general-purpose`, `Explore`, `Plan`, etc.)
2. **Legacy personal** — `~/.pi/agent/agents/*.md` (backward compat, read-only)
3. **Personal (XDG)** — `$PI_CODING_AGENT_DIR/agents/` or `~/.config/pi/agent/agents/*.md`
4. **Packages** — for every entry in `packages` of either settings.json
   (global `~/.config/pi/agent/settings.json`, project `<cwd>/.pi/settings.json`),
   the path `<packageRoot>/agents/*.md` is scanned.
   - Local sources (`/abs`, `~/...`, `./rel`) resolve directly.
   - Git URLs resolve to pi's cache: `~/.config/pi/agent/git/<host>/<owner>/<repo>`.
5. **Project** — `<cwd>/.pi/agents/*.md` (highest priority)

A custom agent named `Explore` overrides the built-in `Explore`.

## Agent file format

```markdown
---
display_name: Explore                 # optional; falls back to filename
description: Fast read-only recon     # shown in /agents and tool descriptions
tools: read, bash, grep, find, ls     # csv; omit = all builtins; "none" = no builtins
disallowed_tools: write, edit         # optional blocklist
extensions: true                      # true | false | "none" | csv of extension names
skills: true                          # true | false | "none" | csv of skill names
model: anthropic/claude-haiku-4-5     # optional override; "provider/id" or fuzzy name
thinking: medium                      # off | minimal | low | medium | high | xhigh
max_turns: 0                          # 0 = unlimited
prompt_mode: replace                  # append | replace (default replace)
inherit_context: false                # fork parent conversation if true
run_in_background: false
isolated: false                       # true = no extension/MCP tools
memory: project                       # user | project | local
isolation: worktree                   # only "worktree" recognized
enabled: true                         # explicit false disables
---

System prompt body goes here.
```

### Field reference (parser → `extensions/orchestration/custom-agents.ts`)

| Frontmatter | Type | Notes |
|---|---|---|
| `display_name` | string | optional |
| `description` | string | falls back to agent name |
| `tools` | csv \| `"none"` | omitted = all builtins; `"none"` or empty = no builtins |
| `disallowed_tools` | csv | optional blocklist |
| `extensions` (alias `inherit_extensions`) | bool \| csv \| `"none"` | inherit-control |
| `skills` (alias `inherit_skills`) | bool \| csv \| `"none"` | inherit-control |
| `model` | string | provider/id or fuzzy name |
| `thinking` | enum | `off`/`minimal`/`low`/`medium`/`high`/`xhigh` |
| `max_turns` | non-neg int | `0` = unlimited |
| `prompt_mode` | `append` \| `replace` | default `replace`; anything not `"append"` is `replace` |
| `inherit_context` | bool | strict `=== true` |
| `run_in_background` | bool | strict `=== true` |
| `isolated` | bool | strict `=== true` |
| `memory` | `user`/`project`/`local` | other values ignored |
| `isolation` | `"worktree"` | only literal recognized |
| `enabled` | bool | default `true`; explicit `false` disables |

YAML is parsed by `parseFrontmatter` (real YAML — `#` comments are stripped).

## Tasks

Persistence is controlled by `taskScope` in `<cwd>/.pi/tasks-config.json`:

| `taskScope` | Storage |
|---|---|
| `memory` | in-process only |
| `session` (default) | `<cwd>/.pi/tasks/tasks-<sessionId>.json` |
| `project` | `<cwd>/.pi/tasks/tasks.json` |

Other config keys:
- `autoCascade` (default `false`) — when a task with `agentType` completes, auto-spawn agents for any unblocked dependents.
- `autoClearCompleted` (default `on_list_complete`) — `never` | `on_list_complete` | `on_task_complete`.

## Environment variables

- `PI_TASKS` — overrides task store path. `off` disables persistence; absolute/relative path = explicit file.
- `PI_TASKS_DEBUG` — enables `[orchestration]` debug logging on stderr.
- `PI_CODING_AGENT_DIR` — overrides the personal agents/settings dir (otherwise `~/.config/pi/agent`).

## Layout

```
index.ts            # extension entry — tools, commands, event wiring
agent-manager.ts    # spawn/abort/track lifecycle
agent-runner.ts     # actual session execution + steer
agent-types.ts      # registry (defaults + custom merged)
agent-display.ts    # status/activity rendering helpers
custom-agents.ts    # .md frontmatter loader (paths above)
default-agents.ts   # built-in agent configs
group-join.ts       # batched completion notifications
auto-clear.ts       # task auto-clear scheduling
task-store.ts       # task persistence
tasks-config.ts     # <cwd>/.pi/tasks-config.json
output-file.ts      # background-agent transcript streaming
worktree.ts         # git worktree isolation
memory.ts           # per-agent memory scopes
model-resolver.ts   # fuzzy model lookup
invocation-config.ts# merge frontmatter + Agent() params
process-tracker.ts  # external process tracking for TaskOutput/Stop
conversation-viewer.ts # /agents conversation view
settings-menu.ts    # /agents config UI
prompts.ts          # system prompt assembly
skill-loader.ts     # skill filtering by frontmatter
context.ts, env.ts, types.ts, task-types.ts
```

## Troubleshooting

**Custom agents not appearing.** Run `/agents` — the list reflects exactly what
`loadCustomAgents(cwd)` discovered. If a package's `agents/*.md` files are
missing, verify the package source resolves to a real local directory (or, for
git packages, that the repo has been cloned to `~/.config/pi/agent/git/...`).

**Agent runs but ignores frontmatter.** Confirm the file starts with `---` on
its own line and ends frontmatter with `---`. Anything before the opening `---`
disables frontmatter parsing entirely.
