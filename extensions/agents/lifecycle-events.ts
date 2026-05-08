/**
 * Agent lifecycle events emitted by extensions/agents/.
 *
 * The single lifecycle event is `agents:subagent_end`, fired exactly once per
 * subagent terminal transition (success / failure / stopped) from the
 * subagent-runner completion path.
 *
 * Subscribers (e.g. extensions/tasks/ in P6) consume this event via the
 * shared event bus to drive cross-extension behaviour without creating a
 * direct TS import dependency on extensions/agents/.
 *
 * Allowed event names enforced by scripts/check-invariants.sh.
 */

export const AGENTS_SUBAGENT_END = "agents:subagent_end";

export type SubagentEndStatus = "success" | "failure" | "stopped";

export interface SubagentEndPayload {
	agentId: string;
	status: SubagentEndStatus;
	createdByTaskId?: string;
}
