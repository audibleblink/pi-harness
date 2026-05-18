/**
 * Cross-extension bridge: agents/ publishes its subagent spawn function here
 * so tasks/ (TaskExecute, cascade) can launch agents without importing
 * agents/'s internals directly.
 *
 * pi's extension loader runs jiti with `moduleCache: false`, so each
 * extension gets its OWN copy of every imported helper module. Module-scope
 * state therefore cannot be shared between extensions — we keep the spawn
 * function on a globalThis-keyed slot instead.
 */

export type SpawnFn = (
  agentType: string,
  prompt: string,
  opts: { description: string; isBackground: boolean; maxTurns?: number },
) => string;

/**
 * Predicate consulted by AgentManager.cleanup(): when it returns true for an
 * agent id, that agent record is kept past the normal 10-minute eviction.
 * tasks/ installs this so subagents bound to live tasks aren't reaped while
 * a long-running DAG is still polling them via get_subagent_result.
 */
export type RetainAgentFn = (agentId: string) => boolean;

const KEY = Symbol.for("pi-harness.spawn-bridge");
type Slot = { fn?: SpawnFn; retain?: RetainAgentFn };
const slot: Slot = ((globalThis as any)[KEY] ??= {});

export function setSpawnFn(fn: SpawnFn): void {
  slot.fn = fn;
}

export function getSpawnFn(): SpawnFn | undefined {
  return slot.fn;
}

export function setRetainAgentFn(fn: RetainAgentFn | undefined): void {
  slot.retain = fn;
}

export function getRetainAgentFn(): RetainAgentFn | undefined {
  return slot.retain;
}
