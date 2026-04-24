import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Vim-quit extension
 * Intercepts :q, :q!, :wq, and :wq! and gracefully shuts down pi.
 */
export default function (pi: ExtensionAPI) {
  const VIM_QUIT_COMMANDS = new Set([":q", ":q!", ":wq", ":wq!", ":qa", ":qa!"]);

  pi.on("input", async (event, ctx) => {
    if (VIM_QUIT_COMMANDS.has(event.text.trim())) {
      ctx.ui.notify("Goodbye! 👋", "info");
      ctx.shutdown();
      return { action: "handled" };
    }
  });
}
