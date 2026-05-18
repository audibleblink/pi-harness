/**
 * UIBus producer module.
 *
 * Extensions emit typed state updates to named slots via a shared event
 * channel. The ui extension subscribes to the channel and fans updates out
 * to whatever renders the slots (e.g. status bar widgets).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Channel ──────────────────────────────────────────────────────────────────

export const UI_BUS_TOPIC = "harness.ui:publish";

// ─── Slot names ───────────────────────────────────────────────────────────────

export const SLOT_MODE = "mode";
/** Combined render slot — used as the chrome widget identifier only. Producers no longer write to it. */
export const SLOT_ORCHESTRATION = "orchestration";
/** Half-slot: published by extensions/agents/ with live subagent records. */
export const SLOT_ORCHESTRATION_AGENTS = "orchestration:agents";
/** Half-slot: published by extensions/tasks/ with live task records. */
export const SLOT_ORCHESTRATION_TASKS = "orchestration:tasks";
export const SLOT_WORKING = "working";
export const SLOT_SUBAGENT_USAGE = "subagentUsage";
export const SLOT_GHOST = "ghost";
export const SLOT_BLUR = "blur";
export const SLOT_AGENT_SKILLS = "agentSkills";

// ─── Envelope ─────────────────────────────────────────────────────────────────

export interface UiBusEnvelope {
	slot: string;
	value: unknown;
}

// ─── State types ──────────────────────────────────────────────────────────────

export interface ModeState {
	label: string;
	model?: string;
}

export interface AgentEntry {
	id: string;
	status: string;
	elapsed: number;
	activity: string;
	model?: string;
	taskId?: string;
}

export interface TaskEntry {
	id: string;
	subject: string;
	status: string;
	agentId?: string;
}

export interface OrchestrationState {
	agents: AgentEntry[];
	tasks: TaskEntry[];
}

export interface WorkingState {
	message: string;
}

export interface SubagentUsageState {
	tokens: number;
	cost: number;
	runningCount: number;
}

export interface GhostController {
	getSuggestion(): string;
	onTextChanged(text: string): void;
	tryAccept(text: string): string | null;
	attachTui(requestRender: () => void): void;
}

// ─── Producers ────────────────────────────────────────────────────────────────

export function publishMode(pi: ExtensionAPI, state: ModeState | null): void {
	pi.events.emit(UI_BUS_TOPIC, { slot: SLOT_MODE, value: state } satisfies UiBusEnvelope);
}

export function publishOrchestrationAgents(pi: ExtensionAPI, agents: AgentEntry[] | null): void {
	pi.events.emit(UI_BUS_TOPIC, { slot: SLOT_ORCHESTRATION_AGENTS, value: agents } satisfies UiBusEnvelope);
}

export function publishOrchestrationTasks(pi: ExtensionAPI, tasks: TaskEntry[] | null): void {
	pi.events.emit(UI_BUS_TOPIC, { slot: SLOT_ORCHESTRATION_TASKS, value: tasks } satisfies UiBusEnvelope);
}

export function publishWorking(pi: ExtensionAPI, state: WorkingState | null): void {
	pi.events.emit(UI_BUS_TOPIC, { slot: SLOT_WORKING, value: state } satisfies UiBusEnvelope);
}

export function publishSubagentUsage(pi: ExtensionAPI, state: SubagentUsageState | null): void {
	pi.events.emit(UI_BUS_TOPIC, { slot: SLOT_SUBAGENT_USAGE, value: state } satisfies UiBusEnvelope);
}

export function publishGhost(pi: ExtensionAPI, controller: GhostController | null): void {
	pi.events.emit(UI_BUS_TOPIC, { slot: SLOT_GHOST, value: controller } satisfies UiBusEnvelope);
}

export function publishBlur(pi: ExtensionAPI, blurred: boolean): void {
	pi.events.emit(UI_BUS_TOPIC, { slot: SLOT_BLUR, value: blurred } satisfies UiBusEnvelope);
}

/** Primary-agent skill allowlist override (null = no override; use persisted visible set). */
export function publishAgentSkills(pi: ExtensionAPI, allowlist: string[] | null): void {
	pi.events.emit(UI_BUS_TOPIC, { slot: SLOT_AGENT_SKILLS, value: allowlist } satisfies UiBusEnvelope);
}
