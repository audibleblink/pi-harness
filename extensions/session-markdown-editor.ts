import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";

/**
 * Read the user's stealth-skills list and strip those <skill>...</skill> entries
 * from the system prompt's <available_skills> block. The stealth-skills extension
 * only modifies the prompt during before_agent_start; viewers invoked before any
 * turn (or that re-read state) would otherwise show the unfiltered base prompt.
 */
function getStealthedSystemPrompt(ctx: { getSystemPrompt(): string }): string {
	const prompt = ctx.getSystemPrompt();
	let stealth: string[];
	try {
		const path = join(getAgentDir(), "settings.json");
		if (!existsSync(path)) return prompt;
		const settings = JSON.parse(readFileSync(path, "utf-8")) as { stealthSkills?: unknown };
		stealth = Array.isArray(settings.stealthSkills)
			? settings.stealthSkills.filter((s): s is string => typeof s === "string")
			: [];
	} catch {
		return prompt;
	}
	if (stealth.length === 0) return prompt;
	const names = new Set(stealth);
	return prompt.replace(
		/  <skill>\s*<name>([^<]+)<\/name>[\s\S]*?<\/skill>\n?/g,
		(match, name: string) => (names.has(name) ? "" : match),
	);
}

type ContentBlock =
	| { type: "text"; text?: string }
	| { type: "thinking"; thinking?: string }
	| { type: "toolCall" | "tool_call"; name?: string; id?: string; arguments?: unknown }
	| { type: "image"; data?: string; mimeType?: string }
	| {
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			id?: string;
			arguments?: unknown;
			data?: string;
			mimeType?: string;
		};

type NotifyLevel = "info" | "warning" | "error";
type EditorContext = { ui: { notify(message: string, level: NotifyLevel): void } };

// Pi's TUI renders inline on the main screen (no alt buffer). The editor (vim/etc.)
// manages its own alt-screen entry/exit. We only show the cursor for the editor and
// hide it again on return; we must not touch ?1049 here or tmux scrollback breaks.
const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";
const TOOL_RESPONSE_ROLES = new Set(["toolResult", "tool_result", "toolResponse", "tool_response"]);

