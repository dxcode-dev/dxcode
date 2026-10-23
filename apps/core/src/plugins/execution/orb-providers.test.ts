import { describe, expect, it } from "vitest";
import { makeE2BConnector } from "../../execution/e2b/connector.js";
import type { OrbConnection } from "./connections-d1.js";
import {
  type OrbProviderSetInput,
  orbProviderSet,
  personalOrbKeysAllowed,
} from "./orb-providers.js";
import { connectionStatus } from "./preparation.js";

const recipe = "0123456789abcdef";
const configuredAt = "2026-10-04T00:00:00.000Z";

const key = (
  scope: OrbConnection["scope"],
  targetId: string,
  status: OrbConnection["status"] = "ready",
  account = `${scope}-team`,
): OrbConnection => ({
  scope,
  targetId,
  providerId: "e2b",
  configuredAt,
  recipe,
  account,
  status,
  state: {
    builds:
      status === "ready"
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
  },
  progress: null,
  error: status === "failed" ? "E2B could not build it." : null,
  served: null,
  revision: 0,
  updatedAt: configuredAt,
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
  connectors: { e2b: makeE2BConnector() },
  recipes: new Map([["e2b", recipe]]),
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
    expect(set[0]?.targets?.get("a1.medium")).toBe(
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
        orbProviderSet(
          input({ personal: [key("personal", "u", "preparing")] }),
        ),
      )[0],
    ).toMatchObject({ scope: "personal", status: "preparing" });
    expect(
      summary(
        orbProviderSet(input({ personal: [key("personal", "u", "failed")] })),
      )[0],
    ).toMatchObject({ scope: "personal", status: "failed" });
    // A connection prepared for another recipe must be prepared again.
    expect(connectionStatus(key("personal", "u"), "fedcba9876543210")).toBe(
      "preparing",
    );
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
