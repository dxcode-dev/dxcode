// React rendering tests run here, compiled by the app's own plugins (React
// Compiler included) in headless Chromium. Name them `*.browser.test.tsx`.
// Pure logic stays in the root node project.
//
// Chromium is the Playwright 1.55 headless shell (build 1187). Install it once
// with `pnpm --filter @dx/web exec playwright install chromium-headless-shell`,
// or point DX_TEST_CHROMIUM at another Chromium binary.
import { createHash } from "node:crypto";
import { playwright } from "@vitest/browser-playwright";
import type { BrowserContext } from "playwright";
import { defineProject } from "vitest/config";
import { appPlugins } from "./vite.config.js";

const root = import.meta.dirname;

// Two checkouts running at once must not fight over Vitest's fixed default
// port, so each checkout gets its own in 41000-48999. Vitest still moves to
// the next free port when two runs share a checkout.
const checkoutPort =
  41_000 + (createHash("sha256").update(root).digest().readUInt32BE(0) % 8000);

// Vitest mocks modules with Playwright routes: each file's `vi.mock` turns
// Chromium's request interception on, and its cleanup turns it off again.
// With that switching, a page's module requests sometimes stayed pending
// forever and the run hung on the next file's import (#1241). A route that
// lasts the whole context keeps interception on; mock routes, added later,
// still answer first.
const chromium = playwright({
  launchOptions: {
    executablePath: process.env.DX_TEST_CHROMIUM || undefined,
    // Tests must not reach the network; only the test server resolves.
    args: [
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    ],
  },
});
const createProvider = chromium.providerFactory;
chromium.providerFactory = (project) => {
  const provider = createProvider(project) as ReturnType<
    typeof createProvider
  > & {
    createContext?: (...args: unknown[]) => Promise<BrowserContext>;
  };
  const createContext = provider.createContext?.bind(provider);
  if (createContext === undefined)
    throw new Error(
      "@vitest/browser-playwright no longer has createContext; move the always-on route in vitest.browser.config.ts.",
    );
  const routed = new WeakSet<BrowserContext>();
  provider.createContext = async (...args) => {
    const context = await createContext(...args);
    if (!routed.has(context)) {
      routed.add(context);
      await context.route(
        () => true,
        (route) => route.continue(),
      );
    }
    return context;
  };
  return provider;
};

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
      provider: chromium,
      instances: [{ browser: "chromium" }],
    },
  },
});
