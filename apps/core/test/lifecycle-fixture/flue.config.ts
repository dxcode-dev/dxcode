import { defineConfig } from "@flue/runtime/config";

export default defineConfig({
  target: "cloudflare",
  app: "./src/app.ts",
  agents: "agents/**/*.ts",
  providers: [],
  tracing: false,
  canonicalFlushDelayMs: 750,
});
