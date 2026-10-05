import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig, type Plugin } from "vite";

const alchemyLocal = process.env.DX_ALCHEMY_LOCAL === "1";
const checkoutLocal = process.env.DX_RUNTIME_MODE === "local";
const checkoutModelPreview = process.env.DX_LOCAL_MODEL_PREVIEW === "1";
const checkoutLocalVariableNames = [
  "DX_ENV",
  "DX_RUNTIME_MODE",
  "DX_AUTH_URL",
  "DX_AUTH_TRUSTED_ORIGINS",
  "DX_RUNNER_PROFILE_CATALOG",
  "DX_SOURCE_CONTROL_SCHEMA_VERSION",
  "DX_DXD_PUBLIC_URL",
  "DX_LOCAL_RUNTIME_URL",
  "DX_LOCAL_RUNTIME_TOKEN",
  "DX_INSTALLED_PLUGINS",
] as const;

const localCallbackHost = (() => {
  const value = process.env.DX_DXD_PUBLIC_URL;
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return undefined;
    return url.hostname;
  } catch {
    return undefined;
  }
})();

const workerRuntimeDependencies = [
  "@better-auth/api-key",
  "@better-auth/core",
  "@earendil-works/pi-ai/providers/all",
  "@effect/sql-d1",
  "@flue/runtime",
  "@flue/runtime/cloudflare/internal",
  "@flue/runtime/cloudflare/workers-ai",
  "@flue/runtime/internal",
  "@flue/runtime/routing",
  "@logtape/logtape",
  "@modelcontextprotocol/client",
  "@opentelemetry/api",
  "better-auth",
  "better-auth/api",
  "better-auth/cookies",
  "better-auth/plugins",
  "e2b",
  "effect",
  "effect/unstable/sql/SqlClient",
  "hono",
  "hono/route",
  "jose",
  "valibot",
  "zod",
];

const prebundleWorkerRuntime = {
  name: "dx-prebundle-worker-runtime",
  apply: "serve",
  enforce: "post",
  configEnvironment(name) {
    if (name === "client") return;
    return {
      optimizeDeps: {
        include: workerRuntimeDependencies,
      },
    };
  },
} satisfies Plugin;

const fluePlugin = flue({ canonicalFlushDelayMs: 750 });
const configureFlueWorker = flueWorkerConfig();

const ampReference = /(?:\bamp\b|onamp\.dev|amp-thread|amp-work|\.amp\/)/i;
const emittedAmpReference =
  /(?:\bAmp\b|onamp\.dev|amp-thread|amp-work|\.amp\/)/;

const publicBoundaryHygiene = (production: boolean) => {
  const sourceRoot = `${resolve(import.meta.dirname, "src")}/`;
  return {
    name: "dx-public-boundary-hygiene",
    apply: "build",
    transform(source, id) {
      if (
        !production ||
        !id.split("?", 1)[0]?.replaceAll("\\", "/").startsWith(sourceRoot)
      )
        return;
      const match = source.replace(/&amp;/gi, "").match(ampReference);
      if (match)
        this.error(`Production module contains an Amp reference: ${id}`);
    },
    generateBundle(_options, bundle) {
      if (!production) return;
      for (const output of Object.values(bundle)) {
        if (!/\.(?:css|html|js|json|map)$/.test(output.fileName)) continue;
        const content =
          output.type === "chunk" ? output.code : String(output.source);
        if (emittedAmpReference.test(content))
          this.error(
            `Production asset contains an Amp reference: ${output.fileName}`,
          );
      }
    },
  } satisfies Plugin;
};

export default defineConfig(({ mode }) => ({
  ...(localCallbackHost === undefined
    ? {}
    : { server: { allowedHosts: [localCallbackHost] } }),
  envDir: mode === "dx-production" ? false : undefined,
  define: {
    __DX_CORE_DEV_FIXTURES__: JSON.stringify(mode !== "dx-production"),
  },
  plugins: [
    publicBoundaryHygiene(mode === "dx-production"),
    fluePlugin,
    cloudflare({
      persistState: checkoutLocal
        ? { path: resolve(import.meta.dirname, "../../.dx/local/cloudflare") }
        : ".wrangler/state",
      config: (config) => {
        configureFlueWorker(config);
        if (checkoutLocal) {
          config.vars = {
            ...config.vars,
            ...Object.fromEntries(
              checkoutLocalVariableNames.map((name) => {
                const value = process.env[name];
                if (value === undefined)
                  throw new Error(`Missing local runtime binding: ${name}`);
                return [name, value];
              }),
            ),
            DX_LOCAL_MODEL_PREVIEW: checkoutModelPreview ? "1" : "0",
          };
        }
        if (alchemyLocal || (checkoutLocal && !checkoutModelPreview)) {
          delete (config as { ai?: unknown }).ai;
        }
        if (checkoutLocal && Array.isArray(config.secrets?.required)) {
          config.secrets.required = config.secrets.required.filter(
            (name) => name !== "E2B_API_KEY",
          );
        }
      },
    }),
    // Incremental discovery otherwise evaluates the generated Worker during a partial Flue graph reload.
    prebundleWorkerRuntime,
  ],
}));
