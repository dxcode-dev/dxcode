import {
  defaultWorkspacePolicy,
  Principal,
  RunnerProfileId,
  SettingsScopeForbidden,
  WorkspaceMembership,
  type WorkspacePolicy,
  type WorkspacePolicyAction,
  type WorkspacePolicyAuditRecord,
  type WorkspacePolicyDenied,
  WorkspacePolicyRepository,
  type WorkspacePolicyUpdate,
  WorkspaceRepository,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import {
  InvalidWorkspacePolicy,
  WorkspacePolicyService,
  workspacePolicyDenial,
} from "./service.js";

const principal = Schema.decodeUnknownSync(Principal)({
  userId: "policy-owner",
  credentialScopes: ["personal", "workspace"],
});
const membership = Schema.decodeUnknownSync(WorkspaceMembership)({
  workspace: {
    id: "policy-workspace",
    displayName: "Policy Team",
    shortName: "policy-team",
    lifecycleState: "active",
    revision: 0,
  },
  userId: principal.userId,
  role: "owner",
});
const localRunner = Schema.decodeUnknownSync(RunnerProfileId)("local-default");
const remoteRunner = Schema.decodeUnknownSync(RunnerProfileId)("e2b-default");

const deniedPolicy: WorkspacePolicy = {
  ...defaultWorkspacePolicy(membership.workspace.id),
  restrictions: {
    allowedRunnerProfileIds: [localRunner],
    allowRemoteRunners: false,
    allowPersonalProviderOverrides: false,
    allowPersonalMcpOverrides: false,
    allowPersonalSecretOverrides: false,
    allowPersonalPluginOverrides: false,
    allowPersonalExecutionOverrides: false,
  },
};

const denialCases = [
  [
    {
      kind: "project.create",
      runnerProfileId: remoteRunner,
      runnerAdapter: "e2b",
    },
    "runner-profile-restricted",
  ],
  [
    {
      kind: "execution.admit",
      runnerProfileId: localRunner,
      runnerAdapter: "e2b",
    },
    "remote-runner-disabled",
  ],
  [
    { kind: "provider.use-personal-override" },
    "personal-provider-overrides-disabled",
  ],
  [{ kind: "mcp.use-personal-override" }, "personal-mcp-overrides-disabled"],
  [
    { kind: "secret.use-personal-override" },
    "personal-secret-overrides-disabled",
  ],
] as const satisfies ReadonlyArray<
  readonly [WorkspacePolicyAction, WorkspacePolicyDenied["reason"]]
>;

const layerFor = (options?: {
  readonly role?: "owner" | "admin" | "member";
  readonly policy?: WorkspacePolicy;
  readonly rejected?: Array<WorkspacePolicyAuditRecord>;
}) => {
  let policy =
    options?.policy ?? defaultWorkspacePolicy(membership.workspace.id);
  const workspaces = Layer.succeed(
    WorkspaceRepository,
    WorkspaceRepository.of({
      findByUser: () =>
        Effect.succeed(
          Option.some({
            ...membership,
            role: options?.role ?? membership.role,
          }),
        ),
      createOwnedByUser: () => Effect.die("not used"),
      updateProfile: () => Effect.die("not used"),
    }),
  );
  const policies = Layer.succeed(
    WorkspacePolicyRepository,
    WorkspacePolicyRepository.of({
      get: () => Effect.succeed(policy),
      put: (_workspaceId, input, expectedRevision) => {
        policy = { ...policy, ...input, revision: expectedRevision + 1 };
        return Effect.succeed(policy);
      },
      recordRejected: (record) =>
        Effect.sync(() => {
          options?.rejected?.push(record);
        }),
      allowedRunnerProfileIds: () =>
        Effect.succeed(policy.restrictions.allowedRunnerProfileIds),
    }),
  );
  const settings = SettingsService.layer.pipe(Layer.provide(workspaces));
  return WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(workspaces, settings, policies, SettingsAudit.layer),
    ),
  );
};

