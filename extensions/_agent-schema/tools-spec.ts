/**
 * Normalize the `tools:` field into a ToolsSpec.
 *
 * Two accepted shapes:
 * - PI comma-string: `tools: read, bash` → deny-by-default allowlist of named tools.
 * - opencode object: `tools: { write: false, bash: true, "mymcp_*": false }`
 *     → allowed = keys with value true; deniedGlobs = keys with value false.
 *
 * The original raw shape is retained on the result for diagnostics.
 */

import type { ToolsSpec } from "./types.js";

export function normalizeTools(
	raw: unknown,
): { ok: true; value: ToolsSpec | undefined } | { ok: false; error: string } {
	if (raw === undefined || raw === null) return { ok: true, value: undefined };

	if (typeof raw === "string") {
		const allowed = new Set(
			raw.split(",").map((s) => s.trim()).filter(Boolean),
		);
		return { ok: true, value: { kind: "csv", allowed, raw } };
	}

	if (typeof raw === "object" && !Array.isArray(raw)) {
		const allowed = new Set<string>();
		const deniedGlobs: string[] = [];
		const rawObj: Record<string, boolean> = {};
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof v !== "boolean") {
				return { ok: false, error: `tools["${k}"] must be a boolean` };
			}
			rawObj[k] = v;
			if (v) allowed.add(k);
			else deniedGlobs.push(k);
		}
		return { ok: true, value: { kind: "object", allowed, deniedGlobs, raw: rawObj } };
	}

	return { ok: false, error: `tools must be a comma-string or object` };
}
