import { env } from "cloudflare:test";
import {
  FREESTYLE_ORB_SIZES,
  Principal,
  type RunnerProfileId,
  type UserId,
} from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import vmSetup from "../../../../deploy/orb/vm-setup.sh?raw";
import { makeFreestyleConnector } from "../../src/execution/freestyle/connector.js";
import { makeFreestyleExecutionProvider } from "../../src/execution/freestyle/provider.js";
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

const solo = "fs-orb-solo" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000006b1";
const threadId = "thr_00000000-0000-4000-8000-0000000006c1";
const timestamp = "2026-10-23T00:00:00.000Z";
const accountId = "acct-00000000-0000-4000-8000-0000000006a1";

/** No deployment provider: Freestyle runs only on a person's account. */
const bindings: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};

/** Freestyle's base snapshots, at their baked-in vCPU counts. */
const BASE_CPUS: Record<string, number> = {
  "freestyle/ubuntu-sm": 2,
  "freestyle/ubuntu": 4,
  "freestyle/ubuntu-lg": 8,
};

interface FakeVm {
  readonly id: string;
  readonly slug: string | null;
  readonly snapshotId: string;
  readonly displayName: string | null;
  readonly cpus: number;
  state: "starting" | "running" | "paused";
  totalRunSeconds: number;
  maxRunTotalSeconds: number | null;
  setupPolls: number;
  readonly files: Map<string, string>;
  readonly execs: Array<{ command: string; linuxUser: string | undefined }>;
}

interface World {
  readonly keys: Set<string>;
  readonly vms: Map<string, FakeVm>;
  readonly deletedVms: Array<FakeVm>;
  readonly snapshots: Map<
    string,
    { id: string; displayName: string; createdAt: string; cpus: number }
  >;
  /** The plan's per-VM vCPU maximum (Free: 4); an upgrade raises it. */
  maxCpus: number;
  readonly calls: Array<string>;
  vmCount: number;
  backgrounded: number;
  /** The base snapshot whose setup fails, if any. */
  failSetupOn: string | undefined;
  readonly background: Map<string, Response>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const error = (status: number, code: string, message: string) =>
  json({ code, message }, status);

const vmJson = (vm: FakeVm) => ({
  id: vm.id,
  slug: vm.slug,
  state: vm.state,
  snapshotId: vm.snapshotId,
  totalRunSeconds: vm.totalRunSeconds,
  maxRunTotalSeconds: vm.maxRunTotalSeconds,
  resources: { cpu: vm.cpus, memory: vm.cpus * 2048, storage: vm.cpus * 8192 },
  createdAt: timestamp,
  updatedAt: timestamp,
});

const decode = (stdin: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(stdin), (character) => character.charCodeAt(0)),
  );

