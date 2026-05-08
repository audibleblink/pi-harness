/**
 * deps.ts — Shared dependency bag passed to every tool's register() function.
 */

import type { AutoClearManager } from "../auto-clear.js";
import type { TaskStore } from "../store.js";

/**
 * Spawn callback wired by index.ts. P5: returns error (cascade comes in P6 via
 * agents:subagent_end event bus). The shape is preserved so TaskExecute can
 * delegate without conditional logic.
 */
export type SpawnSubagent = (agentType: string, prompt: string, opts: {
  description: string;
  isBackground: boolean;
  maxTurns?: number;
}) => string;

export interface TaskDeps {
  getStore: () => TaskStore;
  autoClear: AutoClearManager;
  getCurrentTurn: () => number;
  schedulePublish: () => void;
  /** Spawn callback; throws "not implemented" in P5. */
  spawn: SpawnSubagent;
  /** Mutable record of last cascade config (set by TaskExecute, read by P6 cascade). */
  setCascadeConfig: (cfg: { additionalContext?: string; model?: string; maxTurns?: number }) => void;
}

export function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}
