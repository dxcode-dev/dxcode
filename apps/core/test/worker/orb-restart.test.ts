import { env, runInDurableObject } from "cloudflare:test";
import {
  ORB_RESTART_INTERVAL_SECONDS,
  type RestartThreadOrbResponse,
  type ThreadOrbRestartErrorResponse,
} from "@dx/api";
import {
  Principal,
  type ProjectId,
  ProjectRepository,
  ThreadId,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  type OrbRestartRelayResult,
  restartOrb,
  takeOrbRestartNote,
} from "../../src/orb-restart/execution-object.js";
import { threadOrbRestartRoutes } from "../../src/orb-restart/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { threadSharingRoutes } from "../../src/thread-sharing/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Restart Orb (#1592) in workerd with real D1 and the real Thread
 * authorization: who may restart, and what each outcome of the Thread
 * execution object answers. The object's own limit runs on a real Durable
 * Object's storage below.
 */

const owner = "restart-owner" as UserId;
const member = "restart-member" as UserId;
const outsider = "restart-outsider" as UserId;
const workspaceId = "restart-workspace";
const ownerProject = project(
  "prj_00000000-0000-4000-8000-000000001592",
  owner,
  "restart-owner-personal",
);
const restartThread = thread(
  "thr_00000000-0000-4000-8000-000000001592",
  ownerProject.id as ProjectId,
  owner,
);

/** What the Thread execution object answers, and the requests it saw. */
let objectAnswer: OrbRestartRelayResult;
const objectRequests: Request[] = [];
const executionNamespace = {
  idFromName: (name: string) => name,
  get: () => ({
    fetch: async (request: Request) => {
      objectRequests.push(request);
      return Response.json(objectAnswer);
    },
  }),
} as unknown as Bindings["THREAD_EXECUTION"];

const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "local",
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  THREAD_EXECUTION: executionNamespace,
};

/** Turns the `orb-restart` experimental feature on or off for a person. */
const setOrbRestart = (userId: UserId, enabled: boolean) =>
  env.DB.prepare(
    `INSERT INTO personal_experimental_feature_preferences (
       user_id, preferences, revision, updated_at
     ) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (user_id) DO UPDATE SET preferences = excluded.preferences`,
  )
    .bind(
      userId,
      JSON.stringify(enabled ? [{ id: "orb-restart", enabled: true }] : []),
      new Date().toISOString(),
    )
    .run();

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/threads", threadSharingRoutes);
  app.use("/threads/:threadId/orb/*", authorizeThread);
  app.route("/threads", threadOrbRestartRoutes);
  app.onError(errorHandler);
  return app;
};

const request = (
  userId: UserId,
  path: string,
  method: string,
  body?: unknown,
) =>
  createApp(userId).request(
    path,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
const restart = (userId: UserId) =>
  request(userId, `/threads/${restartThread.id}/orb/restart`, "POST");
const share = (workspaceAccess: "none" | "view" | "contribute") =>
  request(owner, `/threads/${restartThread.id}/sharing`, "PUT", {
    workspaceAccess,
  });

beforeEach(async () => {
  objectRequests.length = 0;
  objectAnswer = {
    outcome: "restarted",
    files: "kept",
    restartedAt: "2026-11-03T04:00:00.000Z",
  };
  await env.DB.batch([
    ...[owner, member, outsider].map((id) =>
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
      ).bind(id, id === owner ? "Ravi Ölçer" : id, `${id}@example.com`),
    ),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Restart Team', 'restart-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('r-owner', ?1, ?2, 'owner', 1),
         ('r-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
      yield* (yield* ThreadRepository).insert(restartThread);
    }),
  );
  await setOrbRestart(owner, true);
  await setOrbRestart(member, true);
});

