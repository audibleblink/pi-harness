import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type KeybindingsManager,
	type Theme,
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

const execFileAsync = promisify(execFile);

// ────────────────────────── config ──────────────────────────

export type ColorSpec = string;

export type PolishedTuiConfig = {
	icons: {
		cwd: string;
		git: string;
		ahead: string;
		behind: string;
		diverged: string;
		conflicted: string;
		untracked: string;
		stashed: string;
		modified: string;
		staged: string;
		renamed: string;
		deleted: string;
		typechanged: string;
	};
	colors: {
		cwdText: ColorSpec;
		git: ColorSpec;
		gitStatus: ColorSpec;
		contextNormal: ColorSpec;
		contextWarning: ColorSpec;
		contextError: ColorSpec;
		tokens: ColorSpec;
		cost: ColorSpec;
		separator: ColorSpec;
	};
};

const configPath = join(getAgentDir(), "zentui.json");

const themeColorTokens = new Set([
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
]);

const defaultConfig: PolishedTuiConfig = {
	icons: {
		cwd: "󰝰",
		git: " ",
		ahead: "󱞿 ",
		behind: "󱞣 ",
		diverged: "⇕ ",
		conflicted: "󰘖 ",
		untracked: "󱪝 ",
		stashed: "$ ",
		modified: " ",
		staged: " ",
		renamed: "󱀱 ",
		deleted: " ",
		typechanged: "T",
	},
	colors: {
		cwdText: "syntaxOperator",
		git: "syntaxKeyword",
		gitStatus: "error",
		contextNormal: "muted",
		contextWarning: "warning",
		contextError: "error",
		tokens: "muted",
		cost: "success",
		separator: "borderMuted",
	},
};

function isHexColor(value: string): boolean {
	return /^#(?:[0-9a-fA-F]{6})$/.test(value);
}

function hexToAnsi(hex: string, isBackground = false): string {
	const normalized = hex.slice(1);
	const r = Number.parseInt(normalized.slice(0, 2), 16);
	const g = Number.parseInt(normalized.slice(2, 4), 16);
	const b = Number.parseInt(normalized.slice(4, 6), 16);
	return `\x1b[${isBackground ? 48 : 38};2;${r};${g};${b}m`;
}

type ThemeLike = { fg(color: string, text: string): string };

function colorize(theme: ThemeLike, color: ColorSpec, text: string): string {
	if (themeColorTokens.has(color)) return theme.fg(color, text);
	if (isHexColor(color)) return `${hexToAnsi(color)}${text}\x1b[39m`;
	return theme.fg("text", text);
}

function ensureConfigExists(): void {
	try {
		writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	} catch {
		// EEXIST expected
	}
}

function loadConfig(): PolishedTuiConfig {
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<PolishedTuiConfig>;
		return {
			icons: { ...defaultConfig.icons, ...(parsed.icons ?? {}) },
			colors: { ...defaultConfig.colors, ...(parsed.colors ?? {}) },
		};
	} catch {
		return defaultConfig;
	}
}

// ────────────────────────── git ──────────────────────────

type GitStatusSummary = {
	branch?: string;
	dirty: boolean;
	ahead: number;
	behind: number;
	conflicted: number;
	untracked: number;
	stashed: boolean;
	modified: number;
	staged: number;
	renamed: number;
	deleted: number;
	typechanged: number;
};

function emptyGitStatus(): GitStatusSummary {
	return {
		branch: undefined,
		dirty: false,
		ahead: 0,
		behind: 0,
		conflicted: 0,
		untracked: 0,
		stashed: false,
		modified: 0,
		staged: 0,
		renamed: 0,
		deleted: 0,
		typechanged: 0,
	};
}

