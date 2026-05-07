/**
 * Git Checkpoint Extension
 *
 * Snapshots the working tree (including untracked files) at each turn_start
 * via `git write-tree`, keyed by the leaf session entryId. On /fork or /tree
 * navigation, prompts the user to restore the working tree to that snapshot.
 *
 * Per PRD: ~80 lines, no UI slot, persists across agent_end, no-op outside
 * a git repo (single warn notification on first turn).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const checkpoints = new Map<string, string>();
	let currentEntryId: string | undefined;
	let gitDisabled = false;
	let gitChecked = false;

	pi.on("tool_result", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!gitChecked) {
			gitChecked = true;
			try {
				await pi.exec("git", ["rev-parse", "--git-dir"]);
			} catch {
				gitDisabled = true;
				if (ctx.hasUI) {
					ctx.ui.notify("git-checkpoint disabled: not a git repository", "warning");
				}
			}
		}
		if (gitDisabled) return;
		if (!currentEntryId) return;

		try {
			await pi.exec("git", ["add", "-A"]);
			const { stdout } = await pi.exec("git", ["write-tree"]);
			const tree = stdout.trim();
			await pi.exec("git", ["reset"]);
			if (tree) checkpoints.set(currentEntryId, tree);
		} catch {
			// snapshot failure is non-fatal; skip this turn
		}
	});

	async function restore(entryId: string, ctx: { hasUI: boolean; ui: { select: (t: string, o: string[]) => Promise<string | undefined>; notify: (m: string, l: "info" | "warning" | "error") => void } }) {
		const tree = checkpoints.get(entryId);
		if (!tree) return;
		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);

		if (choice?.startsWith("Yes")) {
			await pi.exec("git", ["read-tree", "-u", "--reset", tree]);
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	}

	pi.on("session_before_fork", async (event, ctx) => restore(event.entryId, ctx));
	pi.on("session_before_tree", async (event, ctx) => restore(event.preparation.targetId, ctx));
}