describe("Restart Orb route, in workerd with real D1", () => {
  it("restarts for the owner and a contributor, never a viewer or an outsider", async () => {
    const restarted = await restart(owner);
    expect(restarted.status).toBe(200);
    await expect(restarted.json<RestartThreadOrbResponse>()).resolves.toEqual({
      status: "success",
      data: { files: "kept", restartedAt: "2026-11-03T04:00:00.000Z" },
    });
    expect(objectRequests).toHaveLength(1);
    expect(objectRequests[0]?.headers.get("x-dx-thread-id")).toBe(
      restartThread.id,
    );
    // Who restarted it, by the name dx shows (not the email), for the note
    // the Thread's next run gives its agent.
    expect(
      decodeURIComponent(
        objectRequests[0]?.headers.get("x-dx-restarted-by") ?? "",
      ),
    ).toBe("Ravi Ölçer");

    expect((await share("view")).status).toBe(200);
    const viewed = await restart(member);
    expect(viewed.status).toBe(403);
    await expect(
      viewed.json<ThreadOrbRestartErrorResponse>(),
    ).resolves.toMatchObject({ data: { code: "THREAD_READ_ONLY" } });

    expect((await share("contribute")).status).toBe(200);
    expect((await restart(member)).status).toBe(200);

    expect((await restart(outsider)).status).toBe(404);
    // Only the owner's and the contributor's restarts reached the Orb.
    expect(objectRequests).toHaveLength(2);
  });

  it("is off unless the person turned on the orb-restart experimental feature", async () => {
    await setOrbRestart(owner, false);
    const response = await restart(owner);
    expect(response.status).toBe(403);
    await expect(
      response.json<ThreadOrbRestartErrorResponse>(),
    ).resolves.toMatchObject({ data: { code: "ORB_RESTART_DISABLED" } });
    expect(objectRequests).toHaveLength(0);

    await setOrbRestart(owner, true);
    expect((await restart(owner)).status).toBe(200);
  });

  it("refuses an archived Thread without reaching its Orb", async () => {
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(restartThread.id)
      .run();
    const response = await restart(owner);
    expect(response.status).toBe(409);
    await expect(
      response.json<ThreadOrbRestartErrorResponse>(),
    ).resolves.toMatchObject({ data: { code: "THREAD_ARCHIVED" } });
    expect(objectRequests).toHaveLength(0);
  });

  it("says why when the Orb wasn't restarted", async () => {
    const answers: Array<
      [OrbRestartRelayResult, number, string, number | undefined]
    > = [
      [
        { outcome: "too-soon", retryAfterSeconds: 87 },
        429,
        "ORB_RESTART_TOO_SOON",
        87,
      ],
      [{ outcome: "unsupported" }, 409, "ORB_RESTART_UNSUPPORTED", undefined],
      [{ outcome: "unsaved" }, 409, "ORB_RESTART_UNSAVED", undefined],
      [{ outcome: "failed" }, 503, "ORB_RESTART_FAILED", undefined],
    ];
    for (const [answer, status, code, retryAfterSeconds] of answers) {
      objectAnswer = answer;
      const response = await restart(owner);
      expect(response.status).toBe(status);
      const body = await response.json<ThreadOrbRestartErrorResponse>();
      expect(body.data.code).toBe(code);
      expect(body.data.retryAfterSeconds).toBe(retryAfterSeconds);
      expect(response.headers.get("retry-after")).toBe(
        retryAfterSeconds === undefined ? null : String(retryAfterSeconds),
      );
    }
  });

  it("offers the last save when the Orb can't be saved, and drops unsaved work only when asked (#1614)", async () => {
    objectAnswer = {
      outcome: "unsaved",
      savedAt: Date.parse("2026-11-03T09:00:00.000Z"),
    };
    const refused = await restart(owner);
    expect(refused.status).toBe(409);
    await expect(
      refused.json<ThreadOrbRestartErrorResponse>(),
    ).resolves.toMatchObject({
      data: {
        code: "ORB_RESTART_UNSAVED",
        lastSavedAt: "2026-11-03T09:00:00.000Z",
      },
    });
    // A plain restart never asks the object to drop anything.
    expect(
      objectRequests.at(-1)?.headers.get("x-dx-restart-discard-unsaved"),
    ).toBeNull();

    objectAnswer = {
      outcome: "restarted",
      files: "earlier",
      savedAt: Date.parse("2026-11-03T09:00:00.000Z"),
      rescue: "copied",
      restored: {
        name: "dx-recovered-2026-11-03T12-00-00.tar.gz",
        changes: 2,
        commits: 1,
      },
      restartedAt: "2026-11-03T12:00:00.000Z",
    };
    const accepted = await request(
      owner,
      `/threads/${restartThread.id}/orb/restart`,
      "POST",
      { discardUnsaved: true },
    );
    expect(accepted.status).toBe(200);
    expect(
      objectRequests.at(-1)?.headers.get("x-dx-restart-discard-unsaved"),
    ).toBe("1");
    await expect(accepted.json<RestartThreadOrbResponse>()).resolves.toEqual({
      status: "success",
      data: {
        files: "earlier",
        restartedAt: "2026-11-03T12:00:00.000Z",
        savedAt: "2026-11-03T09:00:00.000Z",
        rescue: "copied",
        restoredName: "dx-recovered-2026-11-03T12-00-00.tar.gz",
      },
    });
  });
});

