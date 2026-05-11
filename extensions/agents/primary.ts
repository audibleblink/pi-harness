/**
 * Primary-agent application. Ports applyAgent / clearAgent from modes.ts.
 *
 * State is owned by index.ts and threaded in via AgentsState. This module
 * is responsible for swapping the model, gating active tools, and tracking
 * the original (pre-agent) state for restoration.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "./loader.js";
import { publishAgentSkills, publishMode } from "./bus.js";

export interface OriginalState {
	model: Model<Api> | undefined;
	tools: string[];
}

export interface AgentsState {
	agents: Map<string, AgentDefinition>;
	activeAgent: AgentDefinition | undefined;
	originalState: OriginalState | undefined;
	lastWrittenAgentName: string | undefined;
}

export const AGENT_STATE_ENTRY_TYPE = "agent-state";
export const CLEAR_AGENT_KEY = "(none)";
export const NO_AGENTS_MSG =
	"No agents found. Create agent files in <agentDir>/agents/, this package's agents/, or <cwd>/.pi/agents/";

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const i = ref.indexOf("/");
	if (i === -1) return undefined;
	return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

export async function applyAgent(
	pi: ExtensionAPI,
	state: AgentsState,
	name: string,
	agent: AgentDefinition,
	ctx: ExtensionContext,
): Promise<void> {
	if (state.activeAgent === undefined) {
		state.originalState = { model: ctx.model, tools: pi.getActiveTools() };
	}

	if (agent.model) {
		const ref = parseModelRef(agent.model);
		if (ref) {
			const model = ctx.modelRegistry.find(ref.provider, ref.modelId);
			if (model) {
				const ok = await pi.setModel(model);
				if (!ok) ctx.ui.notify(`Agent "${name}": No API key for ${ref.provider}/${ref.modelId}`, "warning");
			} else {
				ctx.ui.notify(`Agent "${name}": Model ${ref.provider}/${ref.modelId} not found`, "warning");
			}
		} else {
			ctx.ui.notify(`Agent "${name}": Invalid model format "${agent.model}" (expected provider/model-id)`, "warning");
		}
	}

	if (agent.tools && agent.tools.length > 0) {
		const all = new Set(pi.getAllTools().map((t) => t.name));
		pi.setActiveTools(agent.tools.filter((t) => all.has(t)));
	}

	state.activeAgent = agent;
	publishAgentSkills(pi, agent.skills ?? null);
}

export async function clearAgent(
	pi: ExtensionAPI,
	state: AgentsState,
	ctx: ExtensionContext,
): Promise<void> {
	const hadAgent = state.activeAgent !== undefined;
	state.activeAgent = undefined;
	state.lastWrittenAgentName = undefined;
	if (state.originalState) {
		if (state.originalState.model) await pi.setModel(state.originalState.model);
		pi.setActiveTools(state.originalState.tools);
	}
	publishAgentSkills(pi, null);
	// Persist a sentinel so resume/fork/new restoration knows the user explicitly
	// cleared. Without this, the last `agent-state` entry would be re-applied stale.
	if (hadAgent) pi.appendEntry(AGENT_STATE_ENTRY_TYPE, { name: null });
	ctx.ui.notify("Agent cleared, defaults restored", "info");
	updateStatus(pi, state);
}

export function updateStatus(pi: ExtensionAPI, state: AgentsState): void {
	if (state.activeAgent) {
		publishMode(pi, { label: state.activeAgent.name, model: state.activeAgent.model });
	} else if (state.agents.size > 0) {
		publishMode(pi, { label: "pi" });
	} else {
		publishMode(pi, null);
	}
}
