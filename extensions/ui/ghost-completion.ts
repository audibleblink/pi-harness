/**
 * Ghost-text completion controller for the PolishedEditor.
 *
 * When the editor is empty and idle, calls claude-haiku-4-5 to predict the
 * next user message based on the conversation transcript on the current
 * branch. The prediction is exposed via `getSuggestion()` so the editor can
 * render it as dim ghost text. Tab on an empty editor accepts.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";

const DEBOUNCE_MS = 400;
const MAX_TURNS = 3;
const MAX_MESSAGE_CHARS = 1500;

export interface GhostController {
	getSuggestion(): string;
	onTextChanged(text: string): void;
	tryAccept(text: string): string | null;
	attachTui(requestRender: () => void): void;
}

function buildTranscript(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	const parts: string[] = [];
	let userTurns = 0;
	// Walk newest -> oldest, collecting user/assistant text. Stop after MAX_TURNS user msgs.
	for (let i = branch.length - 1; i >= 0; i--) {
		const m: any = (branch[i] as any).message;
		if (!m) continue;
		if (m.role !== "user" && m.role !== "assistant") continue;
		let text = "";
		if (typeof m.content === "string") text = m.content;
		else if (Array.isArray(m.content))
			text = m.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");
		text = text.trim();
		if (!text) continue;
		if (text.length > MAX_MESSAGE_CHARS) text = text.slice(0, MAX_MESSAGE_CHARS) + "…";
		parts.unshift(m.role === "user" ? `USER: ${text}` : `ASSISTANT: ${text}`);
		if (m.role === "user") {
			userTurns++;
			if (userTurns >= MAX_TURNS) break;
		}
	}
	return parts.join("\n\n");
}

export function createGhostController(pi: ExtensionAPI, ctx: ExtensionContext): GhostController {
	let suggestion = "";
	let abort: AbortController | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let agentBusy = false;
	let lastEmpty = true;
	let requestRender: (() => void) | undefined;

	const cancelInflight = () => {
		abort?.abort();
		abort = undefined;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
	};

	const clearSuggestion = () => {
		if (suggestion) {
			suggestion = "";
			requestRender?.();
		}
	};

	const fetchSuggestion = async () => {
		if (agentBusy) return;
		const transcript = buildTranscript(ctx);
		if (!transcript) return;
		const model = ctx.modelRegistry.find("anthropic", "claude-haiku-4-5");
		if (!model) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return;

		cancelInflight();
		abort = new AbortController();
		const ac = abort;
		try {
			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text:
										`Given this conversation transcript between a USER and an ASSISTANT, predict the single next message the USER is most likely to send. Output ONLY that next message text — no quotes, no preamble, no explanation. Keep it concise (1-2 sentences max). If you cannot make a sensible prediction, output an empty response.\n\n<transcript>\n${transcript}\n</transcript>\n\nNext USER message:`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 200, signal: ac.signal },
			);
			if (ac.signal.aborted) return;
			const text = response.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("")
				.trim()
				.replace(/^["'`]|["'`]$/g, "");
			if (!text) return;
			suggestion = text.split("\n")[0]!;
			requestRender?.();
		} catch {
			// ignore
		}
	};

	const scheduleFetch = () => {
		cancelInflight();
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			void fetchSuggestion();
		}, DEBOUNCE_MS);
	};

	pi.on("agent_start", () => {
		agentBusy = true;
		cancelInflight();
		clearSuggestion();
	});
	pi.on("agent_end", () => {
		agentBusy = false;
		if (lastEmpty) scheduleFetch();
	});
	pi.on("session_shutdown", () => {
		cancelInflight();
		requestRender = undefined;
	});

	return {
		getSuggestion: () => suggestion,
		onTextChanged(text: string) {
			const isEmpty = text.length === 0;
			if (isEmpty && !lastEmpty) {
				clearSuggestion();
				scheduleFetch();
			} else if (!isEmpty) {
				if (suggestion) clearSuggestion();
				cancelInflight();
			}
			lastEmpty = isEmpty;
		},
		tryAccept(text: string): string | null {
			if (text.length === 0 && suggestion) {
				const s = suggestion;
				suggestion = "";
				return s;
			}
			return null;
		},
		attachTui(rr) {
			requestRender = rr;
			// Initial empty state — kick off a fetch.
			scheduleFetch();
		},
	};
}
