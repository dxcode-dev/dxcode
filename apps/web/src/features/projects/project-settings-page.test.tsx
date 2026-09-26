// @vitest-environment happy-dom

import type { ProjectData, ProjectDefaultsData } from "@dx/api";
import type { ProjectId, RunnerProfileId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const route = vi.hoisted(() => ({ section: "orb" }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  useParams: () => ({ projectId: "project-1", section: route.section }),
  useLocation: ({
    select,
  }: {
    readonly select: (location: {
      readonly href: string;
      readonly pathname: string;
    }) => unknown;
  }) =>
    select({
      href: "/projects/project-1/settings",
      pathname: "/projects/project-1/settings",
    }),
}));
vi.mock("../../shared/auth/auth-context.js", () => ({
  useAuthenticatedIdentity: () => ({
    identity: {
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
    },
  }),
}));

import { bitbucketKeys } from "../settings/integrations/bitbucket-queries.js";
import {
  type ProjectDefaultsTarget,
  projectDefaultsKeys,
} from "../settings/project-defaults/project-defaults-queries.js";
import { settingsKeys } from "../settings/settings-context-queries.js";
import { projectKeys } from "./project-queries.js";
import { ProjectSettingsPage } from "./project-settings-page.js";
import { sourceGrantKeys } from "./source-grant-queries.js";

const userId = "user-1" as UserId;
const projectId = "project-1" as ProjectId;
const personalTarget = {
  scope: "personal",
} as const satisfies ProjectDefaultsTarget;
const profile = (id: string, label: string) => ({
  id: id as RunnerProfileId,
  label,
  adapter: "e2b" as const,
  resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
  isolation: "sandbox" as const,
  availability: "available" as const,
  capabilities: [],
});
const defaults = {
  scope: "personal",
  revision: 1,
  overrides: {
    shipAction: null,
    commitAuthor: null,
    signingPreference: null,
    runnerProfileId: null,
  },
  resolved: {
    shipAction: { value: "commit", source: "deployment" },
    commitAuthor: { value: "dx", source: "deployment" },
    signingPreference: { value: "disabled", source: "deployment" },
    runnerProfileId: {
      value: "standard" as RunnerProfileId,
      source: "deployment",
    },
  },
  catalog: {
    version: 1,
    defaultProfileId: "standard" as RunnerProfileId,
    profiles: [profile("standard", "Standard"), profile("large", "Large")],
    adapterStates: [],
  },
  restrictions: {
    allowProjectCreation: true,
    allowPublicCodeAccess: false,
    allowedRunnerProfileIds: null,
    source: "deployment",
  },
  canUpdate: true,
} as ProjectDefaultsData;

const project = (
  revision = 1,
  overrides: Partial<ProjectData> = {},
): ProjectData =>
  ({
    id: projectId,
    name: "Project one",
    description: "Initial description",
    revision,
    configuration: { runnerProfileId: "standard" as RunnerProfileId },
    ...overrides,
  }) as ProjectData;

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const renderSettings = async (
  section: "general" | "orb",
  initialProject: ProjectData,
  settings: object | null = {},
  seed?: (queryClient: QueryClient) => void,
) => {
  route.section = section;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    projectKeys.detail(userId, projectId),
    initialProject,
  );
  if (settings !== null)
    queryClient.setQueryData(
      settingsKeys.context(userId, { scope: "personal" }),
      settings,
    );
  queryClient.setQueryData(
    projectDefaultsKeys.detail(userId, personalTarget),
    defaults,
  );
  seed?.(queryClient);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ProjectSettingsPage renderEnvironmentSettings={() => null} />
      </QueryClientProvider>,
    ),
  );
  return { container, queryClient, root };
};

