/**
 * Lizard's sandbox API (lizard.build), faked at the HTTP boundary for
 * Worker tests: the calls dx makes, answered as the real API answered them
 * on 2026-11-10 (sandbox and snapshot shapes, `/bin/sh -c` commands, the
 * file API, and Lizard's refusal of a size the account cannot start).
 */

export interface FakeSandbox {
  readonly id: string;
  readonly size: string;
  readonly template: string | null;
  readonly snapshotId: string | null;
  readonly timeoutMs: number;
  status: "running" | "pausing" | "paused" | "stopped";
  readonly files: Map<string, Uint8Array>;
  readonly execs: Array<{ readonly cmd: string; readonly user?: string }>;
  setupPolls: number;
  /** The Orb's services run (after install.sh, or restored with them). */
  orb: boolean;
  /** Pauses so far; each resume is a fresh boot. */
  pauses: number;
}

export interface FakeSnapshot {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly size: string;
  readonly createdAt: number;
  status: "building" | "ready";
}

export interface LizardWorld {
  readonly apiKey: string;
  readonly projectId: string;
  /** Sizes the account may start; others are refused as Lizard refuses. */
  readonly allowedSizes: ReadonlySet<string>;
  /** Sizes whose install.sh fails. */
  readonly failingSetup: Set<string>;
  /**
   * Sizes whose next create is refused as the trial refuses one size too
   * many running at once (TRIAL_SIZE_RUNNING), once each.
   */
  readonly busyOnce: Set<string>;
  readonly sandboxes: Map<string, FakeSandbox>;
  readonly snapshots: Map<string, FakeSnapshot>;
  /** Every request, its URL, headers other than Authorization, and body. */
  readonly traffic: Array<string>;
  readonly calls: Array<string>;
  /** Pauses that fail, for the idle sweep's retry. */
  failPauses: number;
  /**
   * Snapshot requests whose answer is lost (the request outlives dx's
   * client) although Lizard takes the snapshot, as a full VM's can.
   */
  loseSnapshotAnswers: number;
  count: number;
}

