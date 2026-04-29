---
display_name: Agent
description: General-purpose agent for complex, multi-step tasks
tools: read, bash, edit, write, grep, find, ls   # omit = all builtins; "none" = no builtins
# disallowed_tools:       # optional blocklist
# extensions: true        # true | false | "none" | csv of extension names
# skills: true            # true | false | "none" | csv of skill names
# model: anthropic/claude-sonnet-4-5
# thinking: medium        # off | minimal | low | medium | high | xhigh
# max_turns: 0            # 0 = unlimited
prompt_mode: append       # append | replace
inherit_context: false
run_in_background: true
isolated: false
# memory: project         # user | project | local
# isolation: worktree
enabled: true
---

# Additional instructions appended to the default system prompt.

