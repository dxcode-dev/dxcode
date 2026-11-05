import type {
  OrbProviderListData,
  ProjectData,
  ProjectDefaultsData,
} from "@dx/api";
import type { ProjectId, RunnerProfileId, UserId } from "@dx/domain";
import { builtInShipPrompt } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const route = vi.hoisted(() => ({ section: "orb" }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to = "/",
    params = {},
  }: {
    readonly children: ReactNode;
    readonly to?: string;
    readonly params?: Record<string, string>;
  }) => (
    <a href={to.replace(/\$(\w+)/g, (_, name: string) => params[name] ?? "")}>
      {children}
    </a>
  ),
  useBlocker: () => ({ status: "idle" }),
  useNavigate: () => navigate,
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
vi.mock("../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/auth/auth-context.js")
  >()),
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
    dxCoAuthor: null,
  },
  resolved: {
    shipAction: { value: "push", source: "deployment" },
    commitAuthor: { value: "dx", source: "deployment" },
    signingPreference: { value: "disabled", source: "deployment" },
    runnerProfileId: {
      value: "standard" as RunnerProfileId,
      source: "deployment",
    },
    dxCoAuthor: { value: true, source: "deployment" },
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
    configuration: {
      shipAction: "ship",
      commitAuthor: {
        preference: "dx",
        name: "dxcodeagent",
        email: "agent@dxcode.dev",
      },
      signingPreference: "disabled",
      runnerProfileId: "standard" as RunnerProfileId,
      publicCodeEnabled: false,
      dxCoAuthor: true,
    },
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
        unavailableSizes: [],
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
  [...container.querySelectorAll(".orb-size-picker-group h3")].map(
    (heading) => heading.textContent,
  );
const sizeGroups = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="radiogroup"]')].map((group) =>
    group.getAttribute("aria-label"),
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
    await React.act(async () =>
      mounted.container
        .querySelector<HTMLElement>('[aria-label="Open repository list"]')
        ?.click(),
    );
    await expect
      .poll(() =>
        [...document.querySelectorAll('[role="option"]')].map(
          (option) => option.textContent,
        ),
      )
      .toContain("https://github.com/octocat/dx");
    await React.act(() => mounted.root.unmount());
  });

  it("offers to connect GitHub or Bitbucket, not Retry, when no connection reaches a repository", async () => {
    const fetch = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const mounted = await renderSettings(
      "general",
      project(1, {
        repository: {
          provider: "github",
          fullName: "octocat/Hello-World",
          webUrl: "https://github.com/octocat/Hello-World",
        },
      } as Partial<ProjectData>),
      {},
      (queryClient) => {
        queryClient.setQueryData(sourceGrantKeys.personal(userId), []);
        queryClient.setQueryData(bitbucketKeys.connection(userId), {
          configured: true,
          connection: null,
        });
      },
    );

    const buttons = [...mounted.container.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
    expect(buttons).not.toContain("Retry");
    expect(mounted.container.textContent).toContain(
      "Connect GitHub or Bitbucket to choose a repository.",
    );
    const connect = [...mounted.container.querySelectorAll("a")].find(
      (link) => link.textContent === "Connect",
    );
    expect(connect?.getAttribute("href")).toBe("/settings/integrations");
    expect(fetch).not.toHaveBeenCalled();
    await React.act(() => mounted.root.unmount());
  });

  it("retries GitHub grants and active Bitbucket connection and repositories after loading fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(undefined, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const mounted = await renderSettings(
      "general",
      project(),
      {},
      (queryClient) => {
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
    await React.act(() =>
      vi.waitFor(() =>
        expect(
          mounted.queryClient.getQueryState(sourceGrantKeys.personal(userId))
            ?.status,
        ).toBe("error"),
      ),
    );
    expect(mounted.container.textContent).toContain(
      "Your repositories could not be loaded.",
    );
    expect(
      [...mounted.container.querySelectorAll("a")].some(
        (link) => link.textContent === "Connect",
      ),
    ).toBe(false);
    fetch.mockClear();

    const retry = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
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

  it("groups Orb sizes under provider headings and saves a size from another provider", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetch);
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
    const checked = () =>
      [
        ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ].map((radio) => radio.checked);

    // Settings keep the provider's long name; every size shows at once.
    expect(sectionNames(container)).toEqual(["E2B", "Cloudflare Containers"]);
    expect(sizeGroups(container)).toEqual([
      "E2B sizes",
      "Cloudflare Containers sizes",
    ]);
    expect(checked()).toEqual([false, false, true, false]);

    // Choosing a size under another provider saves as the project default.
    await React.act(() =>
      container
        .querySelectorAll<HTMLInputElement>('input[type="radio"]')
        .item(1)
        .click(),
    );
    expect(checked()).toEqual([false, true, false, false]);
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
    // One provider needs no heading.
    expect(sectionNames(container)).toEqual([]);
    expect(sizeGroups(container)).toEqual(["E2B sizes"]);
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
    const radios = [
      ...container.querySelectorAll<HTMLInputElement>(
        '[aria-label="Cloudflare Containers sizes"] input[type="radio"]',
      ),
    ];
    // Only the saved size is shown, checked and not choosable.
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
      "standard-21 CPU4GB memory8GB disk",
    ]);
    expect(radios[0]?.checked).toBe(true);
    expect(radios[0]?.disabled).toBe(true);
    await React.act(() => root.unmount());
  });

  it("shows a connection's list price and who bills it, and only the deployment's own label on its account", async () => {
    const { container, root } = await renderSettings(
      "orb",
      project(),
      {},
      (queryClient) => {
        seedTwoProviderCatalog(queryClient);
        queryClient.setQueryData(
          projectDefaultsKeys.detail(userId, personalTarget),
          (data: ProjectDefaultsData) => ({
            ...data,
            catalog: {
              ...data.catalog,
              profiles: data.catalog.profiles.map((size) =>
                size.id === "large"
                  ? { ...size, costLabel: "Included in your plan" }
                  : size,
              ),
            },
          }),
        );
        queryClient.setQueryData(
          orbProviderKeys.list(userId, { scope: "personal" }, projectId),
          (data: OrbProviderListData) => ({
            ...data,
            resolved: [
              { ...data.resolved[0], providerId: "e2b", scope: "personal" },
              {
                ...data.resolved[0],
                providerId: "cloudflare",
                scope: "deployment",
              },
            ],
          }),
        );
      },
    );
    const card = (id: string) =>
      [...container.querySelectorAll("label.runner-profile-card")].find(
        (label) => label.querySelector("strong")?.textContent === id,
      );
    const cost = (id: string) =>
      card(id)?.querySelector(".orb-size-card-cost")?.textContent;
    const billing = (id: string) =>
      card(id)?.querySelector(".orb-size-card-billing")?.textContent;

    // E2B bills 2 vCPU and 4 GiB per second: 2 x $0.0504 + 4 x $0.0162.
    expect(cost("Standard")).toBe("$0.17/hour");
    expect(billing("Standard")).toBe(
      "Billed by E2B to your account, paused when inactive",
    );
    // On the person's own E2B account, the deployment's label does not apply.
    expect(cost("Large")).toBe("$0.17/hour");
    // The deployment's account shows no list price and no billing note.
    expect(cost("standard-1")).toBeUndefined();
    expect(billing("standard-1")).toBeUndefined();
    await React.act(() => root.unmount());
  });

  it("prices a Boat connection's sizes from Boat's per-size list", async () => {
    const boatProfile = (id: string, label: string) => ({
      ...profile(id, label),
      adapter: "boat" as const,
    });
    const { container, root } = await renderSettings(
      "orb",
      project(1, {
        configuration: {
          runnerProfileId: "bt.small" as RunnerProfileId,
        } as ProjectData["configuration"],
      }),
      {},
      (queryClient) => {
        queryClient.setQueryData(
          projectDefaultsKeys.detail(userId, personalTarget),
          {
            ...defaults,
            catalog: {
              ...defaults.catalog,
              defaultProfileId: "bt.small" as RunnerProfileId,
              profiles: [
                boatProfile("bt.small", "small"),
                boatProfile("bt.large", "large"),
                // Not one of Boat's sizes, so dx knows no price for it.
                boatProfile("bt.custom", "custom"),
              ],
              providers: [
                {
                  adapter: "boat",
                  displayName: "Boat",
                  pauseResume: "filesystem",
                },
              ],
            },
          },
        );
        seedResolvedOrbs(queryClient, []);
        queryClient.setQueryData(
          orbProviderKeys.list(userId, { scope: "personal" }, projectId),
          (data: OrbProviderListData) => ({
            ...data,
            resolved: [
              {
                providerId: "boat",
                scope: "personal",
                account: null,
                status: "ready",
                unavailableSizes: [],
              },
            ],
          }),
        );
      },
    );
    const labels = [
      ...container.querySelectorAll("label.runner-profile-card"),
    ].map((label) => label.textContent);
    expect(labels).toEqual([
      "small2 CPU4GB memory20GB disk$0.018/hourBilled by Boat to your account, paused when inactive",
      "large2 CPU4GB memory20GB disk$0.072/hourBilled by Boat to your account, paused when inactive",
      "custom2 CPU4GB memory20GB diskBilled by Boat to your account, paused when inactive",
    ]);
    await React.act(() => root.unmount());
  });

  it("names the workspace's account and omits a price dx does not know", async () => {
    const { container, root } = await renderSettings(
      "orb",
      project(1, {
        configuration: {
          runnerProfileId: "local" as RunnerProfileId,
        } as ProjectData["configuration"],
      }),
      {},
      (queryClient) => {
        seedTwoProviderCatalog(queryClient);
        queryClient.setQueryData(
          projectDefaultsKeys.detail(userId, personalTarget),
          (data: ProjectDefaultsData) => ({
            ...data,
            catalog: {
              ...data.catalog,
              profiles: [
                ...data.catalog.profiles,
                {
                  ...profile("local", "local"),
                  adapter: "local" as const,
                },
              ],
            },
          }),
        );
        queryClient.setQueryData(
          orbProviderKeys.list(userId, { scope: "personal" }, projectId),
          (data: OrbProviderListData) => ({
            ...data,
            resolved: [
              {
                ...data.resolved[0],
                providerId: "cloudflare",
                scope: "workspace",
              },
            ],
          }),
        );
      },
    );
    const labels = [
      ...container.querySelectorAll("label.runner-profile-card"),
    ].map((label) => label.textContent);
    expect(labels).toEqual([
      "standard-10.5 CPU4GB memory8GB diskUp to $0.074/hourBilled by Cloudflare to the workspace's account, paused when inactive",
      "standard-21 CPU4GB memory8GB diskUp to $0.11/hourBilled by Cloudflare to the workspace's account, paused when inactive",
      // The saved local size: no known price, and no account pays for it.
      "local2 CPU4GB memory20GB disk",
    ]);
    await React.act(() => root.unmount());
  });
});

