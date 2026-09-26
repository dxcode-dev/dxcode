import { expect, it } from "vitest";

it("blocks unmatched external network requests", async () => {
  const response = await fetch("https://network.invalid/unmatched");

  expect(response.status).toBe(599);
  expect(response.headers.get("x-msw-blocked-request")).toBe(
    "https://network.invalid/unmatched",
  );
});

it("passes unmatched loopback requests through", async () => {
  const error = await fetch("http://127.0.0.1:1/unmatched").catch(
    (cause: unknown) => cause,
  );

  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty("message", "Network connection lost.");
});
