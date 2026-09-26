import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("ThreadExecutionObject worker wiring", () => {
  it("routes a namespace stub to the object and rejects requests without internal authority", async () => {
    const stub = env.THREAD_EXECUTION.getByName(
      "thr_00000000-0000-4000-8000-000000000186",
    );
    expect((await stub.fetch("https://terminal.invalid/")).status).toBe(404);
    await runInDurableObject(stub, async (instance) => {
      const response = await instance.fetch(
        new Request("https://terminal.invalid/", {
          headers: { upgrade: "websocket" },
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  it("rejects the removed provider-direct Terminal route", async () => {
    const stub = env.THREAD_EXECUTION.getByName(
      "thr_00000000-0000-4000-8000-000000000186",
    );

    await runInDurableObject(stub, async (instance) => {
      const response = await instance.fetch(
        new Request("https://terminal.invalid/", {
          headers: {
            upgrade: "websocket",
            "x-dx-thread-id": "thr_00000000-0000-4000-8000-000000000186",
            "x-dx-request-id": "request-terminal-object-rejection",
            "x-dx-started-at": "1787900000000",
            "x-dx-authenticated-duration": "0",
            "x-dx-authorized-duration": "1",
            "x-dx-admitted-duration": "1",
            "x-dx-terminal-route": "provider",
          },
        }),
      );
      expect(response.status).toBe(404);
      expect(response.webSocket).toBeNull();
    });
  });

  it("returns a typed content-free known outcome before daemon dispatch", async () => {
    const threadId = "thr_00000000-0000-4000-8000-000000000187";
    const stub = env.THREAD_EXECUTION.getByName(threadId);

    await runInDurableObject(stub, async (instance) => {
      const response = await instance.fetch(
        new Request("https://thread.internal/daemon/request", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dx-daemon-request": "1",
            "x-dx-thread-id": threadId,
          },
          body: JSON.stringify({
            operation: "files.read",
            path: "private-name-must-not-escape.txt",
          }),
        }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "daemon-unavailable",
        outcome: "known",
      });
    });
  });
});
