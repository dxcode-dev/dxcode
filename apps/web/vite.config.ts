import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { localAllowedHosts, localTranscriptCapture } from "./vite-local.js";

// The browser test project compiles components with these same plugins.
export const appPlugins = () => [tailwindcss(), react({ compiler: true })];

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
    plugins: [...appPlugins(), localTranscriptCapture],
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
