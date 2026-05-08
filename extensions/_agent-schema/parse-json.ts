/**
 * Parse a JSON entry from settings.json `agent` map into an AgentDef.
 * Delegates to finalize() in parse-frontmatter.ts so validation rules stay in
 * one place.
 */

import { finalize } from "./parse-frontmatter.js";
import type { ParseResult } from "./types.js";

export function parseAgentJson(name: string, entry: unknown, sourcePath: string): ParseResult {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return { ok: false, error: `agent ${name} at ${sourcePath}: entry must be an object` };
	}
	return finalize(name, entry as Record<string, unknown>, undefined, sourcePath);
}
