import { resolve } from "node:path";
import {
  VIEW_FRAME_CONTENT_SECURITY_POLICY,
  VIEW_FRAME_PATH,
  viewFrameShell,
} from "@dx/api/views/view-frame.mjs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { localAllowedHosts, localTranscriptCapture } from "./vite-local.js";

/**
 * The dx-view shell at `VIEW_FRAME_PATH`: generated from the view contract,
 * served with its own CSP by the dev and test servers, and emitted beside
 * `index.html`, where the production package's `_headers` gives it the same
 * policy.
 */
const viewFrame: Plugin = {
  name: "dx:view-frame",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== VIEW_FRAME_PATH) return next();
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader(
        "content-security-policy",
        VIEW_FRAME_CONTENT_SECURITY_POLICY,
      );
      response.end(viewFrameShell());
    });
  },
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: `${VIEW_FRAME_PATH.slice(1)}.html`,
      source: viewFrameShell(),
    });
  },
};

// The browser test project compiles components with these same plugins.
export const appPlugins = () => [
  tailwindcss(),
  react({ compiler: true }),
  viewFrame,
];

/**
 * Vite bundles each `new Worker(new URL(...))` module as an asset but leaves
 * it out of the manifest. The production package accepts only files the
 * manifest reaches, so list each worker among the assets of the chunk that
 * loads it, as Vite already does for other modules loaded by URL.
 */
const workersInManifest: Plugin = {
  name: "dx:workers-in-manifest",
  apply: "build",
  enforce: "post",
  generateBundle(_, bundle) {
    const workers = Object.values(bundle).filter(
      (output) =>
        output.type === "asset" &&
        output.fileName.endsWith(".js") &&
        output.originalFileNames.length === 0,
    );
    for (const chunk of Object.values(bundle))
      if (chunk.type === "chunk")
        for (const worker of workers)
          if (chunk.code.includes(worker.fileName))
            chunk.viteMetadata?.importedAssets.add(worker.fileName);
  },
};

export default defineConfig(({ mode }) => {
  const productionPackage = mode === "dx-production";
  const env = productionPackage ? {} : loadEnv(mode, process.cwd(), "DX_");
  const apiTarget = env.DX_WEB_API_TARGET ?? "http://localhost:5173";
  const requestOrigin = env.DX_DEV_REQUEST_ORIGIN;
  const dxEnvironment = productionPackage
    ? ""
    : (process.env.DX_ENV ?? env.DX_ENV ?? "");
  const includeGhosttyProof =
    !productionPackage && process.env.GHOSTTY_PROOF === "1";
  // A dx workspace names its deployment's Portal domain (`.ondx.dev`, or a
  // self-host's own), so the dev server answers its Portal URL there.
  const portalHostSuffix = process.env.DX_PORTAL_HOST_SUFFIX;
  const allowedHosts =
    portalHostSuffix?.startsWith(".") === true
      ? [...localAllowedHosts, portalHostSuffix]
      : localAllowedHosts;

  return {
    envDir: productionPackage ? false : undefined,
    define: {
      "import.meta.env.DX_ENV": JSON.stringify(dxEnvironment),
    },
    plugins: [...appPlugins(), localTranscriptCapture, workersInManifest],
    build: {
      manifest: true,
      // Shiki grammars (cpp, emacs-lisp) and the terminal emulator are large
      // by nature and load only when used; the warning should flag the rest.
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        input: {
          app: resolve(import.meta.dirname, "index.html"),
          ...(includeGhosttyProof
            ? {
                "ghostty-proof": resolve(
                  import.meta.dirname,
                  "ghostty-proof.html",
                ),
              }
            : {}),
        },
      },
    },
    server: {
      port: 3000,
      allowedHosts,
      proxy: {
        "/api/auth": {
          target: apiTarget,
          changeOrigin: true,
          configure(proxy) {
            if (requestOrigin === undefined) return;
            proxy.on("proxyReq", (request) => {
              request.setHeader("origin", requestOrigin);
            });
          },
        },
        "/api/invites": { target: apiTarget, changeOrigin: true },
        // The Feedback Widget's script, panel, and sign-in popup.
        // Only a same-origin request (the consent form) gets the trusted
        // origin; any other keeps its own, so Core still refuses it.
        "/api/feedback-widget": {
          target: apiTarget,
          changeOrigin: false,
          configure(proxy) {
            if (requestOrigin === undefined) return;
            proxy.on("proxyReq", (request, incoming) => {
              const origin = incoming.headers.origin;
              if (
                origin !== undefined &&
                URL.canParse(origin) &&
                new URL(origin).host === incoming.headers.host
              )
                request.setHeader("origin", requestOrigin);
            });
          },
        },
        "/v1": {
          target: apiTarget,
          changeOrigin: false,
          ws: true,
          configure(proxy) {
            if (requestOrigin === undefined) return;
            proxy.on("proxyReq", (request) => {
              request.setHeader("origin", requestOrigin);
            });
            proxy.on("proxyReqWs", (request) => {
              request.setHeader("origin", requestOrigin);
            });
          },
        },
      },
    },
  };
});
