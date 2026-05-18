/**
 * Cross-extension bridge: agents/ publishes its subagent spawn function here
 * so tasks/ (TaskExecute, cascade) can launch agents without importing
 * agents/'s internals directly.
 *
 * Set once during agents/ extension init; read on demand by tasks/.
 */

export type SpawnFn = (
  agentType: string,
  prompt: string,
  opts: { description: string; isBackground: boolean; maxTurns?: number },
) => string;

let spawnFn: SpawnFn | undefined;

export function setSpawnFn(fn: SpawnFn): void {
  spawnFn = fn;
}

export function getSpawnFn(): SpawnFn | undefined {
  return spawnFn;
}
