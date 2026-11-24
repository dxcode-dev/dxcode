import { env } from "cloudflare:test";
import { ORB_PROVIDERS, Principal, type UserId } from "@dx/domain";
import { Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
  runnerArchiveKey,
  runnerExecutionProvider,
} from "../../src/execution/runner/provider.js";
import { readExecutionWorkspaceReadiness } from "../../src/execution/workspace-readiness.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { hiddenOrbProviders } from "../../src/plugins/execution/orb-provider-beta.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import type { ExecutionContext } from "../../src/plugins/execution/provider.js";
import { runnerCall, runnerStatus } from "../../src/runners/client.js";
import {
  PAIR_GUESSES_OVERALL,
  PAIR_GUESSES_PER_ADDRESS,
  personalRunnerRoutes,
  runnerPublicRoutes,
} from "../../src/runners/routes.js";
import {
  desktopOwnerOnlyOnRunner,
  ownerOnlyOnRunner,
} from "../../src/runners/thread-gate.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * Runners end to end at the Worker boundary: a person turns runners on,
 * pairs a machine with a one-time code, the machine dials in over a real
 * WebSocket to its session object, a new Thread pins it, and the runner
 * provider runs workspace operations, archive, and restore through it. The
 * machine is a fake `dxd runner` that keeps the Thread's files in memory.
 */

const person = "runner-person" as UserId;
const stranger = "runner-stranger" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000052a1";
const threadId = "thr_00000000-0000-4000-8000-0000000052a1";
const timestamp = "2026-11-20T00:00:00.000Z";

const bindings: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  RUNNER_SESSION: env.RUNNER_SESSION,
  DX_STORAGE: env.DX_STORAGE,
};

const principalOf = (userId: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId,
    credentialScopes: ["personal", "workspace"],
  });

const app = (userId: UserId = person) => {
  const router = new Hono<AppEnv>();
  router.use("*", requestId);
  router.route("/v1/runner", runnerPublicRoutes);
  router.use("*", async (context, next) => {
    context.set("principal", principalOf(userId));
    await next();
  });
  router.route("/v1/settings/personal/runners", personalRunnerRoutes);
  // authorizeThread's access, as the Thread's sharing would set it.
  for (const feature of ["terminal", "desktop"])
    router.use(`/v1/threads/:threadId/${feature}/*`, async (context, next) => {
      context.set(
        "threadAccess",
        context.req.header("x-test-access") === "contribute"
          ? "contribute"
          : "owner",
      );
      await next();
    });
  router.use("/v1/threads/:threadId/terminal/*", ownerOnlyOnRunner);
  router.use("/v1/threads/:threadId/desktop/*", desktopOwnerOnlyOnRunner);
  router.get("/v1/threads/:threadId/terminal/attach", (context) =>
    context.text("terminal"),
  );
  router.get("/v1/threads/:threadId/desktop/status", (context) =>
    context.text("desktop"),
  );
  router.onError(errorHandler);
  return router;
};

const request = (path: string, init: RequestInit = {}, userId?: UserId) =>
  app(userId).request(path, init, bindings);

const setRunnersFlag = async (userId: UserId, enabled: boolean) => {
  await env.DB.prepare(
    `INSERT INTO personal_experimental_feature_preferences (
       user_id, preferences, revision, updated_at
     ) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (user_id) DO UPDATE SET preferences = excluded.preferences`,
  )
    .bind(
      userId,
      JSON.stringify(
        enabled ? [{ id: "orb-provider-runner", enabled: true }] : [],
      ),
      timestamp,
    )
    .run();
};

/** A fake machine: one Thread folder per Thread, files in memory. */
interface FakeMachine {
  readonly folders: Map<string, Map<string, string>>;
  readonly ops: string[];
  readonly hello: Promise<Record<string, unknown>>;
  /** Prerequisites the machine lacks (a Mac without the Command Line Tools). */
  readonly missing: readonly string[];
  socket: WebSocket;
  token: string;
}

const NO_GIT =
  "git comes with Apple's Command Line Tools, which this Mac does not have. Install them: run `xcode-select --install` on the Mac (or finish the dialog it opened), then try again.";

