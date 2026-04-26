/**
 * Agent Mode Extension
 *
 * OpenCode-style default agent system for PI. Define agents as markdown files
 * with YAML frontmatter, select a default agent, and have all prompts processed
 * through that agent with full real-time visibility.
 *
 * Agent definitions (merged, later sources override earlier ones):
 * 1. <agentDir>/agents/*.md                  (global user — $PI_CODING_AGENT_DIR/agents)
 * 2. <thisExtensionPackageRoot>/agents/*.md  (this package — e.g. pi-harness/agents)
 * 3. <cwd>/.pi/agents/*.md                   (project-local)
 *
 * Pi has no built-in multi-path discovery for agent definitions (unlike skills),
 * so this extension finds its own package root via import.meta.url and scans an
 * `agents/` directory there. That makes agent .md files in the package that ships
 * this extension (e.g. a pi-harness installed via settings.packages) discoverable
 * without symlinks or extra config.
 *
 * Example agent file (e.g., ~/.pi/agent/agents/planner.md):
 * ```markdown
 * ---
 * name: planner
 * description: Planning specialist
 * model: anthropic/claude-sonnet-4-5
 * tools: read, bash, grep, find, ls
 * ---
 * You are a planning specialist. Create detailed plans before implementation.
 * Focus on understanding requirements fully before proposing solutions.
 * ```
 *
 * Usage:
 * - `/agent` — Show selector to switch agents
 * - `/agent <name>` — Switch to agent directly
 * - `Ctrl+Shift+M` — Cycle through available agents
 * - Set default in `.pi/settings.json`: `{ "defaultAgent": "planner" }`
 * - Agent runs inline (same process) with full streaming visibility
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentDefinition {
	name: string;
	description?: string;
	model?: string;
	tools?: string[];
	body: string;
}

interface Settings {
	defaultAgent?: string;
}

interface OriginalState {
	model: Model<Api> | undefined;
	tools: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CLEAR_AGENT_KEY = "(none)";
const AGENT_STATE_ENTRY_TYPE = "agent-state";
const AGENT_BANNER_WIDGET = "agent-mode-banner";
const NO_AGENTS_MSG = "No agents found. Create agent files in <agentDir>/agents/, this package's agents/, or <cwd>/.pi/agents/";

/**
 * Resolve the package root that ships this extension by walking up from this
 * file until we find a `package.json` or an `agents/` sibling. Returns
 * undefined if neither is found before the filesystem root.
 */
function findExtensionPackageRoot(): string | undefined {
	let dir: string;
	try {
		dir = dirname(fileURLToPath(import.meta.url));
	} catch {
		return undefined;
	}

	let prev = "";
	while (dir && dir !== prev) {
		if (existsSync(join(dir, "package.json")) || existsSync(join(dir, "agents"))) {
			return dir;
		}
		prev = dir;
		dir = dirname(dir);
	}
	return undefined;
}

const EXTENSION_PACKAGE_ROOT = findExtensionPackageRoot();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadSettings(cwd: string): Settings {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");

	let settings: Settings = {};

	for (const path of [globalPath, projectPath]) {
		try {
			const content = readFileSync(path, "utf-8");
			const parsed = JSON.parse(content) as Settings;
			settings = { ...settings, ...parsed };
		} catch {
			// skip
		}
	}

	return settings;
}

function findAgentFiles(...dirs: string[]): string[] {
	const files: string[] = [];
	for (const dir of dirs) {
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".md")) {
					files.push(join(dir, entry.name));
				}
			}
		} catch {
			// skip
		}
	}
	return files;
}

function parseAgentFile(filePath: string): AgentDefinition | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);
	if (!body && !fm["name"]) return undefined;

	const tools = typeof fm["tools"] === "string"
		? fm["tools"].split(",").map((t: string) => t.trim()).filter(Boolean)
		: undefined;

	const name = typeof fm["name"] === "string" && fm["name"]
		? fm["name"]
		: basename(filePath, ".md");

	return {
		name,
		description: typeof fm["description"] === "string" ? fm["description"] : undefined,
		model: typeof fm["model"] === "string" ? fm["model"] : undefined,
		tools,
		body: body.trim(),
	};
}

