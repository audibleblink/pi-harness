---
name: pi
description: agent harness docs for pi. invoke when user asks to modify 'itself', 'pi {extensions,skills,themes,prompts}'
---

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Installed package root: $HOME/.local/share/mise/installs/node/24.7.0/lib/node_modules/@earendil-works/pi-coding-agent
- Main documentation: $HOME/.local/share/mise/installs/node/24.7.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md
- Additional docs: $HOME/.local/share/mise/installs/node/24.7.0/lib/node_modules/@earendil-works/pi-coding-agent/docs
- Examples: $HOME/.local/share/mise/installs/node/24.7.0/lib/node_modules/@earendil-works/pi-coding-agent/examples (extensions, custom tools, SDK)
- User config dir on this machine: $PI_CODING_AGENT_DIR, usually $HOME/.config/pi/agent. Do not assume ~/.pi/agent even if older docs mention it.
- If the installed package path is missing, locate the current package under $HOME/.local/share/mise/installs/node/*/lib/node_modules/@earendil-works/pi-coding-agent before failing.
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)