export default function sessionMarkdownEditor(pi: ExtensionAPI) {
	pi.registerCommand("session-markdown", {
		description: "Open the current session as Markdown in $EDITOR",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const sessionId = ctx.sessionManager.getSessionId() ?? "session";
			const file = join(tmpdir(), `pi-session-${sessionId}.md`);
			writeFileSync(file, renderSessionMarkdown(ctx, pi), "utf8");
			if (openInEditorAndDelete(file, ctx)) ctx.ui.notify("Session Markdown file cleaned up", "info");
		},
	});

	pi.registerCommand("session-yaml", {
		description: "Edit a reversible YAML view of the current session, then import it as a new session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const sessionId = ctx.sessionManager.getSessionId() ?? "session";
			const parentSession = ctx.sessionManager.getSessionFile();
			const file = join(tmpdir(), `pi-session-${sessionId}.yaml`);
			writeFileSync(file, renderSessionYaml(ctx, pi), "utf8");

			try {
				if (!openInEditor(file, ctx)) return;

				let messages: YamlMessage[];
				try {
					messages = parseYamlConversation(readFileSync(file, "utf8"));
				} catch (error) {
					ctx.ui.notify(`Invalid session YAML: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}

				// Carry forward the active agent so mode survives the session swap.
				const agentEntry = ctx.sessionManager
					.getEntries()
					.filter((e: any) => e.type === "custom" && e.customType === "agent-state")
					.pop() as { data?: { name: string | null } } | undefined;

				const result = await ctx.newSession({
					parentSession,
					setup: async (sm) => {
						// null sentinel == explicitly cleared; do not carry forward.
						if (agentEntry?.data?.name) sm.appendCustomEntry("agent-state", { name: agentEntry.data.name });
						for (const message of messages) sm.appendMessage(toAgentMessage(message));
					},
					withSession: async (ctx) => {
						ctx.ui.notify(`Imported ${messages.length} messages from YAML`, "info");
					},
				});

				if (result.cancelled) ctx.ui.notify("Session YAML import cancelled", "warning");
			} finally {
				deleteFile(file);
			}
		},
	});
}

function openInEditorAndDelete(file: string, ctx: EditorContext): boolean {
	try {
		return openInEditor(file, ctx);
	} finally {
		deleteFile(file);
	}
}

function deleteFile(file: string) {
	try {
		unlinkSync(file);
	} catch {
		// Ignore cleanup errors.
	}
}

function openInEditor(file: string, ctx: EditorContext): boolean {
	const editor = process.env.EDITOR || process.env.VISUAL;
	if (!editor) {
		ctx.ui.notify("Set $EDITOR or $VISUAL to open session exports", "warning");
		return false;
	}

	const wasRaw = process.stdin.isTTY && process.stdin.isRaw;
	if (wasRaw) process.stdin.setRawMode(false);
	process.stdout.write(SHOW_CURSOR);
	try {
		const [command, ...args] = editor.split(/\s+/).filter(Boolean);
		const result = spawnSync(command, [...args, file], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		if (result.error) throw result.error;
		if (result.signal) {
			ctx.ui.notify(`Editor terminated by signal ${result.signal}`, "warning");
			return false;
		}
		if (result.status !== 0) {
			ctx.ui.notify(`Editor exited with status ${result.status}`, "warning");
			return false;
		}
	} finally {
		process.stdout.write(HIDE_CURSOR);
		if (wasRaw) process.stdin.setRawMode(true);
	}
	return true;
}

function renderSessionMarkdown(ctx: any, pi: ExtensionAPI): string {
	const sm = ctx.sessionManager;
	const branch = sm.getBranch();
	const tools = pi.getAllTools();
	const systemPrompt = getStealthedSystemPrompt(ctx);
	const lines: string[] = [];

	lines.push("# Pi Session", "");
	lines.push(`- Session file: ${sm.getSessionFile() ?? "in-memory"}`);
	lines.push(`- CWD: ${sm.getCwd()}`);
	lines.push(`- Leaf: ${sm.getLeafId() ?? "none"}`);
	if (ctx.model) lines.push(`- Model: ${ctx.model.provider}/${ctx.model.id}`);
	lines.push("");

	lines.push(`## System Prompt (${systemPrompt.length} chars)`, "");
	lines.push(fence(systemPrompt), "");

	lines.push(`## Tools (${tools.length})`, "");
	for (const tool of tools) {
		const parameters = JSON.stringify(tool.parameters, null, 2) ?? "null";
		lines.push(`### ${tool.name}`, "");
		lines.push(`- Description: ${tool.description.length} chars`);
		lines.push(`- Parameters: ${parameters.length} chars`, "");
		lines.push("Description:", "", fence(tool.description), "");
		lines.push("Parameters:", "", fence(parameters, "json"), "");
	}

	const markdownBranch = branch.filter(shouldRenderMarkdownEntry);
	lines.push(`## Current Branch (${markdownBranch.length} entries)`, "");
	for (const entry of markdownBranch) renderEntry(lines, entry);

	return `${lines.join("\n")}\n`;
}

function renderSessionYaml(ctx: any, pi: ExtensionAPI): string {
	const sm = ctx.sessionManager;
	return toYaml({
		format: "pi-session-yaml-v1",
		session: {
			file: sm.getSessionFile() ?? null,
			cwd: sm.getCwd(),
			leafId: sm.getLeafId() ?? null,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
		},
		systemPrompt: getStealthedSystemPrompt(ctx),
		tools: pi.getAllTools().map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
		conversation: getYamlConversation(sm.getBranch()),
	});
}

function getYamlConversation(branch: any[]): YamlMessage[] {
	return branch
		.filter((entry: any) => entry.type === "message" && isDirectRole(entry.message?.role))
		.map((entry: any) => ({
			id: entry.id ?? null,
			parentId: entry.parentId ?? null,
			timestamp: entry.timestamp,
			role: entry.message.role,
			provider: entry.message.provider ?? null,
			model: entry.message.model ?? null,
			content: directContentBlocks(entry.message.content),
		}))
		.filter((entry) => entry.content.length > 0);
}

type YamlMessage = {
	id?: string | null;
	parentId?: string | null;
	timestamp?: string;
	role: "user" | "assistant";
	provider?: string | null;
	model?: string | null;
	content: Array<{ type: "text" | "thinking"; text: string }>;
};

function isDirectRole(role: string | undefined): role is "user" | "assistant" {
	return role === "user" || role === "assistant";
}

function directContentBlocks(content: unknown): Array<{ type: "text" | "thinking"; text: string }> {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];

	const blocks: Array<{ type: "text" | "thinking"; text: string }> = [];
	for (const block of content as ContentBlock[]) {
		if (block.type === "text") blocks.push({ type: "text", text: block.text ?? "" });
		else if (block.type === "thinking") blocks.push({ type: "thinking", text: block.thinking ?? "" });
	}
	return blocks;
}

function toAgentMessage(message: YamlMessage): any {
	const content = message.content.map((block) =>
		block.type === "thinking" ? { type: "thinking", thinking: block.text } : { type: "text", text: block.text },
	);

	if (message.role === "user") {
		return {
			role: "user",
			content,
			timestamp: Date.now(),
		};
	}

	return {
		role: "assistant",
		api: "session-yaml-import",
		provider: message.provider ?? "session-yaml-import",
		model: message.model ?? "session-yaml-import",
		content,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function parseYamlConversation(yaml: string): YamlMessage[] {
	const conversation = parseTopLevelSequence(yaml, "conversation");
	return conversation.map(parseYamlMessage).filter((message) => message.content.length > 0);
}

function parseYamlMessage(value: any): YamlMessage {
	if (!isPlainObject(value) || !isDirectRole(value.role) || !Array.isArray(value.content)) {
		throw new Error("Invalid /session-yaml conversation message");
	}

	return {
		role: value.role,
		provider: typeof value.provider === "string" ? value.provider : null,
		model: typeof value.model === "string" ? value.model : null,
		content: value.content.map(parseYamlContentBlock).filter(Boolean),
	};
}

function parseYamlContentBlock(value: any): { type: "text" | "thinking"; text: string } | undefined {
	if (!isPlainObject(value)) return undefined;
	if (value.type !== "text" && value.type !== "thinking") return undefined;
	if (typeof value.text !== "string") throw new Error("Invalid /session-yaml content block text");
	return { type: value.type, text: value.text };
}

function parseTopLevelSequence(yaml: string, key: string): any[] {
	const lines = yaml.replace(/\r\n/g, "\n").split("\n");
	const keyIndex = lines.findIndex((line) => line === `${key}:`);
	if (keyIndex === -1) throw new Error(`Missing ${key} in /session-yaml file`);

	const result: any[] = [];
	let i = keyIndex + 1;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.startsWith("  ")) break;
		if (line.startsWith("  - ")) {
			const parsed = parseSequenceObject(lines, i, 2);
			result.push(parsed.value);
			i = parsed.next;
		} else {
			i++;
		}
	}
	return result;
}

function parseSequenceObject(lines: string[], start: number, indent: number): { value: Record<string, unknown>; next: number } {
	const value: Record<string, unknown> = {};
	let i = start;
	const firstLine = lines[i];
	const firstContent = firstLine.slice(indent + 2);
	parseKeyValueInto(value, firstContent, lines, i, indent + 2);
	i++;

	while (i < lines.length) {
		const line = lines[i];
		if (!line.startsWith(" ".repeat(indent + 2)) || line.startsWith(" ".repeat(indent) + "- ")) break;
		const content = line.slice(indent + 2);
		const parsed = parseKeyValueInto(value, content, lines, i, indent + 2);
		i = parsed.next;
	}
	return { value, next: i };
}

function parseKeyValueInto(target: Record<string, unknown>, content: string, lines: string[], index: number, indent: number) {
	const separator = content.indexOf(":");
	if (separator === -1) return { next: index + 1 };

	const key = content.slice(0, separator);
	const rest = content.slice(separator + 1);
	if (rest === "") {
		const parsed = parseNestedSequence(lines, index + 1, indent + 2);
		target[key] = parsed.value;
		return { next: parsed.next };
	}
	if (rest === " |-") {
		const parsed = parseBlockScalar(lines, index + 1, indent + 2);
		target[key] = parsed.value;
		return { next: parsed.next };
	}
	target[key] = parseYamlScalar(rest.trim());
	return { next: index + 1 };
}

function parseYamlScalar(value: string): unknown {
	if (value === "null") return null;
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
	if (value === "''") return "";
	if (value.startsWith('"')) return JSON.parse(value);
	return value;
}

function parseNestedSequence(lines: string[], start: number, indent: number): { value: unknown[]; next: number } {
	const result: unknown[] = [];
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.startsWith(" ".repeat(indent) + "- ")) break;
		const parsed = parseSequenceObject(lines, i, indent);
		result.push(parsed.value);
		i = parsed.next;
	}
	return { value: result, next: i };
}

function parseBlockScalar(lines: string[], start: number, indent: number): { value: string; next: number } {
	const block: string[] = [];
	let i = start;
	const prefix = " ".repeat(indent);
	while (i < lines.length && (lines[i].startsWith(prefix) || lines[i] === "")) {
		block.push(lines[i].startsWith(prefix) ? lines[i].slice(indent) : "");
		i++;
	}
	return { value: block.join("\n"), next: i };
}

function toYaml(value: unknown, indent = 0): string {
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return value.map((item) => yamlArrayItem(item, indent)).join("\n");
	}

	if (isPlainObject(value)) {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return "{}";
		return entries.map(([key, item]) => yamlObjectEntry(key, item, indent)).join("\n");
	}

	return yamlScalar(value, indent);
}

