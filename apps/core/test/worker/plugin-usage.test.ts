import { env } from "cloudflare:test";
import {
  type MeteredPluginCall,
  ModelUsageEventInput,
  normalizeUsageQuery,
  normalizeWorkspaceUsageQuery,
  UsageQuery,
  UsageRepository,
  UserId,
  WorkspaceId,
  WorkspaceUsageQuery,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  recordMeteredCall,
  recordUserMeteredCall,
} from "../../src/plugins/metering.js";
import { UsageRepositoryD1 } from "../../src/settings/usage/repository-d1.js";

const alice = Schema.decodeUnknownSync(UserId)("plugin-usage-alice");
const bob = Schema.decodeUnknownSync(UserId)("plugin-usage-bob");
const carol = Schema.decodeUnknownSync(UserId)("plugin-usage-carol");
const outsider = Schema.decodeUnknownSync(UserId)("plugin-usage-outsider");
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)(
  "plugin-usage-workspace",
);
const foreignWorkspaceId = "plugin-usage-foreign-workspace";
const aliceProject = "prj_00000000-0000-4000-8000-000000000501";
const aliceOtherProject = "prj_00000000-0000-4000-8000-000000000502";
const bobProject = "prj_00000000-0000-4000-8000-000000000503";
const carolProject = "prj_00000000-0000-4000-8000-000000000504";
const outsiderProject = "prj_00000000-0000-4000-8000-000000000505";
const aliceThread = "thr_00000000-0000-4000-8000-000000000501";
const aliceOtherThread = "thr_00000000-0000-4000-8000-000000000502";
const bobThread = "thr_00000000-0000-4000-8000-000000000503";
const carolThread = "thr_00000000-0000-4000-8000-000000000504";
const outsiderThread = "thr_00000000-0000-4000-8000-000000000505";

const call = (
  overrides: Partial<Omit<MeteredPluginCall, "pluginId" | "providerId">> & {
    readonly pluginId?: string;
    readonly providerId?: string;
  } = {},
) =>
  ({
    pluginId: "search",
    providerId: "exa",
    capability: "web.search",
    credentialScope: "deployment",
    unit: "request",
    units: 1,
    outcome: "success",
    durationMs: 10,
    submissionId: "plugin-usage-submission",
    ...overrides,
  }) as MeteredPluginCall;

const runUsage = <A, E>(effect: Effect.Effect<A, E, UsageRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UsageRepositoryD1(env.DB))));

const personal = async (
  ownerUserId: UserId,
  overrides: Record<string, unknown> = {},
) => {
  const normalized = await Effect.runPromise(
    normalizeUsageQuery(
      Schema.decodeUnknownSync(UsageQuery)({
        from: "2026-08-01",
        to: "2026-08-31",
        timezoneOffsetMinutes: 0,
        ...overrides,
      }),
    ),
  );
  return runUsage(
    Effect.gen(function* () {
      const repository = yield* UsageRepository;
      return yield* repository.dashboard(ownerUserId, normalized);
    }),
  );
};

const workspace = async (overrides: Record<string, unknown> = {}) => {
  const normalized = await Effect.runPromise(
    normalizeWorkspaceUsageQuery(
      Schema.decodeUnknownSync(WorkspaceUsageQuery)({
        from: "2026-08-01",
        to: "2026-08-31",
        timezoneOffsetMinutes: 0,
        ...overrides,
      }),
    ),
  );
  return runUsage(
    Effect.gen(function* () {
      const repository = yield* UsageRepository;
      return yield* repository.workspaceDashboard(workspaceId, normalized);
    }),
  );
};