function parseGitStatusPorcelain(stdoutText: string, hasStash: boolean): GitStatusSummary {
	const status = emptyGitStatus();
	status.stashed = hasStash;

	for (const line of stdoutText.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("# branch.head ")) {
			const branch = line.slice("# branch.head ".length).trim();
			status.branch = branch && branch !== "(detached)" ? branch : undefined;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/\+(\d+)\s+-(\d+)/);
			if (match) {
				status.ahead = Number(match[1] ?? 0);
				status.behind = Number(match[2] ?? 0);
			}
			continue;
		}
		if (line.startsWith("#")) continue;

		status.dirty = true;

		if (line.startsWith("? ")) {
			status.untracked += 1;
			continue;
		}
		if (line.startsWith("u ")) {
			status.conflicted += 1;
			continue;
		}
		if (!(line.startsWith("1 ") || line.startsWith("2 "))) continue;

		const xy = line.split(" ")[1] ?? "..";
		const x = xy[0] ?? ".";
		const y = xy[1] ?? ".";

		if (x === "R") status.renamed += 1;
		else if (x === "D") status.deleted += 1;
		else if (x === "T") status.typechanged += 1;
		else if (x !== "." && x !== " ") status.staged += 1;

		if (y === "M") status.modified += 1;
		else if (y === "D") status.deleted += 1;
		else if (y === "T") status.typechanged += 1;
	}

	return status;
}

async function readGitStatus(cwd: string): Promise<GitStatusSummary> {
	try {
		const [{ stdout: statusStdout }, stashResult] = await Promise.all([
			execFileAsync("git", ["status", "--porcelain=2", "--branch"], { cwd }),
			execFileAsync("git", ["rev-parse", "--verify", "--quiet", "refs/stash"], { cwd }).catch(
				() => ({ stdout: "" }),
			),
		]);
		return parseGitStatusPorcelain(statusStdout, stashResult.stdout.trim().length > 0);
	} catch {
		return emptyGitStatus();
	}
}

// ────────────────────────── runtime ──────────────────────────

const VERSION_TIMEOUT_MS = 2500;

type RuntimeInfo = { name: string; symbol: string; version?: string };

type RuntimeCandidate = {
	name: string;
	symbol: string;
	detect: (entries: Set<string>) => boolean;
	version: (cwd: string) => Promise<string | undefined>;
};

function hasAny(entries: Set<string>, names: string[]): boolean {
	return names.some((name) => entries.has(name));
}

function hasLuaFile(entries: Set<string>): boolean {
	for (const entry of entries) if (entry.endsWith(".lua")) return true;
	return false;
}

async function runVersion(
	command: string,
	args: string[] = [],
	cwd?: string,
): Promise<string | undefined> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, { cwd, timeout: VERSION_TIMEOUT_MS });
		const text = `${stdout}\n${stderr}`.trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

function prefixVersion(version: string | undefined): string | undefined {
	if (!version) return undefined;
	return version.startsWith("v") ? version : `v${version}`;
}