function yamlObjectEntry(key: string, value: unknown, indent: number): string {
	const prefix = " ".repeat(indent);
	if (isYamlMultilineString(value)) return `${prefix}${key}: |-\n${indentBlock(value as string, indent + 2)}`;
	if (isYamlNested(value)) return `${prefix}${key}:\n${toYaml(value, indent + 2)}`;
	return `${prefix}${key}: ${yamlScalar(value, indent)}`;
}

function yamlArrayItem(value: unknown, indent: number): string {
	const prefix = " ".repeat(indent);
	if (isYamlMultilineString(value)) return `${prefix}- |-\n${indentBlock(value as string, indent + 2)}`;
	if (Array.isArray(value)) return `${prefix}-\n${toYaml(value, indent + 2)}`;
	if (isPlainObject(value)) {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return `${prefix}- {}`;

		const [firstKey, firstValue] = entries[0];
		const first = yamlObjectEntry(firstKey, firstValue, 0);
		const rest = entries.slice(1).map(([key, item]) => yamlObjectEntry(key, item, indent + 2));
		return `${prefix}- ${first}${rest.length ? `\n${rest.join("\n")}` : ""}`;
	}
	return `${prefix}- ${yamlScalar(value, indent)}`;
}

function yamlScalar(value: unknown, indent: number): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value !== "string") return JSON.stringify(value);
	if (value === "") return "''";
	if (isYamlMultilineString(value)) return `|-\n${indentBlock(value, indent + 2)}`;
	return JSON.stringify(value);
}