describe("project General: Ship Behavior, Commit Author, and dx co-author", () => {
  const dialog = () =>
    document.querySelector<HTMLElement>('[aria-label="Customize Ship Prompt"]');
  const promptInput = () =>
    dialog()?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
  const buttonNamed = (root: ParentNode, name: string) =>
    [...root.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === name,
    ) ?? null;
  const choose = (select: HTMLSelectElement | null, value: string) =>
    React.act(() => {
      if (select === null) throw new Error("Missing select.");
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const type = (input: HTMLTextAreaElement | null, value: string) =>
    React.act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("drafts all three with the other General edits and saves them with one Save", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const { container, root } = await renderSettings("general", project());
    const shipSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Ship Behavior"]',
    );
    const authorSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Commit Author"]',
    );
    const coAuthor = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add dx as co-author"]',
    );
    expect(shipSelect?.value).toBe("ship");
    expect(authorSelect?.value).toBe("dx");
    expect(container.textContent).toContain("dxcodeagent <agent@dxcode.dev>");
    // dx is never the co-author of its own commits.
    expect(coAuthor?.disabled).toBe(true);

    await choose(authorSelect, "user");
    expect(container.textContent).toContain("Test User <test@example.com>");
    expect(coAuthor?.disabled).toBe(false);
    expect(coAuthor?.getAttribute("aria-pressed")).toBe("true");
    await React.act(() => coAuthor?.click());
    expect(coAuthor?.getAttribute("aria-pressed")).toBe("false");

    // Custom Ship starts from the default prompt and changes only the form.
    await choose(shipSelect, "custom");
    expect(promptInput()?.value).toBe(builtInShipPrompt("ship"));
    await type(promptInput(), "Open a PR with our template. Do not merge.");
    await React.act(() =>
      buttonNamed(dialog() ?? document, "Use Custom Ship")?.click(),
    );
    expect(dialog()).toBeNull();
    expect(shipSelect?.value).toBe("custom");
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/projects/"),
      expect.objectContaining({ method: "PATCH" }),
    );

    await React.act(() => buttonNamed(container, "Save")?.click());
    const patch = fetch.mock.calls
      .map((call) => call as unknown as [string, RequestInit])
      .find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1].body))).toEqual({
      revision: 1,
      description: "Initial description",
      shipAction: "custom",
      shipPrompt: "Open a PR with our template. Do not merge.",
      commitAuthor: "user",
      dxCoAuthor: false,
    });
    await React.act(() => root.unmount());
  });

  it("keeps the saved choice when the prompt editor is cancelled, and refuses a blank or oversized prompt", async () => {
    const { container, root } = await renderSettings("general", project());
    const shipSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Ship Behavior"]',
    );
    await choose(shipSelect, "custom");
    await React.act(() => buttonNamed(dialog() ?? document, "Cancel")?.click());
    expect(dialog()).toBeNull();
    expect(shipSelect?.value).toBe("ship");

    await choose(shipSelect, "custom");
    await type(promptInput(), "   ");
    expect(buttonNamed(dialog() ?? document, "Use Custom Ship")?.disabled).toBe(
      true,
    );
    await type(promptInput(), "x".repeat(10_001));
    expect(buttonNamed(dialog() ?? document, "Use Custom Ship")?.disabled).toBe(
      true,
    );
    expect(dialog()?.textContent).toContain("10,001 / 10,000");
    await React.act(() => buttonNamed(dialog() ?? document, "Cancel")?.click());
    await React.act(() => root.unmount());
  });

  it("opens a saved custom prompt for editing, and a switch back to Ship keeps it", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const saved = project(3, {
      configuration: {
        ...project().configuration,
        shipAction: "custom",
        shipPrompt: "Our release script.",
      } as ProjectData["configuration"],
    });
    const { container, root } = await renderSettings("general", saved);
    await React.act(() => buttonNamed(container, "Edit Prompt")?.click());
    expect(promptInput()?.value).toBe("Our release script.");
    await React.act(() => buttonNamed(dialog() ?? document, "Cancel")?.click());

    await choose(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Ship Behavior"]',
      ),
      "push",
    );
    expect(buttonNamed(container, "Edit Prompt")).toBeNull();
    await React.act(() => buttonNamed(container, "Save")?.click());
    const patch = fetch.mock.calls
      .map((call) => call as unknown as [string, RequestInit])
      .find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1].body))).toEqual({
      revision: 3,
      description: "Initial description",
      shipAction: "push",
    });
    await React.act(() => root.unmount());
  });
});

