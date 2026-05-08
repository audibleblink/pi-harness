import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TaskDeps } from "./deps.js";
import { textResult } from "./deps.js";

export function register(pi: ExtensionAPI, deps: TaskDeps) {
  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Create a task in the session task list. Use for multi-step work (3+ distinct steps) or when the user provides a list of things to do. Skip for trivial, single-step, or purely conversational/informational requests.

Mark a task in_progress before starting it and completed only when fully done. After completing a task, check TaskList for newly unblocked work.

Tasks are created with status \`pending\`. Set \`agentType\` to mark a task for subagent execution via TaskExecute. Use TaskUpdate afterward to add blocks/blockedBy dependencies.`,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
      agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g., 'general-purpose', 'Explore')." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
    }),

    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const p = params as any;
      deps.autoClear.resetBatchCountdown();
      const meta = p.metadata ?? {};
      if (p.agentType) meta.agentType = p.agentType;
      const task = deps.getStore().create(p.subject, p.description, p.activeForm, Object.keys(meta).length > 0 ? meta : undefined);
      deps.schedulePublish();
      return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
    },
  });
}