/** Freestyle's REST API (`/v5`), in memory, at the HTTP boundary. */
const fakeFreestyle =
  (world: World) =>
  async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    world.calls.push(`${request.method} ${url.pathname}`);
    if (url.host !== "api.freestyle.sh")
      return new Response(null, { status: 599 });
    const key = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (key === undefined || !world.keys.has(key))
      return error(401, "UNAUTHORIZED", "Invalid API key");
    const path = url.pathname;
    const body =
      request.method === "GET" || request.method === "DELETE"
        ? undefined
        : ((await request.json().catch(() => undefined)) as
            | Record<string, unknown>
            | undefined);
    if (path === "/v5/identities" && request.method === "GET")
      return json({ identities: [{ id: "ident-1", managed: true }], total: 1 });
    if (path === "/v5/identities/ident-1")
      return json({ id: "ident-1", accountId, managed: true });
    const stored = /^\/v5\/background-requests\/(.+)$/.exec(path)?.[1];
    if (stored !== undefined) {
      const response = world.background.get(stored);
      if (response === undefined) return json({}, 202);
      world.background.delete(stored);
      return response;
    }
    if (path === "/v5/vms" && request.method === "POST") {
      const snapshotId = body?.snapshotId as string;
      const cpus =
        BASE_CPUS[snapshotId] ?? world.snapshots.get(snapshotId)?.cpus;
      if (cpus === undefined)
        return error(400, "BAD_REQUEST", "No such snapshot");
      if (cpus > world.maxCpus)
        return error(
          429,
          "LIMIT_EXCEEDED",
          `Your plan allows ${world.maxCpus} vCPUs per VM.`,
        );
      const slug = (body?.slug as string | undefined) ?? null;
      if (
        slug !== null &&
        [...world.vms.values()].some((vm) => vm.slug === slug)
      )
        return error(409, "CONFLICT", "Slug taken");
      world.vmCount += 1;
      const vm: FakeVm = {
        id: `vm-${world.vmCount}`,
        slug,
        snapshotId,
        displayName: (body?.displayName as string | undefined) ?? null,
        cpus,
        state: "starting",
        totalRunSeconds: 0,
        maxRunTotalSeconds:
          (body?.maxRunTotalSeconds as number | undefined) ?? null,
        setupPolls: 0,
        files: new Map(),
        execs: [],
      };
      world.vms.set(vm.id, vm);
      return json(vmJson(vm), 201);
    }
    if (path === "/v5/snapshots" && request.method === "GET") {
      const search = url.searchParams.get("search") ?? "";
      return json({
        snapshots: [...world.snapshots.values()].filter(({ displayName }) =>
          displayName.includes(search),
        ),
        totalCount: world.snapshots.size,
      });
    }
    const snapshot = /^\/v5\/snapshots\/(.+)$/.exec(path)?.[1];
    if (snapshot !== undefined && request.method === "DELETE") {
      world.snapshots.delete(snapshot);
      return new Response(null, { status: 204 });
    }
    const match = /^\/v5\/vms\/([^/]+)(\/.*)?$/.exec(path);
    const vm =
      match === null
        ? undefined
        : (world.vms.get(decodeURIComponent(match[1] as string)) ??
          [...world.vms.values()].find(
            ({ slug }) => slug === decodeURIComponent(match[1] as string),
          ));
    if (match === null || vm === undefined)
      return error(404, "NOT_FOUND", "No such VM");
    const action = match[2] ?? "";
    if (action === "" && request.method === "GET") {
      const shown = vmJson(vm);
      // A VM is running by the time anyone looks again.
      if (vm.state === "starting") vm.state = "running";
      return json(shown);
    }
    if (action === "" && request.method === "PATCH") {
      if (typeof body?.maxRunTotalSeconds === "number")
        vm.maxRunTotalSeconds = body.maxRunTotalSeconds;
      return json(vmJson(vm));
    }
    if (action === "" && request.method === "DELETE") {
      world.vms.delete(vm.id);
      world.deletedVms.push(vm);
      return new Response(null, { status: 204 });
    }
    if (action === "/start") {
      if (
        vm.maxRunTotalSeconds !== null &&
        vm.totalRunSeconds >= vm.maxRunTotalSeconds
      )
        return error(409, "CONFLICT", "Run budget spent");
      vm.state = "starting";
      return json(vmJson(vm));
    }
    if (action === "/pause") {
      if (vm.state !== "running") return error(409, "CONFLICT", "Not running");
      vm.state = "paused";
      return json(vmJson(vm));
    }
    if (action === "/snapshot") {
      const id = `snap-${world.snapshots.size + 1}`;
      world.snapshots.set(id, {
        id,
        displayName: body?.displayName as string,
        createdAt: timestamp,
        cpus: vm.cpus,
      });
      const result = json({ snapshotId: id, snapshot: { id } });
      // The first snapshot outlives the request and is detached.
      if (world.backgrounded === 0) {
        world.backgrounded += 1;
        world.background.set("bg-1", result);
        return json({ requestId: "bg-1" }, 202);
      }
      return result;
    }
    if (action === "/exec-await") {
      if (vm.state !== "running") return error(409, "CONFLICT", "Not running");
      const command = body?.command as string;
      const linuxUser = body?.linuxUser as string | undefined;
      vm.execs.push({ command, linuxUser });
      const written = /cat >'([^']+)'$/.exec(command)?.[1];
      if (written !== undefined && typeof body?.stdin === "string") {
        vm.files.set(written, decode(body.stdin));
        return json({ stdout: "", stderr: "", statusCode: 0 });
      }
      if (
        command.includes("setsid nohup bash /var/lib/dx-orb-setup/vm-setup.sh")
      )
        return json({ stdout: "started\n", stderr: "", statusCode: 0 });
      if (command.startsWith("tail -c 400 /var/lib/dx-orb-setup/setup.log"))
        return json({
          stdout: "E: Unable to locate package gh\n",
          stderr: "",
          statusCode: 0,
        });
      if (command.startsWith("cat /var/lib/dx-orb-setup/status")) {
        vm.setupPolls += 1;
        return json({
          stdout:
            vm.setupPolls < 2
              ? "running\n"
              : vm.snapshotId === world.failSetupOn
                ? "failed\n"
                : "done\n",
          stderr: "",
          statusCode: 0,
        });
      }
      if (command.includes("supervisor.pid"))
        return json({
          stdout: "",
          stderr: "",
          statusCode: vm.snapshotId.startsWith("snap-") ? 0 : 1,
        });
      return json({ stdout: `ran as ${linuxUser}`, stderr: "", statusCode: 0 });
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
  method: "GET" | "PUT" | "POST" = "GET",
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