export const lizardWorld = (
  overrides: Partial<LizardWorld> = {},
): LizardWorld => ({
  apiKey: "liz_test_key",
  projectId: "prj_lizard_test",
  allowedSizes: new Set(["mini", "small", "medium"]),
  failingSetup: new Set(),
  busyOnce: new Set(),
  sandboxes: new Map(),
  snapshots: new Map(),
  traffic: [],
  calls: [],
  failPauses: 0,
  loseSnapshotAnswers: 0,
  count: 0,
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const CPUS: Readonly<Record<string, number>> = {
  mini: 1,
  small: 2,
  medium: 4,
  large: 8,
};

const sandboxBody = (sandbox: FakeSandbox) => ({
  id: sandbox.id,
  sandboxId: sandbox.id,
  status: sandbox.status,
  size: sandbox.size,
  cpus: CPUS[sandbox.size] ?? 0,
  template: sandbox.template ?? "claude",
  pauseError: null,
  crashReason: null,
});

/** The quoted arguments of an `sh -c '...' sh 'a' 'b'` command line. */
const shArgs = (command: string) =>
  [...command.matchAll(/'((?:[^']|'\\'')*)'/g)]
    .slice(1)
    .map(([, value]) => (value as string).replaceAll("'\\''", "'"));

export const fakeLizard =
  (world: LizardWorld) =>
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    world.traffic.push(
      `${method} ${url.href} ${JSON.stringify(
        [...headers].filter(([name]) => name !== "authorization"),
      )} ${rawBody}`,
    );
    world.calls.push(`${method} ${url.pathname}`);
    if (url.origin !== "https://lizard.build")
      return json({ error: "unexpected host" }, 599);
    if (headers.get("authorization") !== `Bearer ${world.apiKey}`)
      return json({ error: "Unauthorized" }, 401);
    const body = rawBody === "" ? {} : JSON.parse(rawBody);
    const path = url.pathname;
    if (path === "/api/sandboxes/limits")
      return url.searchParams.get("projectId") === world.projectId
        ? json({ tier: "trial", limits: { vcpu: 8, maxSandboxCpus: 4 } })
        : json({ error: "Project not found" }, 404);
    if (path === "/api/sandboxes" && method === "POST") {
      if (body.projectId !== world.projectId)
        return json({ error: "Project not found" }, 404);
      const snapshot =
        body.snapshotId === undefined
          ? undefined
          : world.snapshots.get(body.snapshotId);
      if (body.snapshotId !== undefined && snapshot?.status !== "ready")
        return json({ error: "Snapshot not found" }, 404);
      const size = snapshot?.size ?? body.size;
      if (world.busyOnce.delete(size))
        return json(
          {
            error: `The trial includes 1 Small and 2 Mini running at a time.`,
            code: "TRIAL_SIZE_RUNNING",
          },
          403,
        );
      if (!world.allowedSizes.has(size))
        return json(
          {
            error: `This account runs Sandboxes of up to 4 vCPU. ${size} Sandboxes are not available to it yet.`,
            message: `This account runs Sandboxes of up to 4 vCPU. ${size} Sandboxes are not available to it yet.`,
            code: "SANDBOX_SIZE_NOT_ALLOWED",
          },
          403,
        );
      world.count += 1;
      const sandbox: FakeSandbox = {
        id: `sbx-${world.count}`,
        size,
        template: body.template ?? null,
        snapshotId: body.snapshotId ?? null,
        timeoutMs: body.timeoutMs,
        status: "running",
        files: new Map(),
        execs: [],
        setupPolls: 0,
        pauses: 0,
        orb: snapshot !== undefined,
      };
      world.sandboxes.set(sandbox.id, sandbox);
      return json(sandboxBody(sandbox), 201);
    }
    const match = /^\/api\/sandboxes\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (match !== null) {
      const sandbox = world.sandboxes.get(match[1] as string);
      const action = match[2];
      if (sandbox === undefined || sandbox.status === "stopped")
        return json({ error: "Sandbox not found" }, 404);
      if (action === undefined && method === "GET")
        return json(sandboxBody(sandbox));
      if (action === undefined && method === "DELETE") {
        sandbox.status = "stopped";
        return json({ ok: true });
      }
      if (action === "pause") {
        if (world.failPauses > 0) {
          world.failPauses -= 1;
          return json({ error: "Pause failed" }, 500);
        }
        // Every pause keeps files only: the resume boots fresh, and the
        // Orb's services start again then.
        sandbox.pauses += 1;
        sandbox.status = "paused";
        return json(sandboxBody(sandbox));
      }
      if (action === "resume") {
        sandbox.status = "running";
        return json(sandboxBody(sandbox));
      }
      if (action === "snapshot") {
        world.count += 1;
        const snapshot: FakeSnapshot = {
          id: `snap-${world.count}`,
          name: body.name,
          source: sandbox.id,
          size: sandbox.size,
          createdAt: Date.now(),
          status: "building",
        };
        world.snapshots.set(snapshot.id, snapshot);
        if (world.loseSnapshotAnswers > 0) {
          world.loseSnapshotAnswers -= 1;
          return json({ error: "Gateway Timeout" }, 504);
        }
        return json({ id: snapshot.id, status: "building" }, 201);
      }
      if (sandbox.status !== "running")
        return json({ error: "Sandbox is paused" }, 409);
      if (action === "files" && method === "POST") {
        sandbox.files.set(
          body.path,
          Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)),
        );
        return json({ status: "written", path: body.path }, 201);
      }
      if (action === "files" && method === "GET") {
        const file = sandbox.files.get(url.searchParams.get("path") ?? "");
        return file === undefined
          ? json({ error: "path does not exist" }, 404)
          : new Response(file);
      }
      if (action === "exec") {
        const cmd = body.cmd as string;
        sandbox.execs.push({ cmd, ...(body.user ? { user: body.user } : {}) });
        const done = (stdout: string, exitCode = 0) =>
          json({ stdout, stderr: "", exitCode, status: "completed" });
        if (cmd.includes("setsid nohup bash /var/lib/dx-orb-setup/install.sh"))
          return done("started\n");
        if (cmd.includes("tail -c 400 /var/lib/dx-orb-setup/setup.log"))
          return done("No space left on device\n");
        if (cmd.includes("cat /var/lib/dx-orb-setup/status")) {
          sandbox.setupPolls += 1;
          if (sandbox.setupPolls < 2) return done("running\n");
          if (world.failingSetup.has(sandbox.size)) return done("failed\n");
          sandbox.orb = true;
          return done("done\n");
        }
        // When dx-orb.service started: a fresh boot each pause.
        if (cmd.includes("MainPID") && cmd.includes("etimes"))
          return done(`${1_794_300_000 + sandbox.pauses * 600}\n`);
        if (cmd.includes("systemctl is-active --quiet dx-orb.service"))
          return done("", sandbox.orb ? 0 : 1);
        if (cmd.includes("/opt/dx/bin/dx-orb-check"))
          return sandbox.orb
            ? done("ok   account            user (uid 1001), home /home/user\n")
            : done("FAIL account   no user\n", 1);
        if (cmd.includes('cat -- "$1" >"$2"')) {
          const [staged, target] = shArgs(cmd.replace(/^sudo -n /, ""));
          const content = sandbox.files.get(staged as string);
          if (content === undefined) return done("", 1);
          sandbox.files.delete(staged as string);
          sandbox.files.set(target as string, content);
          return done("");
        }
        return done(`ran as ${body.user ?? "root"}\n`);
      }
    }
    if (path === "/api/sandbox-snapshots" && method === "GET")
      return json(
        [...world.snapshots.values()].map((entry) => ({
          id: entry.id,
          name: entry.name,
          status: entry.status,
          createdAt: entry.createdAt,
          projectId: world.projectId,
          error: null,
        })),
      );
    const snapshot = /^\/api\/sandbox-snapshots\/([^/]+)$/.exec(path);
    if (snapshot !== null) {
      const found = world.snapshots.get(snapshot[1] as string);
      if (found === undefined) return json({ error: "Not found" }, 404);
      if (method === "DELETE") {
        world.snapshots.delete(found.id);
        return json({ ok: true });
      }
      // Ready on the next read, as Lizard's take about a second.
      const answer = { id: found.id, status: found.status, error: null };
      found.status = "ready";
      return json(answer);
    }
    return json({ error: "Not found" }, 404);
  };
