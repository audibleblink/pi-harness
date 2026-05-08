/**
 * tasks/ — TaskStore + Task* tools + auto-clear.
 *
 * Owns: TaskCreate, TaskList, TaskGet, TaskUpdate, TaskOutput, TaskStop, TaskExecute.
 * Cascade-on-completion subscribes to `agents:subagent_end`.
 *
 * No TUI chrome calls. Publishes orchestration state via UIBus.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { publishOrchestration } from "../ui/bus.js";
import type { OrchestrationState } from "../ui/bus.js";
import { AutoClearManager } from "./auto-clear.js";
import { registerCascade } from "./cascade.js";
import { TaskStore } from "./store.js";
import type { TaskDeps } from "./tools/deps.js";
import { register as registerCreate } from "./tools/create.js";
import { register as registerExecute } from "./tools/execute.js";
import { register as registerGet } from "./tools/get.js";
import { register as registerList } from "./tools/list.js";
import { register as registerOutput } from "./tools/output.js";
import { register as registerStop } from "./tools/stop.js";
import { register as registerUpdate } from "./tools/update.js";

interface TasksConfig {
  taskScope?: "memory" | "session" | "project";
  autoCascade?: boolean;
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";
}

const AUTO_CLEAR_DELAY = 4;

function loadTasksConfig(): TasksConfig {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), ".pi", "tasks-config.json"), "utf-8"));
  } catch { return {}; }
}

export default function (pi: ExtensionAPI) {
  const cfg = loadTasksConfig();
  const piTasks = process.env.PI_TASKS;
  const taskScope = cfg.taskScope ?? "session";

  function resolveStorePath(sessionId?: string): string | undefined {
    if (piTasks === "off") return undefined;
    if (piTasks?.startsWith("/")) return piTasks;
    if (piTasks?.startsWith(".")) return resolve(piTasks);
    if (piTasks) return piTasks;
    if (taskScope === "memory") return undefined;
    if (taskScope === "session" && sessionId) {
      return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    }
    if (taskScope === "session") return undefined;
    return join(process.cwd(), ".pi", "tasks", "tasks.json");
  }

  let store = new TaskStore(resolveStorePath());
  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  let currentTurn = 0;
  let storeUpgraded = false;
  let cascadeConfig: { additionalContext?: string; model?: string; maxTurns?: number } | undefined;

  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if (taskScope === "session" && !piTasks) {
      const sessionId = ctx.sessionManager.getSessionId();
      store = new TaskStore(resolveStorePath(sessionId));
    }
    storeUpgraded = true;
  }

  let publishTimer: ReturnType<typeof setTimeout> | undefined;

  function buildOrchestrationState(): OrchestrationState {
    const tasks = store.list().map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      agentId: t.metadata?.agentId as string | undefined,
    }));
    return { agents: [], tasks };
  }

  function flushPublish() {
    publishTimer = undefined;
    publishOrchestration(pi, buildOrchestrationState());
  }

  function schedulePublish() {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(flushPublish, 50);
  }

  // P5: spawn callback is a stub — TaskExecute returns "not implemented" until P6 wires
  // a runner via the agents/ extension event bus.
  const spawn: TaskDeps["spawn"] = (_agentType, _prompt, _opts) => {
    throw new Error("TaskExecute spawn not yet wired (P6 cascade)");
  };

  const deps: TaskDeps = {
    getStore: () => store,
    autoClear,
    getCurrentTurn: () => currentTurn,
    schedulePublish,
    spawn,
    setCascadeConfig: (c) => { cascadeConfig = c; },
  };

  registerCreate(pi, deps);
  registerList(pi, deps);
  registerGet(pi, deps);
  registerUpdate(pi, deps);
  registerOutput(pi, deps);
  registerStop(pi, deps);
  registerExecute(pi, deps);

  registerCascade(pi, {
    getStore: () => store,
    autoClear,
    getCurrentTurn: () => currentTurn,
    schedulePublish,
    spawn,
    getCascadeConfig: () => cascadeConfig,
    getAutoCascade: () => cfg.autoCascade ?? false,
  });

  // ===== SESSION LIFECYCLE =====

  pi.on("session_start", async (_event, _ctx) => {
    schedulePublish();
  });

  pi.on("session_switch" as any, async (event: any, ctx: ExtensionContext) => {
    const isResume = event?.reason === "resume";
    storeUpgraded = false;
    currentTurn = 0;
    autoClear.reset();
    if (!isResume && taskScope === "memory") store.clearAll();
    upgradeStoreIfNeeded(ctx);
    schedulePublish();
  });

  pi.on("turn_start", async (_event, ctx) => {
    currentTurn++;
    upgradeStoreIfNeeded(ctx);
    if (autoClear.onTurnStart(currentTurn)) schedulePublish();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    upgradeStoreIfNeeded(ctx);
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    upgradeStoreIfNeeded(ctx);
  });

}
