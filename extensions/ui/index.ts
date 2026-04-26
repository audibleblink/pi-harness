/**
 * UI extension entry point.
 *
 * Subscribes to the UIBus channel and maintains a slot map. Other extensions
 * publish typed state updates; this extension receives them and will
 * eventually fan them out to UI widgets (e.g. status bar, overlays).
 *
 * Phase 1: subscribe + maintain slots. Rendering wired in later phases.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { debugLog } from "../_debug.js";
import { UI_BUS_TOPIC, type UiBusEnvelope } from "./bus.js";

export default function uiExtension(pi: ExtensionAPI) {
	const slots = new Map<string, unknown>();
	let unsubscribeBus: (() => void) | undefined;

	function onSlotChanged(slot: string): void {
		debugLog("ui", "slot-changed", { slot });
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

	function unsubscribe(): void {
		unsubscribeBus?.();
		unsubscribeBus = undefined;
	}

	subscribeBus();

	pi.on("session_start", async (event) => {
		if (event.reason === "reload") {
			slots.clear();
			debugLog("ui", "slots-cleared", { reason: "reload" });
		}
	});

	pi.on("session_shutdown", async () => {
		unsubscribe();
	});
}
