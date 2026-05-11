/**
 * Visible Skills Extension (allowlist)
 *
 * Inverted stealth-skills: only skills listed in `visibleSkills` are
 * advertised to the model in the system prompt. Every other loaded skill
 * is marked `disableModelInvocation: true` (hidden from the prompt) but
 * remains invokable via `/skill:name`.
 *
 * Configuration (global only — `~/.config/pi/agent/settings.json`):
 *
 * ```json
 * { "autoSkills": ["pi", "context7"] }
 * ```
 *
 * Empty/missing allowlist => hide all skills from the prompt.
 *
 * The `/skills` command opens an interactive allowlist picker. Changes
 * persist to global settings.json and take effect on the next pi restart.
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
import { SLOT_AGENT_SKILLS, UI_BUS_TOPIC, type UiBusEnvelope } from "./ui/bus.js";

interface SettingsShape {
	autoSkills?: string[];
	[key: string]: unknown;
}

const SETTING_KEY = "autoSkills";

export default function (pi: ExtensionAPI) {
	let visibleSet = new Set<string>();
	let agentOverride: Set<string> | null = null;
	let knownSkills: Skill[] = [];

	pi.events.on(UI_BUS_TOPIC, (data: unknown) => {
		const env = data as UiBusEnvelope;
		if (env?.slot !== SLOT_AGENT_SKILLS) return;
		agentOverride = Array.isArray(env.value)
			? new Set(env.value.filter((v): v is string => typeof v === "string"))
			: null;
	});

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

	function loadVisibleSet(): Set<string> {
		const value = readSettings()[SETTING_KEY];
		if (!Array.isArray(value)) return new Set();
		return new Set(value.filter((v): v is string => typeof v === "string"));
	}

	function persistVisibleSet(set: Set<string>): void {
		const current = readSettings();
		current[SETTING_KEY] = Array.from(set).sort();
		writeSettings(current);
	}

	pi.on("session_start", () => {
		visibleSet = loadVisibleSet();
	});

	pi.on("before_agent_start", (event) => {
		const skills = event.systemPromptOptions.skills ?? [];
		knownSkills = skills;
		if (skills.length === 0) return;

		const original = formatSkillsForPrompt(skills);
		if (!original) return;

		// Hide every skill NOT in the allowlist. Active primary agent (if any)
		// overrides the persisted set for the duration it's active.
		const effective = agentOverride ?? visibleSet;
		const filtered = skills.map((s) =>
			effective.has(s.name) ? s : { ...s, disableModelInvocation: true },
		);
		const replacement = formatSkillsForPrompt(filtered);

		if (!event.systemPrompt.includes(original)) return;
		const newPrompt = event.systemPrompt.replace(original, replacement);
		if (newPrompt === event.systemPrompt) return;
		return { systemPrompt: newPrompt };
	});

	pi.registerCommand("skills", {
		description: "Toggle which skills are advertised in the system prompt (others stay invokable via /skill:name)",
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
		const working = new Set(visibleSet);
		const sorted = [...knownSkills].sort((a, b) => a.name.localeCompare(b.name));

		const result = await ctx.ui.custom<"save" | "cancel">((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Visible Skills — allowlist for system prompt"))),
			);

			function labelFor(name: string): string {
				return `${working.has(name) ? "[x]" : "[ ]"} ${name}`;
			}
			function descFor(name: string): string {
				return working.has(name) ? "visible in prompt" : "hidden from prompt";
			}

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
			ctx.ui.notify("Visible skills: changes discarded", "info");
			return;
		}

		const removed = [...visibleSet].filter((n) => !working.has(n));
		const added = [...working].filter((n) => !visibleSet.has(n));
		if (added.length + removed.length === 0) {
			ctx.ui.notify("Visible skills: no changes", "info");
			return;
		}
		persistVisibleSet(working);
		ctx.ui.notify(
			`Visible skills updated (+${added.length} / -${removed.length}). Restart pi for changes to take effect.`,
			"info",
		);
	}
}