const updateFor = (
  policy: WorkspacePolicy,
  patch: Partial<WorkspacePolicyUpdate["restrictions"]> = {},
): WorkspacePolicyUpdate => ({
  restrictions: { ...policy.restrictions, ...patch },
});

describe("workspacePolicyDenial", () => {
  it.each(denialCases)("denies $0.kind with $1", (action, reason) => {
    expect(workspacePolicyDenial(deniedPolicy, action)).toMatchObject({
      _tag: "WorkspacePolicyDenied",
      reason,
    });
  });

  it("denies personal Orb keys until the workspace explicitly opts in", () => {
    const execution = {
      kind: "plugin.use-personal-override",
      pluginId: "execution",
    } as const;
    const search = { ...execution, pluginId: "search" } as const;
    const defaults = defaultWorkspacePolicy(membership.workspace.id);
    // The general flag defaults to true; it is not an opt-in for Execution.
    expect(defaults.restrictions.allowPersonalPluginOverrides).toBe(true);
    expect(workspacePolicyDenial(defaults, search)).toBeUndefined();
    expect(workspacePolicyDenial(defaults, execution)).toMatchObject({
      reason: "personal-plugin-overrides-disabled",
    });
    const optedIn = {
      ...defaults,
      restrictions: {
        ...defaults.restrictions,
        allowPersonalExecutionOverrides: true,
      },
    };
    expect(workspacePolicyDenial(optedIn, execution)).toBeUndefined();
    // The opt-in applies only together with the general flag.
    expect(
      workspacePolicyDenial(
        {
          ...optedIn,
          restrictions: {
            ...optedIn.restrictions,
            allowPersonalPluginOverrides: false,
          },
        },
        execution,
      ),
    ).toMatchObject({ reason: "personal-plugin-overrides-disabled" });
  });
});

describe("WorkspacePolicyService", () => {
  it.each(["owner", "admin"] as const)(
    "allows a %s to update enforced restrictions",
    async (role) => {
      const current = defaultWorkspacePolicy(membership.workspace.id);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkspacePolicyService;
          return yield* service.update(
            principal,
            membership.workspace.shortName,
            updateFor(current, { allowRemoteRunners: false }),
            0,
            [localRunner, remoteRunner],
            `request-${role}`,
          );
        }).pipe(Effect.provide(layerFor({ role, policy: current }))),
      );
      expect(result.policy).toMatchObject({
        revision: 1,
        restrictions: { allowRemoteRunners: false },
      });
    },
  );

  it("rejects newly introduced unknown runner IDs and empty restrictions", async () => {
    const current = defaultWorkspacePolicy(membership.workspace.id);
    const unknown = Schema.decodeUnknownSync(RunnerProfileId)("unknown-runner");
    for (const allowedRunnerProfileIds of [[unknown], []]) {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* WorkspacePolicyService;
            return yield* service.update(
              principal,
              membership.workspace.shortName,
              updateFor(current, { allowedRunnerProfileIds }),
              0,
              [localRunner, remoteRunner],
              "request-invalid-runner",
            );
          }).pipe(Effect.provide(layerFor({ policy: current }))),
        ),
      ).rejects.toBeInstanceOf(InvalidWorkspacePolicy);
    }
  });

  it("gives members a read-only view and audits mutation rejection", async () => {
    const rejected: Array<WorkspacePolicyAuditRecord> = [];
    const current = defaultWorkspacePolicy(membership.workspace.id);
    const layer = layerFor({ role: "member", policy: current, rejected });
    const view = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* WorkspacePolicyService).get(
          principal,
          membership.workspace.shortName,
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(view).toMatchObject({ canUpdate: false, workspaceRole: "member" });

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* WorkspacePolicyService).update(
            principal,
            membership.workspace.shortName,
            updateFor(current, { allowRemoteRunners: false }),
            0,
            [localRunner, remoteRunner],
            "request-member",
          );
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toBeInstanceOf(SettingsScopeForbidden);
    expect(rejected).toMatchObject([
      { outcome: "rejected", reason: "permission", previousRevision: 0 },
    ]);
  });
});
