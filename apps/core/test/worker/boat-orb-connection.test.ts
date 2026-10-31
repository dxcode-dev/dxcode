import { env } from "cloudflare:test";
import { BOAT_ORB_SIZES, Principal, type UserId } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import vmSetup from "../../../../deploy/orb/vm-setup.sh?raw";
import { makeBoatConnector } from "../../src/execution/boat/connector.js";
import { makeBoatExecutionProvider } from "../../src/execution/boat/provider.js";
import { resolveExecutionTarget } from "../../src/execution/runner-profiles/execution.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import type { OrbProviderConnectors } from "../../src/plugins/execution/connector.js";
import { makePersonalOrbProviderRoutes } from "../../src/plugins/execution/orb-provider-routes.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import { advanceConnection } from "../../src/plugins/execution/preparation.js";
import type { ExecutionContext } from "../../src/plugins/execution/provider.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

const solo = "bt-orb-solo" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000007b1";
const threadId = "thr_00000000-0000-4000-8000-0000000007c1";
const timestamp = "2026-10-24T00:00:00.000Z";
const accountId = "usr_boat_00000007a1";

/** No deployment provider: Boat runs only on a person's account. */
const bindings: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};

type State =
  | "provisioning"
  | "ready"
  | "archived"
  | "provisioned"
  | "cancelled";

interface FakeSandbox {
  readonly id: string;
  readonly type: string;
  readonly from: string | null;
  readonly name: string;
  readonly noEnv: boolean;
  readonly monitoring: boolean;
  readonly idempotencyKey: string | null;
  state: State;
  ttlSeconds: number | null;
  dataExpiredAt: string | null;
  /** When the current machine booted (epoch seconds), for /proc/stat. */
  bootedAt: number;
  /** The Orb's dx-orb.service is installed and enabled on this disk. */
  orb: boolean;
  setupPolls: number;
  readonly files: Map<string, string>;
  readonly execs: Array<{ readonly command: string; readonly asRoot: boolean }>;
}

interface FakeSaved {
  readonly name: string;
  status: "saving" | "ready";
  readonly createdAt: string;
  readonly orb: boolean;
}

interface FakeAccount {
  readonly id: string;
  readonly plan: string;
  readonly zeroDataRetention: boolean;
}

interface World {
  readonly keys: Map<string, FakeAccount>;
  readonly sandboxes: Map<string, FakeSandbox>;
  readonly deleted: Array<FakeSandbox>;
  readonly saved: Map<string, FakeSaved>;
  readonly machineTypes: ReadonlyArray<string>;
  readonly calls: Array<string>;
  count: number;
  clock: number;
  failSetup: boolean;
  /** The next Thread create reaches Boat, but its answer is lost. */
  loseNextThreadCreate: boolean;
}

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ ok: status < 400, ...body }), {
    status,
    headers: { "content-type": "application/json" },
  });

const error = (status: number, code: string, message: string) =>
  json(
    {
      type: "sandbox.error",
      status,
      code,
      message,
      error: { code, message, status },
      requestId: "req_test",
    },
    status,
  );

const sandboxJson = (sandbox: FakeSandbox) => ({
  id: sandbox.id,
  name: sandbox.name,
  state: sandbox.state,
  type: sandbox.type,
  ttlSeconds: sandbox.ttlSeconds,
  dataExpiredAt: sandbox.dataExpiredAt,
  desktopAvailable: false,
  snapshotAvailable: true,
});

const decode = (content: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(content), (character) => character.charCodeAt(0)),
  );

const encode = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** The single-quoted arguments of a `sh -c '<script>' sh '<a>' '<b>'` line. */
const shArgs = (command: string) =>
  [...command.matchAll(/'((?:[^']|'\\'')*)'/g)]
    .map(([, value]) => (value as string).replaceAll(`'\\''`, "'"))
    .slice(1);

const sandboxId = (count: number) => `bx_${String(count).padStart(8, "a")}`;

const FILE_ROOTS = ["/home/user/", "/tmp/"];

