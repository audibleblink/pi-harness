/**
 * orchestration — Merged pi-subagents + pi-tasks extension.
 *
 * Provides agent spawning, task tracking, and coordination in a single extension.
 * Replaces the separate pi-subagents and pi-tasks extensions.
 *
 * Agent tools:   Agent, get_subagent_result, steer_subagent
 * Task tools:    TaskCreate, TaskList, TaskGet, TaskUpdate, TaskOutput, TaskStop, TaskExecute
 * Commands:      /agents, /tasks
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentManager } from "./agent-manager.js";
import { getAgentConversation, getDefaultMaxTurns, getGraceTurns, normalizeMaxTurns, setDefaultMaxTurns, setGraceTurns, steerAgent } from "./agent-runner.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes, getAvailableTypes, getDefaultAgentNames, getUserAgentNames, registerAgents, resolveType } from "./agent-types.js";
import { loadCustomAgents, getPersonalAgentsDir, getLegacyPersonalAgentsDir } from "./custom-agents.js";
import { GroupJoinManager } from "./group-join.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { type AgentConfig, type AgentRecord, type JoinMode, type NotificationDetails, type SubagentType } from "./types.js";
import {
  type AgentActivity,
  type AgentDetails,
  describeActivity,
  formatDuration,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
} from "./agent-display.js";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import { TaskStore } from "./task-store.js";
import { loadTasksConfig } from "./tasks-config.js";
import { openSettingsMenu } from "./settings-menu.js";
import { publishOrchestration } from "../ui/bus.js";
import type { OrchestrationState } from "../ui/bus.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[orchestration]", ...args);
}

// ---- Shared helpers ----

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

/** Safely read total tokens from a session. Returns 0 if unavailable. */
function safeTotalTokens(session: { getSessionStats(): { tokens: { total: number } } } | undefined): number {
  if (!session) return 0;
  try { return session.getSessionStats().tokens?.total ?? 0; } catch { return 0; }
}

/** Safe token formatting — wraps session.getSessionStats() in try-catch. */
function safeFormatTokens(session: { getSessionStats(): { tokens: { total: number } } } | undefined): string {
  if (!session) return "";
  try { return formatTokens(session.getSessionStats().tokens.total); } catch { return ""; }
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = { activeTools: new Map(), toolUses: 0, turnCount: 1, maxTurns, tokens: "", responseText: "", session: undefined };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      state.tokens = safeFormatTokens(state.session);
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
  };

  return { state, callbacks };
}

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

/** Parenthetical status note for completed agent result text. */
function getStatusNote(status: string): string {
  switch (status) {
    case "aborted": return " (aborted — max turns exceeded, output may be incomplete)";
    case "steered": return " (wrapped up — reached turn limit)";
    case "stopped": return " (stopped by user)";
    default: return "";
  }
}