const freestyleOf = (data: {
  readonly providers: ReadonlyArray<{ readonly id: string }>;
}) =>
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  data.providers.find(({ id }) => id === "freestyle") as any;

const key = {
  scope: "personal",
  targetId: solo,
  providerId: "freestyle",
} as const;

const prepare = async () => {
  const steps: Array<string> = [];
  for (let step = 0; step < 40; step += 1) {
    const outcome = await advanceConnection(bindings, env.DB, key, connectors);
    steps.push(
      freestyleOf((await call("")).body.data).connection?.progress?.step ??
        "done",
    );
    if (outcome.nextStepInMs === undefined) return steps;
  }
  throw new Error("Preparation never finished.");
};

beforeEach(async () => {
  world = {
    keys: new Set(["fs-key-1", "fs-key-2"]),
    vms: new Map(),
    deletedVms: [],
    snapshots: new Map(),
    maxCpus: 4,
    calls: [],
    vmCount: 0,
    backgrounded: 0,
    failSetupOn: undefined,
    background: new Map(),
  };
  connectors = {
    freestyle: makeFreestyleConnector({
      fetch: fakeFreestyle(world) as typeof fetch,
    }),
  };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(solo, solo, `${solo}@example.com`, 1, 1),
    env.DB.prepare(
      `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Freestyle project', 'fs.medium', ?, ?)`,
    ).bind(project, solo, timestamp, timestamp),
  ]);
});

