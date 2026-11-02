import { env } from "cloudflare:test";
import { ThreadId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import {
  authorizeActiveThread,
  commandEnvironmentRevision,
} from "../../src/execution/command-preflight.js";
import type { Bindings } from "../../src/http/types.js";
import { muteSpanLogRecords } from "../../src/observability/tracing.js";
import {
  executionEnvironmentRevisionsEqual,
  resolveExecutionEnvironmentRevision,
} from "../../src/settings/environment-variables/execution.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { countD1Calls } from "./d1-call-counter.js";

/**
 * What every agent command checks before it runs (#1493): that its Thread is
 * still active, and whether the environment changed. From an APAC agent a
 * D1 round trip costs about 230 ms, so both take one round trip together,
 * and the environment check reuses the revision the authorization read.
 * An archived Thread still runs no command, and a changed environment
 * variable still reaches the next command.
 */

muteSpanLogRecords();

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "command-preflight-d1-secret-0000000000",
};
const projectId = "prj_55555555-5555-4555-8555-555555555493";
const threadId = Schema.decodeSync(ThreadId)(
  "thr_55555555-5555-4555-8555-555555555493",
);

describe("agent command preflight in workerd with real D1", () => {
  it("authorizes and reads the revision in one round trip, and keeps both guarantees", async () => {
    const email = `command-preflight-${crypto.randomUUID()}@example.com`;
    const signup = await app.request(
      "/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "cf-connecting-ip": "203.0.113.93",
        },
        body: JSON.stringify({
          name: "Synthetic Owner",
          email,
          password: "command-preflight-password-123",
        }),
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
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        projectId,
        ownerId,
        "Preflight Project",
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
    const counter = countD1Calls(env.DB);
    const preflight = {
      authorize: () => authorizeActiveThread(counter.db, threadId),
      revision: () =>
        commandEnvironmentRevision({ ...bindings, DB: counter.db }, threadId),
    };
    const standalone = () =>
      Effect.runPromise(
        resolveExecutionEnvironmentRevision(bindings, threadId),
      );

    // One round trip authorizes the command and reads its revision; the
    // environment check that follows reads nothing more.
    counter.reset();
    await preflight.authorize();
    const first = await preflight.revision();
    expect(counter.calls.length).toBe(1);
    expect(executionEnvironmentRevisionsEqual(first, await standalone())).toBe(
      true,
    );

    // A revision is handed over once: a second check reads its own.
    counter.reset();
    await preflight.revision();
    expect(counter.calls.length).toBe(1);

    // A changed environment variable reaches the next command.
    expect(
      (
        await app.request(
          "/v1/settings/personal/environment-variables",
          {
            method: "POST",
            headers: {
              cookie,
              origin,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              scope: "personal",
              name: "CHANGED",
              kind: "variable",
              value: "next",
            }),
          },
          bindings,
        )
      ).status,
    ).toBe(201);
    await preflight.authorize();
    const next = await preflight.revision();
    expect(executionEnvironmentRevisionsEqual(next, first)).toBe(false);
    expect(executionEnvironmentRevisionsEqual(next, await standalone())).toBe(
      true,
    );

    // An archived Thread runs no command, and leaves no revision behind.
    await preflight.authorize();
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    await expect(preflight.authorize()).rejects.toThrow(
      "Thread is not active.",
    );
    counter.reset();
    await preflight.revision();
    expect(counter.calls.length).toBe(1);
  });
});
