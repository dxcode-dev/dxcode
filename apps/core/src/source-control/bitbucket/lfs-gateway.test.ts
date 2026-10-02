import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../http/types.js";
import type { BitbucketGitLease } from "./git-gateway.js";
import { handleBitbucketLfs } from "./lfs-gateway.js";

const oid = "a".repeat(64);
const token = "oauth-secret";
const leaseToken = "guest-lease";
const gateway = "https://dx.example/api/source/bitbucket/git/space/repo.git";
const bindings: Bindings = {
  DX_CONFIG_ENCRYPTION_KEYS: JSON.stringify({
    activeVersion: 1,
    keys: { 1: btoa("01234567890123456789012345678901") },
  }),
};
const lease = (
  overrides: Partial<BitbucketGitLease> = {},
): BitbucketGitLease => ({
  id_hash: "lease-one",
  thread_id: "thread",
  actor_user_id: "user",
  connection_id: "connection",
  authorization_epoch: 1,
  operation: "fetch",
  ...overrides,
});

const database = (failBatch = false) => {
  const rows = new Map<string, Record<string, unknown>>();
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      run: async () => {
        if (sql.startsWith("INSERT"))
          rows.set(values[0] as string, {
            id: values[0],
            lease_id_hash: values[1],
            method: values[2],
            oid: values[3],
            size: values[4],
            envelope_json: values[5],
          });
        return { success: true };
      },
      first: async () => {
        const row = rows.get(values[0] as string);
        return row?.lease_id_hash === values[1] && row?.method === values[2]
          ? row
          : null;
      },
    }),
  }));
  const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
    if (failBatch) throw new Error("batch failed");
    return Promise.all(statements.map((statement) => statement.run()));
  });
  return { db: { prepare, batch } as unknown as D1Database, rows, batch };
};
const batchRequest = (body: unknown) =>
  new Request(`${gateway}/info/lfs/objects/batch`, {
    method: "POST",
    headers: { "content-type": "application/vnd.git-lfs+json" },
    body: JSON.stringify(body),
  });
const invoke = (options: {
  request: Request;
  suffix?: string;
  currentLease?: BitbucketGitLease;
  repositoryName?: string;
  db: D1Database;
  fetcher: typeof fetch;
}) =>
  handleBitbucketLfs({
    request: options.request,
    suffix: options.suffix ?? "/info/lfs/objects/batch",
    gatewayRepositoryUrl: gateway,
    lease: options.currentLease ?? lease(),
    repositoryName: options.repositoryName ?? "space/repo",
    leaseToken,
    accessToken: token,
    db: options.db,
    bindings,
    fetcher: options.fetcher,
  });

