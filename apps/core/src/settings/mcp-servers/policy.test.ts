import {
  type McpExecutionConnection,
  StoredMcpServer,
  UserId,
  type WorkspacePolicyAction,
  WorkspacePolicyDenied,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import {
  enforcePersonalMcpOverride,
  filterMcpExecutionConnections,
} from "./service.js";

const ownerUserId = Schema.decodeUnknownSync(UserId)("mcp-policy-user");

const policyLayer = (
  evaluateForUser: (
    userId: UserId,
    action: WorkspacePolicyAction,
  ) => Effect.Effect<void, WorkspacePolicyDenied>,
) =>
  Layer.succeed(
    WorkspacePolicyService,
    WorkspacePolicyService.of({
      get: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      evaluateForUser,
    }),
  );

const connection = (
  scope: "personal" | "workspace",
): McpExecutionConnection => ({
  server: Schema.decodeUnknownSync(StoredMcpServer)({
    id:
      scope === "personal"
        ? "mcp_00000000-0000-4000-8000-000000000001"
        : "mcp_00000000-0000-4000-8000-000000000002",
    target: {
      scope,
      id: scope === "personal" ? ownerUserId : "mcp-policy-workspace",
    },
    name: `${scope} server`,
    endpoint: `https://${scope}.example.com/mcp`,
    transport: "streamable-http",
    timeoutMs: 5_000,
    enabled: true,
    projectIds: [],
    roles: ["owner", "admin", "member"],
    healthStatus: "healthy",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  }),
  tools: [],
});

describe("MCP workspace policy adapters", () => {
  it("evaluates the typed action before a personal MCP mutation", async () => {
    const actions: Array<WorkspacePolicyAction> = [];

    await expect(
      Effect.runPromise(
        enforcePersonalMcpOverride(
          { scope: "personal", id: ownerUserId },
          ownerUserId,
        ).pipe(
          Effect.provide(
            policyLayer((_userId, action) =>
              Effect.sync(() => {
                actions.push(action);
              }),
            ),
          ),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(actions).toEqual([{ kind: "mcp.use-personal-override" }]);
  });

  it("preserves a typed workspace-policy denial for personal MCP mutation", async () => {
    const denial = new WorkspacePolicyDenied({
      reason: "personal-mcp-overrides-disabled",
    });
    const result = await Effect.runPromise(
      enforcePersonalMcpOverride(
        { scope: "personal", id: ownerUserId },
        ownerUserId,
      ).pipe(
        Effect.provide(policyLayer(() => Effect.fail(denial))),
        Effect.flip,
      ),
    );

    expect(result).toBe(denial);
  });

  it("allows or filters personal servers at resolution and tool admission", async () => {
    const personal = connection("personal");
    const workspace = connection("workspace");
    const allowed = await Effect.runPromise(
      filterMcpExecutionConnections(ownerUserId, [personal, workspace]).pipe(
        Effect.provide(policyLayer(() => Effect.void)),
      ),
    );
    const filtered = await Effect.runPromise(
      filterMcpExecutionConnections(ownerUserId, [personal, workspace]).pipe(
        Effect.provide(
          policyLayer(() =>
            Effect.fail(
              new WorkspacePolicyDenied({
                reason: "personal-mcp-overrides-disabled",
              }),
            ),
          ),
        ),
      ),
    );

    expect(allowed).toEqual([personal, workspace]);
    expect(filtered).toEqual([workspace]);
  });
});