/** Boat's REST API (`/api/v1`), in memory, at the HTTP boundary. */
const fakeBoat =
  (world: World) =>
  async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    world.calls.push(`${request.method} ${url.pathname}`);
    if (url.host !== "boat.dev" || !url.pathname.startsWith("/api/v1/"))
      return new Response(null, { status: 599 });
    // A signed file URL carries its own authorization.
    const signed = /^\/api\/v1\/signed\/([^/]+)\/(upload|download)$/.exec(
      url.pathname,
    );
    if (signed !== null) {
      const files = world.sandboxes.get(signed[1] as string)?.files;
      const filePath = url.searchParams.get("path") ?? "";
      if (files === undefined) return new Response(null, { status: 404 });
      if (signed[2] === "upload") {
        files.set(filePath, await request.text());
        return new Response(null, { status: 200 });
      }
      const content = files.get(filePath);
      return content === undefined
        ? new Response(null, { status: 404 })
        : new Response(content);
    }
    const key = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const account = key === undefined ? undefined : world.keys.get(key);
    if (account === undefined)
      return error(401, "unauthorized", "Invalid API key");
    const path = url.pathname.slice("/api/v1".length);
    const body =
      request.method === "GET" || request.method === "DELETE"
        ? undefined
        : ((await request.json().catch(() => undefined)) as
            | Record<string, unknown>
            | undefined);
    if (path === "/me")
      return json({
        type: "user.info",
        user: { id: account.id, zeroDataRetention: account.zeroDataRetention },
      });
    if (path === "/limits")
      return json({
        canStart: true,
        activeSandboxes: world.sandboxes.size,
        maxActiveSandboxes: 100,
        billingStatus: "active",
        sandboxPlanKey: account.plan,
        machineTypes: ["small", "default", "large", "xlarge"].map((type) => ({
          type,
          available: world.machineTypes.includes(type),
          reason: world.machineTypes.includes(type)
            ? null
            : "needs the $100 plan",
        })),
      });
    if (path === "/sandboxes" && request.method === "POST") {
      const idempotencyKey = request.headers.get("idempotency-key");
      const replay = [...world.sandboxes.values()].find(
        (sandbox) =>
          idempotencyKey !== null && sandbox.idempotencyKey === idempotencyKey,
      );
      if (replay !== undefined)
        return json(
          {
            type: "sandbox.created",
            status: "ready",
            ttlSeconds: replay.ttlSeconds,
            sandbox: sandboxJson(replay),
          },
          202,
        );
      const type = (body?.type as string | undefined) ?? "default";
      if (!world.machineTypes.includes(type))
        return error(
          403,
          "machine_class_plan_required",
          `${type} needs the $100 plan.`,
        );
      const from = (body?.from as string | undefined) ?? null;
      const saved = from === null ? undefined : world.saved.get(from);
      if (from !== null && saved?.status !== "ready")
        return error(404, "snapshot_not_found", "No such saved snapshot");
      world.count += 1;
      const sandbox: FakeSandbox = {
        id: sandboxId(world.count),
        type,
        from,
        name: body?.name as string,
        noEnv: body?.noEnv === true,
        monitoring: body?.monitoring !== false,
        idempotencyKey,
        state: "provisioning",
        ttlSeconds: (body?.ttlSeconds as number | undefined) ?? 3600,
        dataExpiredAt: null,
        bootedAt: world.clock,
        orb: saved?.orb ?? false,
        setupPolls: 0,
        files: new Map(),
        execs: [],
      };
      world.sandboxes.set(sandbox.id, sandbox);
      if (world.loseNextThreadCreate && sandbox.name.startsWith("dx thr_")) {
        world.loseNextThreadCreate = false;
        return error(500, "http_500", "Internal error");
      }
      return json(
        {
          type: "sandbox.created",
          status: "provisioning",
          ttlSeconds: sandbox.ttlSeconds,
          sandbox: sandboxJson(sandbox),
        },
        202,
      );
    }
    const savedName = /^\/saved-snapshots\/([^/]+)$/.exec(path)?.[1];
    if (path === "/saved-snapshots" && request.method === "POST") {
      if (account.plan === "trial")
        return error(
          403,
          "trial_saved_snapshots_not_allowed",
          "Not during the trial.",
        );
      const source = world.sandboxes.get(body?.sandboxId as string);
      if (source === undefined)
        return error(404, "not_found", "No such sandbox");
      const saved: FakeSaved = {
        name: body?.name as string,
        status: "saving",
        createdAt: timestamp,
        orb: source.orb,
      };
      world.saved.set(saved.name, saved);
      return json(
        {
          type: "snapshot.saved.saving",
          status: "saving",
          snapshot: { ...saved, sourceSandboxId: source.id },
        },
        202,
      );
    }
    if (path === "/saved-snapshots" && request.method === "GET")
      return json({
        type: "snapshot.saved.list",
        snapshots: [...world.saved.values()],
      });
    if (savedName !== undefined) {
      const saved = world.saved.get(decodeURIComponent(savedName));
      if (saved === undefined)
        return error(404, "snapshot_not_found", "No such saved snapshot");
      if (request.method === "DELETE") {
        world.saved.delete(saved.name);
        return json({
          type: "snapshot.saved.deleted",
          name: saved.name,
          status: "deleted",
        });
      }
      const shown = { ...saved };
      // A save settles by the time anyone looks again.
      saved.status = "ready";
      return json({ type: "snapshot.saved.info", snapshot: shown });
    }
    const match = /^\/sandboxes\/([^/]+)(\/.*)?$/.exec(path);
    const sandbox =
      match === null ? undefined : world.sandboxes.get(match[1] as string);
    if (match === null || sandbox === undefined)
      return error(404, "not_found", "No such sandbox");
    const action = match[2] ?? "";
    if (action === "" && request.method === "GET") {
      // A sandbox runs by the time anyone looks.
      if (sandbox.state === "provisioning" || sandbox.state === "provisioned")
        sandbox.state = "ready";
      return json({ sandbox: sandboxJson(sandbox) });
    }
    if (action === "" && request.method === "PATCH") {
      if ("ttlSeconds" in (body ?? {}))
        sandbox.ttlSeconds = body?.ttlSeconds as number | null;
      return json({ sandbox: sandboxJson(sandbox) });
    }
    if (action === "" && request.method === "DELETE") {
      if (request.headers.get("x-ascii-confirm-delete") !== sandbox.id)
        return error(409, "confirmation_required", "Confirm the delete.");
      world.sandboxes.delete(sandbox.id);
      world.deleted.push(sandbox);
      return json(
        {
          type: "deletion.operation",
          operation: {
            id: "del_1",
            kind: "sandbox",
            targetId: sandbox.id,
            status: "pending",
          },
        },
        202,
      );
    }
    if (action === "/stop") {
      if (sandbox.state === "archived")
        // Boat's own answer, 2026-10-31.
        return error(
          400,
          "stop_failed",
          "Sandbox is archived, so it cannot be stopped.",
        );
      sandbox.state = "archived";
      return json({ id: "stop_1", status: "pending" }, 202);
    }
    if (action === "/resume") {
      if (sandbox.dataExpiredAt !== null)
        return error(409, "snapshot_data_expired", "The disk is gone.");
      if (typeof body?.ttlSeconds === "number")
        sandbox.ttlSeconds = body.ttlSeconds;
      // A new machine boots with the sandbox's disk.
      sandbox.state = "provisioned";
      sandbox.bootedAt = world.clock;
      return json({ id: sandbox.id, status: "resuming" }, 202);
    }
    if (action === "/files") {
      const filePath =
        (request.method === "GET"
          ? url.searchParams.get("path")
          : (body?.path as string)) ?? "";
      if (!FILE_ROOTS.some((root) => filePath.startsWith(root)))
        return error(400, "invalid_path", "Outside /home/user and /tmp");
      if (sandbox.state !== "ready")
        return error(409, "sandbox_not_ready", "Not running");
      if (request.method === "PUT") {
        sandbox.files.set(filePath, decode(body?.content as string));
        return json({
          type: "file.written",
          success: true,
          path: filePath,
          encoding: "base64",
          size: 0,
        });
      }
      const content = sandbox.files.get(filePath);
      if (content === undefined) return error(404, "not_found", "No such file");
      // Boat's own answer, 2026-10-31.
      if (content.length > 5 * 1024 * 1024)
        return error(
          400,
          "sandbox_direct_failed",
          `File is too large for read_file (${content.length} bytes > 5242880). Use a download URL instead: POST /sandboxes/{id}/files/download-url.`,
        );
      return json({
        type: "file.read",
        success: true,
        path: filePath,
        encoding: "base64",
        size: content.length,
        content: encode(content),
      });
    }
    const signedKind = /^\/files\/(upload|download)-url$/.exec(action)?.[1];
    if (signedKind !== undefined && request.method === "POST")
      return json({
        url: `https://boat.dev/api/v1/signed/${sandbox.id}/${signedKind}?${new URLSearchParams({ path: body?.path as string })}`,
      });
    if (action === "/commands") {
      if (sandbox.state !== "ready")
        return error(409, "sandbox_not_ready", "Not running");
      const command = body?.command as string;
      const asRoot = command.startsWith("sudo -n ");
      sandbox.execs.push({ command, asRoot });
      const done = (stdout: string, exitCode = 0) =>
        json({
          type: "command.finished",
          success: exitCode === 0,
          exitCode,
          stdout,
          stderr: "",
          timedOut: false,
        });
      // A staged file copied into place: `sh -c '…' sh <staged> <target>`.
      if (command.includes('cat -- "$1" >"$2"')) {
        const [staged, target] = shArgs(command.replace(/^sudo -n /, ""));
        const content = sandbox.files.get(staged as string);
        if (content === undefined) return done("", 1);
        sandbox.files.delete(staged as string);
        sandbox.files.set(target as string, content);
        return done("");
      }
      if (
        command.includes("setsid nohup bash /var/lib/dx-orb-setup/vm-setup.sh")
      )
        return done("started\n");
      if (command.includes("tail -c 400 /var/lib/dx-orb-setup/setup.log"))
        return done("E: Unable to locate package gh\n");
      if (command.includes("cat /var/lib/dx-orb-setup/status")) {
        sandbox.setupPolls += 1;
        if (sandbox.setupPolls < 2) return done("running\n");
        if (world.failSetup) return done("failed\n");
        sandbox.orb = true;
        return done("done\n");
      }
      // Boat runs a sandbox on a machine from a pool that booted long
      // before (seen 2026-10-31), so /proc/stat's boot time says nothing
      // about the Orb; dx-orb.service's process starts with each resume.
      if (command.includes("/proc/stat"))
        return done(`${sandbox.bootedAt - 3_600}\n`);
      if (command.includes("MainPID") && command.includes("etimes"))
        return done(`${sandbox.bootedAt}\n`);
      if (command.includes("systemctl is-active --quiet dx-orb.service"))
        return done("", sandbox.orb ? 0 : 1);
      return done(`ran as ${asRoot ? "root" : "user"}`);
    }
    return new Response(null, { status: 599 });
  };