describe("Bitbucket LFS gateway", () => {
  it("rewrites download actions, stores encrypted credentials, and streams the object", async () => {
    const { db, rows } = database();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          transfer: "basic",
          objects: [
            {
              oid,
              size: 3,
              actions: {
                download: {
                  href: `https://api.media.atlassian.com/file/${oid}/binary`,
                  header: { Authorization: "Bearer signed-secret" },
                },
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response("abc", {
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    const response = await invoke({
      db,
      fetcher,
      request: batchRequest({
        operation: "download",
        transfers: ["basic"],
        objects: [{ oid, size: 3 }],
      }),
    });
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain("signed-secret");
    expect(text).not.toContain("api.media.atlassian.com");
    const action = JSON.parse(text).objects[0].actions.download;
    expect(action.header.Authorization).toBe(
      `Basic ${btoa(`dx:${leaseToken}`)}`,
    );
    expect([...rows.values()][0]?.envelope_json).not.toContain("signed-secret");

    const suffix = new URL(action.href).pathname.slice(
      new URL(gateway).pathname.length,
    );
    // The same lease cannot replay the action under another repository.
    await expect(
      invoke({
        db,
        fetcher,
        repositoryName: "space/other",
        request: new Request(action.href),
        suffix,
      }),
    ).rejects.toBeDefined();
    const objectResponse = await invoke({
      db,
      fetcher,
      request: new Request(action.href),
      suffix,
    });
    expect(await objectResponse.text()).toBe("abc");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `https://api.media.atlassian.com/file/${oid}/binary`,
    );
    expect(
      new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer signed-secret");
  });

  it("proxies bounded upload and verify actions without forwarding browser headers", async () => {
    const { db } = database();
    const push = lease({ operation: "contents-push" });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          objects: [
            {
              oid,
              size: 3,
              actions: {
                upload: {
                  href: "https://api.media.atlassian.com/upload",
                  header: { "X-Signed": "yes" },
                },
                verify: {
                  href: "https://bitbucket.org/verify",
                  header: { Authorization: "Bearer narrow" },
                },
              },
            },
          ],
        }),
      )
      .mockResolvedValue(new Response(null, { status: 200 }));
    const batch = await invoke({
      db,
      fetcher,
      currentLease: push,
      request: batchRequest({
        operation: "upload",
        ref: { name: "refs/heads/feature" },
        objects: [{ oid, size: 3 }],
      }),
    });
    const actions = ((await batch.json()) as any).objects[0].actions;
    await invoke({
      db,
      fetcher,
      currentLease: push,
      suffix: new URL(actions.upload.href).pathname.slice(
        new URL(gateway).pathname.length,
      ),
      request: new Request(actions.upload.href, {
        method: "PUT",
        body: "abc",
        headers: { "content-length": "3", cookie: "do-not-forward" },
      }),
    });
    await invoke({
      db,
      fetcher,
      currentLease: push,
      suffix: new URL(actions.verify.href).pathname.slice(
        new URL(gateway).pathname.length,
      ),
      request: new Request(actions.verify.href, {
        method: "POST",
        body: JSON.stringify({ href: "https://evil.example" }),
      }),
    });
    const uploadHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(uploadHeaders.get("x-signed")).toBe("yes");
    expect(uploadHeaders.has("cookie")).toBe(false);
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ oid, size: 3 }),
    );
  });

  it("denies cross-lease object access, read uploads, and wrong upload refs", async () => {
    const { db } = database();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        objects: [
          {
            oid,
            size: 3,
            actions: { download: { href: "https://bitbucket.org/object" } },
          },
        ],
      }),
    );
    const response = await invoke({
      db,
      fetcher,
      request: batchRequest({
        operation: "download",
        objects: [{ oid, size: 3 }],
      }),
    });
    const href = ((await response.json()) as any).objects[0].actions.download
      .href;
    await expect(
      invoke({
        db,
        fetcher,
        currentLease: lease({ id_hash: "lease-two" }),
        suffix: new URL(href).pathname.slice(new URL(gateway).pathname.length),
        request: new Request(href),
      }),
    ).rejects.toBeDefined();
    await expect(
      invoke({
        db,
        fetcher,
        request: batchRequest({
          operation: "upload",
          ref: { name: "refs/heads/main" },
          objects: [{ oid, size: 3 }],
        }),
      }),
    ).rejects.toBeDefined();
    await expect(
      invoke({
        db,
        fetcher,
        currentLease: lease({ operation: "contents-push" }),
        request: batchRequest({
          operation: "upload",
          ref: { name: "refs/heads/main" },
          objects: [{ oid, size: 3 }],
        }),
      }),
    ).rejects.toBeDefined();
  });

  it("fails closed for malicious action URLs and malformed or oversized batches", async () => {
    const { db } = database();
    const malicious = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        objects: [
          {
            oid,
            size: 3,
            actions: { download: { href: "https://evil.example/steal" } },
          },
        ],
      }),
    );
    await expect(
      invoke({
        db,
        fetcher: malicious,
        request: batchRequest({
          operation: "download",
          objects: [{ oid, size: 3 }],
        }),
      }),
    ).rejects.toBeDefined();
    const unused = vi.fn<typeof fetch>();
    await expect(
      invoke({
        db,
        fetcher: unused,
        request: batchRequest({
          operation: "download",
          objects: [{ oid: "bad", size: 3 }],
        }),
      }),
    ).rejects.toBeDefined();
    await expect(
      invoke({
        db,
        fetcher: unused,
        request: batchRequest({
          operation: "download",
          objects: Array.from({ length: 101 }, () => ({ oid, size: 1 })),
        }),
      }),
    ).rejects.toBeDefined();
    expect(unused).not.toHaveBeenCalled();
  });

  it("stores actions atomically only after every provider action is valid", async () => {
    const firstOid = "b".repeat(64);
    const { db, rows, batch } = database();
    const invalidLaterAction = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        objects: [
          {
            oid: firstOid,
            size: 1,
            actions: { download: { href: "https://bitbucket.org/first" } },
          },
          {
            oid,
            size: 3,
            actions: { download: { href: "https://evil.example/later" } },
          },
        ],
      }),
    );
    await expect(
      invoke({
        db,
        fetcher: invalidLaterAction,
        request: batchRequest({
          operation: "download",
          objects: [
            { oid: firstOid, size: 1 },
            { oid, size: 3 },
          ],
        }),
      }),
    ).rejects.toBeDefined();
    expect(batch).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);

    const failed = database(true);
    await expect(
      invoke({
        db: failed.db,
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            objects: [
              {
                oid,
                size: 3,
                actions: {
                  download: { href: "https://bitbucket.org/object" },
                },
              },
            ],
          }),
        ),
        request: batchRequest({
          operation: "download",
          objects: [{ oid, size: 3 }],
        }),
      }),
    ).rejects.toThrow("batch failed");
    expect(failed.batch).toHaveBeenCalledTimes(1);
    expect(failed.rows.size).toBe(0);
  });
});