/** Escape XML special characters. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = safeTotalTokens(record.session);

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}

/** Build AgentDetails from a base + record-specific fields. */
function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: { toolUses: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: safeFormatTokens(record.session),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const totalTokens = safeTotalTokens(record.session);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

// ---- Task constants ----

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"]);
const REMINDER_INTERVAL = 4;
const AUTO_CLEAR_DELAY = 4;

const SYSTEM_REMINDER = `<system-reminder>
The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user
</system-reminder>`;

// ---- Build task prompt ----

function buildTaskPrompt(task: { id: string; subject: string; description: string }, additionalContext?: string): string {
  let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;
  if (additionalContext) prompt += `\n\n${additionalContext}`;
  prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
  return prompt;
}

export default function (pi: ExtensionAPI) {

  // ===== TASK STATE =====

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
  const tracker = new ProcessTracker();
  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  // ===== SHARED STATE =====

  /** Current session context — updated on every session/tool event. */
  let currentCtx: ExtensionContext | undefined;

  /** Maps agentId → taskId for O(1) completion lookup. */
  const agentTaskMap = new Map<string, string>();

  /** Cascade config — set by TaskExecute, consumed by completion callback. */
  let cascadeConfig: { additionalContext?: string; model?: string; maxTurns?: number } | undefined;

  // ===== AGENT ACTIVITY STATE =====

  const agentActivity = new Map<string, AgentActivity>();

  // ===== ORCHESTRATION PUBLISH =====

  let publishTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleOrchestrationPublish() {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      publishOrchestration(pi, buildOrchestrationState());
    }, 50);
  }

  function buildOrchestrationState(): OrchestrationState {
    const agents = manager.listAgents()
      .filter(a => a.status === "running" || a.status === "queued")
      .map(a => {
        const act = agentActivity.get(a.id);
        return {
          id: a.id,
          status: a.status,
          elapsed: Date.now() - a.startedAt,
          activity: act ? describeActivity(act.activeTools, act.responseText) : "thinking…",
          taskId: agentTaskMap.get(a.id),
        };
      });

    const tasks = store.list().map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      agentId: t.metadata?.agentId as string | undefined,
    }));

    return { agents, tasks };
  }

  // ===== DIRECT AGENT SPAWN/STOP (replaces rpcCall) =====

  function spawnSubagentDirect(type: string, prompt: string, options?: any): string {
    debug("spawn:direct", { type, options: { ...options, prompt: undefined } });
    if (!currentCtx) throw new Error("No active session");
    return manager.spawn(pi, currentCtx, type, prompt, options ?? {});
  }

  function stopSubagentDirect(agentId: string): void {
    manager.abort(agentId);
  }

  // ===== PENDING NUDGE HELPERS =====

  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(key, setTimeout(() => {
      pendingNudges.delete(key);
      send();
    }, delay));
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;

    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
  }

  // ===== GROUP JOIN MANAGER =====

  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { agentActivity.delete(r.id); }

      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      scheduleNudge(groupKey, () => {
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { scheduleOrchestrationPublish(); return; }

        const notifications = unconsumed.map(r => formatTaskNotification(r, 300)).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, 300, agentActivity.get(first.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      scheduleOrchestrationPublish();
    },
    30_000,
  );

  /** Build event data shape (kept for any internal use). */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    let tokens: { input: number; output: number; total: number } | undefined;
    try {
      if (record.session) {
        const stats = record.session.getSessionStats();
        tokens = {
          input: stats.tokens?.input ?? 0,
          output: stats.tokens?.output ?? 0,
          total: stats.tokens?.total ?? 0,
        };
      }
    } catch { /* session stats unavailable */ }
    return { id: record.id, type: record.type, description: record.description, result: record.result, error: record.error, status: record.status, toolUses: record.toolUses, durationMs, tokens };
  }
  void buildEventData; // suppress unused warning

  // ===== BATCH TRACKING =====

  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    const smartAgents = batchAgents.filter(a => a.joinMode === 'smart' || a.joinMode === 'group');
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      groupJoin.registerGroup(groupId, ids);
      for (const id of ids) {
        const record = manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      for (const { id } of batchAgents) {
        const record = manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  // ===== AGENT MANAGER =====
  // The completion callback handles both notification logic (from pi-subagents)
  // and task status updates (from pi-tasks).

  const manager = new AgentManager((record) => {
    // ── Task tracking (unified from pi-tasks completion listener) ──
    const taskId = agentTaskMap.get(record.id);
    if (taskId) {
      agentTaskMap.delete(record.id);
      const task = store.get(taskId);
      if (task) {
        if (record.status === "stopped") {
          // Intentional stop — mark completed, preserve partial result
          store.update(task.id, { status: "completed", metadata: { ...task.metadata, result: record.result || task.metadata?.result } });
          autoClear.trackCompletion(task.id, currentTurn);
        } else if (record.status === "error" || record.status === "aborted") {
          // Actual error — revert to pending
          store.update(task.id, { status: "pending", metadata: { ...task.metadata, lastError: record.error || record.status } });
          autoClear.resetBatchCountdown();
        } else {
          // Success — mark completed
          store.update(task.id, { status: "completed", metadata: { ...task.metadata, result: record.result } });

          // Auto-cascade: start unblocked dependent tasks
          if ((cfg.autoCascade ?? false) && cascadeConfig && currentCtx) {
            const unblocked = store.list().filter(t =>
              t.status === "pending" &&
              t.metadata?.agentType &&
              t.blockedBy.includes(task.id) &&
              t.blockedBy.every(depId => store.get(depId)?.status === "completed")
            );
            for (const next of unblocked) {
              store.update(next.id, { status: "in_progress" });
              const prompt = buildTaskPrompt(next, cascadeConfig.additionalContext);
              try {
                const agentId = spawnSubagentDirect(next.metadata.agentType, prompt, {
                  description: next.subject,
                  isBackground: true,
                  maxTurns: cascadeConfig.maxTurns,
                });
                agentTaskMap.set(agentId, next.id);
                store.update(next.id, { owner: agentId, metadata: { ...next.metadata, agentId } });
              } catch (err: any) {
                store.update(next.id, { status: "pending", metadata: { ...next.metadata, lastError: err.message } });
              }
            }
          }
          autoClear.trackCompletion(task.id, currentTurn);
        }
      }
    }

    // ── Notification logic (from pi-subagents completion callback) ──
    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      scheduleOrchestrationPublish();
      return;
    }

    if (currentBatchAgents.some(a => a.id === record.id)) {
      scheduleOrchestrationPublish();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    scheduleOrchestrationPublish();
  }, undefined, (_record) => {
    // onStart callback
    scheduleOrchestrationPublish();
  });

  // ===== JOIN MODE =====

  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // ===== SESSION AND TURN TRACKING =====

  let currentTurn = 0;
  let lastTaskToolUseTurn = 0;
  let reminderInjectedThisCycle = false;
  let storeUpgraded = false;
  let persistedTasksShown = false;

  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if (taskScope === "session" && !piTasks) {
      const sessionId = ctx.sessionManager.getSessionId();
      const path = resolveStorePath(sessionId);
      store = new TaskStore(path);
    }
    storeUpgraded = true;
  }

  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
        if (taskScope === "session") store.deleteFileIfEmpty();
      } else {
        scheduleOrchestrationPublish();
      }
    }
  }

  // ===== CUSTOM AGENT RELOAD =====

  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
  };
  reloadCustomAgents();

  // ===== SESSION EVENTS =====

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    manager.clearCompleted();
  });

  pi.on("session_switch" as any, async (event: any, ctx: ExtensionContext) => {
    currentCtx = ctx;

    const isResume = event?.reason === "resume";

    storeUpgraded = false;
    persistedTasksShown = false;
    currentTurn = 0;
    lastTaskToolUseTurn = 0;
    reminderInjectedThisCycle = false;
    autoClear.reset();

    if (!isResume && taskScope === "memory") {
      store.clearAll();
    }

    manager.clearCompleted();
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks(isResume);
  });

  pi.on("turn_start", async (_event, ctx) => {
    currentTurn++;
    currentCtx = ctx;
    upgradeStoreIfNeeded(ctx);
    if (autoClear.onTurnStart(currentTurn)) scheduleOrchestrationPublish();
  });

  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    void msg; // token tracking was for TaskWidget display only — no longer needed
  });

  pi.on("tool_result", async (event) => {
    if (TASK_TOOL_NAMES.has(event.toolName)) {
      lastTaskToolUseTurn = currentTurn;
      reminderInjectedThisCycle = false;
      return {};
    }
    if (currentTurn - lastTaskToolUseTurn < REMINDER_INTERVAL) return {};
    if (reminderInjectedThisCycle) return {};
    const tasks = store.list();
    if (tasks.length === 0) return {};
    reminderInjectedThisCycle = true;
    lastTaskToolUseTurn = currentTurn;
    return {
      content: [...event.content, { type: "text" as const, text: SYSTEM_REMINDER }],
    };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    currentCtx = ctx;
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks();
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    currentCtx = ctx;
    upgradeStoreIfNeeded(ctx);
    scheduleOrchestrationPublish();
  });

  pi.on("session_shutdown", async () => {
    currentCtx = undefined;
    manager.abortAll();
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
    manager.dispose();
  });

  // ===== CUSTOM NOTIFICATION RENDERER =====

  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status
          : d.status === "steered" ? "completed (steered)"
          : "completed";

        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        if (d.outputFile) {
          line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(renderOne).join("\n"), 0, 0);
    }
  );

  // ===== AGENT TYPE HELPERS =====

  const buildTypeListText = () => {
    const defaultNames = getDefaultAgentNames();
    const userNames = getUserAgentNames();

    const defaultDescs = defaultNames.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}`;
    });

    const customDescs = userNames.map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${cfg?.description ?? name}`;
    });

    return [
      "Default agents:",
      ...defaultDescs,
      ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
      "",
      "Custom agents can be defined in .pi/agents/<name>.md (project) or $PI_CODING_AGENT_DIR/agents/<name>.md (personal, defaults to $XDG_CONFIG_HOME/pi/agent/agents, i.e. ~/.config/pi/agent/agents) — picked up automatically. Project-level agents override personal ones. Creating a .md file with the same name as a default agent overrides it. The legacy path ~/.pi/agent/agents is still read for backward compatibility.",
    ].join("\n");
  };

  function getModelLabelFromConfig(model: string): string {
    const name = model.includes("/") ? model.split("/").pop()! : model;
    return name.replace(/-\d{8}$/, "");
  }

  const typeListText = buildTypeListText();

  // ===== AGENT TOOL =====

  pi.registerTool<any, AgentDetails>({
    name: "Agent",
    label: "Agent",
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
- For parallel work, use run_in_background: true on each agent. Foreground calls run sequentially — only one executes at a time.
- Use Explore for codebase searches and code understanding.
- Use Plan for architecture and implementation planning.
- Use general-purpose for complex tasks that need file editing.
- Provide clear, detailed prompts so the agent can work autonomously.
- Agent results are returned as text — summarize them for the user.
- Use run_in_background for work you don't need immediately. You will be notified when it completes.
- Use resume with an agent ID to continue a previous agent's work.
- Use steer_subagent to send mid-run messages to a running background agent.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications).`,
    parameters: Type.Object({
      prompt: Type.String({ description: "The task for the agent to perform." }),
      description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
      subagent_type: Type.String({ description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}.` }),
      model: Type.Optional(Type.String({ description: 'Optional model override. Accepts "provider/modelId" or fuzzy name.' })),
      thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh." })),
      max_turns: Type.Optional(Type.Number({ description: "Maximum number of agentic turns before stopping.", minimum: 1 })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Set to true to run in background. Returns agent ID immediately." })),
      resume: Type.Optional(Type.String({ description: "Optional agent ID to resume from." })),
      isolated: Type.Optional(Type.Boolean({ description: "If true, agent gets no extension/MCP tools." })),
      inherit_context: Type.Optional(Type.Boolean({ description: "If true, fork parent conversation into the agent." })),
      isolation: Type.Optional(Type.Literal("worktree", { description: 'Set to "worktree" to run in an isolated git worktree.' })),
    }),

    renderCall(args, theme) {
      const a = args as any;
      const displayName = a.subagent_type ? getDisplayName(a.subagent_type) : "Agent";
      const desc = a.description ?? "";
      return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as AgentDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(text, 0, 0);
      }

      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        return parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        let line = theme.fg("accent", frame) + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
        return new Text(line, 0, 0);
      }

      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");
      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }
      return new Text(line, 0, 0);
    },

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const p = params as any;
      currentCtx = ctx;
      reloadCustomAgents();

      const rawType = p.subagent_type as SubagentType;
      const resolved = resolveType(rawType);
      const subagentType = resolved ?? "general-purpose";
      const fellBack = resolved === undefined;

      const displayName = getDisplayName(subagentType);
      const customConfig = getAgentConfig(subagentType);
      const resolvedConfig = resolveAgentInvocationConfig(customConfig, p);

      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolved);
        } else {
          model = resolved;
        }
      }

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;

      const parentModelId = ctx.model?.id;
      const effectiveModelId = model?.id;
      const agentModelName = effectiveModelId && effectiveModelId !== parentModelId
        ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
        : undefined;
      const agentTags: string[] = [];
      const modeLabel = getPromptModeLabel(subagentType);
      if (modeLabel) agentTags.push(modeLabel);
      if (thinking) agentTags.push(`thinking: ${thinking}`);
      if (isolated) agentTags.push("isolated");
      if (isolation === "worktree") agentTags.push("worktree");
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const detailBase = {
        displayName,
        description: p.description,
        subagentType,
        modelName: agentModelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      // Resume existing agent
      if (p.resume) {
        const existing = manager.getRecord(p.resume);
        if (!existing) return textResult(`Agent not found: "${p.resume}". It may have been cleaned up.`);
        if (!existing.session) return textResult(`Agent "${p.resume}" has no active session to resume.`);
        const record = await manager.resume(p.resume, p.prompt, signal);
        if (!record) return textResult(`Failed to resume agent "${p.resume}".`);
        return textResult(
          record.result?.trim() || record.error?.trim() || "No output.",
          buildDetails(detailBase, record),
        );
      }

      // Background execution
      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: any) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
          }
        };

        id = manager.spawn(pi, ctx, subagentType, p.prompt, {
          description: p.description,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          isolation,
          ...bgCallbacks,
        });

        const joinMode = resolveJoinMode(defaultJoinMode, true);
        const record = manager.getRecord(id);
        if (record && joinMode) {
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          record.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
          writeInitialEntry(record.outputFile, id, p.prompt, ctx.cwd);
        }

        if (joinMode == null || joinMode === 'async') {
          // no batch
        } else {
          currentBatchAgents.push({ id, joinMode });
          if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
          batchFinalizeTimer = setTimeout(finalizeBatch, 100);
        }

        agentActivity.set(id, bgState);
        scheduleOrchestrationPublish();

        const isQueued = record?.status === "queued";
        return textResult(
          `Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${p.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
          { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      }

      // Foreground execution — stream progress via onUpdate
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;

      const streamUpdate = () => {
        const details: AgentDetails = {
          ...detailBase,
          toolUses: fgState.toolUses,
          tokens: fgState.tokens,
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          status: "running",
          activity: describeActivity(fgState.activeTools, fgState.responseText),
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details: details as any,
        });
      };

      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);

      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: any) => {
        origOnSession(session);
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            agentActivity.set(a.id, fgState);
            break;
          }
        }
      };

      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);

      streamUpdate();

      const record = await manager.spawnAndWait(pi, ctx, subagentType, p.prompt, {
        description: p.description,
        model,
        maxTurns: effectiveMaxTurns,
        isolated,
        inheritContext,
        thinkingLevel: thinking,
        isolation,
        ...fgCallbacks,
      });

      clearInterval(spinnerInterval);

      if (fgId) {
        agentActivity.delete(fgId);
      }

      const tokenText = safeFormatTokens(fgState.session);
      const details = buildDetails(detailBase, record, fgState, { tokens: tokenText });
      const fallbackNote = fellBack ? `Note: Unknown agent type "${rawType}" — using general-purpose.\n\n` : "";

      scheduleOrchestrationPublish();

      if (record.status === "error") {
        return textResult(`${fallbackNote}Agent failed: ${record.error}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      return textResult(
        `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
        (record.result?.trim() || "No output."),
        details,
      );
    },
  });

  // ===== GET SUBAGENT RESULT TOOL =====

  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Agent Result",
    description: "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to check." }),
      wait: Type.Optional(Type.Boolean({ description: "If true, wait for the agent to complete before returning." })),
      verbose: Type.Optional(Type.Boolean({ description: "If true, include the agent's full conversation." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const p = params as any;
      const record = manager.getRecord(p.agent_id);
      if (!record) return textResult(`Agent not found: "${p.agent_id}". It may have been cleaned up.`);

      if (p.wait && record.status === "running" && record.promise) {
        record.resultConsumed = true;
        cancelNudge(p.agent_id);
        await record.promise;
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = safeFormatTokens(record.session);
      const toolStats = tokens ? `Tool uses: ${record.toolUses} | ${tokens}` : `Tool uses: ${record.toolUses}`;

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status} | ${toolStats} | Duration: ${duration}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        cancelNudge(p.agent_id);
      }

      if (p.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) output += `\n\n--- Agent Conversation ---\n${conversation}`;
      }

      return textResult(output);
    },
  });

  // ===== STEER SUBAGENT TOOL =====

  pi.registerTool({
    name: "steer_subagent",
    label: "Steer Agent",
    description: "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to steer (must be currently running)." }),
      message: Type.String({ description: "The steering message to send." }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const p = params as any;
      const record = manager.getRecord(p.agent_id);
      if (!record) return textResult(`Agent not found: "${p.agent_id}". It may have been cleaned up.`);
      if (record.status !== "running") return textResult(`Agent "${p.agent_id}" is not running (status: ${record.status}).`);
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(p.message);
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }

      try {
        await steerAgent(record.session, p.message);
        return textResult(`Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.`);
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  // ===== TASK TOOLS =====

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
- Include \`agentType\` (e.g., "general-purpose", "Explore") to mark tasks for subagent execution via TaskExecute`,
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

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const p = params as any;
      autoClear.resetBatchCountdown();
      const meta = p.metadata ?? {};
      if (p.agentType) meta.agentType = p.agentType;
      const task = store.create(p.subject, p.description, p.activeForm, Object.keys(meta).length > 0 ? meta : undefined);
      scheduleOrchestrationPublish();
      return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
    },
  });

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available

