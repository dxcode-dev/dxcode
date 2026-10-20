// React rendering tests run here, compiled by the app's own plugins (React
// Compiler included) in headless Chromium. Name them `*.browser.test.tsx`.
// Pure logic stays in the root node project.
//
// Chromium is the Playwright 1.55 headless shell (build 1187). Install it once
// with `pnpm --filter @dx/web exec playwright install chromium-headless-shell`,
// or point DX_TEST_CHROMIUM at another Chromium binary.
import { createHash } from "node:crypto";
import { playwright } from "@vitest/browser-playwright";
import { defineProject } from "vitest/config";
import { appPlugins } from "./vite.config.js";

const root = import.meta.dirname;

// Two checkouts running at once must not fight over Vitest's fixed default
// port, so each checkout gets its own in 41000-48999. Vitest still moves to
// the next free port when two runs share a checkout.
const checkoutPort =
  41_000 + (createHash("sha256").update(root).digest().readUInt32BE(0) % 8000);

export default defineProject({
  root,
  plugins: appPlugins(),
  define: { "import.meta.env.DX_ENV": JSON.stringify("") },
  // Vitest's importOriginal keeps only the default export of a pre-bundled
  // ESM dependency, so a mock that spreads react-markdown loses its named
  // exports. Serving it unbundled keeps every export; its CommonJS
  // dependencies still need pre-bundling.
  optimizeDeps: {
    exclude: ["react-markdown"],
    include: [
      "react-markdown > hast-util-to-jsx-runtime > style-to-js",
      "react-markdown > remark-parse > unified > extend",
      "react-markdown > remark-parse > mdast-util-from-markdown > micromark > debug",
    ],
  },
  test: {
    name: "web-browser",
    include: ["src/**/*.browser.test.{ts,tsx}"],
    setupFiles: ["./src/testing/browser-test-setup.ts"],
    // Chromium running beside the node tests starved their timing-sensitive
    // cases on a four-core machine, so this project runs after them.
    sequence: { groupOrder: 1 },
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      // Vitest's default 414px frame is a phone; tests that want the phone
      // layout ask for it.
      viewport: { width: 1280, height: 800 },
      api: { host: "127.0.0.1", port: checkoutPort },
      provider: playwright({
        launchOptions: {
          executablePath: process.env.DX_TEST_CHROMIUM || undefined,
          // Tests must not reach the network; only the test server resolves.
          args: [
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
          ],
        },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