describe("Restart Orb on the Thread execution object's storage", () => {
  const threadId = Schema.decodeUnknownSync(ThreadId)(
    "thr_00000000-0000-4000-8000-000000001593",
  );
  const stub = () => env.THREAD_EXECUTION.getByName(threadId);

  it("restarts once per interval, refuses a second request meanwhile, and gives the time back when nothing restarted", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      let now = Date.parse("2026-11-03T04:00:00.000Z");
      const restarted = vi.fn();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const dependencies = (
        outcome: "restarted" | "unsaved" | "unsupported" | "throws",
        hold = false,
      ) => ({
        storage: state.storage,
        by: "Ravi Ölçer",
        now: () => now,
        restart: async () => {
          if (hold) await held;
          if (outcome === "throws") throw new Error("container object reset");
          return outcome === "restarted"
            ? { outcome, files: "kept" as const }
            : { outcome };
        },
        restarted,
      });

      // A failed, an unsupported, and an unsaved restart each leave the
      // limit as it was: the next one may run at once.
      for (const outcome of ["throws", "unsupported", "unsaved"] as const)
        await expect(
          restartOrb(threadId, dependencies(outcome)),
        ).resolves.toEqual({
          outcome: outcome === "throws" ? "failed" : outcome,
        });
      expect(restarted).not.toHaveBeenCalled();
      // None of them leaves a note for the next run.
      await expect(takeOrbRestartNote(state.storage)).resolves.toBeUndefined();

      // A restart in progress refuses a second request (a double click).
      const first = restartOrb(threadId, dependencies("restarted", true));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(
        restartOrb(threadId, dependencies("restarted")),
      ).resolves.toEqual({
        outcome: "too-soon",
        retryAfterSeconds: ORB_RESTART_INTERVAL_SECONDS,
      });
      release();
      await expect(first).resolves.toEqual({
        outcome: "restarted",
        files: "kept",
        restartedAt: "2026-11-03T04:00:00.000Z",
      });
      expect(restarted).toHaveBeenCalledOnce();
      // The next run's agent hears who restarted it, once.
      await expect(takeOrbRestartNote(state.storage)).resolves.toEqual({
        by: "Ravi Ölçer",
        files: "kept",
        restartedAt: "2026-11-03T04:00:00.000Z",
      });
      await expect(takeOrbRestartNote(state.storage)).resolves.toBeUndefined();

      // Until the interval has passed.
      now += (ORB_RESTART_INTERVAL_SECONDS - 30) * 1000;
      await expect(
        restartOrb(threadId, dependencies("restarted")),
      ).resolves.toEqual({ outcome: "too-soon", retryAfterSeconds: 30 });
      now += 30_000;
      await expect(
        restartOrb(threadId, dependencies("restarted")),
      ).resolves.toMatchObject({ outcome: "restarted" });
      expect(restarted).toHaveBeenCalledTimes(2);
    });
  });
});
