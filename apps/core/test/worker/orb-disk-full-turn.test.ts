import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeExecutionActivation } from "../../src/execution/activation.js";
import { makeE2BExecutionProvider } from "../../src/execution/e2b/provider.js";
import type { E2BResolverApi } from "../../src/execution/e2b/resolver.js";
import type { Bindings } from "../../src/http/types.js";
import {
  takeWorkspaceDisk,
  workspaceDiskNote,
} from "../../src/orb-disk/note.js";
import { composeExecutionWorkspaces } from "../../src/plugins/execution/provider.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * #1614: a full Orb disk must not keep a new message's turn from starting.
 * The real composition, activation pipeline, source workspace service, and
 * E2B provider run over real D1; only the E2B control plane and the Orb's
 * guest are faked. The guest keeps a small disk model: its free space, the
 * package-manager caches on it, and how much room the checkout read (the
 * setup program's `activate` action, with its resume hook) needs. A command
 * frees a cache only when it names that cache's path, as `rm` would.
 *
 * On main every scenario fails the turn with WORKSPACE_DISK_FULL at
 * `read-checkout-state`, before the agent runs, so the agent never gets a
 * chance to free space (thr_43b94def, stuck for 13 hours).
 */

const MIB = 1_024 * 1_024;
const GIB = 1_024 * MIB;
const TOTAL = 20 * GIB;
const PNPM_STORE = "/home/user/.local/share/pnpm/store";
const NPM_CACHE = "/home/user/.npm/_cacache";
const CHECKOUT = "/home/user/workspace/repo";

const owner = "disk-full-owner" as UserId;
const ownerProject = project(
  "prj_00000000-0000-4000-8000-000000001614",
  owner,
  "disk-full-owner-personal",
);
const workerEnv = env as unknown as Record<string, unknown>;

interface DiskModel {
  available: number;
  readonly caches: Map<string, number>;
  /** Free space the checkout read and its resume hook need. */
  readonly readNeeds: number;
  /** Every command the guest ran, in order. */
  readonly commands: Array<string>;
  checkoutReads: number;
}

const checkout = {
  status: "ready",
  modules: [],
  lfsNeeded: false,
  shallow: false,
  fullHistoryNeeded: false,
};

/** A command that names a cache's path frees it. */
const clearNamedCaches = (disk: DiskModel, script: string) => {
  for (const [path, bytes] of disk.caches)
    if (script.includes(path)) {
      disk.available += bytes;
      disk.caches.delete(path);
    }
};

const guardLine = (disk: DiskModel, full: boolean) =>
  `dx-disk ${String(TOTAL / 1_024)} ${String(Math.floor(disk.available / 1_024))} ${full ? 1 : 0}\n`;

/** The Orb, answering dx's commands from the disk model. */
const fakeGuest = (sandboxId: string, disk: DiskModel) => {
  const command = (
    script: string,
    options?: { readonly envs?: Record<string, string> },
  ) => {
    disk.commands.push(script);
    // dx's disk guard (it sets `dx_disk_full`) frees space only below
    // 64 MB; any other command of dx's that names a cache frees it.
    let stderr = "";
    const guard = script.includes("dx_disk_full=0");
    if (guard) {
      const low = disk.available < 64 * MIB;
      if (low) clearNamedCaches(disk, script);
      stderr = guardLine(disk, low);
    } else if (script.includes("dx-disk")) {
      clearNamedCaches(disk, script);
      stderr = guardLine(disk, true);
    }
    if (script.includes("DX_ASSET_HELPER_DIGEST")) {
      const tools = JSON.parse(
        options?.envs?.DX_ASSET_TOOLS ?? "[]",
      ) as Array<string>;
      const action = options?.envs?.DX_ASSET_ACTION;
      let operation: Record<string, unknown> | undefined;
      if (action === "activate" || action === "snapshot") {
        disk.checkoutReads += 1;
        operation =
          disk.available < disk.readNeeds
            ? {
                stdout: JSON.stringify({ ...checkout, status: "disk-full" }),
                stderr: "ENOSPC: no space left on device",
                exitCode: 60,
              }
            : {
                stdout: JSON.stringify(
                  action === "activate"
                    ? { checkout, hooks: { status: "ready" } }
                    : checkout,
                ),
                stderr: "",
                exitCode: 0,
              };
      }
      return {
        stdout: JSON.stringify({
          assets: "fresh",
          tools: tools.map((tool) => ({ tool, status: "ok" })),
          ...(operation === undefined ? {} : { operation }),
        }),
        stderr,
        exitCode: 0,
      };
    }
    return { stdout: "", stderr, exitCode: 0 };
  };
  return {
    sandboxId,
    commands: {
      run: async (
        script: string,
        options?: { readonly envs?: Record<string, string> },
      ) => command(script, options),
    },
    files: { write: async () => {} },
    setTimeout: async () => undefined,
  };
};

const fakeE2B = (disk: DiskModel) => {
  const guests = new Map<string, ReturnType<typeof fakeGuest>>();
  return {
    list: () => ({ hasNext: false, nextItems: async () => [] }),
    getInfo: async (sandboxId: string) => ({
      sandboxId,
      state: "running",
      cpuCount: 2,
      memoryMB: 4096,
      metadata: {},
    }),
    connect: async (sandboxId: string) => guests.get(sandboxId),
    create: async () => {
      const sandboxId = `sandbox-${String(guests.size + 1)}`;
      const guest = fakeGuest(sandboxId, disk);
      guests.set(sandboxId, guest);
      return guest;
    },
    kill: async () => true,
    pause: async () => true,
    isNotFound: () => false,
  } as unknown as E2BResolverApi;
};

/** Each test runs on its own storage: the owner and Project first. */
const setUp = async () => {
  Object.assign(workerEnv, {
    E2B_API_KEY: "test-e2b-key",
    DX_ENV: "test",
    DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
    THREAD_EXECUTION: undefined,
    DX_STORAGE: undefined,
  });
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  )
    .bind(owner, "Ada Owner", `${owner}@example.com`)
    .run();
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
    }),
  );
  await env.DB.prepare(
    "UPDATE projects SET runner_profile_id = 'a1.medium'",
  ).run();
};

