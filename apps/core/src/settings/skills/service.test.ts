import {
  McpServerNotFound,
  McpServerRepository,
  PersistenceUnavailable,
  type Principal,
  type ProjectId,
  SkillId,
  SkillIntegrityConflict,
  SkillMcpReferenceInvalid,
  SkillNotFound,
  SkillRepository,
  type SkillTarget,
  SkillVersion,
  StoredMcpServer,
  StoredMcpTool,
  StoredSkill,
  StoredSkillVersion,
  UserId,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsAudit } from "../audit.js";
import { previewSkillImport } from "./import.js";
import { SkillService } from "./service.js";

const owner = Schema.decodeUnknownSync(UserId)("skill-service-owner");
const target = { scope: "personal", id: owner } satisfies SkillTarget;
const projectId = "prj_00000000-0000-4000-8000-000000000044" as ProjectId;
const principal = { userId: owner } as Principal;
const skillId = Schema.decodeUnknownSync(SkillId)(
  "skl_00000000-0000-4000-8000-000000000044",
);
const mcpId = "mcp_00000000-0000-4000-8000-000000000044";
const timestamp = "2026-08-23T00:00:00.000Z";

const bundle = (
  instructions: string,
  mcpServerIds: ReadonlyArray<string> = [],
) => ({
  source: { type: "browser-files" as const, label: "Reviewed test bundle" },
  files: [
    {
      path: "skill.json",
      kind: "file" as const,
      mediaType: "application/json",
      encoding: "utf-8" as const,
      content: JSON.stringify({
        schemaVersion: 1,
        name: "review-guidelines",
        description: "Review this repository consistently.",
        mcpServerIds,
      }),
    },
    {
      path: "instructions.md",
      kind: "file" as const,
      mediaType: "text/markdown",
      encoding: "utf-8" as const,
      content: instructions,
    },
  ],
});

