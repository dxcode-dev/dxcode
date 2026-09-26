import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { createDxSubscriptionCloudflareBinding } from "./invocation.js";

const threadId = "thr_00000000-0000-4000-8000-000000000081";
const database = {
  prepare: vi.fn(() => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => ({
        thread_id: threadId,
        owner_user_id: "subscription-owner",
        connection_id: "subscription-connection",
        model_id: "gpt-5.6-luna",
      })),
    })),
  })),
} as unknown as D1Database;

describe("subscription Cloudflare binding", () => {
  it("derives the owner shard from the trusted Flue Thread identity", async () => {
    const idFromName = vi.fn((name: string) => ({ name }) as DurableObjectId);
    let invocation: Request | undefined;
    const stub = {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        invocation = new Request(input, init);
        return Response.json({ accepted: true });
      }),
    } as unknown as DurableObjectStub;
    const get = vi.fn(() => stub);
    const binding = createDxSubscriptionCloudflareBinding({
      db: database,
      namespace: { idFromName, get } as unknown as DurableObjectNamespace,
      identity: () => ({ name: threadId }),
    });

    const response = await binding.run("gpt-5.6-luna", {
      input: [{ role: "user", content: "hello" }],
    });

    expect(response).toBeInstanceOf(Response);
    expect(idFromName).toHaveBeenCalledWith(
      expect.stringMatching(/^subscription-v1-[0-9a-f]{64}$/),
    );
    expect(get).toHaveBeenCalledOnce();
    expect(invocation?.url).toBe("https://dx-subscription.invalid/invoke");
    const body = await invocation?.text();
    expect(JSON.parse(body ?? "null")).toMatchObject({
      threadId,
      ownerUserId: "subscription-owner",
      connectionId: "subscription-connection",
      modelId: "gpt-5.6-luna",
    });
    expect(body).not.toMatch(/accessToken|refreshToken|credentialEnvelope/);
  });
});
