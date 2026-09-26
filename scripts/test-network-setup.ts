import { HttpResponse, http, passthrough } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

const network = setupServer(
  http.all("*", ({ request }) => {
    const { hostname } = new URL(request.url);
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    ) {
      return passthrough();
    }

    return new HttpResponse(null, {
      status: 599,
      headers: { "x-msw-blocked-request": request.url },
    });
  }),
);

beforeAll(() => network.listen({ onUnhandledRequest: "error" }));
afterEach(() => network.resetHandlers());
afterAll(() => network.close());
