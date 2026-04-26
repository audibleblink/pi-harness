// animation ticker: 80ms for widget spinner/elapsed

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
			timer = setInterval(onTick, 80);
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
