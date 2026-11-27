import { describe, expect, it } from "vitest";
import {
  clearClientDiagnostics,
  clientDiagnostics,
  observeRequest,
  recordConnectionEvent,
} from "./client-diagnostics.js";

describe("client diagnostics", () => {
  it("keeps nothing from before a sign-out", async () => {
    recordConnectionEvent("closed", "session ended");
    await observeRequest(
      "/v1/threads/thr_a?x=1",
      "GET",
      async () => new Response(null, { status: 404 }),
    );
    expect(clientDiagnostics().failedRequests).toHaveLength(1);
    expect(clientDiagnostics().connection).toHaveLength(1);

    clearClientDiagnostics();

    expect(clientDiagnostics()).toEqual({
      logs: [],
      failedRequests: [],
      connection: [],
    });
    await observeRequest(
      "/v1/threads/thr_b",
      "GET",
      async () => new Response(null, { status: 500 }),
    );
    expect(clientDiagnostics().failedRequests).toEqual([
      expect.objectContaining({ path: "/v1/threads/thr_b", status: 500 }),
    ]);
  });
});