function isYamlNested(value: unknown): boolean {
	return Array.isArray(value) || isPlainObject(value);
}

function isYamlMultilineString(value: unknown): boolean {
	return typeof value === "string" && value.includes("\n");
}

function isPlainObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indentBlock(text: string, indent: number): string {
	const prefix = " ".repeat(indent);
	return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function shouldRenderMarkdownEntry(entry: any): boolean {
	const isToolResponse = entry.type === "message" && isToolResponseRole(entry.message?.role);
	return !isToolResponse;
}

function isToolResponseRole(role: string | undefined): boolean {
	return role !== undefined && TOOL_RESPONSE_ROLES.has(role);
}

function renderEntry(lines: string[], entry: any) {
	lines.push(`### ${entry.type} ${entry.id ?? ""}`.trim(), "");
	lines.push(`- Parent: ${entry.parentId ?? "none"}`);
	lines.push(`- Timestamp: ${entry.timestamp}`, "");

	if (entry.type === "message") {
		renderMessage(lines, entry.message);
	} else if (entry.type === "compaction") {
		lines.push(fence(entry.summary));
	} else if (entry.type === "branch_summary") {
		lines.push(fence(entry.summary));
	} else {
		lines.push(fence(JSON.stringify(entry, null, 2), "json"));
	}
	lines.push("");
}

function renderMessage(lines: string[], message: any) {
	lines.push(`#### ${message.role}`, "");
	if (message.role === "assistant") {
		lines.push(`- Provider: ${message.provider ?? ""}`);
		lines.push(`- Model: ${message.model ?? ""}`);
		if (message.usage) lines.push(`- Usage: ${JSON.stringify(message.usage)}`);
		lines.push("");
	}

	if (typeof message.content === "string") {
		lines.push(fence(message.content));
		return;
	}

	if (Array.isArray(message.content)) {
		for (const block of message.content as ContentBlock[]) renderBlock(lines, block);
		return;
	}

	lines.push(fence(JSON.stringify(message, null, 2), "json"));
}

function renderBlock(lines: string[], block: ContentBlock) {
	if (block.type === "text") {
		lines.push(fence(block.text ?? ""), "");
	} else if (block.type === "thinking") {
		lines.push("Thinking:", "", fence(block.thinking ?? ""), "");
	} else if (block.type === "toolCall" || block.type === "tool_call") {
		lines.push(`Tool call: ${block.name ?? ""} (${block.id ?? ""})`, "");
		lines.push(fence(JSON.stringify(block.arguments ?? null, null, 2), "json"), "");
	} else if (block.type === "image") {
		lines.push(`[image: ${block.mimeType ?? "unknown"}, ${block.data?.length ?? 0} base64 chars]`, "");
	} else {
		lines.push(fence(JSON.stringify(block, null, 2), "json"), "");
	}
}

function fence(text: string, lang = ""): string {
	const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
	const ticks = "`".repeat(longest + 1);
	return `${ticks}${lang}\n${text}\n${ticks}`;
}