describe("project settings keyboard and repositories", () => {
  const pressEscape = () =>
    React.act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

  it("closes to the project page on Escape, like the Close button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    navigate.mockClear();
    const { root } = await renderSettings("general", project());
    await pressEscape();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/projects/$projectId",
        params: { projectId },
      }),
    );
    await React.act(() => root.unmount());
  });

  it("leaves Escape to an open dialog or menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    navigate.mockClear();
    const { root } = await renderSettings("general", project());
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    await pressEscape();
    dialog.remove();
    expect(navigate).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });

  it("does not offer the primary repository as an additional one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const { container, root } = await renderSettings(
      "general",
      project(1, {
        repository: {
          provider: "git",
          bindingRevision: 1,
          fullName: "octocat/Hello-World",
          webUrl: "https://github.com/octocat/Hello-World",
        },
      }),
      {},
      (queryClient) => {
        queryClient.setQueryData(sourceGrantKeys.personal(userId), []);
        queryClient.setQueryData(bitbucketKeys.connection(userId), {
          configured: false,
        });
      },
    );
    const trigger = container.querySelector<HTMLElement>(
      "#project-additional-repositories",
    );
    // A combobox takes no name from its text; screen readers need a label.
    expect(trigger?.getAttribute("aria-label")).toBe("Add Repository");
    await React.act(() => trigger?.click());
    const search = document.querySelector<HTMLInputElement>(
      ".additional-repositories-search",
    );
    await React.act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "https://github.com/octocat/hello-world");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.body.textContent).toContain(
      "This is the project's primary repository.",
    );

    // Another pasted repository is still offered.
    await React.act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "https://github.com/octocat/Spoon-Knife");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      [...document.querySelectorAll('[role="option"]')].map(
        (option) => option.textContent,
      ),
    ).toEqual(["https://github.com/octocat/Spoon-Knife"]);
    await React.act(() => root.unmount());
  });
});

