import { ThreadId } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  verifyApiKey: vi.fn(),
  loadAuthenticationRequirements: vi.fn(),
}));

vi.mock("./better-auth.js", () => ({
  createAuth: () => ({
    api: {
      createApiKey: mocks.createApiKey,
      verifyApiKey: mocks.verifyApiKey,
    },
  }),
}));

vi.mock("./requirements.js", () => ({
  loadAuthenticationRequirements: mocks.loadAuthenticationRequirements,
}));

import {
  confirmThreadDaemonApiKey,
  mintThreadDaemonApiKey,
  revokeThreadDaemonApiKey,
  verifyThreadDaemonApiKey,
} from "./daemon-api-key.js";

const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000292",
);

const database = (
  owner: { readonly owner_user_id: string } | null = {
    owner_user_id: "owner-user",
  },
) => {
  const calls: Array<{ readonly sql: string; readonly values: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        calls.push({ sql, values });
        return sql.includes("SELECT owner_user_id") ? owner : { owned: 1 };
      },
      run: async () => {
        calls.push({ sql, values });
        return {};
      },
    }),
  }));
  return { binding: { prepare } as unknown as D1Database, calls };
};

beforeEach(() => {
  mocks.createApiKey.mockReset();
  mocks.verifyApiKey.mockReset();
  mocks.loadAuthenticationRequirements.mockReset();
  mocks.loadAuthenticationRequirements.mockReturnValue(Effect.succeed({}));
});

describe("Thread daemon API key", () => {
  it("mints one hashed-plugin credential bound to the active Thread owner", async () => {
    const db = database();
    mocks.createApiKey.mockResolvedValue({
      id: "daemon-key-id",
      key: "dxd_plaintext-key-value",
    });
    const credential = await mintThreadDaemonApiKey(
      { DB: db.binding },
      threadId,
    );
    expect(credential.id).toBe("daemon-key-id");
    expect(Redacted.value(credential.key)).toBe("dxd_plaintext-key-value");
    expect(mocks.createApiKey).toHaveBeenCalledWith({
      body: {
        configId: "daemon-keys",
        name: "Thread dxd",
        userId: "owner-user",
        metadata: { version: 1, threadId },
        permissions: {},
      },
    });
  });

  it("accepts only the dedicated key for its bound active Thread", async () => {
    const db = database();
    mocks.verifyApiKey.mockResolvedValue({
      valid: true,
      key: {
        id: "daemon-key-id",
        configId: "daemon-keys",
        referenceId: "owner-user",
        metadata: { version: 1, threadId },
      },
    });
    await expect(
      verifyThreadDaemonApiKey(
        { DB: db.binding },
        threadId,
        "Bearer dxd_plaintext-key-value",
      ),
    ).resolves.toEqual({ keyId: "daemon-key-id" });
    await expect(
      verifyThreadDaemonApiKey(
        { DB: db.binding },
        threadId,
        "Bearer dxu_not-a-daemon-key",
      ),
    ).resolves.toBeUndefined();
    expect(mocks.verifyApiKey).toHaveBeenCalledOnce();
  });

  it("confirms a key row for the active Thread owner in one read", async () => {
    const db = database();
    await expect(
      confirmThreadDaemonApiKey({ DB: db.binding }, threadId, "daemon-key-id"),
    ).resolves.toBe(true);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.values).toEqual([
      "daemon-key-id",
      "daemon-keys",
      threadId,
    ]);
    expect(db.calls[0]?.sql).toContain("threads.lifecycle_state = 'active'");
    expect(db.calls[0]?.sql).toContain(
      "threads.owner_user_id = apikey.referenceId",
    );
  });

  it("revokes only a daemon key by its opaque ID", async () => {
    const db = database();
    await revokeThreadDaemonApiKey({ DB: db.binding }, "daemon-key-id");
    expect(db.calls.at(-1)).toEqual({
      sql: "DELETE FROM apikey WHERE id = ? AND configId = ?",
      values: ["daemon-key-id", "daemon-keys"],
    });
  });
});