let world: World;
let connectors: OrbProviderConnectors;

const app = () => {
  const router = new Hono<AppEnv>();
  router.use("*", requestId);
  router.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId: solo,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  router.route(
    "/personal/orb-providers",
    makePersonalOrbProviderRoutes({ connectors }),
  );
  router.onError(errorHandler);
  return router;
};

const call = async (
  path: string,
  method: "GET" | "PUT" = "GET",
  body?: unknown,
) => {
  const response = await app().request(
    `/personal/orb-providers${path}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
    bindings,
  );
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  return { status: response.status, body: (await response.json()) as any };
};

const boatOf = (data: {
  readonly providers: ReadonlyArray<{ readonly id: string }>;
}) =>
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  data.providers.find(({ id }) => id === "boat") as any;

const key = {
  scope: "personal",
  targetId: solo,
  providerId: "boat",
} as const;

const prepare = async () => {
  const steps: Array<string> = [];
  for (let step = 0; step < 40; step += 1) {
    const outcome = await advanceConnection(bindings, env.DB, key, connectors);
    steps.push(
      boatOf((await call("")).body.data).connection?.progress?.step ?? "done",
    );
    if (outcome.nextStepInMs === undefined) return steps;
  }
  throw new Error("Preparation never finished.");
};

const pinThread = async (id: string, runnerProfileId?: string) => {
  await env.DB.prepare(
    "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, project, solo, timestamp, timestamp)
    .run();
  const pin = await resolveThreadExecutionPin({
    db: env.DB,
    bindings,
    userId: solo,
    projectId: project,
    runnerProfileId,
    connectors,
  });
  await env.DB.prepare(
    `UPDATE execution_workspace
        SET provider = ?, runner_profile_id = ?, account_scope = ?,
            account_owner_id = ?, provider_account = ?, provider_template = ?
      WHERE thread_id = ?`,
  )
    .bind(
      pin?.provider,
      pin?.runnerProfileId,
      pin?.credentialScope,
      pin?.credentialOwnerId,
      pin?.credentialAccount,
      pin?.providerTemplate,
      id,
    )
    .run();
  const target = await Effect.runPromise(
    resolveExecutionTarget(bindings, id, { admission: false }),
  );
  return { pin, target };
};

const record = async (id: string) =>
  env.DB.prepare(
    "SELECT provider, state, provider_sandbox_id FROM execution_workspace WHERE thread_id = ?",
  )
    .bind(id)
    .first();

beforeEach(async () => {
  const paid: FakeAccount = {
    id: accountId,
    plan: "p20",
    zeroDataRetention: false,
  };
  world = {
    keys: new Map([
      ["boat_key_1", paid],
      ["box_key_2", paid],
      [
        "boat_trial",
        { id: "usr_trial", plan: "trial", zeroDataRetention: false },
      ],
      ["boat_zdr", { id: "usr_zdr", plan: "p20", zeroDataRetention: true }],
    ]),
    sandboxes: new Map(),
    deleted: [],
    saved: new Map(),
    // The $20 plan: no xlarge.
    machineTypes: ["small", "default", "large"],
    calls: [],
    count: 0,
    clock: 1_793_000_000,
    failSetup: false,
    loseNextThreadCreate: false,
  };
  connectors = {
    boat: makeBoatConnector({ fetch: fakeBoat(world) as typeof fetch }),
  };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(solo, solo, `${solo}@example.com`, 1, 1),
    env.DB.prepare(
      `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Boat project', 'bt.medium', ?, ?)`,
    ).bind(project, solo, timestamp, timestamp),
  ]);
});

