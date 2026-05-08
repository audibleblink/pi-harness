/**
 * cascade-stub.ts — Placeholder subscriber for `agents:subagent_end` (P5).
 *
 * In P5, this is a no-op (debug log only). Real cascade-on-completion logic
 * lands in P6 as `cascade.ts` and will consume the agent→task binding from
 * store.ts to release blocked tasks.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEBUG = !!process.env.PI_TASKS_DEBUG;

export function registerCascadeStub(pi: ExtensionAPI): void {
  pi.on("agents:subagent_end" as any, async (event: any) => {
    if (DEBUG) console.error("[tasks/cascade-stub] agents:subagent_end", event);
  });
}
