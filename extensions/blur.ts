/**
 * Blur extension.
 *
 * Enables terminal focus reporting (DECSET 1004) and listens for the
 * focus-in (\x1b[I) / focus-out (\x1b[O) escape sequences emitted by
 * compliant terminals (xterm, iTerm2, WezTerm, Kitty, Alacritty, Ghostty,
 * VTE-based terminals, Windows Terminal) and by tmux when configured with
 * `set -g focus-events on`.
 *
 * Publishes the boolean blur state on the UIBus as SLOT_BLUR; the editor
 * in extensions/ui/ consumes it to suppress the fake reverse-video cursor
 * block when the pane/window is inactive, matching the behavior of zsh
 * and nvim.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { publishBlur } from "./ui/bus.js";

export default function blurExtension(pi: ExtensionAPI) {
	let blurred = false;
	let active = false;
	let onStdin: ((buf: Buffer) => void) | undefined;
	const disable = () => process.stdout.write("\x1b[?1004l");

	pi.on("session_start", () => {
		if (active) return;
		active = true;
		process.stdout.write("\x1b[?1004h");
		onStdin = (buf: Buffer) => {
			const s = buf.toString("binary");
			let next = blurred;
			if (s.includes("\x1b[O")) next = true;
			if (s.includes("\x1b[I")) next = false;
			if (next !== blurred) {
				blurred = next;
				publishBlur(pi, blurred);
			}
		};
		process.stdin.on("data", onStdin);
		process.on("exit", disable);
	});

	pi.on("session_shutdown", () => {
		if (!active) return;
		active = false;
		if (onStdin) process.stdin.off("data", onStdin);
		onStdin = undefined;
		disable();
	});
}
