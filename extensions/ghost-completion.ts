/**
 * Ghost-text completion: when the editor is empty and idle, ask claude-haiku
 * to predict the next user message based on conversation context. The prediction
 * renders as dim ghost text on the empty input line. Press Tab to accept.
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { complete } from "@mariozechner/pi-ai";

const DEBOUNCE_MS = 400;
const MAX_CONTEXT_CHARS = 6000;

function buildTranscript(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	const parts: string[] = [];
	for (const entry of branch) {
		const m: any = (entry as any).message;
		if (!m) continue;
		let text = "";
		if (typeof m.content === "string") text = m.content;
		else if (Array.isArray(m.content))
			text = m.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");
		text = text.trim();
		if (!text) continue;
		if (m.role === "user") parts.push(`USER: ${text}`);
		else if (m.role === "assistant") parts.push(`ASSISTANT: ${text}`);
	}
	let joined = parts.join("\n\n");
	if (joined.length > MAX_CONTEXT_CHARS) joined = "…\n" + joined.slice(joined.length - MAX_CONTEXT_CHARS);
	return joined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		let suggestion = "";
		let abort: AbortController | undefined;
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		let agentBusy = false;
		let editorRef: GhostEditor | undefined;
		let editorTui: TUI | undefined;

		const clearSuggestion = () => {
			if (suggestion) {
				suggestion = "";
				editorTui?.requestRender();
			}
		};

		const cancelInflight = () => {
			abort?.abort();
			abort = undefined;
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = undefined;
			}
		};

		const fetchSuggestion = async () => {
			if (agentBusy) return;
			if (!editorRef || editorRef.getText().length > 0) return;
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
											`Given this conversation transcript between a USER and an ASSISTANT, predict the single next message the USER is most likely to send. Output ONLY that next message text, no quotes, no preamble, no explanation. Keep it concise (1-2 sentences max). If you cannot make a sensible prediction, output an empty response.\n\n<transcript>\n${transcript}\n</transcript>\n\nNext USER message:`,
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
				if (!editorRef || editorRef.getText().length > 0) return;
				suggestion = text.split("\n")[0]!;
				editorTui?.requestRender();
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
			scheduleFetch();
		});

		class GhostEditor extends CustomEditor {
			handleInput(data: string): void {
				// Tab accepts suggestion when editor is empty and one is available
				if (data === "\t" && suggestion && this.getText().length === 0) {
					const s = suggestion;
					suggestion = "";
					this.setText(s);
					return;
				}
				const before = this.getText();
				super.handleInput(data);
				const after = this.getText();
				if (after !== before) {
					if (after.length === 0) {
						clearSuggestion();
						scheduleFetch();
					} else if (suggestion) {
						clearSuggestion();
						cancelInflight();
					}
				}
			}

			render(width: number): string[] {
				const lines = super.render(width);
				if (!suggestion || this.getText().length !== 0) return lines;
				// Find the cursor sequence and inject dim ghost text right after it.
				// Editor renders cursor as `\x1b[7m \x1b[0m` when on empty position.
				const dim = `\x1b[2m${suggestion}\x1b[22m`;
				for (let i = 0; i < lines.length; i++) {
					const idx = lines[i]!.indexOf("\x1b[7m");
					if (idx === -1) continue;
					const close = lines[i]!.indexOf("\x1b[0m", idx);
					if (close === -1) continue;
					const insertAt = close + 4;
					lines[i] = lines[i]!.slice(0, insertAt) + dim + lines[i]!.slice(insertAt);
					break;
				}
				return lines;
			}
		}

		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const ed = new GhostEditor(tui, theme, kb);
			editorRef = ed;
			editorTui = tui;
			// Initial fetch (empty editor)
			scheduleFetch();
			return ed;
		});

		pi.on("session_shutdown", () => {
			cancelInflight();
			editorRef = undefined;
			editorTui = undefined;
		});
	});
}
