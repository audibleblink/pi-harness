/**
 * Read settings.json `agent` map and route each entry through parseAgentJson.
 * Returns a Map of name → AgentDef plus an array of error strings.
 */

import { parseAgentJson } from "./parse-json.js";
import type { AgentDef } from "./types.js";

export function loadSettingsAgents(
	settings: unknown,
	settingsSourcePath: string,
): { defs: Map<string, AgentDef>; errors: string[] } {
	const defs = new Map<string, AgentDef>();
	const errors: string[] = [];
	if (!settings || typeof settings !== "object") return { defs, errors };
	const map = (settings as { agent?: unknown }).agent;
	if (!map || typeof map !== "object" || Array.isArray(map)) return { defs, errors };

	for (const [name, entry] of Object.entries(map as Record<string, unknown>)) {
		const res = parseAgentJson(name, entry, settingsSourcePath);
		if (res.ok) defs.set(name, res.def);
		else errors.push(res.error);
	}
	return { defs, errors };
}
