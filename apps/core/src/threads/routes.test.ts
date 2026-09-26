import { defaultThreadModelSelection, Thread } from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

const projections = vi.hoisted(() => ({
  mcp: vi.fn(),
  plugins: vi.fn(),
  skills: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { DX_RUNTIME_MODE: "deployed" },
}));
vi.mock("../settings/mcp-servers/execution.js", () => ({
  resolveMcpAgentConnections: projections.mcp,
}));
vi.mock("../settings/plugins/execution.js", () => ({
  resolvePluginAgentData: projections.plugins,
}));
vi.mock("../settings/skills/execution.js", () => ({
  resolveSkillAgentData: projections.skills,
}));

import { resolveCreationResponseDetail, threadDetailData } from "./routes.js";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const thread = Schema.decodeUnknownSync(Thread)({
  id: "thr_00000000-0000-4000-8000-000000000233",
  title: "Parallel projections",
  projectId: "prj_00000000-0000-4000-8000-000000000233",
  ownerUserId: "user-233",
  agentInstructions: { content: "", revision: 0, version: 1 },
  selection: defaultThreadModelSelection(),
  plugins: [],
  skills: [],
  visibility: "private",
  createdAt: "2026-08-28T12:00:00.000Z",
  updatedAt: "2026-08-28T12:00:00.000Z",
  lastActivityAt: "2026-08-28T12:00:00.000Z",
  activityStatus: "idle",
  lifecycleState: "active",
});

describe("Thread response projections", () => {
  it("resolves independent MCP, skill, and plugin data concurrently", async () => {
    const mcp = deferred<readonly []>();
    const skills = deferred<readonly []>();
    const plugins = deferred<readonly []>();
    projections.mcp.mockReturnValue(Effect.promise(() => mcp.promise));
    projections.skills.mockReturnValue(Effect.promise(() => skills.promise));
    projections.plugins.mockReturnValue(Effect.promise(() => plugins.promise));
    const db = {
      prepare: () => ({
        bind: () => ({
          first: () =>
            Promise.resolve({ ready_at: null, preparation_status: null }),
        }),
      }),
    } as unknown as D1Database;

    const detail = Effect.runPromise(threadDetailData({}, db, thread));
    await vi.waitFor(() => {
      expect(projections.mcp).toHaveBeenCalledOnce();
      expect(projections.skills).toHaveBeenCalledOnce();
      expect(projections.plugins).toHaveBeenCalledOnce();
    });
    mcp.resolve([]);
    skills.resolve([]);
    plugins.resolve([]);

    await expect(detail).resolves.toMatchObject({
      id: thread.id,
      agentInitialization: {
        mcpConnections: [],
        skills: [],
        plugins: [],
      },
    });
  });

  it("reads creation detail once while overlapping initial admission", async () => {
    const detailRead = deferred<typeof thread>();
    const admission = deferred<void>();
    const reads = vi.fn(() => Effect.promise(() => detailRead.promise));
    const admissions = vi.fn(() => Effect.promise(() => admission.promise));

    const responseDetail = Effect.runPromise(
      resolveCreationResponseDetail(reads(), admissions()),
    );
    await vi.waitFor(() => {
      expect(reads).toHaveBeenCalledOnce();
      expect(admissions).toHaveBeenCalledOnce();
    });
    admission.resolve();
    detailRead.resolve(thread);

    await expect(responseDetail).resolves.toBe(thread);
    expect(reads).toHaveBeenCalledOnce();
  });

  it("keeps detail failure precedence when concurrent admission also fails", async () => {
    const detailFailure = new Error("detail failed first");
    const admissionFailure = new Error("admission also failed");

    await expect(
      Effect.runPromise(
        resolveCreationResponseDetail(
          Effect.fail(detailFailure),
          Effect.fail(admissionFailure),
        ),
      ),
    ).rejects.toBe(detailFailure);
  });
});
