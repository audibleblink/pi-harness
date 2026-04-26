/**
 * Debug logging for pi-harness extensions.
 * Set PI_HARNESS_DEBUG=1 to enable output to stderr.
 */

export function debugLog(slot: string, kind: string, data?: Record<string, unknown>): void {
	if (process.env["PI_HARNESS_DEBUG"] !== "1") return;
	const suffix =
		data && Object.keys(data).length > 0
			? " " + Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")
			: "";
	console.error(`PI_DBG slot=${slot} kind=${kind}${suffix}`);
}
