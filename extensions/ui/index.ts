/**
 * UI extension entry point.
 *
 * Subscribes to the UIBus channel, maintains a slot map, and owns all chrome:
 * footer (via footer.ts), editor (via editor.ts), and working messages
 * (via working.ts).  Other extensions publish typed state updates; this
 * extension receives them and fans them out to the UI.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { debugLog } from "../_debug.js";
import { UI_BUS_TOPIC, type UiBusEnvelope } from "./bus.js";
import { setupFooter, type FooterHandle } from "./footer.js";
import { registerEditor } from "./editor.js";
import { setupWorking } from "./working.js";

export default function uiExtension(pi: ExtensionAPI) {
	const slots = new Map<string, unknown>();
	let handle: FooterHandle | undefined;
	let unsubscribeBus: (() => void) | undefined;

	function onSlotChanged(slot: string): void {
		debugLog("ui", "slot-changed", { slot });
		handle?.refresh();
	}

	function subscribeBus(): void {
		unsubscribeBus = pi.events.on(UI_BUS_TOPIC, (data) => {
			const envelope = data as UiBusEnvelope;
			const { slot, value } = envelope;
			if (value === null || value === undefined) {
				slots.delete(slot);
			} else {
				slots.set(slot, value);
			}
			onSlotChanged(slot);
		});
	}

	subscribeBus();
	setupWorking(pi);

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload") {
			slots.clear();
			debugLog("ui", "slots-cleared", { reason: "reload" });
		}
		handle = setupFooter(ctx, slots);
		registerEditor(ctx, pi, handle, slots);
		handle.scheduleProjectRefresh(ctx);
		handle.refresh();
	});

	pi.on("agent_start", async (_event, ctx) => {
		handle?.syncState(ctx);
		handle?.refresh();
	});

	pi.on("agent_end", async (_event, ctx) => {
		handle?.syncState(ctx);
		handle?.scheduleProjectRefresh(ctx);
		handle?.refresh();
	});

	pi.on("model_select", async (_event, ctx) => {
		handle?.syncState(ctx);
		handle?.refresh();
	});

	pi.on("message_end", async (_event, ctx) => {
		handle?.syncState(ctx);
		handle?.scheduleProjectRefresh(ctx);
		handle?.refresh();
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		handle?.syncState(ctx);
		handle?.scheduleProjectRefresh(ctx);
		handle?.refresh();
	});

	pi.on("session_compact", async (_event, ctx) => {
		handle?.syncState(ctx);
		handle?.scheduleProjectRefresh(ctx);
		handle?.refresh();
	});

	pi.on("session_shutdown", async () => {
		unsubscribeBus?.();
		unsubscribeBus = undefined;
	});
}
