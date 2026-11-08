import { env as testEnv } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import { assertThreadLifecycleState } from "../../src/execution/activation.js";
import {
  ORB_STOP_RETRY_MS,
  OrbContainerController,
} from "../../src/execution/cloudflare/orb-container.js";
import { cloudflareExecutionProvider } from "../../src/execution/cloudflare/provider.js";
import type { Bindings } from "../../src/http/types.js";
import type { ExecutionContext as OrbExecutionContext } from "../../src/plugins/execution/provider.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Archive's Orb stop through the real archive route (`PATCH
 * /v1/threads/:id/archive` in the whole app), the real Cloudflare provider,
 * and the real Orb container object's logic, over a container that answers
 * as Cloudflare's does (#1740, #1777). Only the container is a stand-in:
 * tests cannot run one.
 *
 * Failure modes this covers:
 * - F1, #1777: a start that failed readiness, then an open queued behind
 *   it answered "running"; archive's snapshot fails with Cloudflare's "The
 *   container has not been started". Was a 503; now 200 and stopped, with no
 *   snapshot, since nothing ran.
 * - F3: a started container that was never saved and can't be snapshotted
 *   is never stopped (#1642); archive answers 200 `orbStopping`, nothing
 *   wakes it while archived, and the object retries the stop, snapshot
 *   first, and logs `orb_stop_abandoned` after three tries.
 * - F4, #1740: archived while the first activation still starts the Orb
 *   (record `provisioning`). Was a 503; now 200 `orbStopping`, and the
 *   object stops it, snapshot first, once every open queued before the
 *   archive has finished.
 * - Control: a healthy Orb is snapshotted and stopped, with no
 *   `orbStopping`.
 */

vi.mock("../../src/execution/execution-workspaces.js", async () => {
  const { composeExecutionWorkspaces } = await import(
    "../../src/plugins/execution/provider.js"
  );
  const { cloudflareExecutionProvider: cloudflare } = await import(
    "../../src/execution/cloudflare/provider.js"
  );
  const { env } = await import("cloudflare:workers");
  const unused = () => Promise.reject(new Error("not used by this test"));
  return {
    executionProviders: { cloudflare },
    makeExecutionWorkspaces: () => {
      throw new Error("not used by this test");
    },
    // The deployment's Cloudflare Orbs, as a deployment that binds them
    // composes them; the activation pipeline is not under test.
    ExecutionWorkspaces: composeExecutionWorkspaces(
      env as Bindings,
      { cloudflare },
      () => ({
        activate: unused,
        reconnect: unused,
        ensureDaemon: unused,
        recordResidentTerminalInput: unused,
        recordResidentTerminalHeartbeat: () => undefined,
      }),
      [
        {
          providerId: "cloudflare",
          capabilities: ["execution.workspace", "execution.pause-resume"],
          pauseResumePreserves: "filesystem",
        },
      ],
      async () => ({
        profile: cloudflareProfile,
        credential: { scope: "deployment" },
      }),
      () => true,
      {},
    ),
  };
});

const cloudflareProfile = {
  id: "cf.standard-1",
  label: "standard-1",
  adapter: "cloudflare",
  instance: "standard-1",
  resources: { cpuCores: 1, memoryMb: 4096, diskGb: 8 },
  isolation: "container",
  availability: "available",
  capabilities: ["git", "pause-resume"],
} as unknown as OrbExecutionContext["profile"];

const orbContext: OrbExecutionContext = {
  account: { scope: "deployment" },
  credentials: undefined,
  profile: cloudflareProfile,
};

/** One Thread's Orb: the real object logic over a stand-in container. */
const orbWorld = () => {
  let clock = Date.parse("2026-11-05T03:31:23Z");
  const empty = () => new Response("").body;
  const opens: number[] = [];
  /** How the readiness probe answers; `ready` by default. */
  let probe: "ready" | "hang" | (() => Promise<number>) = "ready";
  const container = {
    running: false,
    start: vi.fn(() => {
      container.running = true;
    }),
    exec: vi.fn(async (argv: string[]) => {
      let exitCode: Promise<number> = Promise.resolve(0);
      if (argv[0] === "true" && probe === "hang") {
        // The probe never returns; the readiness wait's 300 s pass (#1956).
        clock += 301_000;
        exitCode = new Promise(() => {});
      } else if (argv[0] === "true" && typeof probe === "function")
        exitCode = probe();
      return {
        stdout: empty(),
        stderr: empty(),
        exitCode,
        kill: () => undefined,
      };
    }),
    snapshotContainer: vi.fn(
      async (): Promise<{ id: string; size: number }> => ({
        id: "snapshot-good",
        size: 1024,
      }),
    ),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
    setInactivityTimeout: vi.fn(async () => undefined),
    interceptOutboundHttp: vi.fn(async () => undefined),
  };
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const controller = new OrbContainerController({
    container: container as never,
    storage: {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T,
      put: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
      delete: async (key: string) => values.delete(key),
      setAlarm: async (time: number) => {
        alarm = time;
      },
      getAlarm: async () => alarm,
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    image: () => "registry.cloudflare.com/account/dx-orb@sha256:abc",
    sandboxId: "orb-object-id",
    now: () => clock,
  });
  const stub = new Proxy(controller, {
    get: (target, key) => {
      if (key === "id") return { toString: () => "orb-object-id" };
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (key === "open") opens.push(clock);
        return (value as (...values: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    container,
    controller,
    stub,
    opens,
    setProbe: (next: typeof probe) => {
      probe = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    /** The object's alarm, as Cloudflare fires it. */
    fireAlarm: () => controller.alarm(),
  };
};

const worlds = new Map<string, ReturnType<typeof orbWorld>>();

const appOrigin = "http://dx.test";
const bindings = {
  DB: testEnv.DB,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "deployed",
  DX_AUTH_URL: appOrigin,
  DX_AUTH_TRUSTED_ORIGINS: appOrigin,
  BETTER_AUTH_SECRET: "archive-orb-stop-secret-0000000000000000",
} satisfies Bindings;

beforeAll(() => {
  // The Cloudflare provider reads the deployment's bindings: the Orb
  // container namespace names each Thread's object.
  Object.assign(workerEnv as Record<string, unknown>, {
    ORB_CONTAINER: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        const world = worlds.get(name);
        if (world === undefined) throw new Error(`No Orb for ${name}.`);
        return world.stub;
      },
    },
    DX_WORKSPACE_INACTIVITY_MS: "300000",
  });
});

const logged: Array<Record<string, unknown>> = [];
const captureLogs = () => {
  logged.length = 0;
  for (const level of ["info", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation((...values: unknown[]) => {
      const [line] = values;
      if (typeof line === "object" && line !== null)
        logged.push(line as Record<string, unknown>);
    });
};

afterEach(() => {
  vi.restoreAllMocks();
});

let sequence = 0;
const signUp = async () => {
  sequence += 1;
  const email = `archive-orb-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    `${appOrigin}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: appOrigin,
        "cf-connecting-ip": `198.51.100.${(sequence % 200) + 20}`,
      },
      body: JSON.stringify({
        name: "Archive Orb",
        email,
        password: "archive-orb-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/better-auth\.session_token=[^;,]+/)?.[0];
  if (cookie === undefined) throw new Error("Expected a session cookie.");
  const userId = await testEnv.DB.prepare(
    'SELECT id FROM "user" WHERE email = ?',
  )
    .bind(email)
    .first<string>("id");
  if (userId === null) throw new Error("Expected a user.");
  return { cookie, userId: Schema.decodeSync(UserId)(userId) };
};

/** A signed-in owner's Thread, with its Orb object. */
const ownThread = async () => {
  const owner = await signUp();
  sequence += 1;
  const suffix = `${Date.now().toString(16).slice(-8)}${String(sequence).padStart(4, "0")}`;
  const projectEntity = project(
    `prj_00000000-0000-4000-8000-${suffix}`,
    owner.userId,
    `Archive Orb ${suffix}`,
  );
  const threadEntity = thread(
    `thr_00000000-0000-4000-8000-${suffix}`,
    projectEntity.id as ProjectId,
    owner.userId,
  );
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(projectEntity);
      yield* (yield* ThreadRepository).insert(threadEntity);
    }),
  );
  const world = orbWorld();
  worlds.set(threadEntity.id, world);
  return { cookie: owner.cookie, threadId: threadEntity.id, world };
};

/**
 * The activation's Orb open, through the real Cloudflare provider, which
 * Core admits only for an active Thread.
 */
const openOrb = (threadId: string) =>
  cloudflareExecutionProvider.workspace.create(
    orbContext,
    { threadId: threadId as never },
    {
      authorize: () =>
        assertThreadLifecycleState(testEnv.DB, threadId, "active"),
    },
  );

const archive = async (cookie: string, threadId: string) => {
  const response = await app.request(
    `${appOrigin}/v1/threads/${threadId}/archive`,
    {
      method: "PATCH",
      headers: {
        cookie,
        origin: appOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ archived: true }),
    },
    bindings,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

const lifecycleState = (threadId: string) =>
  testEnv.DB.prepare("SELECT lifecycle_state FROM threads WHERE id = ?")
    .bind(threadId)
    .first<string>("lifecycle_state");

const recordState = (threadId: string) =>
  testEnv.DB.prepare(
    "SELECT state FROM execution_workspace WHERE thread_id = ?",
  )
    .bind(threadId)
    .first<string>("state");

describe("archive's Orb stop through the real route and Orb object", () => {
  it("archives a Thread whose Orb never started with a 200 and stops it without a snapshot (#1777)", async () => {
    const { cookie, threadId, world } = await ownThread();
    // staging, thr_5b6834e0: the fresh start's readiness probe never
    // returned and its stop did not land, so the container still reads as
    // running. Before #1783 an open queued behind it answered "running";
    // now neither open is handed a container that never became ready.
    world.setProbe("hang");
    world.container.destroy.mockRejectedValue(new Error("not stopped"));
    const [first, queued] = await Promise.allSettled([
      openOrb(threadId),
      openOrb(threadId),
    ]);
    expect([first.status, queued.status]).toEqual(["rejected", "rejected"]);
    expect(world.container.running).toBe(true);
    // Cloudflare stops it once asked again.
    world.container.destroy.mockImplementation(async () => {
      world.container.running = false;
    });
    world.container.snapshotContainer.mockRejectedValue(
      new Error("The container has not been started"),
    );

    const archived = await archive(cookie, threadId);

    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({
      status: "success",
      data: { id: threadId, lifecycleState: "archived" },
    });
    // No open succeeded, so Core's record still says a start may be
    // running: the stop is left to the Orb's alarm (#1740).
    expect(archived.body).toMatchObject({ orbStopping: true });
    await world.fireAlarm();
    // Cloudflare says it never started: stopped without a snapshot.
    expect(world.container.running).toBe(false);
    await expect(world.controller.status()).resolves.toEqual({
      running: false,
      status: "paused",
    });
    await expect(lifecycleState(threadId)).resolves.toBe("archived");
  });

  it("never stops a started, never-saved Orb it can't snapshot; answers orbStopping, nothing wakes it, and the stop is retried then logged abandoned", async () => {
    captureLogs();
    const { cookie, threadId, world } = await ownThread();
    await openOrb(threadId);
    world.container.snapshotContainer.mockRejectedValue(
      new Error(
        "The container snapshot could not be completed due to an internal error; try again (reference ID: 5656a1e5)",
      ),
    );

    const archived = await archive(cookie, threadId);

    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({
      data: { lifecycleState: "archived" },
      orbStopping: true,
    });
    // #1642: never stopped without a save.
    expect(world.container.running).toBe(true);
    expect(world.container.destroy).not.toHaveBeenCalled();

    // While it stops, nothing reaches or wakes it.
    const opensBefore = world.opens.length;
    const wakes = [
      ["GET", `/v1/threads/${threadId}/terminal`],
      ["GET", `/v1/threads/${threadId}/desktop`],
      ["GET", `/v1/threads/${threadId}/files/list?path=%2F`],
      ["POST", `/v1/agents/dx/${threadId}`],
    ] as const;
    for (const [method, path] of wakes) {
      const response = await app.request(
        `${appOrigin}${path}`,
        {
          method,
          headers: {
            cookie,
            origin: appOrigin,
            accept: "application/json",
            "content-type": "application/json",
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        },
        bindings,
      );
      expect(response.status, `${method} ${path}`).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        data: { code: "THREAD_ARCHIVED" },
      });
    }
    expect(world.opens.length).toBe(opensBefore);

    // The object tries again, snapshot first, five minutes apart, then
    // logs the stop abandoned at error level for the watch.
    const snapshotsBefore = world.container.snapshotContainer.mock.calls.length;
    for (let tick = 0; tick < 2; tick += 1) {
      world.advance(ORB_STOP_RETRY_MS);
      await world.fireAlarm();
    }
    expect(world.container.snapshotContainer.mock.calls.length).toBe(
      snapshotsBefore + 2,
    );
    expect(world.container.running).toBe(true);
    expect(
      logged.filter((line) => line.event === "orb_stop_abandoned"),
    ).toEqual([
      expect.objectContaining({
        level: "error",
        threadId,
        sandboxId: "orb-object-id",
        tries: 3,
      }),
    ]);
    await expect(lifecycleState(threadId)).resolves.toBe("archived");
  });

  it("stops an Orb archived during its first start once every open queued before the archive ends, snapshot first (#1740)", async () => {
    const { cookie, threadId, world } = await ownThread();
    // The first activation's start waits on its readiness probe.
    let ready: (() => void) | undefined;
    world.setProbe(
      () =>
        new Promise<number>((resolve) => {
          ready = () => resolve(0);
        }),
    );
    const activation = openOrb(threadId);
    await vi.waitFor(() => expect(ready).toBeDefined());
    await expect(recordState(threadId)).resolves.toBe("provisioning");
    // A second open, a reconnect, queues behind the start before the archive.
    const reconnect = openOrb(threadId);
    await vi.waitFor(() => expect(world.opens.length).toBe(2));

    // Archive answers at once, without waiting for the start.
    const archived = await archive(cookie, threadId);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({
      data: { lifecycleState: "archived" },
      orbStopping: true,
    });

    ready?.();
    await activation;
    // The reconnect's open ends too; its retry is refused, since the
    // Thread is archived.
    await expect(reconnect).rejects.toThrow("Thread is not active.");
    // Both opens finished, and the container runs for now.
    expect(world.container.running).toBe(true);

    // The pending stop fires: snapshot first, then stop.
    await world.fireAlarm();
    expect(world.container.snapshotContainer).toHaveBeenCalledOnce();
    expect(world.container.running).toBe(false);
    await expect(world.controller.status()).resolves.toEqual({
      running: false,
      status: "paused",
    });
    await expect(lifecycleState(threadId)).resolves.toBe("archived");
  });

  it("snapshots and stops a healthy Orb, with no orbStopping (control)", async () => {
    const { cookie, threadId, world } = await ownThread();
    await openOrb(threadId);
    const archived = await archive(cookie, threadId);
    expect(archived.status).toBe(200);
    expect(archived.body).not.toHaveProperty("orbStopping");
    expect(world.container.snapshotContainer).toHaveBeenCalledOnce();
    expect(world.container.running).toBe(false);
  });
});
