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
import { createSubagentRuntime } from "./subagent-runner.js";
import { registerSubagentTools } from "./subagent-tools.js";
import { extractAtDispatches } from "./at-dispatch.js";
import { createAgentAtAutocompleteFactory } from "./at-autocomplete.js";
import { dispatchSpawn, PERMISSION_ASK_EVENT, type PermissionAskPayload } from "./spawn.js";
import type { AgentDef } from "../_agent-schema/types.js";

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
	// Load-time gate: while agents.enabled is off, the legacy modes.ts owns
	// primary-mode behavior (including the --agent flag, /agent[s] commands,
	// and Tab/Ctrl+Shift+M cycling). Stay completely inert to avoid duplicate
	// registrations.
	const bootSettings = loadSettings(process.cwd());
	if (!bootSettings.agents?.enabled) return;

	const state: AgentsState = {
		agents: new Map(),
		activeAgent: undefined,
		originalState: undefined,
		lastWrittenAgentName: undefined,
	};
	let allDefs: Map<string, AgentDef> = new Map();

	pi.registerFlag("agent", { description: "Default agent to use at startup", type: "string" });

	registerCommands(pi, state);
	registerCycling(pi, state);

	// Subagent tools (Agent, get_subagent_result, steer_subagent) + lifecycle.
	const subagentRuntime = createSubagentRuntime(pi);
	registerSubagentTools(pi, subagentRuntime, () => state.activeAgent?.permission);

	pi.on("session_shutdown", async () => {
		subagentRuntime.dispose();
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		subagentRuntime.setCurrentCtx(ctx);
		subagentRuntime.schedulePublish();
	});

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

		subagentRuntime.setCurrentCtx(ctx);
		subagentRuntime.manager.clearCompleted();
		subagentRuntime.schedulePublish();

		const { agents, defs, errors } = loadAgents(ctx.cwd);
		state.agents = agents;
		allDefs = defs;
		for (const e of errors) console.error(`[agents] ${e}`);

		ctx.ui.addAutocompleteProvider(createAgentAtAutocompleteFactory(() => allDefs));

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

	// @-mention dispatch: rewrite user input, spawn one subagent per match.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
		const { strippedMessage, dispatches } = extractAtDispatches(event.text, allDefs);
		if (dispatches.length === 0) return;

		const invokerPermission = state.activeAgent?.permission;

		// Fire spawns asynchronously after the input event resolves so we don't
		// block input handling.
		setImmediate(async () => {
			for (const d of dispatches) {
				if (d.rejected === "primary-only") {
					console.error(`[agents] @${d.name}: rejected — agent is primary-only (cannot dispatch as subagent)`);
					ctx.ui.notify(`@${d.name}: cannot dispatch — agent is primary-only`, "warning");
					continue;
				}
				const result = await dispatchSpawn(
					{
						invokerPermission,
						emitAsk: (payload: PermissionAskPayload) => pi.events.emit(PERMISSION_ASK_EVENT, payload),
						performSpawn: async (name, prompt) => {
							try {
								const id = subagentRuntime.spawn(name, prompt, { isBackground: true });
								return { agentId: id };
							} catch (e) {
								return { error: e instanceof Error ? e.message : String(e) };
							}
						},
					},
					d.name,
					strippedMessage,
				);
				if (result.kind === "denied") {
					console.error(`[agents] @${d.name}: rejected — task-permission-denied`);
					ctx.ui.notify(`@${d.name}: rejected by permission.task`, "warning");
				} else if (result.kind === "error") {
					console.error(`[agents] @${d.name}: ${result.message}`);
					ctx.ui.notify(`@${d.name}: ${result.message}`, "error");
				}
			}
		});

		return { action: "transform", text: strippedMessage, images: event.images };
	});

	pi.on("turn_start", async () => {
		if (state.activeAgent && state.activeAgent.name !== state.lastWrittenAgentName) {
			pi.appendEntry(AGENT_STATE_ENTRY_TYPE, { name: state.activeAgent.name });
			state.lastWrittenAgentName = state.activeAgent.name;
		}
	});
}
