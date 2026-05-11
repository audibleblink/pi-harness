/**
 * Subagent runtime for extensions/agents/.
 *
 * Wraps the runner machinery (AgentManager, agent-runner, group-join) under
 * ./internal/ and re-exposes a small surface for the three subagent tool
 * registrations in subagent-tools.ts.
 *
 * Lifecycle: emits `agents:subagent_end` on subagent completion (success,
 * failure, stopped) — see lifecycle-events.ts for the payload shape.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { AgentManager } from "./internal/agent-manager.js";
import { GroupJoinManager } from "./internal/group-join.js";
import {
	type AgentActivity,
	describeActivity,
	formatTokens,
} from "./internal/agent-display.js";
import type {
	AgentRecord,
	JoinMode,
	NotificationDetails,
	SubagentType,
} from "./internal/types.js";
import type { OrchestrationState, SubagentUsageState } from "../ui/bus.js";
import { createPublisher } from "./subagent-bus.js";
import {
	AGENTS_SUBAGENT_END,
	type SubagentEndPayload,
	type SubagentEndStatus,
} from "./lifecycle-events.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeUsage(session: { getSessionStats(): { tokens?: { total?: number }; cost?: number } } | undefined): { tokens: number; cost: number } {
	if (!session) return { tokens: 0, cost: 0 };
	try {
		const stats = session.getSessionStats();
		return { tokens: stats.tokens?.total ?? 0, cost: stats.cost ?? 0 };
	} catch {
		return { tokens: 0, cost: 0 };
	}
}

function safeFormatTokens(session: { getSessionStats(): { tokens: { total: number } } } | undefined): string {
	if (!session) return "";
	try {
		return formatTokens(session.getSessionStats().tokens.total);
	} catch {
		return "";
	}
}

function escapeXml(s: string | undefined | null): string {
	if (s == null) return "";
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getStatusLabel(status: string, error?: string): string {
	switch (status) {
		case "error": return `Error: ${error ?? "unknown"}`;
		case "aborted": return "Aborted (max turns exceeded)";
		case "steered": return "Wrapped up (turn limit)";
		case "stopped": return "Stopped";
		default: return "Done";
	}
}

function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
	const status = getStatusLabel(record.status, record.error);
	const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
	const totalTokens = safeUsage(record.session).tokens;
	const resultPreview = record.result
		? record.result.length > resultMaxLen
			? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
			: record.result
		: "No output.";
	return [
		`<task-notification>`,
		`<task-id>${record.id}</task-id>`,
		record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
		record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
		`<status>${escapeXml(status)}</status>`,
		`<summary>Agent "${escapeXml(record.description)}" ${record.status}</summary>`,
		`<result>${escapeXml(resultPreview)}</result>`,
		`<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>`,
		`</task-notification>`,
	].filter(Boolean).join("\n");
}

function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
	const totalTokens = safeUsage(record.session).tokens;
	return {
		id: record.id,
		description: record.description,
		status: record.status,
		toolUses: record.toolUses,
		turnCount: activity?.turnCount ?? 0,
		maxTurns: activity?.maxTurns,
		totalTokens,
		durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
		outputFile: record.outputFile,
		error: record.error,
		resultPreview: record.result
			? record.result.length > resultMaxLen
				? record.result.slice(0, resultMaxLen) + "…"
				: record.result
			: "No output.",
	};
}

function recordToEndStatus(status: string): SubagentEndStatus | undefined {
	switch (status) {
		case "stopped": return "stopped";
		case "error":
		case "aborted":
			return "failure";
		case "completed":
		case "steered":
			return "success";
		default:
			return undefined;
	}
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export interface SubagentRuntime {
	readonly manager: AgentManager;
	readonly agentActivity: Map<string, AgentActivity>;
	getCurrentCtx(): ExtensionContext | undefined;
	setCurrentCtx(ctx: ExtensionContext | undefined): void;
	getDefaultJoinMode(): JoinMode;
	setDefaultJoinMode(mode: JoinMode): void;
	spawn(type: SubagentType, prompt: string, options?: any): string;
	stop(agentId: string): void;
	cancelNudge(key: string): void;
	registerBackgroundAgent(id: string, joinMode: JoinMode | null): void;
	schedulePublish(): void;
	dispose(): void;
}

const NUDGE_HOLD_MS = 200;

export function createSubagentRuntime(pi: ExtensionAPI): SubagentRuntime {
	let currentCtx: ExtensionContext | undefined;
	const agentActivity = new Map<string, AgentActivity>();
	const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
	let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
	let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
	let batchCounter = 0;
	let defaultJoinMode: JoinMode = "smart";

	const buildOrchestration = (): OrchestrationState => {
		const agents = manager.listAgents()
			.filter(a => a.status === "running" || a.status === "queued")
			.map(a => {
				const act = agentActivity.get(a.id);
				return {
					id: a.id,
					status: a.status,
					elapsed: Date.now() - a.startedAt,
					activity: act ? describeActivity(act.activeTools, act.responseText) : "thinking…",
					taskId: undefined as string | undefined,
				};
			});
		return { agents, tasks: [] };
	};

	const buildSubagentUsage = (): SubagentUsageState | null => {
		let tokens = 0, cost = 0, runningCount = 0;
		let any = false;
		for (const r of manager.listAgents()) {
			if (r.status === "running" || r.status === "queued") {
				any = true;
				if (r.status === "running") runningCount++;
				const u = safeUsage(r.session);
				tokens += u.tokens;
				cost += u.cost;
			} else if (r.finalTokens !== undefined || r.finalCost !== undefined) {
				any = true;
				tokens += r.finalTokens ?? 0;
				cost += r.finalCost ?? 0;
			}
		}
		return any ? { tokens, cost, runningCount } : null;
	};

	const publisher = createPublisher(pi, { buildOrchestration, buildSubagentUsage });

	function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
		cancelNudge(key);
		pendingNudges.set(key, setTimeout(() => {
			pendingNudges.delete(key);
			send();
		}, delay));
	}

	function cancelNudge(key: string) {
		const timer = pendingNudges.get(key);
		if (timer != null) {
			clearTimeout(timer);
			pendingNudges.delete(key);
		}
	}

	function emitIndividualNudge(record: AgentRecord) {
		if (record.resultConsumed) return;
		const notification = formatTaskNotification(record, 500);
		const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";
		pi.sendMessage<NotificationDetails>({
			customType: "subagent-notification",
			content: notification + footer,
			display: true,
			details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
		}, { deliverAs: "followUp", triggerTurn: true });
	}

	function sendIndividualNudge(record: AgentRecord) {
		agentActivity.delete(record.id);
		scheduleNudge(record.id, () => emitIndividualNudge(record));
	}

	const groupJoin = new GroupJoinManager(
		(records, partial) => {
			for (const r of records) agentActivity.delete(r.id);
			const groupKey = `group:${records.map(r => r.id).join(",")}`;
			scheduleNudge(groupKey, () => {
				const unconsumed = records.filter(r => !r.resultConsumed);
				if (unconsumed.length === 0) { publisher.schedule(); return; }
				const notifications = unconsumed.map(r => formatTaskNotification(r, 300)).join("\n\n");
				const label = partial
					? `${unconsumed.length} agent(s) finished (partial — others still running)`
					: `${unconsumed.length} agent(s) finished`;
				const [first, ...rest] = unconsumed;
				const details = buildNotificationDetails(first, 300, agentActivity.get(first.id));
				if (rest.length > 0) {
					details.others = rest.map(r => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
				}
				pi.sendMessage<NotificationDetails>({
					customType: "subagent-notification",
					content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
					display: true,
					details,
				}, { deliverAs: "followUp", triggerTurn: true });
			});
			publisher.schedule();
		},
		30_000,
	);

	function finalizeBatch() {
		batchFinalizeTimer = undefined;
		const batch = [...currentBatchAgents];
		currentBatchAgents = [];

		const smart = batch.filter(a => a.joinMode === "smart" || a.joinMode === "group");
		if (smart.length >= 2) {
			const groupId = `batch-${++batchCounter}`;
			const ids = smart.map(a => a.id);
			groupJoin.registerGroup(groupId, ids);
			for (const id of ids) {
				const record = manager.getRecord(id);
				if (!record) continue;
				record.groupId = groupId;
				if (record.completedAt != null && !record.resultConsumed) {
					groupJoin.onAgentComplete(record);
				}
			}
		} else {
			for (const { id } of batch) {
				const record = manager.getRecord(id);
				if (record?.completedAt != null && !record.resultConsumed) {
					sendIndividualNudge(record);
				}
			}
		}
	}

	const manager = new AgentManager(
		(record) => {
			// Lifecycle event — fired exactly once per terminal transition.
			const endStatus = recordToEndStatus(record.status);
			if (endStatus) {
				const taskId = (record as any).metadata?.taskId as string | undefined;
				const payload: SubagentEndPayload = {
					agentId: record.id,
					status: endStatus,
					createdByTaskId: taskId,
				};
				pi.events.emit(AGENTS_SUBAGENT_END, payload);
			}

			if (record.resultConsumed) {
				agentActivity.delete(record.id);
				publisher.schedule();
				return;
			}
			if (currentBatchAgents.some(a => a.id === record.id)) {
				publisher.schedule();
				return;
			}
			const result = groupJoin.onAgentComplete(record);
			if (result === "pass") sendIndividualNudge(record);
			publisher.schedule();
		},
		undefined,
		(_record) => {
			publisher.schedule();
		},
	);

	function spawn(type: SubagentType, prompt: string, options?: any): string {
		if (!currentCtx) throw new Error("No active session");
		return manager.spawn(pi, currentCtx, type, prompt, options ?? {});
	}

	function stop(agentId: string): void {
		manager.abort(agentId);
	}

	function registerBackgroundAgent(id: string, joinMode: JoinMode | null) {
		if (joinMode == null || joinMode === "async") return;
		currentBatchAgents.push({ id, joinMode });
		if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
		batchFinalizeTimer = setTimeout(finalizeBatch, 100);
	}

	return {
		manager,
		agentActivity,
		getCurrentCtx: () => currentCtx,
		setCurrentCtx: (ctx) => { currentCtx = ctx; },
		getDefaultJoinMode: () => defaultJoinMode,
		setDefaultJoinMode: (m) => { defaultJoinMode = m; },
		spawn,
		stop,
		cancelNudge,
		registerBackgroundAgent,
		schedulePublish: () => publisher.schedule(),
		dispose: () => {
			for (const t of pendingNudges.values()) clearTimeout(t);
			pendingNudges.clear();
			if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
			publisher.dispose();
			manager.abortAll();
			manager.dispose();
		},
	};
}