const runtimes: RuntimeCandidate[] = [
	{
		name: "bun",
		symbol: "",
		detect: (entries) => hasAny(entries, ["bun.lock", "bun.lockb"]),
		version: async () => prefixVersion(await runVersion("bun", ["--version"])),
	},
	{
		name: "deno",
		symbol: "",
		detect: (entries) => hasAny(entries, ["deno.json", "deno.jsonc", "deno.lock"]),
		version: async () => {
			const output = await runVersion("deno", ["--version"]);
			const match = output?.match(/deno\s+([0-9][^\s]*)/i);
			return prefixVersion(match?.[1]);
		},
	},
	{
		name: "lua",
		symbol: "",
		detect: (entries) =>
			hasAny(entries, [
				"stylua.toml",
				".stylua.toml",
				".luarc.json",
				".luarc.jsonc",
				"init.lua",
				"lua",
			]) || hasLuaFile(entries),
		version: async () => {
			const lua = await runVersion("lua", ["-v"]);
			const luaMatch = lua?.match(/Lua\s+([0-9][^\s]*)/i);
			if (luaMatch?.[1]) return prefixVersion(luaMatch[1]);
			const luajit = await runVersion("luajit", ["-v"]);
			const luajitMatch = luajit?.match(/LuaJIT\s+([0-9][^\s]*)/i);
			return prefixVersion(luajitMatch?.[1]);
		},
	},
	{
		name: "nodejs",
		symbol: "",
		detect: (entries) => hasAny(entries, ["package.json", ".nvmrc", ".node-version"]),
		version: async () => prefixVersion(await runVersion("node", ["--version"])),
	},
	{
		name: "python",
		symbol: "",
		detect: (entries) =>
			hasAny(entries, [
				"pyproject.toml",
				"requirements.txt",
				"setup.py",
				"setup.cfg",
				"Pipfile",
				".python-version",
			]),
		version: async () => {
			const python3 = await runVersion("python3", ["--version"]);
			const python3Match = python3?.match(/Python\s+([0-9][^\s]*)/i);
			if (python3Match?.[1]) return prefixVersion(python3Match[1]);
			const python = await runVersion("python", ["--version"]);
			const pythonMatch = python?.match(/Python\s+([0-9][^\s]*)/i);
			return prefixVersion(pythonMatch?.[1]);
		},
	},
	{
		name: "golang",
		symbol: "",
		detect: (entries) => hasAny(entries, ["go.mod"]),
		version: async () => {
			const output = await runVersion("go", ["version"]);
			const match = output?.match(/go version go([0-9][^\s]*)/i);
			return prefixVersion(match?.[1]);
		},
	},
	{
		name: "rust",
		symbol: "󱘗",
		detect: (entries) => hasAny(entries, ["Cargo.toml"]),
		version: async () => {
			const output = await runVersion("rustc", ["--version"]);
			const match = output?.match(/rustc\s+([0-9][^\s]*)/i);
			return prefixVersion(match?.[1]);
		},
	},
	{
		name: "java",
		symbol: "",
		detect: (entries) => hasAny(entries, ["pom.xml", "build.gradle", "build.gradle.kts"]),
		version: async () => {
			const output = await runVersion("java", ["-version"]);
			const quoted = output?.match(/"([0-9][^"]*)"/);
			if (quoted?.[1]) return prefixVersion(quoted[1]);
			const plain = output?.match(/version\s+([0-9][^\s]*)/i);
			return prefixVersion(plain?.[1]);
		},
	},
	{
		name: "ruby",
		symbol: "",
		detect: (entries) => hasAny(entries, ["Gemfile", ".ruby-version"]),
		version: async () => {
			const output = await runVersion("ruby", ["--version"]);
			const match = output?.match(/ruby\s+([0-9][^\s]*)/i);
			return prefixVersion(match?.[1]);
		},
	},
	{
		name: "php",
		symbol: "",
		detect: (entries) => hasAny(entries, ["composer.json"]),
		version: async () => {
			const output = await runVersion("php", ["--version"]);
			const match = output?.match(/PHP\s+([0-9][^\s]*)/i);
			return prefixVersion(match?.[1]);
		},
	},
];

function detectRuntime(entries: Set<string>): RuntimeCandidate | undefined {
	for (const runtime of runtimes) if (runtime.detect(entries)) return runtime;
	return undefined;
}

// Runtime versions don't change during a session; cache per (cwd, runtime).
const runtimeVersionCache = new Map<string, string | undefined>();

async function readRuntimeInfo(cwd: string): Promise<RuntimeInfo | undefined> {
	let entries: Set<string>;
	try {
		entries = new Set(await readdir(cwd));
	} catch {
		entries = new Set();
	}
	const runtime = detectRuntime(entries);
	if (!runtime) return undefined;
	const cacheKey = `${runtime.name}\0${cwd}`;
	let version = runtimeVersionCache.get(cacheKey);
	if (!runtimeVersionCache.has(cacheKey)) {
		version = await runtime.version(cwd);
		runtimeVersionCache.set(cacheKey, version);
	}
	return { name: runtime.name, symbol: runtime.symbol, version };
}

