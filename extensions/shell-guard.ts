import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * shell-guard
 *
 * Hard-blocks bash invocations that the agent should be doing via dedicated
 * tools instead. Currently:
 *   - file readers (cat/nl/head/tail/less/more/bat) → use `read`
 *   - heredoc-to-file (cat <<EOF > file)            → use `write`
 *
 * Add more rules to RULES as needed.
 */

type Rule = {
	name: string;
	test: (cmd: string) => boolean;
	reason: string;
};

const READER_HEAD = /^(?:cat|nl|head|tail|less|more|bat)\b/;

const RULES: Rule[] = [
	{
		name: "heredoc-write",
		test: (cmd) => /<<-?\s*['"]?\w+['"]?[\s\S]*?>\s*\S/.test(cmd),
		reason: "Use the `write` tool to create/overwrite files, not `cat <<EOF > file`.",
	},
	{
		name: "file-reader",
		test: (cmd) => {
			// Split on shell separators; flag only if a reader is the LEADING command
			// of a segment (so `... | head` and `git log | cat` remain allowed).
			for (const seg of cmd.split(/&&|\|\||;|\n/)) {
				const trimmed = seg.trim().replace(
					/^\(+\s*/,
					"",
				);
				if (READER_HEAD.test(trimmed)) return true;
			}
			return false;
		},
		reason: "Use the `read` tool for file contents, not bash readers (cat/head/tail/nl/less/more/bat).",
	},
	{
		name: "pip-install",
		test: (cmd) => {
			for (const seg of cmd.split(/&&|\|\||;|\n|\|/)) {
				const trimmed = seg.trim().replace(
					/^\(+\s*/,
					"",
				);
				if (
					/^(?:python3?\s+-m\s+)?pip3?\s+install\b/
						.test(trimmed)
				) return true;
			}
			return false;
		},
		reason: "Use `uv` (e.g. `uv tool install` for global tools or `uv add` for local deps) instead of `pip install`.",
	},
];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const cmd = String(event.input?.command ?? "");
		if (!cmd) return undefined;

		for (const rule of RULES) {
			if (rule.test(cmd)) {
				return {
					block: true,
					reason: `[shell-guard:${rule.name}] ${rule.reason}`,
				};
			}
		}
		return undefined;
	});
}
