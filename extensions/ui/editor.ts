/**
 * Custom editor component — lifted from extensions/zentui.ts.
 *
 * Registers the PolishedEditor via ctx.ui.setEditorComponent and patches
 * UserMessageComponent to render as a plain container.
 *
 * Call registerEditor(ctx, pi, handle, slots) on session_start after
 * setupFooter has been called.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	UserMessageComponent,
} from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { SLOT_BLUR, SLOT_GHOST, SLOT_MODE, type GhostController, type ModeState } from "./bus.js";
import type { FooterHandle, ThemeLike } from "./footer.js";

// ────────────────────────── helpers ──────────────────────────

type AutocompleteEditorInternals = {
	autocompleteList?: Pick<Component, "render">;
	isShowingAutocomplete?: () => boolean;
	autocompleteProvider?: unknown;
};

const TRUECOLOR_BACKGROUND_ANSI = /\x1b\[48;2;\d+;\d+;\d+m/g;
const INDEXED_BACKGROUND_ANSI = /\x1b\[48;5;\d+m/g;
const SIMPLE_BACKGROUND_ANSI = /\x1b\[(?:4\d|10[0-7]|49)m/g;

function stripBackgroundAnsi(text: string): string {
	return text
		.replace(TRUECOLOR_BACKGROUND_ANSI, "")
		.replace(INDEXED_BACKGROUND_ANSI, "")
		.replace(SIMPLE_BACKGROUND_ANSI, "");
}

function fillStyledLine(content: string, width: number): string {
	const truncated = truncateToWidth(stripBackgroundAnsi(content), width, "");
	const padWidth = Math.max(0, width - visibleWidth(truncated));
	return padWidth > 0 ? `${truncated}${" ".repeat(padWidth)}` : truncated;
}

// Render user messages as plain containers, bypassing pi's default styling.
function patchUserMessageComponent(): void {
	const prototype = UserMessageComponent.prototype as { render(width: number): string[] };
	prototype.render = function (this: UserMessageComponent, width: number): string[] {
		return Container.prototype.render.call(this, width) as string[];
	};
}

// ────────────────────────── PolishedEditor ──────────────────────────

import type { Theme } from "@mariozechner/pi-coding-agent";

class PolishedEditor extends CustomEditor {
	private readonly getModelMeta: () => string;
	private readonly getThinkingLevel: () => string | undefined;
	private readonly getAgentMeta: () => string | undefined;
	private readonly getTopRightLabel: () => string | undefined;
	private readonly uiTheme: Theme;
	private readonly ghost?: GhostController;
	private readonly reset = "\x1b[0m";

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		uiTheme: Theme,
		getModelMeta: () => string,
		getThinkingLevel: () => string | undefined,
		getAgentMeta: () => string | undefined,
		getTopRightLabel: () => string | undefined,
		ghost?: GhostController,
		isBlurred?: () => boolean,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.borderColor = (text: string) => uiTheme.fg("border", text);
		this.uiTheme = uiTheme;
		this.getModelMeta = getModelMeta;
		this.getThinkingLevel = getThinkingLevel;
		this.getAgentMeta = getAgentMeta;
		this.getTopRightLabel = getTopRightLabel;
		this.ghost = ghost;
		this.isBlurred = isBlurred;
	}

	private readonly isBlurred?: () => boolean;

	handleInput(data: string): void {
		if (this.ghost && data === "\t") {
			const accepted = this.ghost.tryAccept(this.getText());
			if (accepted !== null) {
				this.setText(accepted);
				this.ghost.onTextChanged(accepted);
				return;
			}
		}
		const before = this.getText();
		super.handleInput(data);
		const after = this.getText();
		if (this.ghost && after !== before) this.ghost.onTextChanged(after);
	}

	render(width: number): string[] {
		// Reserve 1 column of unthemed margin on each side, then 2 for rails+padding.
		const marginX = 1;
		const frameWidth = Math.max(4, width - marginX * 2);
		const innerWidth = Math.max(1, frameWidth - 4);
		const rendered = super.render(innerWidth);
		const editorInternals = this as unknown as AutocompleteEditorInternals;
		const isShowingAutocomplete =
			typeof editorInternals.isShowingAutocomplete === "function"
				? Boolean(editorInternals.isShowingAutocomplete())
				: false;

		if (rendered.length < 2) return super.render(width);

		const { autocompleteList } = editorInternals;
		const autocompleteCount =
			isShowingAutocomplete && typeof autocompleteList?.render === "function"
				? autocompleteList.render(innerWidth).length
				: 0;
		const editorFrame =
			autocompleteCount > 0 && autocompleteCount < rendered.length
				? rendered.slice(0, -autocompleteCount)
				: rendered;
		const autocompleteLines =
			autocompleteCount > 0 && autocompleteCount < rendered.length
				? rendered.slice(-autocompleteCount)
				: [];

		if (editorFrame.length < 2) return rendered;

		const editorLines = editorFrame.slice(1, -1);
		const metaParts = [this.getModelMeta()];
		const thinkingLevel = this.getThinkingLevel();
		if (thinkingLevel && thinkingLevel !== "off") {
			metaParts.push(this.uiTheme.fg("muted", thinkingLevel));
		}
		const meta = metaParts.filter(Boolean).join(this.uiTheme.fg("border", "  "));
		const agentMeta = this.getAgentMeta();
		const metaLine = agentMeta
			? (() => {
					const leftW = visibleWidth(meta);
					const rightW = visibleWidth(agentMeta);
					const gap = innerWidth - leftW - rightW;
					return gap >= 1 ? `${meta}${" ".repeat(gap)}${agentMeta}` : meta;
				})()
			: meta;

		const isBashMode = this.getText().startsWith("!");
		const railColor = isBashMode ? "mdCode" : "accent";
		const borderColor = isBashMode ? "mdCode" : "border";
		const textPrefix = isBashMode ? this.uiTheme.getFgAnsi("mdCode") : "";
		let coloredEditorLines = editorLines.map((l) => (textPrefix ? `${textPrefix}${l}` : l));
		const blurred = this.isBlurred?.() ?? false;

		// Inject ghost-text suggestion after the cursor when editor is empty.
		const ghostText = !blurred && this.ghost && this.getText().length === 0 ? this.ghost.getSuggestion() : "";
		if (ghostText) {
			const dim = `\x1b[2m${this.uiTheme.fg("muted", ghostText)}\x1b[22m`;
			for (let i = 0; i < coloredEditorLines.length; i++) {
				const line = coloredEditorLines[i]!;
				const idx = line.indexOf("\x1b[7m");
				if (idx === -1) continue;
				const close = line.indexOf("\x1b[0m", idx);
				if (close === -1) continue;
				const insertAt = close + 4;
				coloredEditorLines[i] = line.slice(0, insertAt) + dim + line.slice(insertAt);
				break;
			}
		}
		if (blurred) {
			coloredEditorLines = coloredEditorLines.map((l) =>
				l.replace(/\x1b\[7m/g, "").replace(/\x1b\[27m/g, ""),
			);
		}
		const leftRail = `${this.uiTheme.fg(railColor, "│")}${this.reset} `;
		const rightRail = ` ${this.uiTheme.fg(borderColor, "│")}${this.reset}`;
		const innerDashes = Math.max(0, frameWidth - 2);
		const topRight = this.getTopRightLabel();
		const topRightW = topRight ? visibleWidth(topRight) : 0;
		let topMid: string;
		if (topRight && innerDashes >= topRightW + 8) {
			const rightPad = 2;
			const leftDashes = innerDashes - topRightW - rightPad - 4;
			topMid =
				this.uiTheme.fg(borderColor, "─".repeat(leftDashes)) +
				this.uiTheme.fg(borderColor, "┤") +
				" " + topRight + " " +
				this.uiTheme.fg(borderColor, "├") +
				this.uiTheme.fg(borderColor, "─".repeat(rightPad));
		} else {
			topMid = this.uiTheme.fg(borderColor, "─".repeat(innerDashes));
		}
		const top = this.uiTheme.fg(borderColor, "╭") + topMid + this.uiTheme.fg(borderColor, "╮");
		const bottom = this.uiTheme.fg(borderColor, "╰") + this.uiTheme.fg(borderColor, "─".repeat(innerDashes)) + this.uiTheme.fg(borderColor, "╯");
		const lines = ["", ...coloredEditorLines, "", metaLine];

		// Optional textarea background via custom "editorBg" theme token.
		// Pi's loader stores unknown keys in the fg map, so we resolve the fg
		// escape and swap 38; -> 48; to produce a background sequence. We also
		// pin an explicit foreground ("text") so the cursor's inverse-video
		// marker swaps to a visible text-colored block instead of revealing the
		// terminal default background.
		let editorBgAnsi = "";
		try {
			const fgEscape = this.uiTheme.getFgAnsi("editorBg" as Parameters<Theme["getFgAnsi"]>[0]);
			editorBgAnsi = fgEscape.replace(/\x1b\[38;/, "\x1b[48;");
		} catch {
			/* theme doesn't define editorBg — leave background untouched */
		}
		const linePrefix = editorBgAnsi ? `${editorBgAnsi}${this.uiTheme.getFgAnsi("text")}` : "";
		// Rewrite hard resets so they don't kill our bg/fg state, and ensure
		// inverse-video (cursor marker) is explicitly disabled with \x1b[27m.
		const applyBg = linePrefix
			? (line: string) => `${linePrefix}${line.replace(/\x1b\[0m/g, `\x1b[27m${linePrefix}`)}\x1b[0m`
			: (line: string) => line;

		const margin = " ".repeat(marginX);
		const withMargin = (line: string) => applyBg(`${margin}${line}${margin}`);

		return [
			withMargin(top),
			...lines.map((line) => withMargin(`${leftRail}${fillStyledLine(line, innerWidth)}${rightRail}`)),
			withMargin(bottom),
			...autocompleteLines,
		];
	}
}

