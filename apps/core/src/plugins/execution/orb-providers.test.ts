import { describe, expect, it } from "vitest";
import {
  type OrbKeyConfiguration,
  type OrbProviderSetInput,
  orbProviderSet,
  orbTemplateStatus,
  personalOrbKeysAllowed,
} from "./orb-providers.js";

const recipe = "0123456789abcdef";
const configuredAt = "2026-10-04T00:00:00.000Z";

const key = (
  scope: OrbKeyConfiguration["scope"],
  targetId: string,
  state: "building" | "ready" | "failed" = "ready",
  account = `${scope}-team`,
): OrbKeyConfiguration => ({
  scope,
  targetId,
  providerId: "e2b",
  configuredAt,
  template: {
    configuredAt,
    recipe,
    account,
    state,
    builds:
      state === "ready"
        ? [
            {
              profileId: null,
              name: `dx-orb-${recipe}-base`,
              templateId: "t0",
              buildId: "b0",
              status: "ready",
            },
            {
              profileId: "a1.medium",
              name: `dx-orb-${recipe}-a1-medium`,
              templateId: "t1",
              buildId: "b1",
              status: "ready",
            },
          ]
        : [],
    error: state === "failed" ? "E2B could not build it." : null,
    revision: 0,
    updatedAt: configuredAt,
  },
});

const input = (
  overrides: Partial<OrbProviderSetInput> = {},
): OrbProviderSetInput => ({
  deploymentProviders: [
    {
      providerId: "e2b",
      capabilities: ["execution.workspace", "execution.resident-daemon"],
    },
    {
      providerId: "cloudflare",
      capabilities: ["execution.workspace", "execution.resident-daemon"],
    },
  ],
  profileAdapters: new Set(["e2b", "cloudflare"]),
  personal: [],
  workspace: [],
  projectWorkspaceId: null,
  policy: null,
  localRuntime: false,
  recipe,
  ...overrides,
});

const summary = (set: ReturnType<typeof orbProviderSet>) =>
  set.map(({ providerId, scope, ownerId, status }) => ({
    providerId,
    scope,
    ownerId,
    status,
  }));

describe("Orb provider set", () => {
  it("is every deployment provider when nobody brought a key", () => {
    expect(summary(orbProviderSet(input()))).toEqual([
      {
        providerId: "e2b",
        scope: "deployment",
        ownerId: null,
        status: "ready",
      },
      {
        providerId: "cloudflare",
        scope: "deployment",
        ownerId: null,
        status: "ready",
      },
    ]);
  });

  it("puts a personal key over a workspace key over the deployment, per provider", () => {
    const set = orbProviderSet(
      input({
        personal: [key("personal", "user-1")],
        workspace: [key("workspace", "workspace-1")],
      }),
    );
    expect(summary(set)).toEqual([
      {
        providerId: "e2b",
        scope: "personal",
        ownerId: "user-1",
        status: "ready",
      },
      // Containers has no key: deployment scope only.
      {
        providerId: "cloudflare",
        scope: "deployment",
        ownerId: null,
        status: "ready",
      },
    ]);
    expect(set[0]?.templates?.get("a1.medium")).toBe(
      `dx-orb-${recipe}-a1-medium`,
    );
    expect(set[0]?.account).toBe("personal-team");
    expect(
      summary(
        orbProviderSet(input({ workspace: [key("workspace", "ws")] })),
      )[0],
    ).toMatchObject({ scope: "workspace", ownerId: "ws" });
  });

  it("denies personal keys on workspace projects unless the workspace opted in", () => {
    const personal = [key("personal", "user-1")];
    const workspaceProject = { projectWorkspaceId: "ws" } as const;
    // No policy row, or only the general flag (default true): denied.
    for (const policy of [
      null,
      {
        allowPersonalPluginOverrides: true,
        allowPersonalExecutionOverrides: false,
      },
      {
        allowPersonalPluginOverrides: false,
        allowPersonalExecutionOverrides: true,
      },
    ])
      expect(
        orbProviderSet(input({ personal, ...workspaceProject, policy }))[0]
          ?.scope,
      ).toBe("deployment");
    expect(
      orbProviderSet(
        input({
          personal,
          ...workspaceProject,
          policy: {
            allowPersonalPluginOverrides: true,
            allowPersonalExecutionOverrides: true,
          },
        }),
      )[0]?.scope,
    ).toBe("personal");
    // Personal projects always honor personal keys.
    expect(
      personalOrbKeysAllowed({ projectWorkspaceId: null, policy: null }),
    ).toBe(true);
    // A denied personal key leaves the workspace key in charge.
    expect(
      orbProviderSet(
        input({
          personal,
          workspace: [key("workspace", "ws")],
          ...workspaceProject,
        }),
      )[0]?.scope,
    ).toBe("workspace");
  });

  it("does not fall back to the deployment while a key's template is not ready", () => {
    expect(
      summary(
        orbProviderSet(input({ personal: [key("personal", "u", "building")] })),
      )[0],
    ).toMatchObject({ scope: "personal", status: "building" });
    expect(
      summary(
        orbProviderSet(input({ personal: [key("personal", "u", "failed")] })),
      )[0],
    ).toMatchObject({ scope: "personal", status: "failed" });
    // A template from another recipe or an earlier key must be rebuilt.
    const stale = key("personal", "u");
    expect(orbTemplateStatus(stale, "fedcba9876543210")).toBe("building");
    expect(
      orbTemplateStatus(
        { ...stale, configuredAt: "2026-10-05T00:00:00.000Z" },
        recipe,
      ),
    ).toBe("building");
  });

  it("ignores personal and workspace keys in the local runtime", () => {
    expect(
      summary(
        orbProviderSet(
          input({
            deploymentProviders: [
              {
                providerId: "local",
                capabilities: ["execution.workspace"],
              },
            ],
            profileAdapters: new Set(["local", "e2b"]),
            personal: [key("personal", "u")],
            workspace: [key("workspace", "ws")],
            localRuntime: true,
          }),
        ),
      ),
    ).toEqual([
      {
        providerId: "local",
        scope: "deployment",
        ownerId: null,
        status: "ready",
      },
    ]);
  });

  it("leaves out a provider without sizes in the catalog", () => {
    expect(
      orbProviderSet(
        input({
          profileAdapters: new Set(["cloudflare"]),
          personal: [key("personal", "u")],
        }),
      ).map(({ providerId }) => providerId),
    ).toEqual(["cloudflare"]);
  });
});
