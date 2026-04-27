/**
 * UI extension entry point.
 *
 * Subscribes to the UIBus channel, maintains a slot map, and owns all chrome:
 * footer (via footer.ts), editor (via editor.ts), and working messages
 * (via working.ts).  Other extensions publish typed state updates; this
 * extension receives them and fans them out to the UI.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { UI_BUS_TOPIC, SLOT_MODE, SLOT_ORCHESTRATION, SLOT_SUBAGENT_USAGE, type UiBusEnvelope, type OrchestrationState, type SubagentUsageState } from "./bus.js";
import { setupFooter, type FooterHandle } from "./footer.js";
import { registerEditor } from "./editor.js";
import { setupWorking } from "./working.js";
import { createTicker } from "./ticker.js";
import { renderWidget, hasAnimatedState } from "./widget.js";

export default function uiExtension(pi: ExtensionAPI) {
	const slots = new Map<string, unknown>();
	let handle: FooterHandle | undefined;
	let editorHandle: { refresh: () => void } | undefined;
	let unsubscribeBus: (() => void) | undefined;
	let currentCtx: ExtensionContext | undefined;
	let frame = 0;

	const ticker = createTicker(() => {
		frame++;
		renderAndSetWidget();
	});

	function renderAndSetWidget(): void {
		if (!currentCtx) return;
		const state = slots.get(SLOT_ORCHESTRATION) as OrchestrationState | null | undefined;
		if (!state) {
			currentCtx.ui.setWidget(SLOT_ORCHESTRATION, undefined);
			return;
		}
		const sub = slots.get(SLOT_SUBAGENT_USAGE) as SubagentUsageState | null | undefined;
		const lines = renderWidget(state, frame, sub ?? null).split("\n");
		currentCtx.ui.setWidget(SLOT_ORCHESTRATION, lines, { placement: "aboveEditor" });
	}

	function onSlotChanged(slot: string): void {
		if (slot === SLOT_ORCHESTRATION) {
			const state = slots.get(SLOT_ORCHESTRATION) as OrchestrationState | null | undefined;
			if (!state || !hasAnimatedState(state)) {
				ticker.stop();
			} else if (!ticker.isRunning()) {
				ticker.start();
			}
			renderAndSetWidget();
			return;
		}
		if (slot === SLOT_MODE) {
			// Mode changes only affect the editor label, not the footer.
			editorHandle?.refresh();
			return;
		}
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
			ticker.stop();
			frame = 0;
			slots.clear();
		}
		currentCtx = ctx;
		handle = setupFooter(ctx, slots);
		editorHandle = registerEditor(ctx, pi, handle, slots);
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
		ticker.stop();
		unsubscribeBus?.();
		unsubscribeBus = undefined;
	});
}
