/**
 * @name inline dispatch tokenizer.
 *
 * Pure function: scan a user message for `@<name>` tokens, classify each as
 * dispatch / passthrough / rejected, and return the message with matched
 * dispatch tokens stripped (whitespace collapsed).
 *
 * Rules (PRD § @name inline dispatch):
 *   a. `/` or `\` after `@` in token → not a dispatch (file path).
 *   b. `.` followed by extension-like suffix [A-Za-z0-9]+ → not a dispatch.
 *   c. Bare name not in knownAgents → not a dispatch.
 *   d. Leading `\@name` → strip backslash, passthrough literal.
 *   e. Resolved agent has mode: primary → emit dispatch with rejected: "primary-only".
 *
 * mode: subagent and mode: all are accepted. hidden:true does NOT block dispatch.
 */

import type { AgentDef } from "../_agent-schema/types.js";

export type DispatchRejection = "primary-only" | "task-permission-denied";

export interface AtDispatch {
	name: string;
	rejected?: DispatchRejection;
	askRequired?: boolean;
}

export interface AtExtractResult {
	strippedMessage: string;
	dispatches: AtDispatch[];
}

const NAME_RE = /[A-Za-z0-9_-]+/y;
const EXT_RE = /^[A-Za-z0-9]+/;

export function extractAtDispatches(
	message: string,
	knownAgents: Map<string, AgentDef>,
): AtExtractResult {
	const dispatches: AtDispatch[] = [];
	const removeRanges: Array<[number, number]> = [];
	const escapeRanges: Array<[number]> = []; // backslash positions to remove

	const len = message.length;
	let i = 0;
	while (i < len) {
		const ch = message[i];
		if (ch !== "@") { i++; continue; }
		// Boundary check: previous char must be start-of-string, whitespace, or
		// a punctuation that we treat as a boundary. Mid-word `foo@bar` is not
		// a dispatch. (Email-like protection.)
		const prev = i === 0 ? "" : message[i - 1];
		const escaped = prev === "\\";
		if (!escaped && prev !== "" && !/[\s(\[{,;:'"`]/.test(prev)) { i++; continue; }

		// Tokenize the bare name.
		NAME_RE.lastIndex = i + 1;
		const m = NAME_RE.exec(message);
		if (!m || m.index !== i + 1) { i++; continue; }
		const name = m[0];
		const tokenEnd = i + 1 + name.length;

		// Rule (d): leading \@name → strip backslash, passthrough literal. No dispatch.
		if (escaped) {
			escapeRanges.push([i - 1]);
			i = tokenEnd;
			continue;
		}

		// Rules (a)/(b): inspect chars right after the bare name.
		const after = message.slice(tokenEnd);
		if (after[0] === "/" || after[0] === "\\") { i = tokenEnd; continue; }
		if (after[0] === ".") {
			const ext = EXT_RE.exec(after.slice(1));
			if (ext) { i = tokenEnd; continue; }
		}

		// Rule (c): unknown name → passthrough.
		const def = knownAgents.get(name);
		if (!def) { i = tokenEnd; continue; }

		// Rule (e): primary-only → emit rejected dispatch, but still strip token.
		if (def.mode === "primary") {
			dispatches.push({ name, rejected: "primary-only" });
			removeRanges.push([i, tokenEnd]);
			i = tokenEnd;
			continue;
		}

		if (def.mode !== "subagent" && def.mode !== "all") {
			i = tokenEnd;
			continue;
		}

		dispatches.push({ name });
		removeRanges.push([i, tokenEnd]);
		i = tokenEnd;
	}

	// Build the stripped message: remove dispatch tokens, drop escape backslashes.
	const drops = new Set<number>();
	for (const [s, e] of removeRanges) {
		for (let k = s; k < e; k++) drops.add(k);
	}
	for (const [k] of escapeRanges) drops.add(k);

	let out = "";
	for (let k = 0; k < len; k++) {
		if (!drops.has(k)) out += message[k];
	}
	// Collapse whitespace runs introduced by removal.
	out = out.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

	return { strippedMessage: out, dispatches };
}
