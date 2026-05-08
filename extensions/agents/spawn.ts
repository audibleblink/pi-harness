/**
 * Shared spawn dispatch: enforces invoker `permission.task` rules before
 * delegating to the underlying subagent runtime. Used by BOTH the `Agent`
 * tool and the `@name` inline dispatcher.
 *
 * `permission.task` (PRD § Agent Definition Schema) is matched against the
 * subagent name as a glob pattern; when no matching rule exists the default
 * action is "allow".
 */

import { checkPermission } from "../_agent-schema/permission.js";
import type { PermissionMap } from "../_agent-schema/types.js";

export type TaskAction = "allow" | "ask" | "deny";

export const PERMISSION_ASK_EVENT = "agents:permission_ask";

export interface PermissionAskPayload {
	subagentName: string;
	prompt: string;
}

export function checkTaskPermission(
	perm: PermissionMap | undefined,
	subagentName: string,
): TaskAction {
	const v = checkPermission(perm, "task", subagentName);
	return (v ?? "allow") as TaskAction;
}

export interface DispatchSpawnDeps {
	/** Notification hook for the "ask" path (e.g. emit pi.events). */
	emitAsk?: (payload: PermissionAskPayload) => void;
	/** Actually start the subagent. Returns the new agentId or an error message. */
	performSpawn: (
		name: string,
		prompt: string,
	) => Promise<{ agentId: string } | { error: string }>;
	/** The invoking agent's permission map (`undefined` ⇒ no rules ⇒ allow). */
	invokerPermission?: PermissionMap;
}

export type DispatchResult =
	| { kind: "spawned"; agentId: string }
	| { kind: "denied"; subagentName: string }
	| { kind: "ask"; subagentName: string }
	| { kind: "error"; message: string };

export async function dispatchSpawn(
	deps: DispatchSpawnDeps,
	subagentName: string,
	prompt: string,
): Promise<DispatchResult> {
	const action = checkTaskPermission(deps.invokerPermission, subagentName);
	if (action === "deny") return { kind: "denied", subagentName };
	if (action === "ask") {
		deps.emitAsk?.({ subagentName, prompt });
		return { kind: "ask", subagentName };
	}
	const r = await deps.performSpawn(subagentName, prompt);
	if ("error" in r) return { kind: "error", message: r.error };
	return { kind: "spawned", agentId: r.agentId };
}
