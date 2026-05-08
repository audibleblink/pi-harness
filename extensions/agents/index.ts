/**
 * extensions/agents/ — unified agent system (Phase 2 skeleton).
 *
 * Owns primary-mode behavior (loader + applyAgent + /agent[s] + cycling).
 * Subagent tools, @-dispatch, and lifecycle events arrive in P3/P4.
 *
 * Activation is gated by settings.agents.enabled. While that flag is off
 * (the default in P2), the legacy extensions/modes.ts continues to own
 * primary modes; modes.ts has a 5-line guard to short-circuit when the
 * flag is on, ensuring exactly one owner.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { loadAgents } from "./loader.js";
import {
	AGENT_STATE_ENTRY_TYPE,
	type AgentsState,
	applyAgent,
	updateStatus,
} from "./primary.js";
import { registerCommands } from "./commands.js";
import { registerCycling } from "./cycling.js";

interface Settings {
	defaultPrimaryAgent?: string;
	agents?: { enabled?: boolean };
}

function loadSettings(cwd: string): Settings {
	const paths = [
		join(getAgentDir(), "settings.json"),
		join(cwd, ".pi", "settings.json"),
	];
	let merged: Settings = {};
	for (const p of paths) {
		try {
			const parsed = JSON.parse(readFileSync(p, "utf-8")) as Settings;
			merged = { ...merged, ...parsed };
		} catch {
			// skip
		}
	}
	return merged;
}

export default function agentsExtension(pi: ExtensionAPI) {
	const state: AgentsState = {
		agents: new Map(),
		activeAgent: undefined,
		originalState: undefined,
		lastWrittenAgentName: undefined,
	};

	pi.registerFlag("agent", { description: "Default agent to use at startup", type: "string" });

	registerCommands(pi, state);
	registerCycling(pi, state);

	pi.on("before_agent_start", async (event) => {
		if (state.activeAgent?.body) {
			const body = state.activeAgent.body;
			const sp = state.activeAgent.promptMode === "replace"
				? body
				: `${body}\n\n${event.systemPrompt}`;
			return { systemPrompt: sp };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		const settings = loadSettings(ctx.cwd);
		if (!settings.agents?.enabled) return; // P2: opt-in only

		const { agents, errors } = loadAgents(ctx.cwd);
		state.agents = agents;
		for (const e of errors) console.error(`[agents] ${e}`);

		const agentFlag = pi.getFlag("agent");
		if (typeof agentFlag === "string" && agentFlag) {
			const a = agents.get(agentFlag);
			if (a) await applyAgent(pi, state, agentFlag, a, ctx);
			updateStatus(pi, state);
			return;
		}

		// Resume/fork/new — restore from session state (name only, no re-apply).
		if (event.reason === "resume" || event.reason === "fork" || event.reason === "new") {
			const entries = ctx.sessionManager.getEntries();
			const entry = entries
				.filter((e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === AGENT_STATE_ENTRY_TYPE)
				.pop() as { data?: { name: string } } | undefined;
			if (entry?.data?.name) {
				const a = agents.get(entry.data.name);
				if (a) {
					state.activeAgent = a;
					updateStatus(pi, state);
					return;
				}
			}
		}

		// Legacy `defaultAgent` is IGNORED (hard break). Use defaultPrimaryAgent.
		if (settings.defaultPrimaryAgent) {
			const a = agents.get(settings.defaultPrimaryAgent);
			if (a) await applyAgent(pi, state, settings.defaultPrimaryAgent, a, ctx);
			else console.error(`[agents] defaultPrimaryAgent "${settings.defaultPrimaryAgent}" not found`);
		} else {
			console.error("[agents] no primary agent configured (set defaultPrimaryAgent in settings.json)");
		}

		updateStatus(pi, state);
	});

	pi.on("turn_start", async () => {
		if (state.activeAgent && state.activeAgent.name !== state.lastWrittenAgentName) {
			pi.appendEntry(AGENT_STATE_ENTRY_TYPE, { name: state.activeAgent.name });
			state.lastWrittenAgentName = state.activeAgent.name;
		}
	});
}
