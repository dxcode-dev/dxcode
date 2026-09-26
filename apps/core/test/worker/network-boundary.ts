import { setupNetwork } from "@msw/cloudflare";
import { HttpNetworkFrame } from "msw/experimental";
import { afterAll, afterEach, beforeAll } from "vitest";

export const network = setupNetwork();

network.configure({
  async onUnhandledFrame({ frame, defaults }) {
    if (frame instanceof HttpNetworkFrame) {
      const { hostname } = new URL(frame.data.request.url);
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]"
      ) {
        return;
      }

      await defaults.error();
      throw new Response(null, {
        status: 599,
        headers: { "x-msw-blocked-request": frame.data.request.url },
      });
    }

    await defaults.error();
    throw new Error(`MSW blocked unmatched ${frame.protocol} frame`);
  },
});

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
