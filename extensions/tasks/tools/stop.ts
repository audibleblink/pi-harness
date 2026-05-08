import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { findTaskIdByAgentPrefix } from "../store.js";
import type { TaskDeps } from "./deps.js";
import { textResult } from "./deps.js";

export function register(pi: ExtensionAPI, deps: TaskDeps) {
  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `Stops a running background task by its ID.`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const { task_id, shell_id } = params as any;
      const taskId = task_id ?? shell_id;
      if (!taskId) throw new Error("task_id is required");

      const store = deps.getStore();
      let resolvedId = taskId;
      if (!store.get(resolvedId)) {
        const found = findTaskIdByAgentPrefix(taskId);
        if (found) resolvedId = found;
      }
      const task = store.get(resolvedId);
      if (!task) throw new Error(`No running background process for task ${taskId}`);

      store.update(resolvedId, { status: "completed" });
      deps.autoClear.trackCompletion(resolvedId, deps.getCurrentTurn());
      deps.schedulePublish();
      return textResult(`Task #${resolvedId} stopped successfully`);
    },
  });
}