const harness = async (
  options: {
    readonly mcpReference?: boolean;
    readonly approved?: boolean;
    readonly serverEnabled?: boolean;
    readonly mcpFailure?:
      | McpServerNotFound
      | PersistenceUnavailable
      | Schema.SchemaError;
  } = {},
) => {
  let approved = options.approved ?? true;
  let policy = true;
  let insertVersionCalls = 0;
  let updateStateCalls = 0;
  const initialBundle = bundle(
    "Use the first reviewed version.",
    options.mcpReference ? [mcpId] : [],
  );
  const initialPreview = await Effect.runPromise(
    previewSkillImport(initialBundle),
  );
  let skill = Schema.decodeUnknownSync(StoredSkill)({
    id: skillId,
    target,
    name: initialPreview.manifest.name,
    enabled: false,
    activeVersion: 1,
    pinned: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const versions = new Map([
    [
      1,
      Schema.decodeUnknownSync(StoredSkillVersion)({
        skillId,
        version: 1,
        manifest: initialPreview.manifest,
        instructions: initialPreview.instructions,
        resources: initialPreview.resources,
        source: initialPreview.source,
        integrity: initialPreview.integrity,
        createdAt: timestamp,
        createdByUserId: owner,
      }),
    ],
  ]);
  const current = () => ({
    skill,
    active: versions.get(skill.activeVersion) ?? versions.get(1)!,
    versions: [...versions.keys()]
      .sort((left, right) => right - left)
      .map((version) => Schema.decodeUnknownSync(SkillVersion)(version)),
  });
  const repository = SkillRepository.of({
    list: () => Effect.succeed([current()]),
    find: (_target, id) =>
      id === skill.id
        ? Effect.succeed(current())
        : Effect.fail(new SkillNotFound()),
    findVersion: (id, version) => {
      const found = id === skill.id ? versions.get(version) : undefined;
      return found ? Effect.succeed(found) : Effect.fail(new SkillNotFound());
    },
    insert: () => Effect.die("not used"),
    insertVersion: (_target, version, activate, updatedAt) => {
      if (skill.pinned && activate) {
        return Effect.fail(new SkillIntegrityConflict());
      }
      return Effect.sync(() => {
        insertVersionCalls++;
        versions.set(version.version, version);
        if (activate) {
          skill = { ...skill, activeVersion: version.version, updatedAt };
        }
      });
    },
    updateState: (_target, id, input, updatedAt) => {
      if (id !== skill.id) return Effect.fail(new SkillNotFound());
      if (
        input.activeVersion !== undefined &&
        !versions.has(input.activeVersion)
      ) {
        return Effect.fail(new SkillNotFound());
      }
      return Effect.sync(() => {
        updateStateCalls++;
        skill = {
          ...skill,
          enabled: input.enabled ?? skill.enabled,
          activeVersion: input.activeVersion ?? skill.activeVersion,
          pinned: input.pinned ?? skill.pinned,
          updatedAt,
          ...(input.removedAt === undefined
            ? {}
            : { removedAt: input.removedAt }),
        };
      });
    },
    listEffectiveForThread: () =>
      Effect.succeed(skill.enabled ? [current()] : []),
    getWorkspacePolicy: () => Effect.succeed(policy),
    setWorkspacePolicy: (_workspaceId, allowPersonal) =>
      Effect.sync(() => {
        policy = allowPersonal;
      }),
  });

  const server = Schema.decodeUnknownSync(StoredMcpServer)({
    id: mcpId,
    target,
    name: "Reviewed tools",
    endpoint: "https://mcp.example.com/mcp",
    transport: "streamable-http",
    timeoutMs: 10_000,
    enabled: options.serverEnabled ?? true,
    projectIds: [],
    roles: ["owner", "admin", "member"],
    healthStatus: "healthy",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const tool = () =>
    Schema.decodeUnknownSync(StoredMcpTool)({
      name: "read_status",
      description: "Read status",
      inputSchemaJson: "{}",
      schemaHash: "a".repeat(64),
      ...(approved ? { approvedSchemaHash: "a".repeat(64) } : {}),
      discoveredAt: timestamp,
      ...(approved ? { reviewedAt: timestamp } : {}),
    });
  const mcp = McpServerRepository.of({
    find: (_target: SkillTarget, id: typeof server.id) =>
      options.mcpFailure !== undefined
        ? Effect.fail(options.mcpFailure)
        : id === server.id
          ? Effect.succeed({ server, tools: [tool()] })
          : Effect.fail(new McpServerNotFound()),
    listForExecution: () =>
      Effect.succeed(
        approved ? [{ server, tools: [tool()] }] : [{ server, tools: [] }],
      ),
  } as unknown as McpServerRepository["Service"]);
  const layer = SkillService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SkillRepository, repository),
        Layer.succeed(McpServerRepository, mcp),
        Layer.succeed(
          SettingsAudit,
          SettingsAudit.of({ record: () => Effect.void }),
        ),
      ),
    ),
  );
  return {
    initialBundle,
    initialPreview,
    layer,
    state: () => current(),
    insertVersionCalls: () => insertVersionCalls,
    updateStateCalls: () => updateStateCalls,
    approve: () => {
      approved = true;
    },
  };
};

const audit = { userId: owner, requestId: "skill-service-test" };

const rejectMcpMutation = async (
  operation: "update activate" | "changeState enable",
  failure: McpServerNotFound | PersistenceUnavailable | Schema.SchemaError,
) => {
  const test = await harness({ mcpReference: true, mcpFailure: failure });
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SkillService;
      if (operation === "changeState enable") {
        return yield* Effect.flip(
          service.changeState(target, skillId, { enabled: true }, audit),
        );
      }
      const nextBundle = bundle("Use a changed reviewed version.", [mcpId]);
      const nextPreview = yield* previewSkillImport(nextBundle);
      return yield* Effect.flip(
        service.update(
          target,
          skillId,
          nextBundle,
          nextPreview.integrity,
          true,
          audit,
        ),
      );
    }).pipe(Effect.provide(test.layer)),
  );
  expect(test.insertVersionCalls()).toBe(0);
  expect(test.updateStateCalls()).toBe(0);
  expect(test.state()).toMatchObject({
    skill: { activeVersion: 1, enabled: false },
    versions: [1],
  });
  return error;
};

