/**
 * Agent loader for extensions/agents/.
 *
 * Walks the same three locations as today's modes.ts:
 *   1. <agentDir>/agents/*.md       (global user)
 *   2. <packageRoot>/agents/*.md    (this package)
 *   3. <cwd>/.pi/agents/*.md        (project-local)
 *
 * Merges JSON entries from settings.json `agent` map (JSON wins on
 * collision). Returns Map<string, AgentDefinition> + load errors.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { parseAgentFrontmatter } from "../_agent-schema/parse-frontmatter.js";
import { loadSettingsAgents } from "../_agent-schema/load-settings-agents.js";
import type { AgentDef, PermissionMap } from "../_agent-schema/types.js";

export interface AgentDefinition {
	name: string;
	description?: string;
	model?: string;
	tools?: string[];
	promptMode?: "replace" | "prepend";
	body: string;
	permission?: PermissionMap;
}

export interface LoadResult {
	agents: Map<string, AgentDefinition>;
	defs: Map<string, AgentDef>;
	errors: string[];
}

function findExtensionPackageRoot(): string | undefined {
	let dir: string;
	try {
		dir = dirname(fileURLToPath(import.meta.url));
	} catch {
		return undefined;
	}
	let prev = "";
	while (dir && dir !== prev) {
		if (existsSync(join(dir, "package.json")) || existsSync(join(dir, "agents"))) return dir;
		prev = dir;
		dir = dirname(dir);
	}
	return undefined;
}

const EXTENSION_PACKAGE_ROOT = findExtensionPackageRoot();

function findAgentFiles(...dirs: string[]): string[] {
	const files: string[] = [];
	for (const dir of dirs) {
		try {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (e.isFile() && e.name.endsWith(".md")) files.push(join(dir, e.name));
			}
		} catch {
			// skip
		}
	}
	return files;
}

function primaryEligible(def: AgentDef): boolean {
	if (def.disable === true) return false;
	return def.mode === "primary" || def.mode === "all";
}

function defToDefinition(name: string, def: AgentDef): AgentDefinition {
	const tools = def.tools?.kind === "csv" || def.tools?.kind === "object"
		? Array.from(def.tools.allowed)
		: undefined;
	return {
		name,
		description: def.description,
		model: def.model,
		tools,
		promptMode: def.prompt_mode === "replace" ? "replace" : "prepend",
		body: (def.prompt ?? def.body ?? "").trim(),
		permission: def.permission,
	};
}

export function loadAgents(cwd: string): LoadResult {
	const agents = new Map<string, AgentDefinition>();
	const defs = new Map<string, AgentDef>();
	const errors: string[] = [];

	const globalDir = join(getAgentDir(), "agents");
	const packageDir = EXTENSION_PACKAGE_ROOT ? join(EXTENSION_PACKAGE_ROOT, "agents") : undefined;
	const projectDir = join(cwd, ".pi", "agents");
	const dirs = [globalDir, packageDir, projectDir].filter((d): d is string => Boolean(d));

	// Markdown files (later sources override earlier).
	for (const dir of dirs) {
		for (const file of findAgentFiles(dir)) {
			let raw: string;
			try { raw = readFileSync(file, "utf-8"); } catch { continue; }
			const res = parseAgentFrontmatter(raw, file);
			if (!res.ok) { errors.push(res.error); continue; }
			if (res.def.disable !== true) defs.set(res.def.name, res.def);
			if (!primaryEligible(res.def)) continue;
			if (!res.def.body && !res.def.prompt && !res.def.description) continue;
			agents.set(res.def.name, defToDefinition(res.def.name, res.def));
		}
	}

	// JSON-defined agents from settings.json `agent` map. JSON wins on collision.
	const settingsPaths = [
		join(getAgentDir(), "settings.json"),
		join(cwd, ".pi", "settings.json"),
	];
	for (const sp of settingsPaths) {
		let parsed: unknown;
		try { parsed = JSON.parse(readFileSync(sp, "utf-8")); } catch { continue; }
		const { defs: jsonDefs, errors: errs } = loadSettingsAgents(parsed, sp);
		for (const e of errs) errors.push(e);
		for (const [name, def] of jsonDefs) {
			if (def.disable !== true) defs.set(name, def);
			if (!primaryEligible(def)) continue;
			agents.set(name, defToDefinition(name, def));
		}
	}

	return { agents, defs, errors };
}
