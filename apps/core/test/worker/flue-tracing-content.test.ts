import { installDefaultCloudflareTracing } from "@flue/runtime/cloudflare/internal";
import { expect, it } from "vitest";

/**
 * Flue's generated Worker entry imports src/cloudflare.ts, then calls
 * `installDefaultCloudflareTracing()`, whose adapter writes prompts,
 * completions, and tool I/O into Workers Traces. src/cloudflare.ts installs
 * Flue's content-free adapter at module scope, so the default must yield.
 */
it("keeps Flue's content-bearing default tracing out of the Worker", async () => {
  await import("../../src/cloudflare.js");
  expect(installDefaultCloudflareTracing()).toBeUndefined();
});
