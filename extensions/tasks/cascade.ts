/**
 * cascade.ts — Task cascade-on-completion subscriber for `agents:subagent_end`.
 *
 * Wired in P6. Receives terminal subagent lifecycle events from
 * extensions/agents/ via the event bus (no cross-extension TS imports),
 * looks up the bound task via TaskStore's agent→task binding helpers,
 * updates task status, and (when autoCascade is enabled) releases /
 * launches dependent tasks.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutoClearManager } from "./auto-clear.js";
import { deleteTaskBinding, getTaskByAgent, setTaskBinding, type TaskStore } from "./store.js";
import type { SpawnSubagent } from "./tools/deps.js";

const DEBUG = !!process.env.PI_TASKS_DEBUG;

interface SubagentEndEvent {
  agentId: string;
  status: "success" | "failure" | "stopped";
  createdByTaskId?: string;
}

export interface CascadeDeps {
  getStore: () => TaskStore;
  autoClear: AutoClearManager;
  getCurrentTurn: () => number;
  schedulePublish: () => void;
  spawn: SpawnSubagent;
  /** Last cascade config recorded by TaskExecute; controls subsequent auto-cascades. */
  getCascadeConfig: () => { additionalContext?: string; model?: string; maxTurns?: number } | undefined;
  /** Whether cascade-on-completion auto-spawns unblocked dependents. */
  getAutoCascade: () => boolean;
}

export function registerCascade(pi: ExtensionAPI, deps: CascadeDeps): void {
  pi.on("agents:subagent_end" as any, async (raw: any) => {
    const event = raw as SubagentEndEvent;
    if (DEBUG) console.error("[tasks/cascade] agents:subagent_end", event);

    const taskId = getTaskByAgent(event.agentId) ?? event.createdByTaskId;
    if (!taskId) return;
    deleteTaskBinding(event.agentId);

    const store = deps.getStore();
    const task = store.get(taskId);
    if (!task) return;

    if (event.status === "failure") {
      store.update(task.id, {
        status: "pending",
        metadata: { ...task.metadata, lastError: "subagent failure" },
      });
      deps.autoClear.resetBatchCountdown();
      deps.schedulePublish();
      return;
    }

    // success or stopped → mark completed
    store.update(task.id, {
      status: "completed",
      metadata: { ...task.metadata },
    });
    deps.autoClear.trackCompletion(task.id, deps.getCurrentTurn());

    // Auto-cascade: launch any newly-unblocked dependents.
    const cascadeCfg = deps.getCascadeConfig();
    if (deps.getAutoCascade() && cascadeCfg) {
      const unblocked = store.list().filter(t =>
        t.status === "pending" &&
        t.metadata?.agentType &&
        t.blockedBy.includes(task.id) &&
        t.blockedBy.every(depId => store.get(depId)?.status === "completed")
      );
      for (const next of unblocked) {
        store.update(next.id, { status: "in_progress" });
        const prompt = buildTaskPrompt(next, cascadeCfg.additionalContext);
        try {
          const agentId = deps.spawn(next.metadata.agentType, prompt, {
            description: next.subject,
            isBackground: true,
            maxTurns: cascadeCfg.maxTurns,
          });
          setTaskBinding(agentId, next.id);
          store.update(next.id, { owner: agentId, metadata: { ...next.metadata, agentId } });
        } catch (err: any) {
          store.update(next.id, {
            status: "pending",
            metadata: { ...next.metadata, lastError: err.message },
          });
        }
      }
    }

    deps.schedulePublish();
  });
}

function buildTaskPrompt(task: { id: string; subject: string; description: string }, additionalContext?: string): string {
  let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;
  if (additionalContext) prompt += `\n\n${additionalContext}`;
  prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
  return prompt;
}
