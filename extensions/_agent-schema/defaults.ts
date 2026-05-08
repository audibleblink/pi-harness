/**
 * Schema defaults + alias collapse used by both frontmatter and JSON parsers.
 */

import type { AgentMode } from "./types.js";

export const DEFAULT_MODE: AgentMode = "all";

/**
 * Collapse legacy aliases into canonical fields, in-place on a shallow copy.
 * - `maxSteps` → `steps`
 * - `enabled: false` → `disable: true` (only when `disable` not explicitly set)
 */
export function applyAliases(input: Record<string, unknown>): Record<string, unknown> {
	const out = { ...input };
	if (out["maxSteps"] !== undefined && out["steps"] === undefined) {
		out["steps"] = out["maxSteps"];
	}
	if (out["enabled"] === false && out["disable"] === undefined) {
		out["disable"] = true;
	}
	return out;
}