const encode = (text: string) => btoa(text);
const decode = (base64: string) => atob(base64);

const pairAndConnect = async (
  missing: readonly string[] = [],
): Promise<FakeMachine> => {
  const pairing = await request("/v1/settings/personal/runners/pairings", {
    method: "POST",
  });
  expect(pairing.status).toBe(201);
  const { data } = (await pairing.json()) as {
    readonly data: { code: string; command: string; expiresAt: number };
  };
  expect(data.command).toBe(
    `curl -fsSL http://localhost/v1/runner/install.sh | sh -s -- --code ${data.code}`,
  );
  const pair = (code: string) =>
    request("/v1/runner/pair", {
      method: "POST",
      body: JSON.stringify({
        code,
        name: "studio-mac",
        os: "macos",
        arch: "aarch64",
        version: "0.15.0",
      }),
    });
  const paired = await pair(data.code.toLowerCase().replace("-", ""));
  expect(paired.status).toBe(201);
  const { machineId, token } = (await paired.json()) as {
    machineId: string;
    token: string;
  };
  expect(machineId).toMatch(/^rnm_[0-9a-f]{24}$/);
  // A code pairs once.
  expect((await pair(data.code)).status).toBe(403);
  return connect(token, missing);
};

const connect = async (
  token: string,
  missing: readonly string[] = [],
): Promise<FakeMachine> => {
  const response = await request("/v1/runner/connect", {
    headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket as WebSocket;
  socket.accept();
  const machine: Partial<FakeMachine> & {
    folders: Map<string, Map<string, string>>;
    ops: string[];
  } = { folders: new Map(), ops: [], token, socket, missing };
  let helloReceived: (frame: Record<string, unknown>) => void = () => {};
  machine.hello = new Promise((resolve) => {
    helloReceived = resolve;
  });
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as Record<string, unknown>;
    if (frame.type === "hello") helloReceived(frame);
    if (frame.type === "request")
      void serve(machine as FakeMachine, frame).then((reply) =>
        socket.send(JSON.stringify({ type: "reply", id: frame.id, ...reply })),
      );
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      version: "0.15.0",
      os: "macos",
      arch: "aarch64",
      sandbox: "seatbelt",
      threads: [],
      missing,
    }),
  );
  return machine as FakeMachine;
};

const serve = async (
  machine: FakeMachine,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const op = frame.op as string;
  const thread = frame.thread as string;
  const body = frame.body as Record<string, unknown>;
  machine.ops.push(op);
  const folder = machine.folders.get(thread);
  const fail = (code: string, message: string) => ({
    ok: false,
    error: { code, message },
  });
  switch (op) {
    case "ensure": {
      // As `dxd runner`: an activation on a machine without git says what
      // to install.
      if (body.existingOnly !== true && machine.missing.includes("git"))
        return fail("prerequisites", NO_GIT);
      if (folder === undefined) {
        const restore = body.restore as { url: string } | undefined;
        if (restore !== undefined) {
          const response = await request(new URL(restore.url).pathname, {
            headers: { authorization: `Bearer ${machine.token}` },
          });
          if (!response.ok) return fail("failed", "restore download failed");
          const snapshot = (await response.json()) as Record<string, string>;
          machine.folders.set(thread, new Map(Object.entries(snapshot)));
          return {
            ok: true,
            result: { cwd: "/home/user/workspace/repo", restored: true },
          };
        }
        if (body.existingOnly === true) return fail("not-found", "no folder");
        machine.folders.set(thread, new Map());
      }
      return { ok: true, result: { cwd: "/home/user/workspace/repo" } };
    }
    case "write":
      folder?.set(body.path as string, decode(body.contents as string));
      return { ok: true, result: {} };
    case "read": {
      const content = folder?.get(body.path as string);
      return content === undefined
        ? fail("not-found", "no such file")
        : { ok: true, result: { contents: encode(content) } };
    }
    case "stat": {
      const path = body.path as string;
      const file = folder?.has(path) === true;
      const directory = [...(folder?.keys() ?? [])].some((key) =>
        key.startsWith(`${path}/`),
      );
      return file || directory
        ? { ok: true, result: { file, directory, symlink: false } }
        : fail("not-found", "no such path");
    }
    case "exec":
      return {
        ok: true,
        result: {
          stdout: `ran: ${body.command as string}\n`,
          stderr: "",
          exitCode: 0,
        },
      };
    case "archive": {
      const upload = await request(new URL(body.uploadUrl as string).pathname, {
        method: "PUT",
        headers: { authorization: `Bearer ${machine.token}` },
        body: JSON.stringify(Object.fromEntries(folder ?? [])),
      });
      if (!upload.ok) return fail("failed", `upload ${upload.status}`);
      machine.folders.delete(thread);
      return { ok: true, result: { bytes: 1 } };
    }
    case "pause":
    case "destroy":
      if (op === "destroy") machine.folders.delete(thread);
      return { ok: true, result: {} };
    case "daemon":
      return typeof body.apiKey === "string"
        ? { ok: true, result: { status: "running" } }
        : { ok: true, result: { status: "credential-required" } };
    default:
      return fail("invalid", `unknown op ${op}`);
  }
};