// ────────────────────────── ui ──────────────────────────

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

class PolishedEditor extends CustomEditor {
	private readonly getModelMeta: () => string;
	private readonly getThinkingLevel: () => string | undefined;
	private readonly uiTheme: Theme;
	private readonly reset = "\x1b[0m";

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		uiTheme: Theme,
		getModelMeta: () => string,
		getThinkingLevel: () => string | undefined,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.borderColor = (text: string) => uiTheme.fg("border", text);
		this.uiTheme = uiTheme;
		this.getModelMeta = getModelMeta;
		this.getThinkingLevel = getThinkingLevel;
	}

	private fillLine(content: string, width: number): string {
		return fillStyledLine(content, width);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
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

		const isBashMode = this.getText().startsWith("!");
		const railColor = isBashMode ? "mdCode" : "accent";
		const borderColor = isBashMode ? "mdCode" : "border";
		const textPrefix = isBashMode ? this.uiTheme.getFgAnsi("mdCode") : "";
		const coloredEditorLines = editorLines.map((l) => (textPrefix ? `${textPrefix}${l}` : l));
		const leftRail = `${this.uiTheme.fg(railColor, "│")}${this.reset} `;
		const rightRail = ` ${this.uiTheme.fg(railColor, "│")}${this.reset}`;
		const top = this.uiTheme.fg(railColor, "╭") + this.uiTheme.fg(borderColor, "─".repeat(Math.max(0, width - 2))) + this.uiTheme.fg(railColor, "╮");
		const bottom = this.uiTheme.fg(railColor, "╰") + this.uiTheme.fg(borderColor, "─".repeat(Math.max(0, width - 2))) + this.uiTheme.fg(railColor, "╯");
		const lines = ["", ...coloredEditorLines, "", meta];

		return [
			top,
			...lines.map((line) => `${leftRail}${this.fillLine(line, innerWidth)}${rightRail}`),
			bottom,
			...autocompleteLines,
		];
	}
}

// ────────────────────────── extension ──────────────────────────

type FooterState = GitStatusSummary & {
	modelLabel: string;
	providerLabel: string;
	contextLabel: string;
	tokenLabel: string;
	costLabel: string;
	cwd: string;
	contextPercent: number | null | undefined;
	runtime?: RuntimeInfo;
};

type UsageTotals = { input: number; output: number; cost: number };

function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	return `${Math.round(value / 1000)}k`;
}

function formatProviderLabel(provider: string | undefined): string {
	if (!provider) return "Unknown";
	const known: Record<string, string> = {
		anthropic: "Anthropic",
		gemini: "Google",
		google: "Google",
		ollama: "Ollama",
		openai: "OpenAI",
		"openai-codex": "OpenAI",
	};
	return (
		known[provider] ?? provider.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
	);
}

function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
		cost += message.usage?.cost?.total ?? 0;
	}
	return { input, output, cost };
}

function buildTokenLabel(totals: UsageTotals): string {
	return `↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`;
}

function buildCostLabel(totals: UsageTotals): string {
	return `$${totals.cost.toFixed(3)}`;
}

function buildContextLabel(
	usage: ReturnType<ExtensionContext["getContextUsage"]>,
	contextWindow: number | undefined,
): string {
	if (!usage || !contextWindow || contextWindow <= 0) return "--";
	const percent =
		usage.percent === null ? "?" : `${Math.max(0, Math.min(999, Math.round(usage.percent)))}%`;
	return `${percent}/${formatCount(contextWindow)}`;
}

function getRuntimeColorToken(runtime: RuntimeInfo | undefined): string {
	switch (runtime?.name) {
		case "nodejs":
			return "success";
		case "deno":
			return "syntaxType";
		case "bun":
			return "warning";
		case "python":
		case "java":
			return "warning";
		case "rust":
		case "ruby":
			return "error";
		case "golang":
			return "syntaxType";
		case "lua":
		case "php":
			return "accent";
		default:
			return "text";
	}
}

