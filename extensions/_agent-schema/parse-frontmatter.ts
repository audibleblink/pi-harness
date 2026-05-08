/**
 * Parse YAML frontmatter from a markdown agent file into an AgentDef.
 * Shares finalize() with parse-json.ts to keep validation/alias rules in one
 * place.
 */

import { basename } from "node:path";
import { parseFrontmatter as parseFm } from "@mariozechner/pi-coding-agent";
import { applyAliases, DEFAULT_MODE } from "./defaults.js";
import { normalizePermission } from "./permission.js";
import { resolvePrompt } from "./prompt-resolver.js";
import { normalizeTools } from "./tools-spec.js";
import type { AgentDef, AgentMode, ParseResult } from "./types.js";

const VALID_MODES: ReadonlySet<AgentMode> = new Set(["primary", "subagent", "all"]);

export function parseAgentFrontmatter(raw: string, sourcePath: string): ParseResult {
	const { frontmatter, body } = parseFm<Record<string, unknown>>(raw);
	const name = (typeof frontmatter["name"] === "string" && frontmatter["name"]) as string
		|| basename(sourcePath, ".md");
	return finalize(name, frontmatter, body, sourcePath);
}

/** Shared finalize used by both parsers. */
export function finalize(
	name: string,
	rawInput: Record<string, unknown>,
	body: string | undefined,
	sourcePath: string,
): ParseResult {
	const fm = applyAliases(rawInput);
	const fail = (msg: string): ParseResult => ({
		ok: false,
		error: `agent ${name} at ${sourcePath}: ${msg}`,
	});

	// mode
	let mode: AgentMode = DEFAULT_MODE;
	let modeImplicit = true;
	const modeRaw = fm["mode"];
	if (modeRaw !== undefined) {
		modeImplicit = false;
		if (typeof modeRaw !== "string" || !VALID_MODES.has(modeRaw as AgentMode)) {
			return fail(`invalid mode "${String(modeRaw)}" (expected primary|subagent|all)`);
		}
		mode = modeRaw as AgentMode;
	}

	// tools
	const toolsRes = normalizeTools(fm["tools"]);
	if (!toolsRes.ok) return fail(toolsRes.error);

	// permission
	const permRes = normalizePermission(fm["permission"]);
	if (!permRes.ok) return fail(permRes.error);

	// prompt resolution (file: ref)
	const promptRaw = typeof fm["prompt"] === "string" ? (fm["prompt"] as string) : undefined;
	const promptRes = resolvePrompt(promptRaw, body, sourcePath);
	if (!promptRes.ok) return fail(promptRes.error);

	// description required for subagents (only when description missing AND mode is subagent — `all` does NOT require it)
	const description = typeof fm["description"] === "string" ? (fm["description"] as string) : undefined;
	if (mode === "subagent" && !description) {
		return fail(`subagent requires "description"`);
	}

	const def: AgentDef = {
		name,
		sourcePath,
		mode,
		modeImplicit,
		description,
		model: typeof fm["model"] === "string" ? (fm["model"] as string) : undefined,
		prompt: promptRes.value,
		temperature: typeof fm["temperature"] === "number" ? (fm["temperature"] as number) : undefined,
		steps: typeof fm["steps"] === "number" ? (fm["steps"] as number) : undefined,
		disable: fm["disable"] === true ? true : undefined,
		hidden: fm["hidden"] === true ? true : undefined,
		tools: toolsRes.value,
		permission: permRes.value,
		body: body && body.trim() ? body : undefined,

		prompt_mode: typeof fm["prompt_mode"] === "string" ? (fm["prompt_mode"] as string) : undefined,
		display_name: typeof fm["display_name"] === "string" ? (fm["display_name"] as string) : undefined,
		extensions: fm["extensions"] ?? fm["inherit_extensions"],
		skills: fm["skills"] ?? fm["inherit_skills"],
		inherit_context: fm["inherit_context"] === true ? true : fm["inherit_context"] === false ? false : undefined,
		isolated: fm["isolated"] === true ? true : fm["isolated"] === false ? false : undefined,
		memoryScope: typeof fm["memoryScope"] === "string" ? (fm["memoryScope"] as string) : undefined,
		thinkingLevel: typeof fm["thinkingLevel"] === "string" ? (fm["thinkingLevel"] as string)
			: typeof fm["thinking"] === "string" ? (fm["thinking"] as string) : undefined,
		isolation: typeof fm["isolation"] === "string" ? (fm["isolation"] as string) : undefined,
		run_in_background: fm["run_in_background"] === true ? true
			: fm["run_in_background"] === false ? false : undefined,
		enabled: fm["enabled"] === false ? false : fm["enabled"] === true ? true : undefined,
		max_turns: typeof fm["max_turns"] === "number" ? (fm["max_turns"] as number) : undefined,
		disallowed_tools: fm["disallowed_tools"],
		memory: typeof fm["memory"] === "string" ? (fm["memory"] as string) : undefined,
		raw: fm,
	};

	return { ok: true, def };
}
