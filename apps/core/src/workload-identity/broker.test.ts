import type { IssueWorkloadIdentityRequest } from "@dx/api";
import {
  WorkloadIdentityUnauthorized,
  WorkloadIdentityUnavailable,
} from "@dx/domain";
import {
  createLocalJWKSet,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../http/types.js";
import { workloadIdentityLogger } from "../logging.js";
import {
  makeWorkloadIdentityBroker,
  type ResidentWorkloadIdentityAuthority,
} from "./broker.js";

const issuer = "https://identity.example/api/workload-identity";
const audience = "https://cloud.example/workloads";
const kid = "signing-key-01";
const now = Date.UTC(2026, 8, 4, 12, 0, 0);
let signingKeys: string;
let mismatchedKeys: string;
let rotatedKeys: string;

beforeAll(async () => {
  const primary = await generateKeyPair("RS256", { extractable: true });
  const alternate = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = {
    ...(await exportJWK(primary.publicKey)),
    use: "sig",
    alg: "RS256",
    kid,
  };
  signingKeys = JSON.stringify({
    version: 1,
    activeKid: kid,
    keys: [
      {
        kid,
        publicJwk,
        privateKeyPkcs8: await exportPKCS8(primary.privateKey),
      },
    ],
  });
  mismatchedKeys = JSON.stringify({
    version: 1,
    activeKid: kid,
    keys: [
      {
        kid,
        publicJwk,
        privateKeyPkcs8: await exportPKCS8(alternate.privateKey),
      },
    ],
  });
  rotatedKeys = JSON.stringify({
    version: 1,
    activeKid: kid,
    keys: [
      {
        kid: "retiring-key-01",
        publicJwk: {
          ...(await exportJWK(alternate.publicKey)),
          use: "sig",
          alg: "RS256",
          kid: "retiring-key-01",
        },
      },
      {
        kid,
        publicJwk,
        privateKeyPkcs8: await exportPKCS8(primary.privateKey),
      },
    ],
  });
});

type StatementCall = { sql: string; binds: unknown[] };

interface AuthorityTestRow {
  readonly user_id: string;
  readonly project_id: string;
  readonly workspace_id: string | null;
  readonly thread_id: string;
  readonly runtime_id: string;
}

const authorityRow: AuthorityTestRow = {
  user_id: "user-secret-17",
  project_id: "project-secret-29",
  workspace_id: "org-secret-41",
  thread_id: "thread-secret-53",
  runtime_id: "sandbox-secret-67",
};

const fakeDb = (
  options: { rows?: readonly AuthorityTestRow[]; issuedChanges?: number } = {},
) => {
  const calls: StatementCall[] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, binds: [] as unknown[] };
      calls.push(call);
      return {
        bind(...binds: unknown[]) {
          call.binds = binds;
          return this;
        },
        async all() {
          return { results: options.rows ?? [authorityRow] };
        },
        async run() {
          return {
            meta: {
              changes: sql.includes("SELECT ?")
                ? (options.issuedChanges ?? 1)
                : 1,
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, calls };
};

const bindings = (db: D1Database, keys = signingKeys): Bindings => ({
  DB: db,
  DX_ENV: "production",
  DX_WORKLOAD_IDENTITY_ISSUER: issuer,
  DX_WORKLOAD_IDENTITY_SIGNING_KEYS: keys,
});

const resident = (
  overrides: Partial<ResidentWorkloadIdentityAuthority> = {},
): ResidentWorkloadIdentityAuthority => ({
  threadId: "thread-secret-53" as ResidentWorkloadIdentityAuthority["threadId"],
  runtimeProvider: "e2b",
  runtimeAssurance: "dx_provider_attested_v1",
  isCurrent: () => true,
  ...overrides,
});

const request = (
  ttlSeconds?: 60 | 300 | 3_600,
): IssueWorkloadIdentityRequest => ({
  audience,
  ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
});

const broker = (beforeAudit?: () => Promise<void>) =>
  makeWorkloadIdentityBroker({
    now: () => now,
    randomBytes: (length) => new Uint8Array(length).fill(7),
    randomUuid: () => "audit-id-not-a-token-jti",
    ...(beforeAudit === undefined ? {} : { beforeAudit }),
  });

describe("workload identity broker", () => {
  it.each([
    ["default", undefined, 300],
    ["minimum", 60, 60],
    ["maximum", 3_600, 3_600],
  ] as const)(
    "issues an RS256 token with the %s TTL",
    async (_label, ttl, expectedTtl) => {
      const { db, calls } = fakeDb();
      const service = broker();
      const result = await service.issue(
        bindings(db),
        resident(),
        request(ttl),
      );
      const jwks = service.jwks(bindings(db));
      const verified = await jwtVerify(
        result.token,
        createLocalJWKSet({ keys: [...jwks.keys] }),
        {
          issuer,
          audience,
          algorithms: ["RS256"],
          typ: "JWT",
          currentDate: new Date(now),
        },
      );

      expect(verified.protectedHeader).toEqual({
        alg: "RS256",
        kid,
        typ: "JWT",
      });
      expect(verified.payload).toMatchObject({
        iss: issuer,
        aud: audience,
        iat: now / 1_000,
        exp: now / 1_000 + expectedTtl,
        token_use: "dx_workload_identity_v1",
        runtime_assurance: "dx_provider_attested_v1",
        user_id: authorityRow.user_id,
        project_id: authorityRow.project_id,
        workspace_id: authorityRow.workspace_id,
        thread_id: authorityRow.thread_id,
      });
      expect(verified.payload.jti).toBe("BwcHBwcHBwcHBwcHBwcHBw");
      expect(result.expiresAt).toBe(now / 1_000 + expectedTtl);
      expect(calls[1]?.binds.slice(10, 13)).toEqual([
        ttl ?? null,
        expectedTtl,
        result.expiresAt,
      ]);
    },
  );

  it("derives a stable bounded subject without embedding authority IDs", async () => {
    const first = await broker().issue(
      bindings(fakeDb().db),
      resident(),
      request(),
    );
    const second = await broker().issue(
      bindings(fakeDb().db),
      resident(),
      request(),
    );
    const payload = (
      await jwtVerify(
        first.token,
        createLocalJWKSet({
          keys: [...broker().jwks(bindings(fakeDb().db)).keys],
        }),
        { currentDate: new Date(now) },
      )
    ).payload;
    const secondPayload = (
      await jwtVerify(
        second.token,
        createLocalJWKSet({
          keys: [...broker().jwks(bindings(fakeDb().db)).keys],
        }),
        { currentDate: new Date(now) },
      )
    ).payload;

    expect(payload.sub).toBe(secondPayload.sub);
    expect(payload.sub?.length).toBeLessThan(256);
    for (const raw of Object.values(authorityRow))
      expect(payload.sub).not.toContain(raw);
  });

  it("omits workspace identity for a personal Project", async () => {
    const { db } = fakeDb({
      rows: [{ ...authorityRow, workspace_id: null }],
    });
    const issued = await broker().issue(bindings(db), resident(), request());
    const payload = (
      await jwtVerify(
        issued.token,
        createLocalJWKSet({ keys: [...broker().jwks(bindings(db)).keys] }),
        { currentDate: new Date(now) },
      )
    ).payload;

    expect(payload.workspace_id).toBeUndefined();
    expect(payload.sub).toMatch(/^dx:wid:v1:u:/);
  });

  it("publishes retiring public keys while signing with only the active key", async () => {
    const { db } = fakeDb();
    const configured = bindings(db, rotatedKeys);
    const service = broker();
    const issued = await service.issue(configured, resident(), request());
    const jwks = service.jwks(configured);
    const verified = await jwtVerify(
      issued.token,
      createLocalJWKSet({ keys: [...jwks.keys] }),
      {
        currentDate: new Date(now),
      },
    );

    expect(jwks.keys.map(({ kid: keyId }) => keyId)).toEqual([
      "retiring-key-01",
      kid,
    ]);
    expect(verified.protectedHeader.kid).toBe(kid);
  });

  it("requires provider attestation when the audience policy says so", async () => {
    const { db, calls } = fakeDb();
    const configured = {
      ...bindings(db),
      DX_WORKLOAD_IDENTITY_AUDIENCE_POLICIES: JSON.stringify({
        version: 1,
        policies: [
          { audience, minimumRuntimeAssurance: "dx_provider_attested_v1" },
        ],
      }),
    };
    await expect(
      broker().issue(
        configured,
        resident({ runtimeAssurance: "dx_dxd_channel_v1" }),
        request(),
      ),
    ).rejects.toBeInstanceOf(WorkloadIdentityUnauthorized);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.binds.slice(-3)).toEqual(["denied", "authority", 0]);
  });

  it.each([
    ["inactive or deleted authority", []],
    ["revoked organization authority", []],
    ["revoked organization member authority", []],
    ["ambiguous thread authority", [authorityRow, authorityRow]],
  ] as const)(
    "denies an %s represented by the authority query result",
    async (_label, rows) => {
      const { db, calls } = fakeDb({ rows });
      await expect(
        broker().issue(bindings(db), resident(), request()),
      ).rejects.toBeInstanceOf(WorkloadIdentityUnauthorized);
      expect(calls[0]?.sql).toContain("thread.lifecycle_state = 'active'");
      expect(calls[0]?.sql).toContain("organization.lifecycleState = 'active'");
      expect(calls[0]?.sql).toContain("member.userId = thread.owner_user_id");
    },
  );

  it.each([
    [
      "local",
      "thread-secret-53",
      ["local", "thread-secret-53", "local", "local"],
    ],
    ["e2b", "sandbox-secret-67", ["e2b", "thread-secret-53", "e2b", "e2b"]],
  ] as const)(
    "uses exact %s authority and audit bind ordering",
    async (provider, runtimeId, authorityBinds) => {
      const { db, calls } = fakeDb({
        rows: [{ ...authorityRow, runtime_id: runtimeId }],
      });
      await broker().issue(
        bindings(db),
        resident({ runtimeProvider: provider }),
        request(60),
      );
      expect(calls[0]?.binds).toEqual(authorityBinds);
      expect(calls[1]?.binds).toEqual([
        "wid_audit-id-not-a-token-jti",
        "2026-09-04T12:00:00.000Z",
        authorityRow.user_id,
        authorityRow.project_id,
        authorityRow.workspace_id,
        authorityRow.thread_id,
        provider,
        expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        "dx_provider_attested_v1",
        audience,
        60,
        60,
        now / 1_000 + 60,
        kid,
        0,
        authorityRow.thread_id,
        authorityRow.user_id,
        authorityRow.project_id,
        authorityRow.workspace_id,
        provider,
        runtimeId,
        provider,
        runtimeId,
      ]);
    },
  );

  it.each([
    ["malformed", "not-json"],
    ["mismatched", () => mismatchedKeys],
  ])("fails closed for %s signing configuration", async (_label, value) => {
    const { db, calls } = fakeDb();
    await expect(
      broker().issue(
        bindings(db, typeof value === "function" ? value() : value),
        resident(),
        request(),
      ),
    ).rejects.toBeInstanceOf(WorkloadIdentityUnavailable);
    expect(calls.at(-1)?.binds.slice(-3)).toEqual([
      "error",
      "configuration",
      0,
    ]);
  });

  it("rechecks resident authority after the pre-audit race window", async () => {
    let current = true;
    const { db, calls } = fakeDb();
    await expect(
      broker(async () => {
        current = false;
      }).issue(bindings(db), resident({ isCurrent: () => current }), request()),
    ).rejects.toBeInstanceOf(WorkloadIdentityUnauthorized);
    expect(calls.some(({ sql }) => sql.includes("SELECT ?"))).toBe(false);
    expect(calls.at(-1)?.binds.slice(-3)).toEqual(["denied", "authority", 0]);
  });

  it("denies issuance when the final conditional insert changes no rows", async () => {
    const { db, calls } = fakeDb({ issuedChanges: 0 });
    await expect(
      broker().issue(bindings(db), resident(), request()),
    ).rejects.toBeInstanceOf(WorkloadIdentityUnauthorized);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.binds.slice(-3)).toEqual(["denied", "authority", 0]);
  });

  it("keeps token, JTI, raw runtime ID, and signer detail out of audit and logs", async () => {
    const info = vi
      .spyOn(workloadIdentityLogger, "info")
      .mockImplementation(() => undefined);
    const { db, calls } = fakeDb();
    const result = await broker().issue(bindings(db), resident(), request());
    // The final binds use the runtime ID only to revalidate authority. It is not
    // among the values selected into the audit row.
    const serialized = JSON.stringify({
      auditValues: calls[1]?.binds.slice(0, 15),
      logs: info.mock.calls,
    });
    expect(serialized).not.toContain(result.token);
    expect(serialized).not.toContain("BwcHBwcHBwcHBwcHBwcHBw");
    expect(serialized).not.toContain(authorityRow.runtime_id);

    const failed = fakeDb();
    await expect(
      broker().issue(
        bindings(failed.db, "private signer detail"),
        resident(),
        request(),
      ),
    ).rejects.toBeInstanceOf(WorkloadIdentityUnavailable);
    expect(
      JSON.stringify({ calls: failed.calls, logs: info.mock.calls }),
    ).not.toContain("private signer detail");
    info.mockRestore();
  });
});
