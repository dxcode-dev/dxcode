/**
 * Boat's REST API (`/api/v1`) in memory, at the HTTP boundary, for worker
 * tests of Boat Orbs.
 */
export type State =
  | "provisioning"
  | "ready"
  | "archived"
  | "provisioned"
  | "cancelled";

export interface FakeSandbox {
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

export interface FakeSaved {
  readonly name: string;
  status: "saving" | "ready";
  readonly createdAt: string;
  readonly orb: boolean;
}

export interface FakeAccount {
  readonly id: string;
  readonly plan: string;
  readonly zeroDataRetention: boolean;
}

export interface World {
  readonly keys: Map<string, FakeAccount>;
  readonly sandboxes: Map<string, FakeSandbox>;
  readonly deleted: Array<FakeSandbox>;
  readonly saved: Map<string, FakeSaved>;
  readonly machineTypes: ReadonlyArray<string>;
  readonly calls: Array<string>;
  /** Every request's URL and body, with its headers left out. */
  readonly traffic?: Array<string>;
  count: number;
  clock: number;
  failSetup: boolean;
  /** The next Thread create reaches Boat, but its answer is lost. */
  loseNextThreadCreate: boolean;
}

export const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ ok: status < 400, ...body }), {
    status,
    headers: { "content-type": "application/json" },
  });

export const error = (status: number, code: string, message: string) =>
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

export const sandboxJson = (sandbox: FakeSandbox) => ({
  id: sandbox.id,
  name: sandbox.name,
  state: sandbox.state,
  type: sandbox.type,
  ttlSeconds: sandbox.ttlSeconds,
  dataExpiredAt: sandbox.dataExpiredAt,
  desktopAvailable: false,
  snapshotAvailable: true,
});

export const decode = (content: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(content), (character) => character.charCodeAt(0)),
  );

export const encode = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** The single-quoted arguments of a `sh -c '<script>' sh '<a>' '<b>'` line. */
export const shArgs = (command: string) =>
  [...command.matchAll(/'((?:[^']|'\\'')*)'/g)]
    .map(([, value]) => (value as string).replaceAll(`'\\''`, "'"))
    .slice(1);

export const sandboxId = (count: number) =>
  `bx_${String(count).padStart(8, "a")}`;

export const FILE_ROOTS = ["/home/user/", "/tmp/"];

/** Boat's REST API (`/api/v1`), in memory, at the HTTP boundary. */
export const fakeBoat =
  (world: World) =>
  async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    world.calls.push(`${request.method} ${url.pathname}`);
    world.traffic?.push(`${url.href}\n${await request.clone().text()}`);
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
        createdAt: new Date(world.clock * 1_000).toISOString(),
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