const seed = async (threadId: string) => {
  await setUp();
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ThreadRepository).insert(
        thread(threadId, ownerProject.id as ProjectId, owner),
      );
    }),
  );
  await env.DB.prepare(
    `INSERT INTO thread_source_snapshot (
       thread_id, project_id, binding_revision, provider,
       repository_full_name, clone_url, default_branch,
       initial_ref, initial_commit_sha, created_at
     ) VALUES (?, ?, 1, 'github', 'example-org/example-repo',
       'https://github.com/example-org/example-repo.git', 'main',
       'refs/heads/main', ?, '2026-11-03T12:00:00.000Z')`,
  )
    .bind(threadId, ownerProject.id, "a".repeat(40))
    .run();
};

/** Starts the turn's activation, as a new message does. */
const startTurn = async (threadId: string, disk: DiskModel) => {
  await seed(threadId);
  const workspaces = composeExecutionWorkspaces(
    workerEnv as unknown as Bindings,
    { e2b: makeE2BExecutionProvider(fakeE2B(disk)) },
    makeExecutionActivation(),
  );
  const outcome = await workspaces.sandboxFactory
    .createSandbox({ id: threadId })
    .then(
      () => ({ started: true as const }),
      (error: unknown) => ({
        started: false as const,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  const reading = takeWorkspaceDisk(threadId);
  return {
    ...outcome,
    note: reading === undefined ? undefined : workspaceDiskNote(reading),
  };
};

const diskModel = (input: {
  readonly available: number;
  readonly caches: ReadonlyArray<readonly [string, number]>;
  readonly readNeeds: number;
}): DiskModel => ({
  available: input.available,
  caches: new Map(input.caches),
  readNeeds: input.readNeeds,
  commands: [],
  checkoutReads: 0,
});

/** No command dx ran deletes anything in the user's checkout. */
const touchedNoUserFiles = (disk: DiskModel) =>
  disk.commands
    .flatMap((script) => script.split("\n"))
    .filter((line) => /\brm\b|-delete\b/.test(line))
    .every((line) => !line.includes(CHECKOUT));

describe("A full Orb disk and a new message's turn (#1614)", () => {
  it("nearly full (the incident): dx clears the package caches and the turn starts", async () => {
    // 40 MB free passes the old guard (16 MB), but the checkout read and
    // its resume hook need 100 MB, so the read fails as the disk fills.
    const disk = diskModel({
      available: 40 * MIB,
      caches: [
        [PNPM_STORE, 3 * GIB],
        [NPM_CACHE, 90 * MIB],
      ],
      readNeeds: 100 * MIB,
    });
    const turn = await startTurn(
      "thr_00000000-0000-4000-8000-000000161401",
      disk,
    );
    expect(turn).toMatchObject({ started: true });
    expect(disk.caches.has(PNPM_STORE)).toBe(false);
    expect(turn.note).toMatch(/caches/);
    expect(touchedNoUserFiles(disk)).toBe(true);
  });

  it("a write fails with room above the guard's line: dx clears caches and retries once", async () => {
    const disk = diskModel({
      available: 200 * MIB,
      caches: [[PNPM_STORE, 3 * GIB]],
      readNeeds: GIB,
    });
    const turn = await startTurn(
      "thr_00000000-0000-4000-8000-000000161402",
      disk,
    );
    expect(turn).toMatchObject({ started: true });
    expect(disk.caches.has(PNPM_STORE)).toBe(false);
    expect(disk.checkoutReads).toBe(2);
    expect(turn.note).toMatch(/caches/);
    expect(touchedNoUserFiles(disk)).toBe(true);
  });

  it("still full after the caches: the turn starts in recovery mode and the agent is told", async () => {
    const disk = diskModel({
      available: 40 * MIB,
      caches: [],
      readNeeds: 100 * MIB,
    });
    const turn = await startTurn(
      "thr_00000000-0000-4000-8000-000000161403",
      disk,
    );
    expect(turn).toMatchObject({ started: true });
    // One read, one retry after the cleanup, then no more.
    expect(disk.checkoutReads).toBe(2);
    expect(turn.note).toMatch(/recovery mode/);
    expect(turn.note).toMatch(/free space/i);
    expect(touchedNoUserFiles(disk)).toBe(true);
  });
});
