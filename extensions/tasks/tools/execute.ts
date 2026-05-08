import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { setTaskBinding } from "../store.js";
import type { TaskDeps } from "./deps.js";
import { textResult } from "./deps.js";

export function register(pi: ExtensionAPI, deps: TaskDeps) {
  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: `Execute one or more tasks as subagents.

## When to Use This Tool

- To start execution of tasks that have \`agentType\` set (created via TaskCreate with agentType parameter)
- Tasks must be \`pending\` with all blockedBy dependencies \`completed\`
- Each task runs as an independent background subagent`,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const p = params as any;
      const store = deps.getStore();
      const results: string[] = [];
      const launched: string[] = [];

      for (const taskId of p.task_ids) {
        const task = store.get(taskId);
        if (!task) { results.push(`#${taskId}: not found`); continue; }
        if (task.status !== "pending") { results.push(`#${taskId}: not pending (status: ${task.status})`); continue; }
        if (!task.metadata?.agentType) { results.push(`#${taskId}: no agentType set`); continue; }

        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return !blocker || blocker.status !== "completed";
        });
        if (openBlockers.length > 0) { results.push(`#${taskId}: blocked by ${openBlockers.map(id => "#" + id).join(", ")}`); continue; }

        store.update(taskId, { status: "in_progress" });
        const prompt = buildTaskPrompt(task, p.additional_context);
        try {
          const agentId = deps.spawn(task.metadata.agentType, prompt, {
            description: task.subject,
            isBackground: true,
            maxTurns: p.max_turns,
          });
          setTaskBinding(agentId, taskId);
          store.update(taskId, { owner: agentId, metadata: { ...task.metadata, agentId } });
          launched.push(`#${taskId} → agent ${agentId}`);
        } catch (err: any) {
          store.update(taskId, { status: "pending" });
          results.push(`#${taskId}: spawn failed — ${err.message}`);
        }
      }

      deps.setCascadeConfig({
        additionalContext: p.additional_context,
        model: p.model,
        maxTurns: p.max_turns,
      });

      deps.schedulePublish();

      const lines: string[] = [];
      if (launched.length > 0) {
        lines.push(
          `Launched ${launched.length} agent(s):\n${launched.join("\n")}\n` +
          `Use TaskOutput to check progress. Do not spawn additional agents for these tasks.`
        );
      }
      if (results.length > 0) lines.push(`Skipped:\n${results.join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });
}

function buildTaskPrompt(task: { id: string; subject: string; description: string }, additionalContext?: string): string {
  let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;
  if (additionalContext) prompt += `\n\n${additionalContext}`;
  prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
  return prompt;
}
