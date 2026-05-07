/**
 * Git Checkpoint Extension
 *
 * Snapshots the working tree (including untracked files) at each turn_end
 * via `git write-tree`, keyed by the leaf session entryId (the just-finished
 * assistant message). On /fork or /tree navigation, prompts the user to
 * restore the working tree to that snapshot.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const checkpoints = new Map<string, string>();
	let gitDisabled = false;
	let gitChecked = false;

	async function ensureGit(ctx: { hasUI: boolean; ui: { notify: (m: string, l: "info" | "warning" | "error") => void } }) {
		if (gitChecked) return;
		gitChecked = true;
		try {
			await pi.exec("git", ["rev-parse", "--git-dir"]);
		} catch {
			gitDisabled = true;
			if (ctx.hasUI) ctx.ui.notify("git-checkpoint disabled: not a git repository", "warning");
		}
	}

	pi.on("turn_end", async (_event, ctx) => {
		await ensureGit(ctx);
		if (gitDisabled) return;
		const leaf = ctx.sessionManager.getLeafEntry();
		if (!leaf) return;

		try {
			await pi.exec("git", ["add", "-A"]);
			const { stdout } = await pi.exec("git", ["write-tree"]);
			const tree = stdout.trim();
			await pi.exec("git", ["reset"]);
			if (tree) checkpoints.set(leaf.id, tree);
		} catch {
			// snapshot failure is non-fatal; skip this turn
		}
	});

	async function restore(entryId: string, ctx: { hasUI: boolean; ui: { select: (t: string, o: string[]) => Promise<string | undefined>; notify: (m: string, l: "info" | "warning" | "error") => void } }) {
		if (!ctx.hasUI) return;
		const tree = checkpoints.get(entryId);
		if (!tree) {
			ctx.ui.notify("No checkpoint for this entry", "warning");
			return;
		}

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
