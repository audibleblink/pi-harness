import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TaskDeps } from "./deps.js";
import { textResult } from "./deps.js";

export function register(pi: ExtensionAPI, deps: TaskDeps) {
  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Update a task's fields or status. Mark in_progress before starting work, completed only when fully done. Status \`deleted\` removes the task permanently.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
        anyOf: [
          { type: "string", enum: ["pending", "in_progress", "completed"] },
          { type: "string", const: "deleted" },
        ],
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
      owner: Type.Optional(Type.String({ description: "New owner for the task" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task." })),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    }),

    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const { taskId, ...fields } = params as any;
      const store = deps.getStore();
      const { task, changedFields, warnings } = store.update(taskId, fields);

      if (changedFields.length === 0 && !task) {
        return Promise.resolve(textResult(`Task #${taskId} not found`));
      }

      if (fields.status === "pending") {
        deps.autoClear.resetBatchCountdown();
      } else if (fields.status === "completed") {
        deps.autoClear.trackCompletion(taskId, deps.getCurrentTurn());
      }

      deps.schedulePublish();
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) msg += ` (warning: ${warnings.join("; ")})`;
      return Promise.resolve(textResult(msg));
    },
  });
}