beforeEach(async () => {
  const at = "2026-07-01T00:00:00.000Z";
  await env.DB.batch([
    ...[
      [alice, "Alice"],
      [bob, "Bob"],
      [carol, "Carol"],
      [outsider, "Outsider"],
    ].map(([id, name]) =>
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      ).bind(id, name, `${id}@example.com`, 1, 1),
    ),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Plugin Usage Team", "plugin-usage-team", 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(foreignWorkspaceId, "Foreign Team", "plugin-usage-foreign", 1),
    ...[
      [alice, workspaceId, "owner"],
      [bob, workspaceId, "member"],
      [carol, workspaceId, "member"],
      [outsider, foreignWorkspaceId, "owner"],
    ].map(([userId, organizationId, role]) =>
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
      ).bind(`member-${userId}`, organizationId, userId, role, 1),
    ),
    ...[
      [aliceProject, alice],
      [aliceOtherProject, alice],
      [bobProject, bob],
      [carolProject, carol],
      [outsiderProject, outsider],
    ].map(([id, owner]) =>
      env.DB.prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, owner, `Project ${id.slice(-3)}`, at, at),
    ),
    ...[
      [aliceThread, aliceProject, alice],
      [aliceOtherThread, aliceOtherProject, alice],
      [bobThread, bobProject, bob],
      [carolThread, carolProject, carol],
      [outsiderThread, outsiderProject, outsider],
    ].map(([id, project, owner]) =>
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, visibility, created_at, updated_at) VALUES (?, ?, ?, 'private', ?, ?)",
      ).bind(id, project, owner, at, at),
    ),
  ]);

  // Alice: mixed scopes for one capability, an error, and a multi-unit call.
  for (const [threadId, input, occurredAt] of [
    [
      aliceThread,
      call({ credentialScope: "personal" }),
      "2026-08-02T10:00:00.000Z",
    ],
    [
      aliceThread,
      call({ credentialScope: "personal", outcome: "error" }),
      "2026-08-02T10:01:00.000Z",
    ],
    [aliceThread, call(), "2026-08-03T10:00:00.000Z"],
    [
      aliceThread,
      call({ capability: "web.read", units: 3 }),
      "2026-08-03T11:00:00.000Z",
    ],
    [
      aliceOtherThread,
      call({
        pluginId: "code",
        providerId: "quickjs",
        capability: "code.execute",
      }),
      "2026-08-04T10:00:00.000Z",
    ],
    // A plugin outside the catalog (removed, or not yet merged) is just more rows.
    [
      aliceOtherThread,
      call({
        pluginId: "translate",
        providerId: "deepl",
        capability: "text.translate",
        credentialScope: "workspace",
      }),
      "2026-08-04T11:00:00.000Z",
    ],
    // Outside the range on both sides.
    [aliceThread, call(), "2026-07-31T23:59:59.999Z"],
    [aliceThread, call(), "2026-09-01T00:00:00.000Z"],
    // Bob: one deployment-scope call attributed to the workspace.
    [bobThread, call({ units: 2 }), "2026-08-05T09:00:00.000Z"],
    // Outsider: another workspace's deployment call.
    [outsiderThread, call({ units: 50 }), "2026-08-05T09:00:00.000Z"],
  ] as const) {
    await recordMeteredCall(env.DB, threadId, input, occurredAt);
  }

  // Carol has model usage but no plugin usage.
  await runUsage(
    Effect.gen(function* () {
      const repository = yield* UsageRepository;
      yield* repository.record(
        Schema.decodeUnknownSync(ModelUsageEventInput)({
          id: "plugin-usage-carol-model",
          kind: "model",
          threadId: carolThread,
          occurredAt: "2026-08-05T09:00:00.000Z",
          outcome: "success",
          durationMs: 100,
          submissionId: "plugin-usage-carol-submission",
          turnId: "plugin-usage-carol-turn",
          purpose: "agent",
          observedProviderId: "cloudflare",
          observedProviderName: "Cloudflare Workers AI",
          observedModelId: "@cf/zai-org/glm-5.2",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: null,
          totalTokens: 15,
        }),
      );
    }),
  );
});

