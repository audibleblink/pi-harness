/**
 * Stealth Skills Extension
 *
 * Hides specific skills from the system prompt while keeping them invokable
 * via `/skill:name`. This is the user-side equivalent of putting
 * `disable-model-invocation: true` in a SKILL.md frontmatter, but without
 * editing upstream skill files.
 *
 * Configuration (global only — `~/.config/pi/agent/settings.json`):
 *
 * ```json
 * { "stealthSkills": ["context7", "browser-use"] }
 * ```
 *
 * Why these settings? Pi's `pi config` TUI fully disables skills (also drops
 * them from `/skill:name`); pi's `--no-skills` does the same. There is no
 * built-in way to keep a skill loaded for explicit invocation while hiding
 * its description from the system prompt. This extension fills that gap.
 *
 * Mechanics:
 * - On `before_agent_start`, take `systemPromptOptions.skills`, mark every
 *   skill whose name is in `stealthSkills` as `disableModelInvocation: true`,
 *   re-render the skills XML block via `formatSkillsForPrompt`, and replace
 *   the original block in the assembled system prompt.
 * - Skill slash-command registration ignores `disableModelInvocation`, so
 *   `/skill:name` keeps working for hidden skills (verified in
 *   pi-coding-agent/dist/core/skills.js).
 *
 * The `/skills` command opens an interactive selector to toggle which skills
 * are hidden. Changes persist to global settings.json and take effect on
 * the next pi restart (settings are read once at session_start).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	formatSkillsForPrompt,
	getAgentDir,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

interface SettingsShape {
	stealthSkills?: string[];
	[key: string]: unknown;
}

const SETTING_KEY = "stealthSkills";

export default function (pi: ExtensionAPI) {
	// Read once at session_start; changes apply on restart.
	let stealthSet = new Set<string>();
	// Cache the most recent skill list seen via before_agent_start, so /skills
	// can populate its picker. Empty until the first agent turn — in that
	// case we tell the user to send any prompt first.
	let knownSkills: Skill[] = [];

	function settingsPath(): string {
		return join(getAgentDir(), "settings.json");
	}

	function readSettings(): SettingsShape {
		const path = settingsPath();
		if (!existsSync(path)) return {};
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as SettingsShape;
		} catch {
			return {};
		}
	}

	function writeSettings(next: SettingsShape): void {
		const path = settingsPath();
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
		renameSync(tmp, path);
	}

	function loadStealthSet(): Set<string> {
		const value = readSettings()[SETTING_KEY];
		if (!Array.isArray(value)) return new Set();
		return new Set(value.filter((v): v is string => typeof v === "string"));
	}

	function persistStealthSet(set: Set<string>): void {
		const current = readSettings();
		current[SETTING_KEY] = Array.from(set).sort();
		writeSettings(current);
	}

	pi.on("session_start", () => {
		stealthSet = loadStealthSet();
	});

	pi.on("before_agent_start", (event) => {
		const skills = event.systemPromptOptions.skills ?? [];
		knownSkills = skills;
		if (stealthSet.size === 0 || skills.length === 0) return;

		const original = formatSkillsForPrompt(skills);
		if (!original) return;

		const filtered = skills.map((s) =>
			stealthSet.has(s.name) ? { ...s, disableModelInvocation: true } : s,
		);
		const replacement = formatSkillsForPrompt(filtered);

		if (!event.systemPrompt.includes(original)) return; // unexpected — bail safely
		const newPrompt = event.systemPrompt.replace(original, replacement);
		if (newPrompt === event.systemPrompt) return;
		return { systemPrompt: newPrompt };
	});

	pi.registerCommand("skills", {
		description: "Toggle which skills are hidden from the system prompt (kept invokable via /skill:name)",
		handler: async (_args, ctx) => {
			if (knownSkills.length === 0) {
				ctx.ui.notify(
					"No skills observed yet — send any prompt first so pi reports the loaded skill list, then run /skills again.",
					"info",
				);
				return;
			}
			await showSkillsPicker(ctx);
		},
	});

	async function showSkillsPicker(ctx: ExtensionContext): Promise<void> {
		// Operate on a working copy so changes are atomic per session.
		const working = new Set(stealthSet);
		const sorted = [...knownSkills].sort((a, b) => a.name.localeCompare(b.name));

		const result = await ctx.ui.custom<"save" | "cancel">((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Stealth Skills — toggle prompt visibility"))),
			);

			function labelFor(name: string): string {
				return `${working.has(name) ? "[x]" : "[ ]"} ${name}`;
			}
			function descFor(name: string): string {
				return working.has(name) ? "hidden from prompt" : "visible in prompt";
			}

			// SelectList mutates this array in place; we keep the same reference and
			// edit individual items' label/description on toggle so the rendered list
			// updates without rebuilding the component.
			const liveItems: SelectItem[] = sorted.map((skill) => ({
				value: skill.name,
				label: labelFor(skill.name),
				description: descFor(skill.name),
			}));

			const maxVisible = Math.min(Math.max(sorted.length, 1), 15);
			const selectList = new SelectList(liveItems, maxVisible, {
				selectedPrefix: (text: string) => theme.fg("accent", text),
				selectedText: (text: string) => theme.fg("accent", text),
				description: (text: string) => theme.fg("muted", text),
				scrollInfo: (text: string) => theme.fg("dim", text),
				noMatch: (text: string) => theme.fg("warning", text),
			});
			// Disarm SelectList's own enter/esc handlers — we drive completion ourselves
			// from the outer handleInput so space=toggle and enter=save are unambiguous.
			selectList.onSelect = () => {};
			selectList.onCancel = () => {};

			container.addChild(selectList);
			container.addChild(
				new Text(theme.fg("dim", "↑↓ navigate • space toggle • enter save • esc cancel")),
			);
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (matchesKey(data, "escape")) {
						done("cancel");
						return;
					}
					if (matchesKey(data, "enter")) {
						done("save");
						return;
					}
					if (matchesKey(data, "space")) {
						const item = selectList.getSelectedItem();
						if (item) {
							if (working.has(item.value)) working.delete(item.value);
							else working.add(item.value);
							const live = liveItems.find((it) => it.value === item.value);
							if (live) {
								live.label = labelFor(item.value);
								live.description = descFor(item.value);
							}
							selectList.invalidate();
							tui.requestRender();
						}
						return;
					}
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (result === "cancel") {
			ctx.ui.notify("Stealth skills: changes discarded", "info");
			return;
		}

		const removed = [...stealthSet].filter((n) => !working.has(n));
		const added = [...working].filter((n) => !stealthSet.has(n));
		if (added.length + removed.length === 0) {
			ctx.ui.notify("Stealth skills: no changes", "info");
			return;
		}
		persistStealthSet(working);
		ctx.ui.notify(
			`Stealth skills updated (+${added.length} / -${removed.length}). Restart pi for changes to take effect.`,
			"info",
		);
	}
}