const listRunners = async (userId: UserId = person) => {
  const response = await request("/v1/settings/personal/runners", {}, userId);
  return {
    status: response.status,
    runners:
      response.status === 200
        ? (
            (await response.json()) as {
              readonly data: {
                readonly runners: ReadonlyArray<{
                  id: string;
                  name: string;
                  online: boolean;
                }>;
              };
            }
          ).data.runners
        : [],
  };
};

const pin = (userId: UserId, runnerMachineId?: string) =>
  resolveThreadExecutionPin({
    db: env.DB,
    bindings,
    userId,
    projectId: project,
    runnerProfileId: "rn.machine",
    ...(runnerMachineId === undefined ? {} : { runnerMachineId }),
    connectors: {},
    hiddenProviders: () => hiddenOrbProviders(bindings, principalOf(userId)),
  }).then(
    (value) => value,
    (cause: { readonly reason?: string }) => cause.reason ?? String(cause),
  );

const contextFor = (machineId: string): ExecutionContext => {
  const size = ORB_PROVIDERS.find(({ id }) => id === "runner")?.sizes[0];
  if (size === undefined) throw new Error("runner has no size");
  return {
    account: { scope: "deployment" },
    credentials: undefined,
    profile: { ...size, machine: machineId },
  };
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?1, ?1, ?2, 1, 1, 1)',
    ).bind(person, `${person}@example.com`),
    env.DB.prepare(
      'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?1, ?1, ?2, 1, 1, 1)',
    ).bind(stranger, `${stranger}@example.com`),
    env.DB.prepare(
      `INSERT OR IGNORE INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Runner project', 'rn.machine', ?, ?)`,
    ).bind(project, person, timestamp, timestamp),
  ]);
  await setRunnersFlag(person, true);
  await setRunnersFlag(stranger, true);
  await env.DB.prepare("DELETE FROM request_budget").run();
});