describe("plugin usage aggregation", () => {
  it("groups personal usage by plugin, provider, capability, scope, and unit", async () => {
    const dashboard = await personal(alice);
    expect(dashboard.plugins).toEqual([
      {
        pluginId: "code",
        pluginName: "Code",
        providerId: "quickjs",
        providerName: "QuickJS",
        capability: "code.execute",
        credentialScope: "deployment",
        unit: "request",
        units: 1,
        events: 1,
        outcomes: { success: 1, error: 0 },
      },
      {
        pluginId: "search",
        pluginName: "Web search",
        providerId: "exa",
        providerName: "Exa",
        capability: "web.read",
        credentialScope: "deployment",
        unit: "request",
        units: 3,
        events: 1,
        outcomes: { success: 1, error: 0 },
      },
      {
        pluginId: "search",
        pluginName: "Web search",
        providerId: "exa",
        providerName: "Exa",
        capability: "web.search",
        credentialScope: "personal",
        unit: "request",
        units: 2,
        events: 2,
        outcomes: { success: 1, error: 1 },
      },
      {
        pluginId: "search",
        pluginName: "Web search",
        providerId: "exa",
        providerName: "Exa",
        capability: "web.search",
        credentialScope: "deployment",
        unit: "request",
        units: 1,
        events: 1,
        outcomes: { success: 1, error: 0 },
      },
      {
        pluginId: "translate",
        pluginName: "translate",
        providerId: "deepl",
        providerName: "deepl",
        capability: "text.translate",
        credentialScope: "workspace",
        unit: "request",
        units: 1,
        events: 1,
        outcomes: { success: 1, error: 0 },
      },
    ]);
  });

  it("uses the local-day range boundary, inclusive start and exclusive end", async () => {
    // UTC+05:30: 2026-08-01 local starts at 2026-07-31T18:30:00.000Z.
    const shifted = await personal(alice, {
      from: "2026-08-01",
      to: "2026-08-02",
      timezoneOffsetMinutes: 330,
    });
    expect(
      shifted.plugins.map((row) => [row.capability, row.credentialScope]),
    ).toEqual([
      ["web.search", "personal"],
      ["web.search", "deployment"],
    ]);
    expect(shifted.plugins[1]?.units).toBe(1);

    const single = await personal(alice, {
      from: "2026-08-03",
      to: "2026-08-03",
    });
    expect(single.plugins.map((row) => row.capability)).toEqual([
      "web.read",
      "web.search",
    ]);
    const september = await personal(alice, {
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(september.plugins).toHaveLength(1);
  });

  it("applies attribution filters but not model filters", async () => {
    const byProject = await personal(alice, { projectId: aliceOtherProject });
    expect(byProject.plugins.map((row) => row.pluginId)).toEqual([
      "code",
      "translate",
    ]);
    const byThread = await personal(alice, { threadId: aliceThread });
    expect(byThread.plugins.every((row) => row.pluginId === "search")).toBe(
      true,
    );
    const byModelProvider = await personal(alice, { providerId: "openai" });
    expect(byModelProvider.summary.modelTurns).toBe(0);
    expect(byModelProvider.plugins).toHaveLength(5);
  });

  it("attributes workspace usage per member, including deployment-scope calls", async () => {
    const dashboard = await workspace({ ranking: "users" });
    const searchDeployment = dashboard.plugins.find(
      (row) =>
        row.capability === "web.search" && row.credentialScope === "deployment",
    );
    // Alice's 1 + Bob's 2; the other workspace's 50 never appear.
    expect(searchDeployment).toMatchObject({ units: 3, events: 2 });
    expect(dashboard.plugins.reduce((total, row) => total + row.units, 0)).toBe(
      10,
    );

    expect(
      dashboard.pluginUsers.map((row) => [
        row.userName,
        row.capability,
        row.credentialScope,
        row.units,
      ]),
    ).toEqual([
      ["Alice", "code.execute", "deployment", 1],
      ["Alice", "web.read", "deployment", 3],
      ["Alice", "web.search", "personal", 2],
      ["Alice", "web.search", "deployment", 1],
      ["Alice", "text.translate", "workspace", 1],
      ["Bob", "web.search", "deployment", 2],
    ]);
    // Carol has model usage and ranks, but has no plugin rows.
    expect(
      dashboard.ranking.kind === "users" &&
        dashboard.ranking.items.some((item) => item.userId === carol),
    ).toBe(true);
    expect(dashboard.pluginUsers.some((row) => row.userId === carol)).toBe(
      false,
    );
    expect(JSON.stringify(dashboard)).not.toMatch(
      /thr_|plugin-usage-submission|Outsider/,
    );

    const bobOnly = await workspace({ ranking: "users", userId: bob });
    expect(bobOnly.plugins).toEqual([
      expect.objectContaining({
        capability: "web.search",
        credentialScope: "deployment",
        units: 2,
      }),
    ]);
    expect(bobOnly.pluginUsers.map((row) => row.userId)).toEqual([bob]);

    const carolOnly = await workspace({ ranking: "users", userId: carol });
    expect(carolOnly.plugins).toEqual([]);
    expect(carolOnly.pluginUsers).toEqual([]);
  });

  it("keeps Thread-less dictation rows beside search rows, with audio seconds as their own unit", async () => {
    const dictation = (
      credentialScope: MeteredPluginCall["credentialScope"],
      unit: MeteredPluginCall["unit"],
      units: number,
    ) =>
      call({
        pluginId: "speech",
        providerId: "sarvam",
        capability: "speech.transcribe",
        credentialScope,
        unit,
        units,
        submissionId: null,
      });
    // Composer dictation has no Thread or Project.
    await recordUserMeteredCall(
      env.DB,
      alice,
      dictation("deployment", "audio_second", 42),
      "2026-08-10T09:00:00.000Z",
    );
    await recordUserMeteredCall(
      env.DB,
      alice,
      dictation("deployment", "audio_second", 8),
      "2026-08-10T09:05:00.000Z",
    );
    // Same plugin, scope, and capability in another unit stays its own row.
    await recordUserMeteredCall(
      env.DB,
      alice,
      dictation("deployment", "request", 1),
      "2026-08-10T09:06:00.000Z",
    );
    await recordUserMeteredCall(
      env.DB,
      bob,
      dictation("personal", "audio_second", 5),
      "2026-08-10T09:10:00.000Z",
    );
    await recordMeteredCall(
      env.DB,
      aliceThread,
      call(),
      "2026-08-10T10:00:00.000Z",
    );
    const nullAttribution = await env.DB.prepare(
      "SELECT COUNT(*) AS rows FROM plugin_usage_event WHERE thread_id IS NULL AND project_id IS NULL AND workspace_id = ?",
    )
      .bind(workspaceId)
      .first<number>("rows");
    expect(nullAttribution).toBe(4);

    const day = { from: "2026-08-10", to: "2026-08-10" };
    const alicesDay = await personal(alice, day);
    expect(
      alicesDay.plugins.map((row) => [
        row.pluginName,
        row.providerName,
        row.capability,
        row.credentialScope,
        row.unit,
        row.units,
        row.events,
      ]),
    ).toEqual([
      ["Web search", "Exa", "web.search", "deployment", "request", 1, 1],
      [
        "Dictation",
        "Sarvam",
        "speech.transcribe",
        "deployment",
        "audio_second",
        50,
        2,
      ],
      [
        "Dictation",
        "Sarvam",
        "speech.transcribe",
        "deployment",
        "request",
        1,
        1,
      ],
    ]);

    // Project and Thread filters drop rows that belong to no Thread.
    for (const filter of [
      { projectId: aliceProject },
      { threadId: aliceThread },
    ]) {
      const filtered = await personal(alice, { ...day, ...filter });
      expect(filtered.plugins.map((row) => row.pluginId)).toEqual(["search"]);
    }

    const workspaceDay = await workspace({ ...day, ranking: "users" });
    expect(
      workspaceDay.pluginUsers.map((row) => [
        row.userName,
        row.pluginId,
        row.credentialScope,
        row.unit,
        row.units,
      ]),
    ).toEqual([
      ["Alice", "search", "deployment", "request", 1],
      ["Alice", "speech", "deployment", "audio_second", 50],
      ["Alice", "speech", "deployment", "request", 1],
      ["Bob", "speech", "personal", "audio_second", 5],
    ]);
    const workspaceProject = await workspace({
      ...day,
      ranking: "users",
      projectId: aliceProject,
    });
    expect(workspaceProject.plugins.map((row) => row.pluginId)).toEqual([
      "search",
    ]);
  });
});