describe("a URL-bound project's Git Repository", () => {
  const urlBound = () =>
    project(3, {
      repository: {
        provider: "git",
        bindingRevision: 1,
        fullName: "octocat/Hello-World",
        webUrl: "https://github.com/octocat/Hello-World",
        cloneUrl: "https://github.com/octocat/Hello-World.git",
      },
      remoteAliases: [],
    } as Partial<ProjectData>);
  const noConnections = (queryClient: QueryClient) => {
    queryClient.setQueryData(sourceGrantKeys.personal(userId), []);
    queryClient.setQueryData(bitbucketKeys.connection(userId), {
      configured: true,
      connection: null,
    });
  };
  const type = async (input: HTMLInputElement | null, value: string) => {
    await React.act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const button = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent === name ||
        candidate.getAttribute("aria-label") === name,
    );
  const click = async (element: HTMLElement | undefined) => {
    expect(element).toBeDefined();
    await React.act(async () => element?.click());
  };
  const requests = (fetch: ReturnType<typeof vi.fn>) =>
    fetch.mock.calls.map((call) => {
      const [url, init] = call as [string, RequestInit | undefined];
      return {
        url: String(url),
        method: init?.method ?? "GET",
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
    });

  it("edits the URL in place and saves it as the project's repository", async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { container, root } = await renderSettings(
      "general",
      urlBound(),
      {},
      noConnections,
    );
    const url = container.querySelector<HTMLInputElement>(
      '[aria-label="Repository URL"]',
    );
    expect(url?.value).toBe("https://github.com/octocat/Hello-World");
    expect(url?.disabled).toBe(false);

    await type(url, "https://github.com/octocat/Spoon-Knife");
    await click(button(container, "Save"));

    expect(requests(fetch).filter(({ method }) => method !== "GET")).toEqual([
      {
        url: expect.stringContaining("/v1/projects/project-1/source"),
        method: "PUT",
        body: { revision: 3, url: "https://github.com/octocat/Spoon-Knife" },
      },
    ]);
    await React.act(() => root.unmount());
  });

  it("says why a URL is refused and sends nothing", async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { container, root } = await renderSettings(
      "general",
      urlBound(),
      {},
      noConnections,
    );
    await type(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Repository URL"]',
      ),
      "git@github.com:octocat/Spoon-Knife.git",
    );
    await click(button(container, "Save"));
    expect(container.textContent).toContain(
      "Enter an HTTPS Git URL without credentials",
    );
    expect(requests(fetch).filter(({ method }) => method !== "GET")).toEqual(
      [],
    );
    await React.act(() => root.unmount());
  });

  it("copies a git clone command for the saved URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const writeText = vi.fn(async () => undefined);
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({
      writeText,
    } as unknown as Clipboard);
    const { container, root } = await renderSettings(
      "general",
      urlBound(),
      {},
      noConnections,
    );
    await click(button(container, "Clone"));
    expect(writeText).toHaveBeenCalledWith(
      "git clone https://github.com/octocat/Hello-World.git",
    );
    await React.act(() => root.unmount());
  });

  it("adds and removes Git remote aliases and saves the list", async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { container, root } = await renderSettings(
      "general",
      project(3, {
        ...urlBound(),
        remoteAliases: ["https://mirror.example.test/octocat/hello-world"],
      } as Partial<ProjectData>),
      {},
      noConnections,
    );
    const alias = container.querySelector<HTMLInputElement>(
      '[aria-label="Git remote alias"]',
    );
    await type(alias, "not a remote");
    await click(button(container, "Add alias"));
    expect(container.textContent).toContain(
      "Enter an HTTPS or SSH Git URL without credentials",
    );
    await type(alias, "git@github.com:octocat/Hello-World.git");
    await click(button(container, "Add alias"));
    await click(
      button(
        container,
        "Remove https://mirror.example.test/octocat/hello-world",
      ),
    );
    expect(
      [
        ...container.querySelectorAll('[aria-label="Git remote aliases"] li'),
      ].map((item) => item.textContent),
    ).toEqual(["git@github.com:octocat/Hello-World.git"]);
    await click(button(container, "Save"));

    expect(requests(fetch).filter(({ method }) => method !== "GET")).toEqual([
      {
        url: expect.stringContaining("/v1/projects/project-1"),
        method: "PATCH",
        body: {
          revision: 3,
          description: "Initial description",
          remoteAliases: ["git@github.com:octocat/Hello-World.git"],
        },
      },
    ]);
    await React.act(() => root.unmount());
  });
});
