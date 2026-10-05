// @vitest-environment happy-dom

import type {
  OrbProviderListData,
  ProjectData,
  ProjectDefaultsData,
} from "@dx/api";
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
import { orbProviderKeys } from "../settings/orb-providers/orb-providers-queries.js";
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

/** The providers this person's Threads in the project can start on. */
const seedResolvedOrbs = (
  queryClient: QueryClient,
  providerIds: ReadonlyArray<"e2b" | "cloudflare">,
) =>
  queryClient.setQueryData(
    orbProviderKeys.list(userId, { scope: "personal" }, projectId),
    {
      scope: "personal",
      canUpdate: true,
      localRuntime: false,
      providers: [],
      personalKeysOnWorkspaceProjects: null,
      resolved: providerIds.map((providerId) => ({
        providerId,
        scope: "deployment",
        account: null,
        status: "ready",
      })),
    } satisfies OrbProviderListData,
  );

const cloudflareProfile = (id: string, cpuCores: number) => ({
  ...profile(id, id),
  adapter: "cloudflare" as const,
  isolation: "container" as const,
  resources: { cpuCores, memoryMb: 4096, diskGb: 8 },
});

/** A catalog with E2B (standard, large) and Cloudflare (standard-1, -2). */
const seedTwoProviderCatalog = (queryClient: QueryClient) =>
  queryClient.setQueryData(projectDefaultsKeys.detail(userId, personalTarget), {
    ...defaults,
    catalog: {
      ...defaults.catalog,
      profiles: [
        ...defaults.catalog.profiles,
        cloudflareProfile("standard-1", 0.5),
        cloudflareProfile("standard-2", 1),
      ],
      providers: [
        { adapter: "e2b", displayName: "E2B", pauseResume: "processes" },
        {
          adapter: "cloudflare",
          displayName: "Cloudflare Containers",
          shortName: "Cloudflare",
          pauseResume: "filesystem",
        },
      ],
    },
  });

const sectionNames = (container: HTMLElement) =>
  [...container.querySelectorAll(".orb-size-section-trigger")].map(
    (trigger) => trigger.textContent,
  );

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
  seedResolvedOrbs(queryClient, ["e2b"]);
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

  it("groups Orb sizes by provider in an accordion opened at the saved default", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const consoleError = vi.spyOn(console, "error");
    const { container, root } = await renderSettings(
      "orb",
      project(1, {
        configuration: {
          runnerProfileId: "standard-1" as RunnerProfileId,
        } as ProjectData["configuration"],
      }),
      {},
      (queryClient) => {
        seedTwoProviderCatalog(queryClient);
        seedResolvedOrbs(queryClient, ["e2b", "cloudflare"]);
      },
    );
    const section = (name: string) =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".orb-size-section-trigger",
        ),
      ].find((trigger) => trigger.textContent === name);
    const checked = () =>
      [
        ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ].map((radio) => radio.checked);

    // Settings keep the provider's long name.
    expect(sectionNames(container)).toEqual(["E2B", "Cloudflare Containers"]);
    expect(section("E2B")?.getAttribute("aria-expanded")).toBe("false");
    expect(
      section("Cloudflare Containers")?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      container
        .querySelector('[role="radiogroup"]')
        ?.getAttribute("aria-label"),
    ).toBe("Cloudflare Containers sizes");
    expect(checked()).toEqual([true, false]);

    // One section open at a time.
    await React.act(() => section("E2B")?.click());
    expect(section("E2B")?.getAttribute("aria-expanded")).toBe("true");
    expect(
      section("Cloudflare Containers")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      container
        .querySelector('[role="radiogroup"]')
        ?.getAttribute("aria-label"),
    ).toBe("E2B sizes");
    expect(checked()).toEqual([false, false]);

    // Choosing a size in another section saves as the project default.
    await React.act(() =>
      container
        .querySelectorAll<HTMLInputElement>('input[type="radio"]')
        .item(1)
        .click(),
    );
    expect(checked()).toEqual([false, true]);
    expect(section("E2B")?.getAttribute("aria-expanded")).toBe("true");
    expect(String(consoleError.mock.calls)).not.toContain("Accordion");
    consoleError.mockRestore();
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    await React.act(() => save?.click());
    const [, init] = fetch.mock.calls.at(-1) as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toMatchObject({
      revision: 1,
      runnerProfileId: "large",
    });
    await React.act(() => root.unmount());
  });

  it("lists only providers resolved for this person in the project", async () => {
    const { container, root } = await renderSettings(
      "orb",
      project(),
      {},
      seedTwoProviderCatalog,
    );
    expect(sectionNames(container)).toEqual(["E2B"]);
    await React.act(() => root.unmount());
  });

  it("keeps a saved default on a provider outside the set, marked not available", async () => {
    const { container, root } = await renderSettings(
      "orb",
      project(1, {
        configuration: {
          runnerProfileId: "standard-2" as RunnerProfileId,
        } as ProjectData["configuration"],
      }),
      {},
      seedTwoProviderCatalog,
    );
    expect(sectionNames(container)).toEqual([
      "E2B",
      "Cloudflare ContainersNot available",
    ]);
    const unavailable = container.querySelectorAll<HTMLButtonElement>(
      ".orb-size-section-trigger",
    )[1];
    expect(unavailable?.getAttribute("aria-expanded")).toBe("true");
    // Only the saved size is shown, checked and not choosable.
    const radios = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ];
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
      "standard-21 CPU4GB memory8GB disk",
    ]);
    expect(radios[0]?.checked).toBe(true);
    expect(radios[0]?.disabled).toBe(true);
    await React.act(() => root.unmount());
  });
});
