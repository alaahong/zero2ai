// @ts-nocheck — example file; install @zero2ai/coding-agent before running
import type { ExtensionAPI } from "@zero2ai/coding-agent";

export default function myPlugin(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("my-plugin loaded from example marketplace!", "info");
  });
}
