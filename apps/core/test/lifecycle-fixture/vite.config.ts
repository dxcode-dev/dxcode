import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    flue(),
    cloudflare({
      config: flueWorkerConfig(),
      // The lifecycle runner serves the build with `vite preview` from a
      // migrated state directory of its own.
      ...(process.env.DX_LIFECYCLE_PERSIST_TO === undefined
        ? {}
        : {
            persistState: { path: process.env.DX_LIFECYCLE_PERSIST_TO },
            inspectorPort: false,
          }),
    }),
  ],
});