describe("Runners", () => {
  it("hides runners until the person turns them on", async () => {
    await setRunnersFlag(person, false);
    expect((await listRunners()).status).toBe(404);
    expect(
      (
        await request("/v1/settings/personal/runners/pairings", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect(await pin(person)).toBe("beta-provider-off");
  });

  it("serves the install script with this deployment's origin", async () => {
    const response = await request("/v1/runner/install.sh");
    expect(response.status).toBe(200);
    const script = await response.text();
    expect(script).toContain('DX_ORIGIN="http://localhost"');
    expect(script).not.toContain("__DX_ORIGIN__");
    expect(script).toContain('"$bin/dxd" runner pair --server "$DX_ORIGIN"');
  });

  it("records what a machine lacks and refuses its activation with what to install", async () => {
    const machine = await pairAndConnect(["git", "python3"]);
    await machine.hello;
    const machineId = (await listRunners()).runners[0]?.id as string;
    expect(await runnerStatus(bindings, machineId)).toMatchObject({
      online: true,
      missing: ["git", "python3"],
    });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(threadId, project, person, timestamp, timestamp),
      env.DB.prepare(
        `UPDATE execution_workspace
            SET provider = 'runner', runner_profile_id = 'rn.machine',
                account_scope = 'deployment', provider_template = ?
          WHERE thread_id = ?`,
      ).bind(machineId, threadId),
    ]);
    // The code survives the session object and the provider, so activation
    // shows it as runner_prerequisites_missing with the runner's words.
    await expect(
      runnerExecutionProvider.workspace.create(
        contextFor(machineId),
        { threadId: threadId as never },
        {} as never,
      ),
    ).rejects.toThrow(`runner:prerequisites:${NO_GIT}`);
  });

  it("pairs a machine, sees it online, pins Threads to it, and runs, archives, and restores a Thread there", async () => {
    expect(await pin(person)).toBe("no-runner");
    const machine = await pairAndConnect();
    const hello = await machine.hello;
    expect(hello.type).toBe("hello");
    const { runners } = await listRunners();
    expect(runners).toHaveLength(1);
    const machineId = runners[0]?.id as string;
    expect(runners[0]).toMatchObject({ name: "studio-mac", online: true });

    // Another person sees none of it and cannot pin it.
    expect((await listRunners(stranger)).runners).toHaveLength(0);
    expect(await pin(stranger, machineId)).toBe("no-runner");
    // The owner's new Thread pins the machine, named or by default.
    expect(await pin(person)).toMatchObject({
      provider: "runner",
      runnerProfileId: "rn.machine",
      credentialScope: "deployment",
      providerTemplate: machineId,
    });
    expect(await pin(person, machineId)).toMatchObject({
      providerTemplate: machineId,
    });

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(threadId, project, person, timestamp, timestamp),
      env.DB.prepare(
        `UPDATE execution_workspace
            SET provider = 'runner', runner_profile_id = 'rn.machine',
                account_scope = 'deployment', provider_template = ?
          WHERE thread_id = ?`,
      ).bind(machineId, threadId),
    ]);

    // Thread detail names the machine: the web shows Terminal and Desktop
    // to its owner only.
    expect(
      await readExecutionWorkspaceReadiness(env.DB, threadId as never),
    ).toMatchObject({
      runner: { machineId, name: "studio-mac" },
    });

    // Terminal: the owner only, even when the Thread is shared.
    expect(
      (await request(`/v1/threads/${threadId}/terminal/attach`)).status,
    ).toBe(200);
    const shared = await request(`/v1/threads/${threadId}/terminal/attach`, {
      headers: { "x-test-access": "contribute" },
    });
    expect(shared.status).toBe(403);
    expect(
      ((await shared.json()) as { data: { code: string } }).data.code,
    ).toBe("RUNNER_THREAD_OWNER_ONLY");

    // Desktop (the whole machine): the owner only, too.
    expect(
      (await request(`/v1/threads/${threadId}/desktop/status`)).status,
    ).toBe(200);
    const sharedDesktop = await request(
      `/v1/threads/${threadId}/desktop/status`,
      { headers: { "x-test-access": "contribute" } },
    );
    expect(sharedDesktop.status).toBe(403);
    expect(
      ((await sharedDesktop.json()) as { data: { code: string } }).data.code,
    ).toBe("RUNNER_THREAD_OWNER_ONLY");

    const context = contextFor(machineId);
    const handle = await runnerExecutionProvider.workspace.create(
      context,
      { threadId: threadId as never },
      {} as never,
    );
    expect(handle.hostMachine).toBe(true);
    const sandbox = await handle.sandbox("/home/user/workspace/repo");
    await sandbox.writeFile(
      "/home/user/workspace/repo/notes.md",
      "hello runner",
    );
    expect(await sandbox.readFile("/home/user/workspace/repo/notes.md")).toBe(
      "hello runner",
    );
    const ran = await sandbox.exec("git status", {
      cwd: "/home/user/workspace/repo",
    });
    expect(ran).toMatchObject({ exitCode: 0, stdout: "ran: git status\n" });

    const daemon = await runnerExecutionProvider.residentDaemon?.install(
      context,
      handle,
      {
        threadId: threadId as never,
        endpoint: "wss://dx.test/v1/dxd/thr",
        mintCredential: async () => ({
          id: "key",
          key: Redacted.make("dxd_test_key"),
        }),
      },
    );
    expect(daemon).toEqual({});

    // Archive: the snapshot goes to R2 and the folder leaves the machine.
    await runnerExecutionProvider.workspace.release(
      context,
      { threadId: threadId as never },
      "archive",
    );
    expect(machine.folders.has(threadId)).toBe(false);
    expect(
      await env.DX_STORAGE.head(runnerArchiveKey(threadId)),
    ).not.toBeNull();

    // Unarchive: the next activation restores the folder from R2.
    const restored = await runnerExecutionProvider.workspace.create(
      context,
      { threadId: threadId as never },
      {} as never,
    );
    expect(
      await (await restored.sandbox("/home/user/workspace/repo")).readFile(
        "/home/user/workspace/repo/notes.md",
      ),
    ).toBe("hello runner");

    // Destroy removes the folder and the snapshot.
    await runnerExecutionProvider.workspace.release(
      context,
      { threadId: threadId as never },
      "destroy",
    );
    expect(machine.folders.has(threadId)).toBe(false);
    expect(await env.DX_STORAGE.head(runnerArchiveKey(threadId))).toBeNull();

    // A runner that goes away: archive keeps its folder, nothing fails.
    machine.socket.close(1000, "lid closed");
    await runnerExecutionProvider.workspace.release(
      context,
      { threadId: threadId as never },
      "archive",
    );
    expect(machine.ops.filter((op) => op === "archive")).toHaveLength(1);
    // Removing the machine refuses its token from then on.
    const removed = await request(
      `/v1/settings/personal/runners/${machineId}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect((await listRunners()).runners).toHaveLength(0);
    const refused = await request("/v1/runner/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${machine.token}`,
      },
    });
    expect(refused.status).toBe(401);
    // Its Threads say it was removed, not that it sleeps.
    await expect(
      runnerCall(bindings, machineId, "stat", threadId, { path: "/home/user" }),
    ).rejects.toThrow(/^runner:removed:/);
  });

  // #2436: a code is 8 letters, so unlimited guessing finds live codes.
  it("stops pairing guesses from one address, then from everyone", async () => {
    const pairing = await request("/v1/settings/personal/runners/pairings", {
      method: "POST",
    });
    const { code } = (
      (await pairing.json()) as { readonly data: { code: string } }
    ).data;
    expect(code).toMatch(
      /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
    );
    const wrong = code === "BBBB-BBBB" ? "CCCC-CCCC" : "BBBB-BBBB";
    const pair = (guess: string, address: string) =>
      request("/v1/runner/pair", {
        method: "POST",
        headers: { "cf-connecting-ip": address },
        body: JSON.stringify({
          code: guess,
          name: "guesser",
          os: "linux",
          arch: "x86_64",
        }),
      });
    for (let guess = 0; guess < PAIR_GUESSES_PER_ADDRESS; guess += 1)
      expect((await pair(wrong, "198.51.100.7")).status).toBe(403);
    // Out of guesses, even the right code is refused, and the code stays live.
    const limited = await pair(code, "198.51.100.7");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("900");
    expect(
      ((await limited.json()) as { data: { code: string } }).data.code,
    ).toBe("RATE_LIMITED");
    // Spread over many addresses, the guesses run out for everyone.
    for (
      let guess = PAIR_GUESSES_PER_ADDRESS;
      guess < PAIR_GUESSES_OVERALL;
      guess += 1
    )
      expect(
        (await pair(wrong, `10.0.${Math.floor(guess / 256)}.${guess % 256}`))
          .status,
      ).toBe(403);
    expect((await pair(code, "192.0.2.1")).status).toBe(429);
    // A new window: the person on their own address pairs with the code.
    await env.DB.prepare("DELETE FROM request_budget").run();
    expect((await pair(code, "192.0.2.1")).status).toBe(201);
  });
});
