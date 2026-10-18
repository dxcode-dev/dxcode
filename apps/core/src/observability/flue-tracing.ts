import { instrument } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { traceLogger } from "../logging.js";

let installed = false;

/**
 * Flue's generated Worker entry installs its Cloudflare agent tracing after
 * the user modules it imports, unless an adapter is already installed. That
 * default writes prompts, completions, system instructions, and tool
 * arguments and results into Workers Traces. Installing Flue's documented
 * content-free adapter first keeps the agent spans (model, token usage, tool
 * names) without the conversation. Call it at Cloudflare entry module scope.
 */
export const installContentFreeFlueTracing = () => {
  if (installed) return;
  installed = true;
  try {
    instrument(createCloudflareTracing({ content: false }));
  } catch {
    traceLogger.warn("Flue content-free tracing installation failed.", {
      event: "flue_tracing_install_failed",
    });
  }
};