## Output

Returns a summary of each task including id, subject, status, owner, and blockedBy.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;
        if (task.owner) line += ` (${task.owner})`;
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && blocker.status !== "completed";
          });
          if (openBlockers.length > 0) line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
        }
        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Use this tool to retrieve a task by its ID from the task list.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const p = params as any;
      const task = store.get(p.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      const desc = task.description.replace(/\\n/g, "\n");
      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.owner) lines.push(`Owner: ${task.owner}`);
      lines.push(`Description: ${desc}`);

      if (task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
      }
      if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
      const metaKeys = Object.keys(task.metadata);
      if (metaKeys.length > 0) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first

**Mark tasks as resolved:**
- When you have completed the work described in a task
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- ONLY mark a task as completed when you have FULLY accomplished it

**Delete tasks:**
- Setting status to \`deleted\` permanently removes the task

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\``,
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

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...fields } = params as any;
      const { task, changedFields, warnings } = store.update(taskId, fields);

      if (changedFields.length === 0 && !task) {
        return Promise.resolve(textResult(`Task #${taskId} not found`));
      }

      if (fields.status === "pending") {
        autoClear.resetBatchCountdown();
      } else if (fields.status === "completed" || fields.status === "deleted") {
        if (fields.status === "completed") autoClear.trackCompletion(taskId, currentTurn);
      }

      scheduleOrchestrationPublish();
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) msg += ` (warning: ${warnings.join("; ")})`;
      return Promise.resolve(textResult(msg));
    },
  });

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

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block, timeout } = params as any;

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) {
        let resolvedId = task_id;
        if (!store.get(resolvedId)) {
          for (const [agentId, taskId] of agentTaskMap) {
            if (agentId === task_id || agentId.startsWith(task_id)) { resolvedId = taskId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (!task) throw new Error(`No task found with ID ${task_id}`);

        if (task.metadata?.agentId) {
          if (block && task.status === "in_progress") {
            const agentRecord = manager.getRecord(task.metadata.agentId);
            if (agentRecord?.promise) {
              await Promise.race([
                agentRecord.promise,
                new Promise<void>((_resolve, reject) => {
                  const timer = setTimeout(() => reject(new Error("timeout")), timeout ?? 30000);
                  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
                }).catch(() => {}),
              ]).catch(() => {});
            }
          }
          const updated = store.get(task_id) ?? task;
          return textResult(`Task #${task_id} [${updated.status}] — subagent ${task.metadata.agentId}`);
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
      );
    },
  });

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `Stops a running background task by its ID.`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { task_id, shell_id } = params as any;
      const taskId = task_id ?? shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await tracker.stop(taskId);
      if (!stopped) {
        let resolvedId = taskId;
        if (!store.get(resolvedId)) {
          for (const [agentId, tId] of agentTaskMap) {
            if (agentId === taskId || agentId.startsWith(taskId)) { resolvedId = tId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (task?.metadata?.agentId && task.status === "in_progress") {
          store.update(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, currentTurn);
          stopSubagentDirect(task.metadata.agentId);
          scheduleOrchestrationPublish();
          return textResult(`Task #${taskId} stopped successfully`);
        }
        throw new Error(`No running background process for task ${taskId}`);
      }

      store.update(taskId, { status: "completed" });
      autoClear.trackCompletion(taskId, currentTurn);
      scheduleOrchestrationPublish();
      return textResult(`Task #${taskId} stopped successfully`);
    },
  });

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

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const p = params as any;
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
          const agentId = spawnSubagentDirect(task.metadata.agentType, prompt, {
            description: task.subject,
            isBackground: true,
            maxTurns: p.max_turns,
          });
          agentTaskMap.set(agentId, taskId);
          store.update(taskId, { owner: agentId, metadata: { ...task.metadata, agentId } });
          launched.push(`#${taskId} → agent ${agentId}`);
        } catch (err: any) {
          debug(`spawn:error task=#${taskId}`, err);
          store.update(taskId, { status: "pending" });
          results.push(`#${taskId}: spawn failed — ${err.message}`);
        }
      }

      cascadeConfig = {
        additionalContext: p.additional_context,
        model: p.model,
        maxTurns: p.max_turns,
      };

      scheduleOrchestrationPublish();

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

  // ===== /AGENTS COMMAND =====

  const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
  const personalAgentsDir = () => getPersonalAgentsDir();
  const legacyPersonalAgentsDir = () => getLegacyPersonalAgentsDir();
  const personalLocationLabel = () => `Personal (${personalAgentsDir()}/)`;

  function findAgentFile(name: string): { path: string; location: "project" | "personal" } | undefined {
    const projectPath = join(projectAgentsDir(), `${name}.md`);
    if (existsSync(projectPath)) return { path: projectPath, location: "project" };
    const personalPath = join(personalAgentsDir(), `${name}.md`);
    if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
    const legacyPath = join(legacyPersonalAgentsDir(), `${name}.md`);
    if (existsSync(legacyPath)) return { path: legacyPath, location: "personal" };
    return undefined;
  }

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit";
    if (registry) {
      const resolved = resolveModel(cfg.model, registry);
      if (typeof resolved === "string") return "inherit";
    }
    return getModelLabelFromConfig(cfg.model);
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();
    const options: string[] = [];

    const agents = manager.listAgents();
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }

    if (allNames.length > 0) options.push(`Agent types (${allNames.length})`);
    options.push("Create new agent");
    options.push("Settings");

    const noAgentsMsg = allNames.length === 0 && agents.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";

    if (noAgentsMsg) ctx.ui.notify(noAgentsMsg, "info");

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Running agents (")) {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) { ctx.ui.notify("No agents.", "info"); return; }

    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    const entries = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      const indicator = sourceIndicator(cfg);
      const prefix = `${indicator}${name} · ${model}`;
      const desc = disabled ? "(disabled)" : (cfg?.description ?? name);
      return { name, prefix, desc };
    });
    const maxPrefix = Math.max(...entries.map(e => e.prefix.length));

    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");
    const legend = legendParts.length ? "\n" + legendParts.join("  ") : "";

    const options = entries.map(({ prefix, desc }) => `${prefix.padEnd(maxPrefix)} — ${desc}`);
    if (legend) options.push(legend);

    const choice = await ctx.ui.select("Agent types", options);
    if (!choice) return;

    const agentName = choice.split(" · ")[0].replace(/^[•◦✕\s]+/, "").trim();
    if (getAgentConfig(agentName)) {
      await showAgentDetail(ctx, agentName);
      await showAllAgentsList(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents();
    if (agents.length === 0) { ctx.ui.notify("No agents.", "info"); return; }

    const options = agents.map(a => {
      const dn = getDisplayName(a.type);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });

    const choice = await ctx.ui.select("Running agents", options);
    if (!choice) return;

    const idx = options.indexOf(choice);
    if (idx < 0) return;
    const record = agents[idx];

    await viewAgentConversation(ctx, record);
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
    if (!record.session) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
      return;
    }

    const { ConversationViewer } = await import("./conversation-viewer.js");
    const session = record.session;
    const activity = agentActivity.get(record.id);

    await ctx.ui.custom<undefined>(
      (tui, theme, _keybindings, done) => {
        return new ConversationViewer(tui, session, record, activity, theme, done);
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%" },
      },
    );
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) { ctx.ui.notify(`Agent config not found for "${name}".`, "warning"); return; }

    const file = findAgentFile(name);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
        if (confirmed) {
          unlinkSync(file.path);
          reloadCustomAgents();
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
      if (confirmed) {
        unlinkSync(file.path);
        reloadCustomAgents();
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      personalLocationLabel(),
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const fmFields: string[] = [];
    fmFields.push(`description: ${cfg.description}`);
    if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
    fmFields.push(`tools: ${cfg.builtinToolNames?.join(", ") || "all"}`);
    if (cfg.model) fmFields.push(`model: ${cfg.model}`);
    if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
    if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
    fmFields.push(`prompt_mode: ${cfg.promptMode}`);
    if (cfg.extensions === false) fmFields.push("extensions: false");
    else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
    if (cfg.skills === false) fmFields.push("skills: false");
    else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
    if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
    if (cfg.inheritContext) fmFields.push("inherit_context: true");
    if (cfg.runInBackground) fmFields.push("run_in_background: true");
    if (cfg.isolated) fmFields.push("isolated: true");
    if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
    if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);

    const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (file) {
      const content = readFileSync(file.path, "utf-8");
      if (content.includes("\nenabled: false\n")) {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      const updated = content.replace(/^---\n/, "---\nenabled: false\n");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      personalLocationLabel(),
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (!file) return;

    const content = readFileSync(file.path, "utf-8");
    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
    const { writeFileSync } = await import("node:fs");

    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      personalLocationLabel(),
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body.
Write the file using the write tool. Only write the file, nothing else.`;

    const record = await manager.spawnAndWait(pi, ctx, "general-purpose", generatePrompt, {
      description: `Generate ${name} agent`,
      maxTurns: 5,
    });

    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }

    reloadCustomAgents();

    if (existsSync(targetPath)) {
      ctx.ui.notify(`Created ${targetPath}`, "info");
    } else {
      ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
    }
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    const toolChoice = await ctx.ui.select("Tools", ["all", "none", "read-only (read, bash, grep, find, ls)", "custom..."]);
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice === "all") tools = BUILTIN_TOOL_NAMES.join(", ");
    else if (toolChoice === "none") tools = "none";
    else if (toolChoice.startsWith("read-only")) tools = "read, bash, grep, find, ls";
    else {
      const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
      if (!customTools) return;
      tools = customTools;
    }

    const modelChoice = await ctx.ui.select("Model", ["inherit (parent model)", "haiku", "sonnet", "opus", "custom..."]);
    if (!modelChoice) return;

    let modelLine = "";
    if (modelChoice === "haiku") modelLine = "\nmodel: anthropic/claude-haiku-4-5-20251001";
    else if (modelChoice === "sonnet") modelLine = "\nmodel: anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") modelLine = "\nmodel: anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      const customModel = await ctx.ui.input("Model (provider/modelId)");
      if (customModel) modelLine = `\nmodel: ${customModel}`;
    }

    const thinkingChoice = await ctx.ui.select("Thinking level", ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"]);
    if (!thinkingChoice) return;
    const thinkingLine = thinkingChoice !== "inherit" ? `\nthinking: ${thinkingChoice}` : "";

    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    const content = `---
description: ${description}
tools: ${tools}${modelLine}${thinkingLine}
prompt_mode: replace
---

${systemPrompt}
`;

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  async function showSettings(ctx: ExtensionCommandContext) {
    const choice = await ctx.ui.select("Settings", [
      `Max concurrency (current: ${manager.getMaxConcurrent()})`,
      `Default max turns (current: ${getDefaultMaxTurns() ?? "unlimited"})`,
      `Grace turns (current: ${getGraceTurns()})`,
      `Join mode (current: ${getDefaultJoinMode()})`,
    ]);
    if (!choice) return;

    if (choice.startsWith("Max concurrency")) {
      const val = await ctx.ui.input("Max concurrent background agents", String(manager.getMaxConcurrent()));
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) { manager.setMaxConcurrent(n); ctx.ui.notify(`Max concurrency set to ${n}`, "info"); }
        else ctx.ui.notify("Must be a positive integer.", "warning");
      }
    } else if (choice.startsWith("Default max turns")) {
      const val = await ctx.ui.input("Default max turns before wrap-up (0 = unlimited)", String(getDefaultMaxTurns() ?? 0));
      if (val) {
        const n = parseInt(val, 10);
        if (n === 0) { setDefaultMaxTurns(undefined); ctx.ui.notify("Default max turns set to unlimited", "info"); }
        else if (n >= 1) { setDefaultMaxTurns(n); ctx.ui.notify(`Default max turns set to ${n}`, "info"); }
        else ctx.ui.notify("Must be 0 (unlimited) or a positive integer.", "warning");
      }
    } else if (choice.startsWith("Grace turns")) {
      const val = await ctx.ui.input("Grace turns after wrap-up steer", String(getGraceTurns()));
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) { setGraceTurns(n); ctx.ui.notify(`Grace turns set to ${n}`, "info"); }
        else ctx.ui.notify("Must be a positive integer.", "warning");
      }
    } else if (choice.startsWith("Join mode")) {
      const val = await ctx.ui.select("Default join mode for background agents", [
        "smart — auto-group 2+ agents in same turn (default)",
        "async — always notify individually",
        "group — always group background agents",
      ]);
      if (val) {
        const mode = val.split(" ")[0] as JoinMode;
        setDefaultJoinMode(mode);
        ctx.ui.notify(`Default join mode set to ${mode}`, "info");
      }
    }
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });

  // ===== /TASKS COMMAND =====

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          store.clearCompleted();
          if (taskScope === "session") store.deleteFileIfEmpty();
          scheduleOrchestrationPublish();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          store.clearAll();
          if (taskScope === "session") store.deleteFileIfEmpty();
          scheduleOrchestrationPublish();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const statusIcon = (status: string) => {
          switch (status) {
            case "completed": return "✔";
            case "in_progress": return "◼";
            default: return "◻";
          }
        };

        const choices = tasks.map(t => `${statusIcon(t.status)} #${t.id} [${t.status}] ${t.subject}`);
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        const match = selected.match(/#(\d+)/);
        if (match) await viewTaskDetail(match[1]);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];
        if (task.status === "pending") actions.push("▸ Start (in_progress)");
        if (task.status === "in_progress") actions.push("✓ Complete");
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          store.update(taskId, { status: "in_progress" });
          scheduleOrchestrationPublish();
          return viewTasks();
        } else if (action === "✓ Complete") {
          store.update(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, currentTurn);
          scheduleOrchestrationPublish();
          return viewTasks();
        } else if (action === "✗ Delete") {
          store.update(taskId, { status: "deleted" });
          scheduleOrchestrationPublish();
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, mainMenu, AUTO_CLEAR_DELAY);

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        store.create(subject, description);
        scheduleOrchestrationPublish();
        return mainMenu();
      };

      await mainMenu();
    },
  });
}
