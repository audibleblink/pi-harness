/**
 * `/agents` — live status view of running/queued subagents and tasks.
 *
 * Separate from `/agent` (primary-agent switcher in commands.ts) because it
 * needs access to the subagent runtime + the tasks-snapshot bridge.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { getTasksSnapshotFn, type TaskSnapshot } from "../_shared/spawn-bridge.js";
import type { SubagentRuntime } from "./subagent-runner.js";
import type { AgentRecord } from "./internal/types.js";

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function buildItems(agents: AgentRecord[], tasks: TaskSnapshot[]): SelectItem[] {
  const items: SelectItem[] = [];
  const now = Date.now();

  const live = agents.filter(a => a.status === "running" || a.status === "queued");
  const done = agents.filter(a => a.status !== "running" && a.status !== "queued");

  for (const a of live) {
    items.push({
      value: `agent:${a.id}`,
      label: `▶ ${a.type} (${a.id.slice(0, 8)})`,
      description: `${a.status} · ${fmtElapsed(now - a.startedAt)} · ${a.description}`,
    });
  }
  for (const a of done) {
    const dur = a.completedAt ? fmtElapsed(a.completedAt - a.startedAt) : "?";
    items.push({
      value: `agent:${a.id}`,
      label: `· ${a.type} (${a.id.slice(0, 8)})`,
      description: `${a.status} · ${dur} · ${a.description}`,
    });
  }

  for (const t of tasks) {
    const marker = t.status === "in_progress" ? "▶" : t.status === "completed" ? "✓" : "·";
    const agentSuffix = t.agentId ? ` → ${t.agentId.slice(0, 8)}` : "";
    items.push({
      value: `task:${t.id}`,
      label: `${marker} #${t.id} ${t.subject}`,
      description: `${t.status}${agentSuffix}`,
    });
  }

  return items;
}

async function showStatusPicker(ctx: ExtensionContext, items: SelectItem[]): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`Agents & Tasks (${items.length})`))));
    const list = new SelectList(items, Math.min(items.length, 15), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    list.onSelect = (it) => done(it.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter view • esc close")));
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    return {
      render(width: number) { return container.render(width); },
      invalidate() { container.invalidate(); },
      handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
    };
  });
}

function formatAgentDetail(a: AgentRecord): string {
  const lines = [
    `Agent ${a.id}`,
    `  type:        ${a.type}`,
    `  status:      ${a.status}`,
    `  description: ${a.description}`,
    `  tool uses:   ${a.toolUses}`,
    `  started:     ${fmtElapsed(Date.now() - a.startedAt)} ago`,
  ];
  if (a.completedAt) lines.push(`  duration:    ${fmtElapsed(a.completedAt - a.startedAt)}`);
  if (a.error) lines.push(`  error:       ${a.error}`);
  if (a.result) {
    const preview = a.result.length > 400 ? a.result.slice(0, 400) + "…" : a.result;
    lines.push(`  result:\n${preview.split("\n").map(l => "    " + l).join("\n")}`);
  }
  return lines.join("\n");
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: SubagentRuntime): void {
  pi.registerCommand("agents", {
    description: "Show running subagents and tasks",
    handler: async (_args: string | undefined, ctx: ExtensionContext) => {
      const agents = runtime.manager.listAgents();
      const tasks = getTasksSnapshotFn()?.() ?? [];
      if (agents.length === 0 && tasks.length === 0) {
        ctx.ui.notify("No agents or tasks.", "info");
        return;
      }
      const items = buildItems(agents, tasks);
      const sel = await showStatusPicker(ctx, items);
      if (!sel) return;
      const [kind, id] = sel.split(":", 2);
      if (kind === "agent") {
        const rec = runtime.manager.getRecord(id);
        if (!rec) { ctx.ui.notify(`Agent ${id} not found (may have been cleaned up).`, "warning"); return; }
        ctx.ui.notify(formatAgentDetail(rec), "info");
        if (rec.status === "running" || rec.status === "queued") {
          const stop = await ctx.ui.confirm("Stop agent?", `Stop agent ${id.slice(0, 8)}?`);
          if (stop) { runtime.stop(id); ctx.ui.notify(`Stopped ${id}.`, "info"); }
        }
        return;
      }
      if (kind === "task") {
        const tasks = getTasksSnapshotFn()?.() ?? [];
        const t = tasks.find(x => x.id === id);
        if (!t) { ctx.ui.notify(`Task #${id} not found.`, "warning"); return; }
        const lines = [`Task #${t.id}`, `  subject: ${t.subject}`, `  status:  ${t.status}`];
        if (t.agentId) lines.push(`  agent:   ${t.agentId}`);
        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });
}