function loadAgents(cwd: string): Map<string, AgentDefinition> {
	const globalDir = join(getAgentDir(), "agents");
	const packageDir = EXTENSION_PACKAGE_ROOT ? join(EXTENSION_PACKAGE_ROOT, "agents") : undefined;
	const projectDir = join(cwd, ".pi", "agents");

	// Later sources override earlier ones: global → package → project.
	const dirs = [globalDir, packageDir, projectDir].filter((d): d is string => Boolean(d));

	const agents = new Map<string, AgentDefinition>();
	for (const dir of dirs) {
		for (const file of findAgentFiles(dir)) {
			const agent = parseAgentFile(file);
			if (agent) agents.set(agent.name, agent);
		}
	}

	return agents;
}

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const slashIdx = ref.indexOf("/");
	if (slashIdx === -1) return undefined;
	return {
		provider: ref.slice(0, slashIdx),
		modelId: ref.slice(slashIdx + 1),
	};
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function agentModeExtension(pi: ExtensionAPI) {
	let agents = new Map<string, AgentDefinition>();
	let activeAgent: AgentDefinition | undefined;
	let originalState: OriginalState | undefined;
	let lastWrittenAgentName: string | undefined;

	pi.registerFlag("agent", {
		description: "Default agent to use at startup",
		type: "string",
	});

	async function applyAgent(name: string, agent: AgentDefinition, ctx: ExtensionContext): Promise<void> {
		// Snapshot state before first agent is applied
		if (activeAgent === undefined) {
			originalState = {
				model: ctx.model,
				tools: pi.getActiveTools(),
			};
		}

		if (agent.model) {
			const ref = parseModelRef(agent.model);
			if (ref) {
				const model = ctx.modelRegistry.find(ref.provider, ref.modelId);
				if (model) {
					const success = await pi.setModel(model);
					if (!success) {
						ctx.ui.notify(`Agent "${name}": No API key for ${ref.provider}/${ref.modelId}`, "warning");
					}
				} else {
					ctx.ui.notify(`Agent "${name}": Model ${ref.provider}/${ref.modelId} not found`, "warning");
				}
			} else {
				ctx.ui.notify(`Agent "${name}": Invalid model format "${agent.model}" (expected provider/model-id)`, "warning");
			}
		}

		// Replace the tool set with the agent's whitelist. Agent frontmatter `tools:`
		// is authoritative — listed tools only, nothing more. Tools not listed (e.g.
		// write/edit for a read-only agent) become unavailable to the LLM.
		if (agent.tools && agent.tools.length > 0) {
			const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
			const validTools = agent.tools.filter((t) => allToolNames.has(t));
			pi.setActiveTools(validTools);
		}

		activeAgent = agent;
	}

	async function clearAgent(ctx: ExtensionContext): Promise<void> {
		activeAgent = undefined;
		lastWrittenAgentName = undefined;
		if (originalState) {
			if (originalState.model) {
				await pi.setModel(originalState.model);
			}
			pi.setActiveTools(originalState.tools);
		}
		ctx.ui.notify("Agent cleared, defaults restored", "info");
		updateStatus(ctx);
	}

	function buildAgentDescription(agent: AgentDefinition): string {
		const parts: string[] = [];
		if (agent.model) parts.push(agent.model);
		if (agent.tools) parts.push(`tools:${agent.tools.join(",")}`);
		if (agent.description) parts.push(agent.description);
		return parts.join(" | ") || "No configuration";
	}

	async function showAgentPicker(
		ctx: ExtensionContext,
		items: SelectItem[],
		headerText: string,
		maxVisible: number,
	): Promise<string | null> {
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold(headerText))));

			const selectList = new SelectList(items, Math.min(items.length, maxVisible), {
				selectedPrefix: (text: string) => theme.fg("accent", text),
				selectedText: (text: string) => theme.fg("accent", text),
				description: (text: string) => theme.fg("muted", text),
				scrollInfo: (text: string) => theme.fg("dim", text),
				noMatch: (text: string) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	async function handleAgentSelection(ctx: ExtensionContext, result: string | null): Promise<void> {
		if (!result) return;

		if (result === CLEAR_AGENT_KEY) {
			await clearAgent(ctx);
			return;
		}

		const agent = agents.get(result);
		if (agent) {
			await applyAgent(result, agent, ctx);
			updateStatus(ctx);
		}
	}

	async function showAgentSelector(ctx: ExtensionContext): Promise<void> {
		if (agents.size === 0) {
			ctx.ui.notify(NO_AGENTS_MSG, "warning");
			return;
		}

		const items: SelectItem[] = Array.from(agents.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, agent]) => ({
				value: name,
				label: name === activeAgent?.name ? `${name} (active)` : name,
				description: buildAgentDescription(agent),
			}));

		items.push({
			value: CLEAR_AGENT_KEY,
			label: CLEAR_AGENT_KEY,
			description: "Clear active agent, restore defaults",
		});

		const result = await showAgentPicker(ctx, items, "Select Agent", 10);
		await handleAgentSelection(ctx, result);
	}

	function updateStatus(ctx: ExtensionContext) {
		const t = ctx.ui.theme;
		if (activeAgent) {
			const label = t.fg("syntaxKeyword", `▸ ${activeAgent.name}`);
			const model = activeAgent.model ? t.fg("muted", ` ${activeAgent.model}`) : "";
			ctx.ui.setStatus(AGENT_BANNER_WIDGET, label + model);
		} else if (agents.size > 0) {
			ctx.ui.setStatus(
				AGENT_BANNER_WIDGET,
				t.fg("syntaxKeyword", "▸ ") + t.fg("muted", "pi"),
			);
		} else {
			ctx.ui.setStatus(AGENT_BANNER_WIDGET, undefined);
		}
	}

	async function cycleAgent(ctx: ExtensionContext): Promise<void> {
		const agentNames = Array.from(agents.keys()).sort();
		if (agentNames.length === 0) {
			ctx.ui.notify(NO_AGENTS_MSG, "warning");
			return;
		}

		const cycleList = [CLEAR_AGENT_KEY, ...agentNames];
		const currentName = activeAgent?.name ?? CLEAR_AGENT_KEY;
		const currentIndex = cycleList.indexOf(currentName);
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleList.length;
		const nextName = cycleList[nextIndex];

		if (nextName === CLEAR_AGENT_KEY) {
			await clearAgent(ctx);
			return;
		}

		const agent = agents.get(nextName);
		if (!agent) return;

		await applyAgent(nextName, agent, ctx);
		updateStatus(ctx);
	}

	// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────

	// Use Ctrl+Shift+M to avoid conflict with pi-subagents (Ctrl+Shift+A)
	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle agents",
		handler: async (ctx) => {
			await cycleAgent(ctx);
		},
	});

	// ─── Commands ─────────────────────────────────────────────────────────────────

	pi.registerCommand("agent", {
		description: "Switch active agent",
		handler: async (args, ctx) => {
			if (args?.trim()) {
				const name = args.trim();

				if (name === CLEAR_AGENT_KEY || name === "none" || name === "clear") {
					await clearAgent(ctx);
					return;
				}

				const agent = agents.get(name);
				if (!agent) {
					const available = Array.from(agents.keys()).join(", ") || "(none defined)";
					ctx.ui.notify(`Unknown agent "${name}". Available: ${available}`, "error");
					return;
				}

				await applyAgent(name, agent, ctx);
				updateStatus(ctx);
				return;
			}

			await showAgentSelector(ctx);
		},
	});

	// ─── Event Handlers ─────────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (activeAgent?.body) {
			return {
				systemPrompt: `${activeAgent.body}\n\n${event.systemPrompt}`,
			};
		}
	});

	pi.on("session_start", async (event, ctx) => {
		agents = loadAgents(ctx.cwd);

		// --agent flag takes highest priority
		const agentFlag = pi.getFlag("agent");
		if (typeof agentFlag === "string" && agentFlag) {
			const agent = agents.get(agentFlag);
			if (agent) {
				await applyAgent(agentFlag, agent, ctx);
			}
			updateStatus(ctx);
			return;
		}

		// On resume/fork, restore from session state (name only — no re-apply of model/tools)
		if (event.reason === "resume" || event.reason === "fork") {
			const entries = ctx.sessionManager.getEntries();
			const agentEntry = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === AGENT_STATE_ENTRY_TYPE)
				.pop() as { data?: { name: string } } | undefined;

			if (agentEntry?.data?.name) {
				const agent = agents.get(agentEntry.data.name);
				if (agent) {
					activeAgent = agent;
					updateStatus(ctx);
					return;
				}
			}
		}

		const settings = loadSettings(ctx.cwd);
		if (settings.defaultAgent) {
			const agent = agents.get(settings.defaultAgent);
			if (agent) {
				await applyAgent(settings.defaultAgent, agent, ctx);
			}
		}

		updateStatus(ctx);
	});

	pi.on("turn_start", async () => {
		// Only write when the active agent changes — avoids unbounded session log growth
		if (activeAgent && activeAgent.name !== lastWrittenAgentName) {
			pi.appendEntry(AGENT_STATE_ENTRY_TYPE, { name: activeAgent.name });
			lastWrittenAgentName = activeAgent.name;
		}
	});
}
