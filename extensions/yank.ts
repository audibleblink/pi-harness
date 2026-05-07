import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("yank", {
    description: "Copy the last LLM response to clipboard",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch();
      let text = "";
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as any;
        if (e.type === "message" && e.message?.role === "assistant") {
          for (const block of e.message.content ?? []) {
            if (block.type === "text") text += block.text;
          }
          break;
        }
      }
      if (!text) {
        ctx.ui.notify("No assistant response to yank", "warning");
        return;
      }
      const proc = spawn("pbcopy");
      proc.stdin.end(text);
      await new Promise((r) => proc.on("close", r));
      ctx.ui.notify(`Copied ${text.length} chars to clipboard`, "success");
    },
  });
}