describe("project settings workspace state", () => {
  it("keeps public project settings copy dx-owned", async () => {
    const general = await renderSettings("general", project());
    expect(general.container.textContent).toContain(
      "Shown next to the project across dx.",
    );
    expect(general.container.textContent).not.toMatch(/\bamp\b/i);
    await React.act(() => general.root.unmount());

    const orb = await renderSettings("orb", project());
    expect(orb.container.textContent).toContain(
      "These files help dx prepare Orbs and expose app portals.",
    );
    expect(orb.container.textContent).not.toMatch(/\bamp\b/i);
    await React.act(() => orb.root.unmount());
  });

  it("keeps available providers visible while active Bitbucket repositories load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const mounted = await renderSettings(
      "general",
      project(),
      {},
      (queryClient) => {
        queryClient.setQueryData(sourceGrantKeys.personal(userId), [
          {
            id: "grant-1",
            ownerScope: "personal",
            ownerId: userId,
            installationId: "7",
            status: "active",
            installationStatus: "active",
            account: { id: "9", login: "octocat", type: "user" },
            repositorySelection: "selected",
            repositories: [
              {
                id: "101",
                fullName: "octocat/dx",
                webUrl: "https://github.com/octocat/dx",
                visibility: "private",
              },
            ],
          },
        ]);
        queryClient.setQueryData(bitbucketKeys.connection(userId), {
          configured: true,
          connection: {
            id: "connection-1",
            accountName: "dx-team",
            status: "active",
          },
        });
      },
    );

    expect(mounted.container.textContent).toContain(
      "Loading authorized repositories…",
    );
    expect(mounted.container.textContent).toContain("GitHub · octocat/dx");
    expect(
      mounted.container.querySelector('[aria-label="Authorized repository"]'),
    ).not.toBeNull();
    await React.act(() => mounted.root.unmount());
  });

  it("retries GitHub grants and active Bitbucket connection and repositories", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(undefined, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const mounted = await renderSettings(
      "general",
      project(),
      {},
      (queryClient) => {
        queryClient.setQueryData(sourceGrantKeys.personal(userId), []);
        queryClient.setQueryData(bitbucketKeys.connection(userId), {
          configured: true,
          connection: {
            id: "connection-1",
            accountName: "dx-team",
            status: "active",
          },
        });
        queryClient.setQueryData(
          bitbucketKeys.repositories(userId, "connection-1"),
          { connectionId: "connection-1", repositories: [] },
        );
      },
    );
    fetch.mockClear();

    const retry = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    await React.act(() => retry?.click());

    const paths = fetch.mock.calls.map(([path]) => String(path));
    expect(paths).toContain("/v1/integrations/github/personal/grants");
    expect(paths).toContain("/v1/integrations/bitbucket/personal/connection");
    expect(paths).toContain("/v1/integrations/bitbucket/personal/repositories");
    await React.act(() => mounted.root.unmount());
  });

  it("keeps a cached workspace project loading until settings settle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const mounted = await renderSettings(
      "orb",
      project(1, { workspaceId: "workspace-1" as never }),
      null,
    );

    expect(mounted.container.textContent).toContain(
      "Loading workspace settings…",
    );
    expect(mounted.container.textContent).not.toContain(
      "Workspace settings are unavailable.",
    );
    await React.act(() => mounted.root.unmount());
  });

  it("keeps a dirty general editor mounted across a newer project result", async () => {
    const { container, queryClient, root } = await renderSettings(
      "general",
      project(),
    );
    const name = container.querySelector<HTMLInputElement>(
      '[aria-label="Project name"]',
    );
    await React.act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(name, "Local draft");
      name?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await React.act(() =>
      queryClient.setQueryData(
        projectKeys.detail(userId, projectId),
        project(2, { name: "Remote name" as never }),
      ),
    );

    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Project name"]'),
    ).toBe(name);
    expect(name?.value).toBe("Local draft");
    await React.act(() => root.unmount());
  });

  it("keeps a dirty Orb editor mounted across a newer project result", async () => {
    const { container, queryClient, root } = await renderSettings(
      "orb",
      project(),
    );
    const radios = container.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    );
    const large = radios.item(1);
    await React.act(() => large.click());
    expect(large.checked).toBe(true);

    await React.act(() =>
      queryClient.setQueryData(
        projectKeys.detail(userId, projectId),
        project(2),
      ),
    );

    expect(container.querySelectorAll('input[type="radio"]').item(1)).toBe(
      large,
    );
    expect(large.checked).toBe(true);
    await React.act(() => root.unmount());
  });
});
