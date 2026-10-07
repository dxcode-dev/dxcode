import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { localAllowedHosts, localTranscriptCapture } from "./vite-local.js";

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

  return {
    envDir: productionPackage ? false : undefined,
    define: {
      "import.meta.env.DX_ENV": JSON.stringify(dxEnvironment),
    },
    plugins: [tailwindcss(), react(), localTranscriptCapture],
    build: {
      manifest: true,
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
      allowedHosts: localAllowedHosts,
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
