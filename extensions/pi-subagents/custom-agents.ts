/**
 * custom-agents.ts — Load user-defined agents from project and personal (XDG) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
import type { AgentConfig, MemoryScope, ThinkingLevel } from "./types.js";

/**
 * Resolve the personal (global) agents directory. Precedence:
 *   1. $PI_CODING_AGENT_DIR/agents            (explicit override)
 *   2. $XDG_CONFIG_HOME/pi/agent/agents       (XDG)
 *   3. ~/.config/pi/agent/agents              (XDG default)
 * Used for writing (new agents). Reading also falls back to the legacy
 * ~/.pi/agent/agents path if it exists.
 */
export function getPersonalAgentsDir(): string {
  const piDir = process.env.PI_CODING_AGENT_DIR;
  if (piDir) return join(piDir, "agents");
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "pi", "agent", "agents");
}

/** Legacy personal dir (pre-XDG). Still read for backward compatibility. */
export function getLegacyPersonalAgentsDir(): string {
  return join(homedir(), ".pi", "agent", "agents");
}

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins, later overrides earlier):
 *   1. Legacy personal: ~/.pi/agent/agents/*.md            (backward compat)
 *   2. Personal (XDG):  $PI_CODING_AGENT_DIR or ~/.config/pi/agent/agents/*.md
 *   3. Project:         <cwd>/.pi/agents/*.md
 *
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  const legacyDir = getLegacyPersonalAgentsDir();
  const personalDir = getPersonalAgentsDir();
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  loadFromDir(legacyDir, agents, "global");    // lowest priority (legacy)
  if (personalDir !== legacyDir) loadFromDir(personalDir, agents, "global");
  loadFromDir(projectDir, agents, "project");  // highest priority
  return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(dir: string, agents: Map<string, AgentConfig>, source: "project" | "global"): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch {
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");

    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }

    const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);

    agents.set(name, {
      name,
      displayName: str(fm.display_name),
      description: str(fm.description) ?? name,
      builtinToolNames: csvList(fm.tools, BUILTIN_TOOL_NAMES),
      disallowedTools: csvListOptional(fm.disallowed_tools),
      extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
      skills: inheritField(fm.skills ?? fm.inherit_skills),
      model: str(fm.model),
      thinking: str(fm.thinking) as ThinkingLevel | undefined,
      maxTurns: nonNegativeInt(fm.max_turns),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "append" ? "append" : "replace",
      inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
      runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
      isolated: fm.isolated != null ? fm.isolated === true : undefined,
      memory: parseMemory(fm.memory),
      isolation: fm.isolation === "worktree" ? "worktree" : undefined,
      enabled: fm.enabled !== false,  // default true; explicitly false disables
      source,
    });
  }
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/** Extract a non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

/**
 * Parse a raw CSV field value into items, or undefined if absent/empty/"none".
 */
function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map(t => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Parse a comma-separated list field with defaults.
 * omitted → defaults; "none"/empty → []; csv → listed items.
 */
function csvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}

/**
 * Parse an optional comma-separated list field.
 * omitted → undefined; "none"/empty → undefined; csv → listed items.
 */
function csvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
}

/**
 * Parse a memory scope field.
 * omitted → undefined; "user"/"project"/"local" → MemoryScope.
 */
function parseMemory(val: unknown): MemoryScope | undefined {
  if (val === "user" || val === "project" || val === "local") return val;
  return undefined;
}

/**
 * Parse an inherit field (extensions, skills).
 * omitted/true → true (inherit all); false/"none"/empty → false; csv → listed names.
 */
function inheritField(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}
