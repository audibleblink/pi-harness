/**
 * Slash commands for extensions/agents/: `/agent` and `/agents` (selector +
 * direct-switch). Surface unchanged from modes.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	type AgentsState,
	applyAgent,
	clearAgent,
	CLEAR_AGENT_KEY,
	NO_AGENTS_MSG,
	updateStatus,
} from "./primary.js";

function buildAgentDescription(agent: { model?: string; tools?: string[]; description?: string }): string {
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
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(headerText))));

		const list = new SelectList(items, Math.min(items.length, maxVisible), {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		list.onSelect = (it) => done(it.value);
		list.onCancel = () => done(null);

		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render(width: number) { return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
		};
	});
}

async function showAgentSelector(pi: ExtensionAPI, state: AgentsState, ctx: ExtensionContext): Promise<void> {
	if (state.agents.size === 0) {
		ctx.ui.notify(NO_AGENTS_MSG, "warning");
		return;
	}
	const items: SelectItem[] = Array.from(state.agents.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, agent]) => ({
			value: name,
			label: name === state.activeAgent?.name ? `${name} (active)` : name,
			description: buildAgentDescription(agent),
		}));
	items.push({
		value: CLEAR_AGENT_KEY,
		label: CLEAR_AGENT_KEY,
		description: "Clear active agent, restore defaults",
	});
	const result = await showAgentPicker(ctx, items, "Select Agent", 10);
	if (!result) return;
	if (result === CLEAR_AGENT_KEY) { await clearAgent(pi, state, ctx); return; }
	const agent = state.agents.get(result);
	if (agent) {
		await applyAgent(pi, state, result, agent, ctx);
		updateStatus(pi, state);
	}
}

function makeHandler(pi: ExtensionAPI, state: AgentsState) {
	return async (args: string | undefined, ctx: ExtensionContext) => {
		if (args?.trim()) {
			const name = args.trim();
			if (name === CLEAR_AGENT_KEY || name === "none" || name === "clear") {
				await clearAgent(pi, state, ctx);
				return;
			}
			const agent = state.agents.get(name);
			if (!agent) {
				const available = Array.from(state.agents.keys()).join(", ") || "(none defined)";
				ctx.ui.notify(`Unknown agent "${name}". Available: ${available}`, "error");
				return;
			}
			await applyAgent(pi, state, name, agent, ctx);
			updateStatus(pi, state);
			return;
		}
		await showAgentSelector(pi, state, ctx);
	};
}

export function registerCommands(pi: ExtensionAPI, state: AgentsState): void {
	const handler = makeHandler(pi, state);
	pi.registerCommand("agent", { description: "Switch active agent", handler });
	pi.registerCommand("agents", { description: "Switch active agent", handler });
}