describe("SkillService", () => {
  describe.each(["update activate", "changeState enable"] as const)(
    "%s MCP validation",
    (operation) => {
      it("maps a missing MCP server to the business conflict without mutation", async () => {
        const error = await rejectMcpMutation(
          operation,
          new McpServerNotFound(),
        );
        expect(error).toBeInstanceOf(SkillMcpReferenceInvalid);
      });

      it("propagates persistence failures without mutation", async () => {
        const failure = PersistenceUnavailable.new(
          { operation: "find MCP server" },
          new Error("D1 unavailable"),
        );
        const error = await rejectMcpMutation(operation, failure);
        expect(error).toBe(failure);
      });

      it("propagates schema failures without mutation", async () => {
        const failure = await Effect.runPromise(
          Effect.flip(Schema.decodeUnknownEffect(StoredMcpServer)({})),
        );
        const error = await rejectMcpMutation(operation, failure);
        expect(error).toBe(failure);
        expect(Schema.isSchemaError(error)).toBe(true);
      });
    },
  );

  it("leaves the active immutable version unchanged after invalid updates", async () => {
    const test = await harness();
    const nextBundle = bundle("Use a changed reviewed version.");
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SkillService;
        return yield* Effect.flip(
          service.update(
            target,
            skillId,
            nextBundle,
            test.initialPreview.integrity,
            true,
            audit,
          ),
        );
      }).pipe(Effect.provide(test.layer)),
    );
    expect(error).toBeInstanceOf(SkillIntegrityConflict);
    expect(test.insertVersionCalls()).toBe(0);
    expect(test.state()).toMatchObject({
      skill: { activeVersion: 1 },
      versions: [1],
    });
  });

  it("publishes versions, rolls back, and requires unpinning before changing the active version", async () => {
    const test = await harness();
    const nextBundle = bundle("Use the second reviewed version.");
    const nextPreview = await Effect.runPromise(previewSkillImport(nextBundle));
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SkillService;
        yield* service.update(
          target,
          skillId,
          nextBundle,
          nextPreview.integrity,
          true,
          audit,
        );
        yield* service.changeState(
          target,
          skillId,
          { activeVersion: Schema.decodeUnknownSync(SkillVersion)(1) },
          audit,
        );
        yield* service.changeState(target, skillId, { pinned: true }, audit);
        const pinnedError = yield* Effect.flip(
          service.changeState(
            target,
            skillId,
            { activeVersion: Schema.decodeUnknownSync(SkillVersion)(2) },
            audit,
          ),
        );
        expect(pinnedError).toBeInstanceOf(SkillIntegrityConflict);
        yield* service.changeState(
          target,
          skillId,
          {
            pinned: false,
            activeVersion: Schema.decodeUnknownSync(SkillVersion)(2),
          },
          audit,
        );
      }).pipe(Effect.provide(test.layer)),
    );
    expect(test.state()).toMatchObject({
      skill: { activeVersion: 2, pinned: false },
      versions: [2, 1],
    });
  });

  it("requires current reviewed MCP tools for activation and new Thread resolution", async () => {
    const test = await harness({ mcpReference: true, approved: false });
    const rejected = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SkillService;
        return yield* Effect.flip(
          service.changeState(target, skillId, { enabled: true }, audit),
        );
      }).pipe(Effect.provide(test.layer)),
    );
    expect(rejected).toBeInstanceOf(SkillMcpReferenceInvalid);
    expect(test.state().skill.enabled).toBe(false);

    test.approve();
    const snapshots = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SkillService;
        yield* service.changeState(target, skillId, { enabled: true }, audit);
        return yield* service.resolveForThread(principal, projectId);
      }).pipe(Effect.provide(test.layer)),
    );
    expect(snapshots).toEqual([
      expect.objectContaining({ id: skillId, version: 1, scope: "personal" }),
    ]);
    expect(JSON.stringify(snapshots)).not.toMatch(
      /credential|token|instructions/i,
    );
  });

  it("rejects a disabled MCP server as a business conflict", async () => {
    const test = await harness({
      mcpReference: true,
      approved: true,
      serverEnabled: false,
    });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SkillService;
        return yield* Effect.flip(
          service.changeState(target, skillId, { enabled: true }, audit),
        );
      }).pipe(Effect.provide(test.layer)),
    );
    expect(error).toBeInstanceOf(SkillMcpReferenceInvalid);
    expect(test.updateStateCalls()).toBe(0);
    expect(test.state().skill.enabled).toBe(false);
  });
});
