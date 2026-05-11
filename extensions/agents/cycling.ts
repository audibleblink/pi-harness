/**
 * Primary-agent cycling. Registers a single `switch_agent` action bound to
 * BOTH **Tab** (opencode parity) and `Ctrl+Shift+M` (legacy alias).
 *
 * Cycles only agents with mode: primary | all and not disable: true (the
 * loader already filters non-primary agents from state.agents).
 *
 * Tab precedence note: pi.registerShortcut wires a global handler. The
 * editor in extensions/ui/ owns its own Tab handling for ghost-completion
 * tab-acceptance; that handler runs first when the input is non-empty (it
 * decides whether to consume Tab or fall through). When the editor input
 * is empty AND no completion is in progress, Tab falls through to this
 * shortcut and triggers `switch_agent`. Mirrors the pattern used by other
 * UIBus-driven editor integrations.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import {
	type AgentsState,
	applyAgent,
	clearAgent,
	CLEAR_AGENT_KEY,
	NO_AGENTS_MSG,
	updateStatus,
} from "./primary.js";

async function switch_agent(pi: ExtensionAPI, state: AgentsState, ctx: ExtensionContext): Promise<void> {
	const names = Array.from(state.agents.keys()).sort();
	if (names.length === 0) {
		ctx.ui.notify(NO_AGENTS_MSG, "warning");
		return;
	}
	const cycle = [CLEAR_AGENT_KEY, ...names];
	const cur = state.activeAgent?.name ?? CLEAR_AGENT_KEY;
	const idx = cycle.indexOf(cur);
	const next = cycle[(idx === -1 ? 0 : idx + 1) % cycle.length];
	if (next === CLEAR_AGENT_KEY) { await clearAgent(pi, state, ctx); return; }
	const agent = state.agents.get(next);
	if (!agent) return;
	await applyAgent(pi, state, next, agent, ctx);
	updateStatus(pi, state);
}

export function registerCycling(pi: ExtensionAPI, state: AgentsState): void {
	const handler = (ctx: ExtensionContext) => switch_agent(pi, state, ctx);
	// Tab is reserved for editor (ghost-completion accept, slash-command autocomplete).
	pi.registerShortcut(Key.ctrlShift("m"), { description: "switch_agent (Ctrl+Shift+M)", handler });
}
