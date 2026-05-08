import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { findTaskIdByAgentPrefix } from "../store.js";
import type { TaskDeps } from "./deps.js";
import { textResult } from "./deps.js";

export function register(pi: ExtensionAPI, deps: TaskDeps) {
  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 }),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const { task_id } = params as any;
      const store = deps.getStore();

      let resolvedId = task_id;
      if (!store.get(resolvedId)) {
        const found = findTaskIdByAgentPrefix(task_id);
        if (found) resolvedId = found;
      }
      const task = store.get(resolvedId);
      if (!task) throw new Error(`No task found with ID ${task_id}`);

      const agentId = task.metadata?.agentId as string | undefined;
      if (agentId) {
        return textResult(`Task #${task.id} [${task.status}] — subagent ${agentId}`);
      }
      return textResult(`Task #${task.id} [${task.status}]`);
    },
  });
}
