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

const KEY = Symbol.for("pi-harness.spawn-bridge");
type Slot = { fn?: SpawnFn };
const slot: Slot = ((globalThis as any)[KEY] ??= {});

export function setSpawnFn(fn: SpawnFn): void {
  slot.fn = fn;
}

export function getSpawnFn(): SpawnFn | undefined {
  return slot.fn;
}
