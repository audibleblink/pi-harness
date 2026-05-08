/**
 * Shared agent-definition types. Used by both the legacy modes/orchestration
 * extensions (transitionally) and the upcoming extensions/agents extension.
 */

export type AgentMode = "primary" | "subagent" | "all";

export type PermissionAction = "allow" | "ask" | "deny";

/** Permission keys recognized by the schema. */
export const PERMISSION_KEYS = [
	"read", "edit", "glob", "grep", "list", "bash", "task",
	"external_directory", "todowrite", "webfetch", "websearch",
	"lsp", "skill", "question", "doom_loop",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/** Keys that accept either shorthand or pattern→action object. */
export const OBJECT_CAPABLE_PERMISSION_KEYS = new Set<PermissionKey>([
	"read", "edit", "glob", "grep", "list", "bash",
	"task", "external_directory", "lsp", "skill",
]);

export type PermissionValue =
	| PermissionAction
	| Record<string, PermissionAction>;

export type PermissionMap = Partial<Record<PermissionKey, PermissionValue>>;

/** Tools spec preserves both shapes for diagnostics + a normalized view. */
export type ToolsSpec =
	| { kind: "csv"; allowed: Set<string>; raw: string }
	| { kind: "object"; allowed: Set<string>; deniedGlobs: string[]; raw: Record<string, boolean> };

export interface AgentDef {
	name: string;
	sourcePath: string;
	/** Discriminator. Default "all" applied by parser when absent. */
	mode: AgentMode;
	/** True when `mode:` was NOT present in the source (default applied). */
	modeImplicit: boolean;

	// opencode-parity fields
	description?: string;
	model?: string;
	prompt?: string;
	temperature?: number;
	steps?: number;
	disable?: boolean;
	hidden?: boolean;
	tools?: ToolsSpec;
	permission?: PermissionMap;

	// Markdown body (frontmatter-loaded files only). Used as fallback prompt.
	body?: string;

	// PI-specific fields (no opencode equivalent) — passed through unchanged.
	prompt_mode?: string;
	display_name?: string;
	extensions?: unknown;
	skills?: unknown;
	inherit_context?: boolean;
	isolated?: boolean;
	memoryScope?: string;
	thinkingLevel?: string;
	isolation?: string;
	run_in_background?: boolean;
	enabled?: boolean;
	max_turns?: number;
	disallowed_tools?: unknown;
	memory?: string;
	/** Catch-all for any other PI fields the loader wants to inspect. */
	raw: Record<string, unknown>;
}

export type ParseResult =
	| { ok: true; def: AgentDef }
	| { ok: false; error: string };
