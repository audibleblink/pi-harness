/**
 * @-mention autocomplete provider.
 *
 * Lists agents with mode in {subagent, all} AND !disable AND !hidden.
 * Wired into the editor via ExtensionUIContext.addAutocompleteProvider().
 *
 * Pure helper `listAtMentionAgents` is exported for unit testing of the
 * filter (Phase 4 verify).
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@mariozechner/pi-tui";
import type { AgentDef } from "../_agent-schema/types.js";

export function listAtMentionAgents(
	defs: Map<string, AgentDef>,
): AutocompleteItem[] {
	const out: AutocompleteItem[] = [];
	for (const [name, def] of defs) {
		if (def.mode !== "subagent" && def.mode !== "all") continue;
		if (def.disable === true) continue;
		if (def.hidden === true) continue;
		out.push({
			value: `@${name}`,
			label: `@${name}`,
			description: def.description,
		});
	}
	return out.sort((a, b) => a.value.localeCompare(b.value));
}

/** Find an `@<word>` prefix immediately before the cursor, if any. */
function extractAtPrefixAtCursor(line: string, col: number): { start: number; prefix: string } | null {
	const before = line.slice(0, col);
	const m = before.match(/(?:^|[\s(\[{,;:'"`])@([A-Za-z0-9_-]*)$/);
	if (!m) return null;
	const prefix = m[1];
	const start = col - prefix.length - 1; // includes the '@'
	return { start, prefix };
}

/**
 * Wraps the built-in autocomplete provider; injects agent suggestions when the
 * cursor is on an `@<bare>` token (no `/`, `\`, or `.<ext>`).
 */
export function createAgentAtAutocompleteFactory(getDefs: () => Map<string, AgentDef>) {
	return (current: AutocompleteProvider): AutocompleteProvider => ({
		async getSuggestions(lines, cursorLine, cursorCol, opts) {
			const innerPromise = current.getSuggestions(lines, cursorLine, cursorCol, opts);
			const line = lines[cursorLine] ?? "";
			const at = extractAtPrefixAtCursor(line, cursorCol);
			if (!at) return innerPromise;

			// Don't override file-style `@path/...` or `@foo.ext`.
			const after = line.slice(cursorCol);
			if (/^\//.test(after) || /^\\/.test(after)) return innerPromise;

			const items = listAtMentionAgents(getDefs())
				.filter((it) => it.value.slice(1).toLowerCase().startsWith(at.prefix.toLowerCase()));
			if (items.length === 0) return innerPromise;

			const inner = await innerPromise;
			const merged: AutocompleteSuggestions = {
				items: [...items, ...(inner?.items ?? [])],
				prefix: `@${at.prefix}`,
			};
			return merged;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
		},
	});
}
