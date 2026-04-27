/** Interval for the animation ticker (spinner + elapsed). */
export const TICK_INTERVAL_MS = 80;

export interface Ticker {
	start(): void;
	stop(): void;
	isRunning(): boolean;
}

export function createTicker(onTick: () => void): Ticker {
	let timer: ReturnType<typeof setInterval> | undefined;

	return {
		start() {
			if (timer !== undefined) return;
			timer = setInterval(onTick, TICK_INTERVAL_MS);
		},
		stop() {
			if (timer === undefined) return;
			clearInterval(timer);
			timer = undefined;
		},
		isRunning() {
			return timer !== undefined;
		},
	};
}
