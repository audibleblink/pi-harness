/**
 * Debounced UIBus publishers for the agents/ subagent runtime.
 *
 * Mirrors the publish points used by extensions/orchestration/ today:
 *   - publishOrchestration  ← scheduled on every state change
 *   - publishSubagentUsage  ← suppressed when the value is unchanged
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	publishOrchestration,
	publishSubagentUsage,
	type OrchestrationState,
	type SubagentUsageState,
} from "../ui/bus.js";

export interface PublishHooks {
	buildOrchestration: () => OrchestrationState;
	buildSubagentUsage: () => SubagentUsageState | null;
}

export interface Publisher {
	schedule: () => void;
	dispose: () => void;
}

export function createPublisher(pi: ExtensionAPI, hooks: PublishHooks): Publisher {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let last: SubagentUsageState | null | undefined;

	const equal = (
		a: SubagentUsageState | null | undefined,
		b: SubagentUsageState | null | undefined,
	): boolean => {
		if (a === b) return true;
		if (!a || !b) return a === b;
		return a.tokens === b.tokens && a.cost === b.cost && a.runningCount === b.runningCount;
	};

	const flush = () => {
		timer = undefined;
		publishOrchestration(pi, hooks.buildOrchestration());
		const sub = hooks.buildSubagentUsage();
		if (!equal(sub, last)) {
			last = sub;
			publishSubagentUsage(pi, sub);
		}
	};

	return {
		schedule() {
			if (timer) clearTimeout(timer);
			timer = setTimeout(flush, 50);
		},
		dispose() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}