describe("Freestyle in a person's own account", () => {
  it("builds an Orb snapshot per size the plan allows, tests it, and runs a Thread's VM through pause and wake", async () => {
    const listed = await call("");
    expect(freestyleOf(listed.body.data)).toMatchObject({
      deployment: false,
      connection: null,
      pauseResume: "processes",
      fields: [{ id: "apiKey", secret: true }],
    });
    expect(
      freestyleOf(listed.body.data).sizes.map(({ id }: { id: string }) => id),
    ).toEqual(FREESTYLE_ORB_SIZES.map(({ id }) => id));

    // A refused key fails in the save request.
    const refused = await call("/freestyle/connection", "PUT", {
      credentials: { apiKey: "not-a-key" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.data.detail).toBe("Freestyle rejected this API key.");

    const saved = await call("/freestyle/connection", "PUT", {
      credentials: { apiKey: "fs-key-1" },
    });
    expect(saved.status).toBe(200);
    expect(freestyleOf(saved.body.data).connection).toMatchObject({
      account: accountId,
      status: "preparing",
    });

    const steps = [...new Set(await prepare())];
    expect(steps).toEqual([
      "Building the Orb (fs.small, fs.medium) in your Freestyle account",
      "Starting a test Orb",
      "done",
    ]);

    // Each allowed size booted its own base, ran the VM recipe as root, and
    // became a snapshot; the plan refused fs.large. No build VM is left.
    const recipe = await (connectors.freestyle?.recipe() as Promise<string>);
    expect(
      [...world.snapshots.values()].map(({ displayName }) => displayName),
    ).toEqual(
      expect.arrayContaining([
        `dx-orb-${recipe}-fs.small`,
        `dx-orb-${recipe}-fs.medium`,
      ]),
    );
    expect(world.snapshots.size).toBe(2);
    expect(world.vms.size).toBe(0);
    const builds = world.deletedVms.filter(({ displayName }) =>
      displayName?.startsWith("dx-orb-build-"),
    );
    expect(builds.map(({ snapshotId }) => snapshotId).sort()).toEqual([
      "freestyle/ubuntu",
      "freestyle/ubuntu-sm",
    ]);
    for (const build of builds) {
      expect(build.files.get("/var/lib/dx-orb-setup/vm-setup.sh")).toBe(
        vmSetup,
      );
      expect(build.files.has("/var/lib/dx-orb-setup/files/dx-orb-init")).toBe(
        true,
      );
      expect(new Set(build.execs.map(({ linuxUser }) => linuxUser))).toEqual(
        new Set(["root"]),
      );
    }
    // The test Orb booted from the smallest snapshot and ran as `user`.
    const probe = world.deletedVms.find(
      ({ displayName }) => displayName === "dx-orb-probe",
    );
    expect(probe?.snapshotId).toBe("snap-1");
    expect(probe?.execs.map(({ linuxUser }) => linuxUser)).toEqual(["user"]);

    const ready = await call("");
    expect(freestyleOf(ready.body.data).connection).toMatchObject({
      status: "ready",
      account: accountId,
    });
    // The plan refused fs.large, so the picker leaves it out.
    expect(ready.body.data.resolved).toEqual([
      {
        providerId: "freestyle",
        scope: "personal",
        account: accountId,
        status: "ready",
        unavailableSizes: [
          {
            id: "fs.large",
            reason: "Your plan allows 4 vCPUs per VM.",
          },
        ],
      },
    ]);

    // A Thread on fs.medium pins that size's snapshot.
    await env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(threadId, project, solo, timestamp, timestamp)
      .run();
    const pin = await resolveThreadExecutionPin({
      db: env.DB,
      bindings,
      userId: solo,
      projectId: project,
      runnerProfileId: undefined,
      connectors,
    });
    expect(pin).toEqual({
      provider: "freestyle",
      runnerProfileId: "fs.medium",
      credentialScope: "personal",
      credentialOwnerId: solo,
      credentialAccount: accountId,
      providerTemplate: "snap-2",
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
        threadId,
      )
      .run();
    const target = await Effect.runPromise(
      resolveExecutionTarget(bindings, threadId, { admission: false }),
    );
    expect(target.profile).toMatchObject({
      adapter: "freestyle",
      baseSnapshot: "freestyle/ubuntu",
      snapshot: "snap-2",
    });
    if (target.credential.scope !== "personal") throw new Error("no account");
    expect(Redacted.value(target.credential.credentials)).toEqual({
      apiKey: "fs-key-1",
    });

    // The provider creates the Thread's VM from the pinned snapshot, with a
    // run budget of one idle window, and records it in D1.
    const provider = makeFreestyleExecutionProvider({
      fetch: fakeFreestyle(world) as typeof fetch,
    });
    const context: ExecutionContext = {
      account: { scope: "personal", userId: solo, providerAccount: accountId },
      credentials: target.credential.credentials,
      profile: target.profile,
    };
    const authorize = async () => {};
    const handle = await provider.workspace.create(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    const vm = [...world.vms.values()][0] as FakeVm;
    expect(vm).toMatchObject({
      slug: threadId.replaceAll("_", "-"),
      snapshotId: "snap-2",
      state: "running",
      maxRunTotalSeconds: 300,
    });
    const record = async () =>
      env.DB.prepare(
        "SELECT provider, state, provider_sandbox_id FROM execution_workspace WHERE thread_id = ?",
      )
        .bind(threadId)
        .first();
    expect(await record()).toEqual({
      provider: "freestyle",
      state: "initialized",
      provider_sandbox_id: vm.id,
    });

    // Commands and writes run as the workspace account.
    const ran = await handle.guest.commands.run("pwd", {
      cwd: "/home/user/workspace",
    });
    expect(ran).toMatchObject({ exitCode: 0, stdout: "ran as user" });
    await handle.guest.files.write("/home/user/note.txt", "hello");
    expect(vm.files.get("/home/user/note.txt")).toBe("hello");
    expect(vm.execs.at(-1)?.linuxUser).toBe("user");

    // Core moves the run deadline forward while the Orb is in use.
    vm.totalRunSeconds = 120;
    await handle.setIdleDeadline(300_000);
    expect(vm.maxRunTotalSeconds).toBe(420);

    // Idle: the budget runs out and Freestyle pauses the VM, memory and
    // all. The next activation raises the budget, then resumes it.
    vm.totalRunSeconds = 420;
    vm.state = "paused";
    const residency: Array<string> = [];
    await provider.workspace.connect(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    await provider.workspace.create(
      context,
      { threadId: threadId as never },
      {
        authorize,
        observeResidency: (seen) => {
          residency.push(seen);
        },
      },
    );
    expect(residency).toEqual(["running"]);
    expect(vm).toMatchObject({ state: "running", maxRunTotalSeconds: 720 });
    expect(world.vms.size).toBe(1);

    // Archiving pauses the VM; deleting the Thread deletes it.
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
    expect(vm.state).toBe("paused");
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "destroy",
    );
    expect(world.vms.size).toBe(0);
    expect(await record()).toMatchObject({ state: "lost" });

    // A new key for the same account keeps the snapshots it already made.
    const created = world.calls.filter(
      (call) => call === "POST /v5/vms",
    ).length;
    const rotating = await call("/freestyle/connection", "PUT", {
      credentials: { apiKey: "fs-key-2" },
    });
    expect(freestyleOf(rotating.body.data).connection).toMatchObject({
      account: accountId,
      status: "preparing",
      updating: true,
    });
    await prepare();
    expect(freestyleOf((await call("")).body.data).connection).toMatchObject({
      status: "ready",
      updating: false,
    });
    expect(world.snapshots.size).toBe(2);
    // Only the refused size was tried again, and one test Orb started.
    expect(
      world.calls.filter((call) => call === "POST /v5/vms").length - created,
    ).toBe(2);
    // Freestyle's detached requests and VM boots are polled in real time.
  }, 30_000);

  it("offers only the sizes the plan allows, refuses a Thread on another, and adds it after the plan is upgraded", async () => {
    expect(
      (
        await call("/freestyle/connection", "PUT", {
          credentials: { apiKey: "fs-key-1" },
        })
      ).status,
    ).toBe(200);
    await prepare();
    const sizesOf = async () => {
      const data = (await call("")).body.data;
      return {
        connection: freestyleOf(data).connection,
        picker: data.resolved[0],
      };
    };
    let now = await sizesOf();
    expect(now.connection).toMatchObject({
      status: "ready",
      unavailableSizes: [
        {
          id: "fs.large",
          reason: "Your plan allows 4 vCPUs per VM.",
        },
      ],
    });
    expect(now.picker.unavailableSizes).toEqual(
      now.connection.unavailableSizes,
    );

    // A Thread on the refused size says so, instead of "preparing".
    const pin = (runnerProfileId: string) =>
      resolveThreadExecutionPin({
        db: env.DB,
        bindings,
        userId: solo,
        projectId: project,
        runnerProfileId: runnerProfileId as RunnerProfileId,
        connectors,
      });
    await expect(pin("fs.large")).rejects.toMatchObject({
      _tag: "OrbUnavailable",
      reason: "size-unavailable",
    });

    // The person upgrades their plan, then checks again from the settings.
    world.maxCpus = 8;
    const checked = await call("/freestyle/connection/retry", "POST");
    expect(checked.status).toBe(200);
    // fs.small and fs.medium keep serving new Threads meanwhile.
    now = await sizesOf();
    expect(now.connection).toMatchObject({
      status: "preparing",
      updating: true,
    });
    expect(now.picker).toMatchObject({
      status: "ready",
      unavailableSizes: [{ id: "fs.large" }],
    });
    expect((await pin("fs.medium"))?.providerTemplate).toBe("snap-2");

    await prepare();
    now = await sizesOf();
    expect(now.connection).toMatchObject({
      status: "ready",
      unavailableSizes: [],
    });
    expect(now.picker.unavailableSizes).toEqual([]);
    const large = await pin("fs.large");
    expect(large?.runnerProfileId).toBe("fs.large");
    expect(world.snapshots.get(large?.providerTemplate as string)?.cpus).toBe(
      8,
    );
    // Check again only rebuilt the size the plan refused before.
    expect(world.snapshots.size).toBe(3);
  }, 30_000);

  it("checks a connection that lacks sizes again a day after it was ready, and not before", async () => {
    await call("/freestyle/connection", "PUT", {
      credentials: { apiKey: "fs-key-1" },
    });
    await prepare();
    const status = async () =>
      env.DB.prepare(
        "SELECT status, recipe FROM orb_connection WHERE target_id = ?",
      )
        .bind(solo)
        .first<{ status: string; recipe: string | null }>();
    // A read the same day leaves it ready.
    await call("");
    expect(await status()).toMatchObject({ status: "ready" });
    // A read a day later prepares it again, still serving its sizes.
    await env.DB.prepare(
      "UPDATE orb_connection SET updated_at = ? WHERE target_id = ?",
    )
      .bind(new Date(Date.now() - 25 * 60 * 60_000).toISOString(), solo)
      .run();
    world.maxCpus = 8;
    const read = (await call("")).body.data;
    expect(await status()).toEqual({ status: "preparing", recipe: null });
    expect(read.resolved[0]).toMatchObject({ status: "ready" });
    await prepare();
    expect(
      freestyleOf((await call("")).body.data).connection.unavailableSizes,
    ).toEqual([]);
  }, 30_000);

  it("fails with the end of the setup log and leaves no build VM when the Orb setup fails", async () => {
    world.failSetupOn = "freestyle/ubuntu";
    const saved = await call("/freestyle/connection", "PUT", {
      credentials: { apiKey: "fs-key-1" },
    });
    expect(saved.status).toBe(200);
    await prepare();
    expect(freestyleOf((await call("")).body.data).connection).toMatchObject({
      status: "failed",
      error:
        "The Orb setup failed in the fs.medium VM: E: Unable to locate package gh",
    });
    expect(world.vms.size).toBe(0);
    expect(world.snapshots.size).toBeLessThanOrEqual(1);
  }, 30_000);
});
