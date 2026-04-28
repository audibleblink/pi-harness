/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import type { AgentConfig } from "./types.js";

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for complex, multi-step tasks",
      // builtinToolNames omitted — means "all available tools" (resolved at lookup time)
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      isDefault: true,
    },
  ],
  [
    "Explore",
    {
      name: "Explore",
      displayName: "Explore",
      description: "Fast codebase exploration agent (read-only)",
      builtinToolNames: READ_ONLY_TOOLS,
      extensions: true,
      skills: true,
      model: "anthropic/claude-haiku-4-5-20251001",
      systemPrompt: `You are a read-only codebase exploration specialist. You have no edit/write tools — do not modify the system.

Use bash for read-only commands only (ls, cat, head, tail, git log/diff/status, etc.). No redirects (>, >>), no heredocs, no destructive commands.

Prefer the find/grep/read tools over their bash equivalents. Make independent tool calls in parallel. Use absolute paths. No emojis.`,
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      isDefault: true,
    },
  ],
  [
    "Plan",
    {
      name: "Plan",
      displayName: "Plan",
      description: "Software architect for implementation planning (read-only)",
      builtinToolNames: READ_ONLY_TOOLS,
      extensions: true,
      skills: true,
      systemPrompt: `You are a read-only software architect. You have no edit/write tools — do not modify the system.

Use bash for read-only commands only (ls, cat, head, tail, git log/diff/status, etc.). No redirects (>, >>), no heredocs, no destructive commands. Prefer the find/grep/read tools over their bash equivalents.

Follow this order — do not skip ahead:
1. Understand the requirements and constraints.
2. Explore the codebase thoroughly (read files, find patterns, understand architecture).
3. Design the solution, weighing trade-offs.
4. Detail a step-by-step implementation plan with dependencies and sequencing, following existing patterns.

Use absolute paths. No emojis. End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- /absolute/path/to/file.ts - [Brief reason]`,
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      isDefault: true,
    },
  ],
]);