function formatRuntimeSegment(theme: Pick<Theme, "fg">, runtime: RuntimeInfo | undefined): string {
	if (!runtime) return "";
	const label = runtime.version ? `${runtime.symbol} ${runtime.version}` : runtime.symbol;
	return `${colorize(theme, "text", "via")} ${colorize(theme, getRuntimeColorToken(runtime), label)}`;
}

function formatCwdLabel(cwd: string, cwdIcon: string): string {
	const last = basename(cwd) || cwd;
	return cwdIcon ? `${cwdIcon} ${last}` : last;
}

export default function (pi: ExtensionAPI) {
	const state: FooterState = {
		modelLabel: "no-model",
		providerLabel: "Unknown",
		contextLabel: "--",
		tokenLabel: "↑0 ↓0",
		costLabel: "$0.000",
		cwd: "",
		contextPercent: undefined,
		runtime: undefined,
		...emptyGitStatus(),
	};

	let currentConfig: PolishedTuiConfig = loadConfig();
	let requestFooterRender: (() => void) | undefined;
	let projectRefreshInFlight = false;
	let projectRefreshPending = false;
	let projectRefreshDebounceTimer: NodeJS.Timeout | undefined;
	let lastProjectRefreshAt = 0;
	const PROJECT_REFRESH_MIN_INTERVAL_MS = 500;

	const refresh = () => requestFooterRender?.();

	const syncState = (ctx: ExtensionContext) => {
		const totals = getUsageTotals(ctx);
		const usage = ctx.getContextUsage();
		const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow;
		state.modelLabel = ctx.model?.id ?? "no-model";
		state.providerLabel = formatProviderLabel(ctx.model?.provider);
		state.contextLabel = buildContextLabel(usage, contextWindow);
		state.tokenLabel = buildTokenLabel(totals);
		state.costLabel = buildCostLabel(totals);
		state.cwd = ctx.cwd;
		state.contextPercent = usage?.percent;
	};

	const refreshProjectState = async (ctx: ExtensionContext) => {
		const [gitStatus, runtime] = await Promise.all([
			readGitStatus(ctx.cwd),
			readRuntimeInfo(ctx.cwd),
		]);
		Object.assign(state, gitStatus);
		state.runtime = runtime;
	};

	const runProjectRefresh = (ctx: ExtensionContext) => {
		projectRefreshInFlight = true;
		lastProjectRefreshAt = Date.now();
		void refreshProjectState(ctx).finally(() => {
			projectRefreshInFlight = false;
			refresh();
			if (projectRefreshPending) {
				projectRefreshPending = false;
				scheduleProjectRefresh(ctx);
			}
		});
	};

	const scheduleProjectRefresh = (ctx: ExtensionContext) => {
		if (projectRefreshInFlight) {
			projectRefreshPending = true;
			return;
		}
		const elapsed = Date.now() - lastProjectRefreshAt;
		if (elapsed >= PROJECT_REFRESH_MIN_INTERVAL_MS) {
			runProjectRefresh(ctx);
			return;
		}
		if (projectRefreshDebounceTimer) return;
		projectRefreshDebounceTimer = setTimeout(() => {
			projectRefreshDebounceTimer = undefined;
			runProjectRefresh(ctx);
		}, PROJECT_REFRESH_MIN_INTERVAL_MS - elapsed);
	};

	const installFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => {
				scheduleProjectRefresh(ctx);
				tui.requestRender();
			});
			const separator = colorize(theme, currentConfig.colors.separator, " | ");

			return {
				dispose: () => {
					unsubscribeBranch();
					requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const innerWidth = Math.max(1, width - 2);
					const cwdLabel = colorize(
						theme,
						currentConfig.colors.cwdText,
						formatCwdLabel(state.cwd, currentConfig.icons.cwd),
					);
					const branch = state.branch;
					const contextColor =
						state.contextPercent !== null && state.contextPercent !== undefined
							? state.contextPercent >= 90
								? currentConfig.colors.contextError
								: state.contextPercent >= 70
									? currentConfig.colors.contextWarning
									: currentConfig.colors.contextNormal
							: currentConfig.colors.contextNormal;
					const gitColor = (text: string) => colorize(theme, currentConfig.colors.git, text);
					const gitStatusColor = (text: string) =>
						colorize(theme, currentConfig.colors.gitStatus, text);
					const gitIcon = gitColor(currentConfig.icons.git);
					const allStatus = [
						state.conflicted > 0 ? currentConfig.icons.conflicted : "",
						state.stashed ? currentConfig.icons.stashed : "",
						state.deleted > 0 ? currentConfig.icons.deleted : "",
						state.renamed > 0 ? currentConfig.icons.renamed : "",
						state.modified > 0 ? currentConfig.icons.modified : "",
						state.typechanged > 0 ? currentConfig.icons.typechanged : "",
						state.staged > 0 ? currentConfig.icons.staged : "",
						state.untracked > 0 ? currentConfig.icons.untracked : "",
					].join("");
					const aheadBehind =
						state.ahead > 0 && state.behind > 0
							? currentConfig.icons.diverged
							: state.ahead > 0
								? currentConfig.icons.ahead
								: state.behind > 0
									? currentConfig.icons.behind
									: "";
					const statusBlock =
						allStatus || aheadBehind ? gitStatusColor(`[${allStatus}${aheadBehind}]`) : "";
					const branchLabel = branch
						? `${colorize(theme, "text", "on")} ${gitIcon} ${gitColor(branch)}${statusBlock ? ` ${statusBlock}` : ""}`
						: "";
					const runtimeLabel = formatRuntimeSegment(theme, state.runtime);

					const left = [cwdLabel, branchLabel, runtimeLabel].filter(Boolean).join(" ");
					const right = [
						colorize(theme, contextColor, state.contextLabel),
						colorize(theme, currentConfig.colors.tokens, state.tokenLabel),
						colorize(theme, currentConfig.colors.cost, state.costLabel),
					].join(separator);

					const leftWidth = visibleWidth(left);
					const rightWidth = visibleWidth(right);
					const content =
						leftWidth >= innerWidth
							? truncateToWidth(left, innerWidth)
							: leftWidth + 1 + rightWidth <= innerWidth
								? `${left}${" ".repeat(innerWidth - leftWidth - rightWidth)}${right}`
								: left;
					return [` ${content} `];
				},
			};
		});
	};

	const installEditor = (ctx: ExtensionContext) => {
		let autocompleteFixed = false;

		const editorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			const uiTheme = ctx.ui.theme;
			const editor = new PolishedEditor(
				tui,
				theme,
				keybindings,
				uiTheme,
				() =>
					[
						uiTheme.fg("accent", state.modelLabel),
						uiTheme.fg("text", state.providerLabel),
					].join(uiTheme.fg("borderMuted", "  ")),
				() => {
					try {
						return pi.getThinkingLevel();
					} catch {
						return undefined;
					}
				},
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

		ctx.ui.setEditorComponent(editorFactory);
	};

	const installUi = (ctx: ExtensionContext) => {
		ensureConfigExists();
		currentConfig = loadConfig();
		patchUserMessageComponent();
		syncState(ctx);
		installFooter(ctx);
		installEditor(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	};

	pi.on("session_start", async (_event, ctx) => {
		installUi(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		syncState(ctx);
		refresh();
	});

	pi.on("agent_end", async (_event, ctx) => {
		syncState(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("model_select", async (_event, ctx) => {
		syncState(ctx);
		refresh();
	});

	pi.on("message_end", async (_event, ctx) => {
		syncState(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		syncState(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("session_compact", async (_event, ctx) => {
		syncState(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	});
}
