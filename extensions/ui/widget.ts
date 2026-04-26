/**
 * Orchestration widget renderer.
 *
 * Renders agents (with spinner + elapsed + activity) and tasks (with status
 * icon + subject) as a combined multi-line string for ctx.ui.setWidget.
 */

import type { OrchestrationState, AgentEntry, TaskEntry } from "./bus.js";
import { SPINNER, formatMs } from "../orchestration/agent-display.js";

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }

// ─── Status icons ─────────────────────────────────────────────────────────────

function agentIcon(status: string, frame: number): string {
	if (status === "running") return cyan(SPINNER[frame % SPINNER.length] ?? "⠋");
	if (status === "queued") return dim("⏸");
	return dim("·");
}

function taskIcon(status: string): string {
	if (status === "completed") return green("✓");
	if (status === "in_progress") return yellow("⟳");
	return dim("·");
}

function taskStatusLabel(status: string): string {
	if (status === "completed") return green(status);
	if (status === "in_progress") return yellow(status);
	return dim(status);
}

// ─── Row builders ─────────────────────────────────────────────────────────────

function renderAgent(agent: AgentEntry, frame: number): string {
	const icon = agentIcon(agent.status, frame);
	const elapsed = dim(formatMs(agent.elapsed));
	const activity = agent.activity || "thinking…";
	const model = agent.model ? ` ${dim(`[${agent.model}]`)}` : "";
	return ` ${icon} ${elapsed} ${activity}${model}`;
}

function renderTask(task: TaskEntry, indent = false): string {
	const icon = taskIcon(task.status);
	const label = taskStatusLabel(task.status);
	const prefix = indent ? "  ↳ " : " ";
	return `${prefix}${icon} ${task.subject}  ${label}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if the state has any agents or tasks that require animation
 * (running/queued agents or in-progress tasks).
 */
export function hasAnimatedState(state: OrchestrationState): boolean {
	if (state.agents.some(a => a.status === "running" || a.status === "queued")) return true;
	if (state.tasks.some(t => t.status === "in_progress")) return true;
	return false;
}

/**
 * Render the full orchestration widget as a multi-line string.
 * `frame` is the current spinner frame index (incremented each tick).
 */
export function renderWidget(state: OrchestrationState, frame: number): string {
	const lines: string[] = [];

	// Build set of agent IDs currently active for cascade linking
	const activeAgentIds = new Set(state.agents.map(a => a.id));

	// Tasks indexed by agentId for cascade grouping
	const tasksByAgent = new Map<string, TaskEntry[]>();
	const orphanTasks: TaskEntry[] = [];
	for (const task of state.tasks) {
		if (task.agentId && activeAgentIds.has(task.agentId)) {
			const list = tasksByAgent.get(task.agentId) ?? [];
			list.push(task);
			tasksByAgent.set(task.agentId, list);
		} else {
			orphanTasks.push(task);
		}
	}

	// Agents section with cascade-linked tasks
	for (const agent of state.agents) {
		lines.push(renderAgent(agent, frame));
		const linked = tasksByAgent.get(agent.id) ?? [];
		for (const task of linked) {
			lines.push(renderTask(task, true));
		}
	}

	// Tasks without a currently-active agent
	for (const task of orphanTasks) {
		lines.push(renderTask(task, false));
	}

	return lines.join("\n");
}
