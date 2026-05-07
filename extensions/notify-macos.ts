/**
 * Fires a macOS desktop notification on agent_end.
 *
 * Tries terminal-notifier first, falls back to osascript.
 * No-op on non-darwin platforms.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import process from "node:process";

async function notify(
	pi: ExtensionAPI,
	title: string,
	message: string,
): Promise<void> {
	if (process.platform !== "darwin") return;
	const result = await pi.exec("terminal-notifier", [
		"-title",
		title,
		"-message",
		message,
	]);
	if (result.code === 0) return;
	const t = title.replaceAll('"', '\\"');
	const m = message.replaceAll('"', '\\"');
	await pi.exec("osascript", [
		"-e",
		`display notification "${m}" with title "${t}"`,
	]);
}

export default function notifyMacOSExtension(pi: ExtensionAPI) {
	pi.on("agent_end", async () => {
		process.stderr.write("\x07");
		await notify(pi, "pi", "Response complete");
	});
}