describe("Boat in a person's own account", () => {
  it("saves one Orb snapshot, tests it, and runs a Thread's sandbox through stop and resume", async () => {
    const listed = await call("");
    expect(boatOf(listed.body.data)).toMatchObject({
      deployment: false,
      connection: null,
      pauseResume: "filesystem",
      fields: [{ id: "apiKey", secret: true }],
    });
    expect(
      boatOf(listed.body.data).sizes.map(({ id }: { id: string }) => id),
    ).toEqual(BOAT_ORB_SIZES.map(({ id }) => id));

    // A refused key, a trial account, and a zero-data-retention account
    // fail in the save request, before anything runs in Boat.
    const refused = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "not-a-key" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.data.detail).toBe("Boat rejected this API key.");
    const trial = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "boat_trial" },
    });
    expect(trial.status).toBe(400);
    expect(trial.body.data.detail).toMatch(/free trial cannot save snapshots/);
    const zdr = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "boat_zdr" },
    });
    expect(zdr.status).toBe(400);
    expect(zdr.body.data.detail).toMatch(/zero data retention/);
    expect(
      world.calls.filter((call) => call === "POST /api/v1/sandboxes"),
    ).toEqual([]);

    const saved = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "boat_key_1" },
    });
    expect(saved.status).toBe(200);
    expect(boatOf(saved.body.data).connection).toMatchObject({
      account: accountId,
      status: "preparing",
    });

    const steps = [...new Set(await prepare())];
    expect(steps).toEqual([
      "Building the Orb in your Boat account",
      "Starting a test Orb",
      "done",
    ]);

    // One stock sandbox, with none of the account's secrets and no
    // retained command output, ran the VM recipe as root and became the
    // saved snapshot; then it was deleted.
    const recipe = await (connectors.boat?.recipe() as Promise<string>);
    const snapshot = `dx-orb-${recipe}`;
    expect([...world.saved.keys()]).toEqual([snapshot]);
    expect(world.sandboxes.size).toBe(0);
    const build = world.deleted.find(({ name }) =>
      name.startsWith("dx-orb-build-"),
    );
    expect(build).toMatchObject({ from: null, noEnv: true, monitoring: false });
    expect(build?.files.get("/var/lib/dx-orb-setup/vm-setup.sh")).toBe(vmSetup);
    expect(build?.files.has("/var/lib/dx-orb-setup/files/dx-orb-init")).toBe(
      true,
    );
    expect(build?.execs.every(({ asRoot }) => asRoot)).toBe(true);
    // The test Orb started from the snapshot and found dx-orb-init running.
    const probe = world.deleted.find(({ name }) => name === "dx-orb-probe");
    expect(probe).toMatchObject({ from: snapshot, orb: true, noEnv: true });

    const ready = await call("");
    expect(boatOf(ready.body.data).connection).toMatchObject({
      status: "ready",
      account: accountId,
      unavailableSizes: [
        {
          id: "bt.xlarge",
          reason:
            "Your Boat plan does not include this size (Boat: needs the $100 plan).",
        },
      ],
    });

    // A Thread on bt.medium pins the one snapshot; the plan has no xlarge.
    const { pin, target } = await pinThread(threadId);
    expect(pin).toEqual({
      provider: "boat",
      runnerProfileId: "bt.medium",
      credentialScope: "personal",
      credentialOwnerId: solo,
      credentialAccount: accountId,
      providerTemplate: snapshot,
    });
    await expect(
      resolveThreadExecutionPin({
        db: env.DB,
        bindings,
        userId: solo,
        projectId: project,
        runnerProfileId: "bt.xlarge",
        connectors,
      }),
    ).rejects.toMatchObject({ reason: "size-unavailable" });
    expect(target.profile).toMatchObject({
      adapter: "boat",
      machineType: "default",
      snapshot,
    });
    if (target.credential.scope !== "personal") throw new Error("no account");
    expect(Redacted.value(target.credential.credentials)).toEqual({
      apiKey: "boat_key_1",
    });

    const provider = makeBoatExecutionProvider({
      fetch: fakeBoat(world) as typeof fetch,
    });
    const context: ExecutionContext = {
      account: { scope: "personal", userId: solo, providerAccount: accountId },
      credentials: target.credential.credentials,
      profile: target.profile,
    };
    const authorize = async () => {};

    // The first create reaches Boat but its answer is lost; the retry gets
    // the same sandbox back instead of a second one.
    world.loseNextThreadCreate = true;
    await expect(
      provider.workspace.create(
        context,
        { threadId: threadId as never },
        { authorize },
      ),
    ).rejects.toThrow();
    const handle = await provider.workspace.create(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    expect(world.sandboxes.size).toBe(1);
    const sandbox = [...world.sandboxes.values()][0] as FakeSandbox;
    expect(sandbox).toMatchObject({
      from: snapshot,
      type: "default",
      noEnv: true,
      monitoring: false,
      state: "ready",
      // One idle window (DX_WORKSPACE_INACTIVITY_MS's default).
      ttlSeconds: 300,
    });
    expect(await record(threadId)).toEqual({
      provider: "boat",
      state: "initialized",
      provider_sandbox_id: sandbox.id,
    });
    expect(handle.processesStartedAt).toBe(world.clock * 1_000);

    // Commands and writes run as the workspace account.
    const ran = await handle.guest.commands.run("pwd", {
      cwd: "/home/user/workspace",
      envs: { DX_EXAMPLE: "it's" },
    });
    expect(ran).toMatchObject({ exitCode: 0, stdout: "ran as user" });
    await handle.guest.files.write("/home/user/note.txt", "hello");
    expect(sandbox.files.get("/home/user/note.txt")).toBe("hello");
    const flue = await handle.sandbox("/home/user/workspace");
    await flue.writeFile("/opt/dx-note.txt", "outside");
    expect(sandbox.files.get("/opt/dx-note.txt")).toBe("outside");
    expect(await flue.readFile("/home/user/note.txt")).toBe("hello");
    // Above 5 MiB, files go through Boat's signed URLs both ways.
    const large = "x".repeat(6 * 1024 * 1024);
    await flue.writeFile("/home/user/large.txt", large);
    expect(sandbox.files.get("/home/user/large.txt")).toBe(large);
    expect(await flue.readFile("/home/user/large.txt")).toBe(large);
    expect(sandbox.execs.some(({ asRoot }) => asRoot)).toBe(false);

    // Core moves Boat's own auto-stop forward while the Orb is in use.
    await handle.setIdleDeadline(900_000);
    expect(sandbox.ttlSeconds).toBe(900);

    // Idle: Boat's auto-stop stops the sandbox, keeping only its disk. The
    // next activation resumes it on a new machine and reports the new boot.
    sandbox.state = "archived";
    world.clock += 3_600;
    const residency: Array<string> = [];
    const woken = await provider.workspace.create(
      context,
      { threadId: threadId as never },
      {
        authorize,
        observeResidency: (seen) => {
          residency.push(seen);
        },
      },
    );
    expect(residency).toEqual(["paused"]);
    expect(sandbox).toMatchObject({ state: "ready", ttlSeconds: 300 });
    expect(woken.processesStartedAt).toBe(world.clock * 1_000);
    expect(world.sandboxes.size).toBe(1);
    // A connect to the running sandbox resumes nothing.
    const resumes = world.calls.filter((call) =>
      call.endsWith("/resume"),
    ).length;
    await provider.workspace.connect(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    expect(world.calls.filter((call) => call.endsWith("/resume")).length).toBe(
      resumes,
    );

    // Archiving stops the sandbox; deleting the Thread deletes it.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "archive",
    );
    expect(sandbox.state).toBe("archived");
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "archive",
    );
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "destroy",
    );
    expect(world.sandboxes.size).toBe(0);
    expect(world.deleted.at(-1)?.id).toBe(sandbox.id);
    expect(await record(threadId)).toMatchObject({ state: "lost" });

    // A new key for the same account keeps the snapshot it already saved:
    // preparing again starts only a test Orb.
    const created = world.calls.filter(
      (call) => call === "POST /api/v1/sandboxes",
    ).length;
    const rotating = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "box_key_2" },
    });
    expect(boatOf(rotating.body.data).connection).toMatchObject({
      account: accountId,
      status: "preparing",
      updating: true,
    });
    await prepare();
    expect(boatOf((await call("")).body.data).connection).toMatchObject({
      status: "ready",
      updating: false,
    });
    expect([...world.saved.keys()]).toEqual([snapshot]);
    expect(
      world.calls.filter((call) => call === "POST /api/v1/sandboxes").length -
        created,
    ).toBe(1);

    // The person moves to the $100 plan and checks again: the same
    // snapshot now serves bt.xlarge, after one more test Orb.
    world.machineTypes = ["small", "default", "large", "xlarge"];
    expect((await call("/boat/connection/retry", "POST")).status).toBe(200);
    await prepare();
    expect(boatOf((await call("")).body.data).connection).toMatchObject({
      status: "ready",
      unavailableSizes: [],
    });
    const xlarge = await resolveThreadExecutionPin({
      db: env.DB,
      bindings,
      userId: solo,
      projectId: project,
      runnerProfileId: "bt.xlarge",
      connectors,
    });
    expect(xlarge).toMatchObject({
      runnerProfileId: "bt.xlarge",
      providerTemplate: snapshot,
    });
    expect([...world.saved.keys()]).toEqual([snapshot]);
    expect(
      world.calls.filter((call) => call === "POST /api/v1/sandboxes").length -
        created,
    ).toBe(2);
  }, 30_000);

  it("marks a Thread lost when Boat deleted its stopped disk after 14 days", async () => {
    await call("/boat/connection", "PUT", {
      credentials: { apiKey: "boat_key_1" },
    });
    await prepare();
    const { target } = await pinThread(threadId);
    const provider = makeBoatExecutionProvider({
      fetch: fakeBoat(world) as typeof fetch,
    });
    const context: ExecutionContext = {
      account: { scope: "personal", userId: solo, providerAccount: accountId },
      credentials:
        target.credential.scope === "personal"
          ? target.credential.credentials
          : undefined,
      profile: target.profile,
    };
    const authorize = async () => {};
    await provider.workspace.create(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    const sandbox = [...world.sandboxes.values()][0] as FakeSandbox;
    sandbox.state = "archived";
    sandbox.dataExpiredAt = timestamp;
    await expect(
      provider.workspace.connect(
        context,
        { threadId: threadId as never },
        { authorize },
      ),
    ).rejects.toMatchObject({
      reason: "Boat deleted this Orb's disk 14 days after it stopped",
    });
    expect(await record(threadId)).toMatchObject({ state: "lost" });
    // Destroying a lost Thread calls nothing more.
    const calls = world.calls.length;
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "destroy",
    );
    expect(world.calls.length).toBe(calls);
  }, 30_000);

  it("fails with the end of the setup log and leaves no build sandbox when the Orb setup fails", async () => {
    world.failSetup = true;
    const saved = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "boat_key_1" },
    });
    expect(saved.status).toBe(200);
    await prepare();
    expect(boatOf((await call("")).body.data).connection).toMatchObject({
      status: "failed",
      error: "The Orb setup failed: E: Unable to locate package gh",
    });
    expect(world.sandboxes.size).toBe(0);
    expect(world.saved.size).toBe(0);
  }, 30_000);
});
