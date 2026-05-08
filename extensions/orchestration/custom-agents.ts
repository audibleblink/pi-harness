/**
 * custom-agents.ts — Load user-defined agents from project and personal (XDG) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseAgentFrontmatter } from "../_agent-schema/parse-frontmatter.js";
import { loadSettingsAgents } from "../_agent-schema/load-settings-agents.js";
import type { AgentDef } from "../_agent-schema/types.js";
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
 *   3. Packages (global+project settings.json) → <packageRoot>/agents/*.md
 *   4. Project:         <cwd>/.pi/agents/*.md
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
  for (const { root, scope } of resolvePackageAgentRoots(cwd)) {
    loadFromDir(join(root, "agents"), agents, scope);
  }
  loadFromDir(projectDir, agents, "project");  // highest priority

  // JSON-defined agents (settings.json `agent` map) override markdown by name.
  const personalParent = join(getPersonalAgentsDir(), "..");
  for (const sp of [join(personalParent, "settings.json"), join(cwd, ".pi", "settings.json")]) {
    if (!existsSync(sp)) continue;
    try {
      const settings = JSON.parse(readFileSync(sp, "utf-8"));
      const { defs, errors } = loadSettingsAgents(settings, sp);
      for (const e of errors) console.error(`[orchestration] ${e}`);
      for (const [name, def] of defs) {
        // Subagent-eligible: mode subagent or all (default).
        if (def.mode !== "subagent" && def.mode !== "all") continue;
        if (def.disable === true) continue;
        agents.set(name, fromAgentDef(name, def, sp.includes("/.pi/") ? "project" : "global"));
      }
    } catch {
      // skip
    }
  }
  return agents;
}

/** Map a parsed AgentDef to the orchestration AgentConfig shape. */
function fromAgentDef(name: string, def: AgentDef, source: "project" | "global"): AgentConfig {
  const csvTools = def.tools?.kind === "csv" ? Array.from(def.tools.allowed) : undefined;
  return {
    name,
    displayName: def.display_name,
    description: def.description ?? name,
    builtinToolNames: csvTools ?? BUILTIN_TOOL_NAMES,
    disallowedTools: Array.isArray(def.disallowed_tools)
      ? def.disallowed_tools.filter((t): t is string => typeof t === "string") : undefined,
    extensions: inheritFromDef(def.extensions),
    skills: inheritFromDef(def.skills),
    model: def.model,
    thinking: def.thinkingLevel as ThinkingLevel | undefined,
    maxTurns: typeof def.max_turns === "number" && def.max_turns >= 0 ? def.max_turns : undefined,
    systemPrompt: (def.prompt ?? def.body ?? "").trim(),
    promptMode: def.prompt_mode === "append" ? "append" : "replace",
    inheritContext: def.inherit_context,
    runInBackground: def.run_in_background,
    isolated: def.isolated,
    memory: parseMemory(def.memory),
    isolation: def.isolation === "worktree" ? "worktree" : undefined,
    enabled: def.disable !== true && def.enabled !== false,
    source,
  };
}

function inheritFromDef(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  if (Array.isArray(val)) {
    const items = val.filter((v): v is string => typeof v === "string");
    return items.length > 0 ? items : false;
  }
  if (typeof val === "string") {
    const items = val.split(",").map(t => t.trim()).filter(Boolean);
    return items.length > 0 ? items : false;
  }
  return true;
}

/** Settings.json paths: project (<cwd>/.pi/settings.json) and global (XDG personal dir parent). */
function resolvePackageAgentRoots(cwd: string): Array<{ root: string; scope: "project" | "global" }> {
  const out: Array<{ root: string; scope: "project" | "global" }> = [];
  const personalParent = join(getPersonalAgentsDir(), ".."); // ~/.config/pi/agent
  const globalSettings = join(personalParent, "settings.json");
  const projectSettings = join(cwd, ".pi", "settings.json");

  // Global first (lower priority), then project (higher priority)
  for (const pkg of readPackages(globalSettings)) {
    const root = resolvePackageRoot(pkg, personalParent);
    if (root) out.push({ root, scope: "global" });
  }
  for (const pkg of readPackages(projectSettings)) {
    const root = resolvePackageRoot(pkg, join(cwd, ".pi"));
    if (root) out.push({ root, scope: "project" });
  }
  return out;
}

function readPackages(settingsPath: string): Array<string | { source?: string }> {
  if (!existsSync(settingsPath)) return [];
  try {
    const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return Array.isArray(data.packages) ? data.packages : [];
  } catch { return []; }
}

/** Resolve a package source spec to a local directory, if it exists. */
function resolvePackageRoot(pkg: string | { source?: string }, settingsDir: string): string | undefined {
  const source = (typeof pkg === "string" ? pkg : pkg.source)?.trim();
  if (!source) return undefined;
  // Local path (absolute, ~, or relative to settings dir)
  if (source.startsWith("/") || source.startsWith("~") || source.startsWith(".")) {
    const expanded = source.startsWith("~") ? join(homedir(), source.slice(source[1] === "/" ? 2 : 1)) : source;
    const abs = expanded.startsWith("/") ? expanded : join(settingsDir, expanded);
    return existsSync(abs) ? abs : undefined;
  }
  // Git URL → check pi's cache layout: ~/.config/pi/agent/git/<host>/<owner>/<repo>
  const m = source.match(/^(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/.]+)(?:\.git)?\/?$/);
  if (m) {
    const [, host, owner, repo] = m;
    const cached = join(getPersonalAgentsDir(), "..", "git", host, owner, repo);
    return existsSync(cached) ? cached : undefined;
  }
  return undefined;
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
    const filePath = join(dir, file);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const res = parseAgentFrontmatter(content, filePath);
    if (!res.ok) {
      console.error(`[orchestration] ${res.error}`);
      continue;
    }
    const def = res.def;
    const name = basename(file, ".md");
    agents.set(name, fromAgentDef(name, def, source));
  }
}

/** Memory scope coercion. */
function parseMemory(val: unknown): MemoryScope | undefined {
  if (val === "user" || val === "project" || val === "local") return val;
  return undefined;
}
