// Local-only production build of the thread page stress harness (not shipped).
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { appPlugins } from "./vite.config.js";

const root = import.meta.dirname;
export default defineConfig({
  root,
  plugins: appPlugins(),
  define: { "import.meta.env.DX_ENV": JSON.stringify("") },
  build: {
    // Keep component names readable for render counting and profiles.
    minify: false,
    outDir: resolve(root, "node_modules/.stress-dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        thread: resolve(root, "thread-page-stress.html"),
      },
    },
  },
  preview: { port: 3312, host: "127.0.0.1" },
});
