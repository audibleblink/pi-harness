/**
 * Subagent tool registrations: Agent, get_subagent_result, steer_subagent.
 *
 * Schemas + handler logic for agent spawning, result retrieval, and steering.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type AgentActivity,
	type AgentDetails,
	describeActivity,
	formatDuration,
	formatMs,
	formatTokens,
	formatTurns,
	getDisplayName,
	getPromptModeLabel,
	SPINNER,
} from "./internal/agent-display.js";
import {
	getAgentConversation,
	getDefaultMaxTurns,
	normalizeMaxTurns,
	steerAgent,
} from "./internal/agent-runner.js";
import {
	getAgentConfig,
	getAvailableTypes,
	getDefaultAgentNames,
	getUserAgentNames,
	registerAgents,
	resolveType,
} from "./internal/agent-types.js";
import { loadCustomAgents } from "./internal/custom-agents.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./internal/invocation-config.js";
import { resolveModel } from "./internal/model-resolver.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./internal/output-file.js";
import type { SubagentType } from "./internal/types.js";
import type { SubagentRuntime } from "./subagent-runner.js";
import type { PermissionMap } from "../_agent-schema/types.js";
import { checkTaskPermission, PERMISSION_ASK_EVENT } from "./spawn.js";

function textResult(msg: string, details?: AgentDetails) {
	return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

function safeUsage(session: { getSessionStats(): { tokens?: { total?: number }; cost?: number } } | undefined): { tokens: number; cost: number } {
	if (!session) return { tokens: 0, cost: 0 };
	try {
		const stats = session.getSessionStats();
		return { tokens: stats.tokens?.total ?? 0, cost: stats.cost ?? 0 };
	} catch { return { tokens: 0, cost: 0 }; }
}

function safeFormatTokens(session: { getSessionStats(): { tokens: { total: number } } } | undefined): string {
	if (!session) return "";
	try { return formatTokens(session.getSessionStats().tokens.total); } catch { return ""; }
}

function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
	const state: AgentActivity = {
		activeTools: new Map(), toolUses: 0, turnCount: 1, maxTurns,
		tokens: "", responseText: "", session: undefined,
	};
	const callbacks = {
		onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
			if (activity.type === "start") {
				state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
			} else {
				for (const [key, name] of state.activeTools) {
					if (name === activity.toolName) { state.activeTools.delete(key); break; }
				}
				state.toolUses++;
			}
			state.tokens = safeFormatTokens(state.session);
			onStreamUpdate?.();
		},
		onTextDelta: (_delta: string, fullText: string) => {
			state.responseText = fullText;
			onStreamUpdate?.();
		},
		onTurnEnd: (turnCount: number) => {
			state.turnCount = turnCount;
			onStreamUpdate?.();
		},
		onSessionCreated: (session: any) => {
			state.session = session;
		},
	};
	return { state, callbacks };
}

function getStatusNote(status: string): string {
	switch (status) {
		case "aborted": return " (aborted — max turns exceeded, output may be incomplete)";
		case "steered": return " (wrapped up — reached turn limit)";
		case "stopped": return " (stopped by user)";
		default: return "";
	}
}

function buildDetails(
	base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
	record: { toolUses: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any },
	activity?: AgentActivity,
	overrides?: Partial<AgentDetails>,
): AgentDetails {
	return {
		...base,
		toolUses: record.toolUses,
		tokens: safeFormatTokens(record.session),
		turnCount: activity?.turnCount,
		maxTurns: activity?.maxTurns,
		durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
		status: record.status as AgentDetails["status"],
		agentId: record.id,
		error: record.error,
		...overrides,
	};
}

function getModelLabelFromConfig(model: string): string {
	const name = model.includes("/") ? model.split("/").pop()! : model;
	return name.replace(/-\d{8}$/, "");
}

function buildTypeListText(): string {
	const defaultNames = getDefaultAgentNames();
	const userNames = getUserAgentNames();
	const defaultDescs = defaultNames.map((name) => {
		const cfg = getAgentConfig(name);
		const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
		return `- ${name}: ${cfg?.description ?? name}${modelSuffix}`;
	});
	const customDescs = userNames.map((name) => {
		const cfg = getAgentConfig(name);
		return `- ${name}: ${cfg?.description ?? name}`;
	});
	return [
		"Default agents:",
		...defaultDescs,
		...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
		"",
		"Custom agents defined in .pi/agents/<name>.md (project) or $PI_CODING_AGENT_DIR/agents/<name>.md",
	].join("\n");
}

export function registerSubagentTools(
	pi: ExtensionAPI,
	runtime: SubagentRuntime,
	getInvokerPermission: () => PermissionMap | undefined = () => undefined,
): void {
	const reloadCustomAgents = () => {
		const userAgents = loadCustomAgents(process.cwd());
		registerAgents(userAgents);
	};
	reloadCustomAgents();

	const typeListText = buildTypeListText();
	const { manager, agentActivity } = runtime;

	// ─── Agent ───────────────────────────────────────────────────────────────
	pi.registerTool<any, AgentDetails>({
		name: "Agent",
		label: "Agent",
		description: `Launch a sub-agent to handle a task autonomously. Each agent type has its own contenxt, tools ,and capabilities.

Available agent types:
${typeListText}

- For parallel work, use run_in_background: true on each agent.
- Results are returned as text; summarize them for the user. `,
		parameters: Type.Object({
			prompt: Type.String({ description: "The clear, detailed prompt/task for the agent to perform. The agent cannot ask follow-up questions." }),
			description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
			subagent_type: Type.String({ description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}.` }),
			model: Type.Optional(Type.String({ description: 'Optional model override. Accepts "provider/modelId" or fuzzy name.' })),
			thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh." })),
			max_turns: Type.Optional(Type.Number({ description: "Maximum number of agentic turns before stopping.", minimum: 1 })),
			run_in_background: Type.Optional(Type.Boolean({ description: "Set to true to run in background. Returns agent ID immediately. notifications will arrive on completion" })),
			resume: Type.Optional(Type.String({ description: "Optional agent ID to resume from or steer_subagent to send mid-run messages to a running one." })),
			isolated: Type.Optional(Type.Boolean({ description: "If true, agent gets no extension/MCP tools." })),
			inherit_context: Type.Optional(Type.Boolean({ description: "If true, fork parent conversation into the agent." })),
			isolation: Type.Optional(Type.Literal("worktree", { description: 'Set to "worktree" to run in an isolated git worktree.' })),
		}),

		renderCall(args, theme) {
			const a = args as any;
			const displayName = a.subagent_type ? getDisplayName(a.subagent_type) : "Agent";
			const desc = a.description ?? "";
			return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as AgentDetails | undefined;
			if (!details) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(text, 0, 0);
			}
			const stats = (d: AgentDetails) => {
				const parts: string[] = [];
				if (d.modelName) parts.push(d.modelName);
				if (d.tags) parts.push(...d.tags);
				if (d.turnCount != null && d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
				if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
				if (d.tokens) parts.push(d.tokens);
				return parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
			};
			if (isPartial || details.status === "running") {
				const frame = SPINNER[details.spinnerFrame ?? 0];
				const s = stats(details);
				let line = theme.fg("accent", frame) + (s ? " " + s : "");
				line += "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
				return new Text(line, 0, 0);
			}
			if (details.status === "background") {
				return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
			}
			if (details.status === "completed" || details.status === "steered") {
				const duration = formatMs(details.durationMs);
				const isSteered = details.status === "steered";
				const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
				const s = stats(details);
				let line = icon + (s ? " " + s : "");
				line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);
				if (expanded) {
					const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
					if (resultText) {
						const lines = resultText.split("\n").slice(0, 50);
						for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
						if (resultText.split("\n").length > 50) {
							line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
						}
					}
				} else {
					const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
					line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
				}
				return new Text(line, 0, 0);
			}
			if (details.status === "stopped") {
				const s = stats(details);
				let line = theme.fg("dim", "■") + (s ? " " + s : "");
				line += "\n" + theme.fg("dim", "  ⎿  Stopped");
				return new Text(line, 0, 0);
			}
			const s = stats(details);
			let line = theme.fg("error", "✗") + (s ? " " + s : "");
			if (details.status === "error") {
				line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
			} else {
				line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
			}
			return new Text(line, 0, 0);
		},

		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const p = params as any;
			runtime.setCurrentCtx(ctx);
			reloadCustomAgents();

			const rawType = p.subagent_type as SubagentType;
			const resolved = resolveType(rawType);
			const subagentType = resolved ?? "general-purpose";
			const fellBack = resolved === undefined;

			// permission.task enforcement (Phase 4) — invoker = active primary.
			const permAction = checkTaskPermission(getInvokerPermission(), subagentType);
			if (permAction === "deny") {
				return textResult(`Refused: permission.task denies spawning subagent "${subagentType}".`);
			}
			if (permAction === "ask") {
				pi.events.emit(PERMISSION_ASK_EVENT, { subagentName: subagentType, prompt: p.prompt });
				return textResult(`Refused: permission.task requires user confirmation to spawn subagent "${subagentType}". (ask flow not yet interactive)`);
			}

			const displayName = getDisplayName(subagentType);
			const customConfig = getAgentConfig(subagentType);
			const resolvedConfig = resolveAgentInvocationConfig(customConfig, p);

			let model = ctx.model;
			if (resolvedConfig.modelInput) {
				const mResolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
				if (typeof mResolved === "string") {
					if (resolvedConfig.modelFromParams) return textResult(mResolved);
				} else {
					model = mResolved;
				}
			}

			const thinking = resolvedConfig.thinking;
			const inheritContext = resolvedConfig.inheritContext;
			const runInBackground = resolvedConfig.runInBackground;
			const isolated = resolvedConfig.isolated;
			const isolation = resolvedConfig.isolation;

			const parentModelId = ctx.model?.id;
			const effectiveModelId = model?.id;
			const agentModelName = effectiveModelId && effectiveModelId !== parentModelId
				? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
				: undefined;
			const agentTags: string[] = [];
			const modeLabel = getPromptModeLabel(subagentType);
			if (modeLabel) agentTags.push(modeLabel);
			if (thinking) agentTags.push(`thinking: ${thinking}`);
			if (isolated) agentTags.push("isolated");
			if (isolation === "worktree") agentTags.push("worktree");
			const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
			const detailBase = {
				displayName,
				description: p.description,
				subagentType,
				modelName: agentModelName,
				tags: agentTags.length > 0 ? agentTags : undefined,
			};

			if (p.resume) {
				const existing = manager.getRecord(p.resume);
				if (!existing) return textResult(`Agent not found: "${p.resume}". It may have been cleaned up.`);
				if (!existing.session) return textResult(`Agent "${p.resume}" has no active session to resume.`);
				const record = await manager.resume(p.resume, p.prompt, signal);
				if (!record) return textResult(`Failed to resume agent "${p.resume}".`);
				return textResult(
					record.result?.trim() || record.error?.trim() || "No output.",
					buildDetails(detailBase, record),
				);
			}

			if (runInBackground) {
				const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

				let id: string;
				const origBgOnSession = bgCallbacks.onSessionCreated;
				bgCallbacks.onSessionCreated = (session: any) => {
					origBgOnSession(session);
					const rec = manager.getRecord(id);
					if (rec?.outputFile) {
						rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
					}
				};

				id = manager.spawn(pi, ctx, subagentType, p.prompt, {
					description: p.description,
					model,
					maxTurns: effectiveMaxTurns,
					isolated,
					inheritContext,
					thinkingLevel: thinking,
					isBackground: true,
					isolation,
					...bgCallbacks,
				});

				const joinMode = resolveJoinMode(runtime.getDefaultJoinMode(), true);
				const record = manager.getRecord(id);
				if (record && joinMode) {
					record.joinMode = joinMode;
					record.toolCallId = toolCallId;
					record.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
					writeInitialEntry(record.outputFile, id, p.prompt, ctx.cwd);
				}

				runtime.registerBackgroundAgent(id, joinMode ?? null);
				agentActivity.set(id, bgState);
				runtime.schedulePublish();

				const isQueued = record?.status === "queued";
				return textResult(
					`Agent ${isQueued ? "queued" : "started"} in background.\n` +
					`Agent ID: ${id}\n` +
					`Type: ${displayName}\n` +
					`Description: ${p.description}\n` +
					(record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
					(isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
					`\nYou will be notified when this agent completes.\n` +
					`Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
					`Do not duplicate this agent's work.`,
					{ ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
				);
			}

			let spinnerFrame = 0;
			const startedAt = Date.now();
			let fgId: string | undefined;

			const streamUpdate = () => {
				const details: AgentDetails = {
					...detailBase,
					toolUses: fgState.toolUses,
					tokens: fgState.tokens,
					turnCount: fgState.turnCount,
					maxTurns: fgState.maxTurns,
					durationMs: Date.now() - startedAt,
					status: "running",
					activity: describeActivity(fgState.activeTools, fgState.responseText),
					spinnerFrame: spinnerFrame % SPINNER.length,
				};
				onUpdate?.({
					content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
					details: details as any,
				});
			};

			const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);

			const origOnSession = fgCallbacks.onSessionCreated;
			fgCallbacks.onSessionCreated = (session: any) => {
				origOnSession(session);
				for (const a of manager.listAgents()) {
					if (a.session === session) {
						fgId = a.id;
						agentActivity.set(a.id, fgState);
						break;
					}
				}
			};

			const spinnerInterval = setInterval(() => {
				spinnerFrame++;
				streamUpdate();
			}, 80);

			streamUpdate();

			const record = await manager.spawnAndWait(pi, ctx, subagentType, p.prompt, {
				description: p.description,
				model,
				maxTurns: effectiveMaxTurns,
				isolated,
				inheritContext,
				thinkingLevel: thinking,
				isolation,
				...fgCallbacks,
			});

			clearInterval(spinnerInterval);

			if (fgId) agentActivity.delete(fgId);

			const tokenText = safeFormatTokens(fgState.session);
			const details = buildDetails(detailBase, record, fgState, { tokens: tokenText });
			const fallbackNote = fellBack ? `Note: Unknown agent type "${rawType}" — using general-purpose.\n\n` : "";

			runtime.schedulePublish();

			if (record.status === "error") {
				return textResult(`${fallbackNote}Agent failed: ${record.error}`, details);
			}

			const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
			const statsParts = [`${record.toolUses} tool uses`];
			if (tokenText) statsParts.push(tokenText);
			return textResult(
				`${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
				(record.result?.trim() || "No output."),
				details,
			);
		},
	});

	// ─── get_subagent_result ─────────────────────────────────────────────────
	pi.registerTool({
		name: "get_subagent_result",
		label: "Get Agent Result",
		description: "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "The agent ID to check." }),
			wait: Type.Optional(Type.Boolean({ description: "If true, wait for the agent to complete before returning." })),
			verbose: Type.Optional(Type.Boolean({ description: "If true, include the agent's full conversation." })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const p = params as any;
			const record = manager.getRecord(p.agent_id);
			if (!record) return textResult(`Agent not found: "${p.agent_id}". It may have been cleaned up.`);

			if (p.wait && record.status === "running" && record.promise) {
				record.resultConsumed = true;
				runtime.cancelNudge(p.agent_id);
				await record.promise;
			}

			const displayName = getDisplayName(record.type);
			const duration = formatDuration(record.startedAt, record.completedAt);
			const tokens = safeFormatTokens(record.session);
			const toolStats = tokens ? `Tool uses: ${record.toolUses} | ${tokens}` : `Tool uses: ${record.toolUses}`;

			let output =
				`Agent: ${record.id}\n` +
				`Type: ${displayName} | Status: ${record.status} | ${toolStats} | Duration: ${duration}\n` +
				`Description: ${record.description}\n\n`;

			if (record.status === "running") {
				output += "Agent is still running. Use wait: true or check back later.";
			} else if (record.status === "error") {
				output += `Error: ${record.error}`;
			} else {
				output += record.result?.trim() || "No output.";
			}

			if (record.status !== "running" && record.status !== "queued") {
				record.resultConsumed = true;
				runtime.cancelNudge(p.agent_id);
			}

			if (p.verbose && record.session) {
				const conversation = getAgentConversation(record.session);
				if (conversation) output += `\n\n--- Agent Conversation ---\n${conversation}`;
			}

			return textResult(output);
		},
	});

	// ─── steer_subagent ──────────────────────────────────────────────────────
	pi.registerTool({
		name: "steer_subagent",
		label: "Steer Agent",
		description: "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "The agent ID to steer (must be currently running)." }),
			message: Type.String({ description: "The steering message to send." }),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const p = params as any;
			const record = manager.getRecord(p.agent_id);
			if (!record) return textResult(`Agent not found: "${p.agent_id}". It may have been cleaned up.`);
			if (record.status !== "running") return textResult(`Agent "${p.agent_id}" is not running (status: ${record.status}).`);
			if (!record.session) {
				if (!record.pendingSteers) record.pendingSteers = [];
				record.pendingSteers.push(p.message);
				return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
			}
			try {
				await steerAgent(record.session, p.message);
				return textResult(`Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.`);
			} catch (err) {
				return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
