import { env } from "cloudflare:test";
import { Effect, Exit, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { muteSpanLogRecords } from "../../src/observability/tracing.js";
import {
  executionEnvironmentRevisionsEqual,
  resolveExecutionEnvironment,
  resolveExecutionEnvironmentRevision,
} from "../../src/settings/environment-variables/execution.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { countD1Calls, summarizeD1Calls } from "./d1-call-counter.js";

/**
 * D1 round trips for what an execution receives (#1482). A Thread's Terminal
 * wake and every agent start read it, from a Durable Object a continent away
 * from D1 for most people, so each sequential round trip costs about 230 ms.
 * Both reads take exactly one, however many scopes hold variables, and still
 * resolve the same values with the same precedence.
 */

muteSpanLogRecords();

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "execution-environment-d1-secret-00000",
};
const password = "execution-environment-password-123";
const projectId = "prj_44444444-4444-4444-8444-444444444482";
const threadId = "thr_44444444-4444-4444-8444-444444444482";

const request = (path: string, cookie: string, body: unknown) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings,
  );

const values = (snapshot: {
  readonly values: ReadonlyArray<{
    readonly name: string;
    readonly value: Redacted.Redacted<string>;
  }>;
}) =>
  Object.fromEntries(
    snapshot.values.map(({ name, value }) => [name, Redacted.value(value)]),
  );

describe("execution environment reads in workerd with real D1", () => {
  it("resolves every scope with its precedence in one round trip", async () => {
    const email = `execution-environment-${crypto.randomUUID()}@example.com`;
    const signup = await app.request(
      "/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "cf-connecting-ip": "203.0.113.82",
        },
        body: JSON.stringify({ name: "Synthetic Owner", email, password }),
      },
      bindings,
    );
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const ownerId = await env.DB.prepare(
      'SELECT id FROM "user" WHERE email = ?',
    )
      .bind(email)
      .first<string>("id");
    if (ownerId === null) throw new Error("Expected owner identity.");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      ).bind("execution-workspace", "Execution Team", "execution-team", 1),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
      ).bind("execution-member", "execution-workspace", ownerId, "owner", 1),
      env.DB.prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        projectId,
        ownerId,
        "Execution Project",
        "2026-11-02T00:00:00.000Z",
        "2026-11-02T00:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        threadId,
        projectId,
        ownerId,
        "2026-11-02T00:00:00.000Z",
        "2026-11-02T00:00:00.000Z",
      ),
    ]);

    // SHARED is set in every scope: personal wins, then project, then
    // workspace. Each scope also holds a name only it sets.
    const personal = "/v1/settings/personal/environment-variables";
    const workspace =
      "/v1/settings/workspaces/execution-team/environment-variables";
    const created = [
      [workspace, { scope: "workspace", name: "SHARED", value: "workspace" }],
      [workspace, { scope: "workspace", name: "WORKSPACE_ONLY", value: "w" }],
      [
        `${personal}?scope=project&projectId=${projectId}`,
        { scope: "project", projectId, name: "SHARED", value: "project" },
      ],
      [
        `${personal}?scope=project&projectId=${projectId}`,
        { scope: "project", projectId, name: "PROJECT_ONLY", value: "p" },
      ],
      [personal, { scope: "personal", name: "SHARED", value: "personal" }],
      [personal, { scope: "personal", name: "PERSONAL_ONLY", value: "me" }],
    ] as const;
    for (const [path, body] of created)
      expect(
        (await request(path, cookie, { ...body, kind: "variable" })).status,
        `${body.scope} ${body.name}`,
      ).toBe(201);

    const counter = countD1Calls(env.DB);
    const counted = { ...bindings, DB: counter.db };
    counter.reset();
    const snapshot = await Effect.runPromise(
      resolveExecutionEnvironment(counted, threadId),
    );
    const environmentCalls = summarizeD1Calls(counter.calls);
    counter.reset();
    const revision = await Effect.runPromise(
      resolveExecutionEnvironmentRevision(counted, threadId),
    );
    const revisionCalls = summarizeD1Calls(counter.calls);

    expect(values(snapshot)).toEqual({
      PERSONAL_ONLY: "me",
      PROJECT_ONLY: "p",
      SHARED: "personal",
      WORKSPACE_ONLY: "w",
    });
    expect(environmentCalls.roundTrips).toBe(1);
    expect(revisionCalls.roundTrips).toBe(1);
    // Read in one transaction, the values carry their own revision, which
    // the standalone revision read sees too while nothing changes.
    expect(
      executionEnvironmentRevisionsEqual(snapshot.revision, revision),
    ).toBe(true);
    expect(snapshot.revision.workspace.targetId).toBe("execution-workspace");

    // A change moves the revision the next read reports.
    expect(
      (
        await request(personal, cookie, {
          scope: "personal",
          name: "LATER",
          kind: "variable",
          value: "later",
        })
      ).status,
    ).toBe(201);
    const later = await Effect.runPromise(
      resolveExecutionEnvironment(bindings, threadId),
    );
    expect(values(later).LATER).toBe("later");
    expect(
      executionEnvironmentRevisionsEqual(later.revision, snapshot.revision),
    ).toBe(false);

    // A Thread that does not exist has no environment, as before.
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          resolveExecutionEnvironment(
            bindings,
            "thr_44444444-4444-4444-8444-444444444483",
          ),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          resolveExecutionEnvironmentRevision(
            bindings,
            "thr_44444444-4444-4444-8444-444444444483",
          ),
        ),
      ),
    ).toBe(true);
  });
});