// ────────────────────────── public API ──────────────────────────

export function registerEditor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	handle: FooterHandle,
	slots: Map<string, unknown>,
): { refresh: () => void } {
	patchUserMessageComponent();

	let autocompleteFixed = false;
	const uiTheme = ctx.ui.theme;
	const ghost = slots.get(SLOT_GHOST) as GhostController | undefined;

	const editorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const editor = new PolishedEditor(
			tui,
			theme,
			keybindings,
			uiTheme,
			() =>
				[
					uiTheme.fg("accent", handle.getModelLabel()),
					uiTheme.fg("text", handle.getProviderLabel()),
				].join(uiTheme.fg("borderMuted", "  ")),
			() => {
				try {
					return pi.getThinkingLevel();
				} catch {
					return undefined;
				}
			},
			() => {
				const mode = slots.get(SLOT_MODE) as ModeState | undefined;
				if (!mode) return undefined;
				const label = uiTheme.fg("syntaxKeyword", `🤖 ${mode.label}`);
				const model = mode.model ? uiTheme.fg("muted", ` ${mode.model}`) : "";
				return label + model;
			},
			() => handle.buildCwdGitSegment(uiTheme as unknown as ThemeLike),
			ghost,
			() => slots.get(SLOT_BLUR) === true,
		);

		const originalHandleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			const editorInternals = editor as unknown as AutocompleteEditorInternals;
			if (!autocompleteFixed && !editorInternals.autocompleteProvider) {
				autocompleteFixed = true;
				ctx.ui.setEditorComponent(editorFactory);
				editor.handleInput(data);
				return;
			}
			originalHandleInput(data);
		};

		return editor;
	};

	let requestEditorRender: (() => void) | undefined;

	const wrappedFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		requestEditorRender = () => tui.requestRender();
		ghost?.attachTui(() => tui.requestRender());
		const editor = editorFactory(tui, theme, keybindings);
		return editor;
	};

	ctx.ui.setEditorComponent(wrappedFactory);
	return { refresh: () => requestEditorRender?.() };
}
