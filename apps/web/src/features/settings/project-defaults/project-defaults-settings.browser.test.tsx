import type { OrbProviderListData, ProjectDefaultsData } from "@dx/api";
import { type RunnerProfileId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { orbProviderKeys } from "../orb-providers/orb-providers-queries.js";
import {
  type ProjectDefaultsTarget,
  projectDefaultsKeys,
} from "./project-defaults-queries.js";
import { ProjectDefaultsSettings } from "./project-defaults-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
  }: {
    readonly children: React.ReactNode;
    readonly to?: string;
  }) => <a href={to ?? "/projects"}>{children}</a>,
}));

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const target = { scope: "personal" } as const satisfies ProjectDefaultsTarget;

const defaults = (
  revision: number,
  commitAuthor: ProjectDefaultsData["overrides"]["commitAuthor"] = null,
  dxCoAuthor: ProjectDefaultsData["overrides"]["dxCoAuthor"] = null,
): ProjectDefaultsData => ({
  scope: "personal",
  revision,
  overrides: {
    shipAction: null,
    commitAuthor,
    signingPreference: null,
    runnerProfileId: null,
    dxCoAuthor,
  },
  resolved: {
    shipAction: { value: "ship", source: "deployment" },
    commitAuthor: { value: commitAuthor ?? "dx", source: "deployment" },
    signingPreference: { value: "disabled", source: "deployment" },
    runnerProfileId: {
      value: "e2b-standard" as never,
      source: "deployment",
    },
    dxCoAuthor: {
      value: dxCoAuthor ?? true,
      source: dxCoAuthor === null ? "deployment" : "personal",
    },
  },
  catalog: {
    version: 1,
    defaultProfileId: "e2b-standard" as never,
    profiles: [],
    adapterStates: [],
  },
  restrictions: {
    allowProjectCreation: true,
    allowPublicCodeAccess: false,
    allowedRunnerProfileIds: null,
    source: "deployment",
  },
  canUpdate: true,
});

/** The providers set up for this person: what a new Thread can start on. */
const resolvedOrbs = (
  providerIds: ReadonlyArray<
    OrbProviderListData["resolved"][number]["providerId"]
  >,
): OrbProviderListData => ({
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
});

const renderSettings = async (
  queryClient: QueryClient,
  initial: ProjectDefaultsData,
  orbs: OrbProviderListData = resolvedOrbs(["e2b"]),
) => {
  queryClient.setQueryData(projectDefaultsKeys.detail(userId, target), initial);
  queryClient.setQueryData(orbProviderKeys.list(userId, target), orbs);
  const container = document.createElement("div");
  const root = createRoot(container);
  await React.act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider
          value={{
            identity: {
              id: userId,
              name: "Test User",
              email: "test@example.com",
            },
            logout: () => undefined,
          }}
        >
          <ProjectDefaultsSettings onDirtyChange={() => undefined} />
        </AuthContext.Provider>
      </QueryClientProvider>,
    ),
  );
  return { container, root };
};

const selectCommitAuthor = (container: HTMLElement, value: "dx" | "user") => {
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Default commit author"]',
  );
  React.act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    setter?.call(select, value);
    select?.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return select;
};

describe("project defaults settings", () => {
  // #1303: on until someone turns it off; saving sends only that change.
  it("shows Add dx as co-author on by default and saves it turned off", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const saved = defaults(2, null, false);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "success", data: saved }));
    vi.stubGlobal("fetch", fetchMock);
    const { container, root } = await renderSettings(queryClient, defaults(1));

    const toggle = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Add dx as co-author"]',
      );
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Add dx as co-author");
    await React.act(async () => toggle()?.click());
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    const save = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Save Defaults",
    );
    await React.act(async () => save?.click());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      expectedRevision: 1,
      overrides: { commitAuthor: null, dxCoAuthor: false },
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Project defaults saved for new projects.",
      ),
    );
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");

    await React.act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("keeps the saved confirmation mounted through the authoritative Query write", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const saved = defaults(4, "user");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "success", data: saved }));
    vi.stubGlobal("fetch", fetchMock);
    const { container, root } = await renderSettings(queryClient, defaults(3));

    selectCommitAuthor(container, "user");
    const save = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Save Defaults",
    );
    await React.act(async () => save?.click());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Project defaults saved for new projects.",
      ),
    );
    expect(
      queryClient.getQueryData(projectDefaultsKeys.detail(userId, target)),
    ).toEqual(saved);

    await React.act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("keeps a dirty draft on its baseline revision when Query receives a newer revision", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ status: "success", data: defaults(5, "user") }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { container, root } = await renderSettings(queryClient, defaults(3));

    const select = selectCommitAuthor(container, "user");
    await React.act(() =>
      queryClient.setQueryData(
        projectDefaultsKeys.detail(userId, target),
        defaults(4, "dx"),
      ),
    );
    expect(select?.value).toBe("user");

    const save = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Save Defaults",
    );
    await React.act(async () => save?.click());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      expectedRevision: 3,
      overrides: { commitAuthor: "user" },
    });

    await React.act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("keeps a draft mounted when a background defaults refetch fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { container, root } = await renderSettings(queryClient, defaults(3));
    const select = selectCommitAuthor(container, "user");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unavailable")));

    await React.act(async () => {
      await queryClient.refetchQueries({
        queryKey: projectDefaultsKeys.detail(userId, target),
        exact: true,
      });
    });
    await React.act(async () => {
      await vi.waitFor(() =>
        expect(
          queryClient.getQueryState(projectDefaultsKeys.detail(userId, target))
            ?.error,
        ).toBeInstanceOf(Error),
      );
    });

    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Default commit author"]',
      ),
    ).toBe(select);
    expect(select?.value).toBe("user");
    await React.act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "Project defaults could not be refreshed. Showing the last loaded settings.",
        ),
      );
    });

    await React.act(() => root.unmount());
    vi.unstubAllGlobals();
  });
  // #1691: Orb Size lists only the providers set up for this person, keeps a
  // saved default on any other provider as one unavailable size, and links to
  // Orb Providers to add one.
  it("lists only Orb providers that are set up, keeping a saved default on another as unavailable", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const size = (id: string, adapter: "e2b" | "cloudflare" | "freestyle") => ({
      id: id as RunnerProfileId,
      label: id,
      adapter,
      resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
      isolation: "sandbox" as const,
      availability: "available" as const,
      capabilities: [],
    });
    const initial = defaults(1);
    const { container, root } = await renderSettings(
      queryClient,
      {
        ...initial,
        overrides: {
          ...initial.overrides,
          runnerProfileId: "cf-standard" as RunnerProfileId,
        },
        resolved: {
          ...initial.resolved,
          runnerProfileId: {
            value: "cf-standard" as RunnerProfileId,
            source: "personal",
          },
        },
        catalog: {
          ...initial.catalog,
          profiles: [
            size("e2b-standard", "e2b"),
            size("e2b-large", "e2b"),
            size("cf-standard", "cloudflare"),
            size("cf-large", "cloudflare"),
            size("fs-standard", "freestyle"),
          ],
          providers: [
            { adapter: "e2b", displayName: "E2B", pauseResume: "processes" },
            {
              adapter: "cloudflare",
              displayName: "Cloudflare Containers",
              pauseResume: "filesystem",
            },
            {
              adapter: "freestyle",
              displayName: "Freestyle",
              pauseResume: "processes",
            },
          ],
        },
      },
      resolvedOrbs(["e2b"]),
    );

    const card = (id: string) =>
      [...container.querySelectorAll("label.runner-profile-card")].find(
        (label) => label.querySelector("strong")?.textContent === id,
      );
    const cardIds = [
      ...container.querySelectorAll("label.runner-profile-card strong"),
    ].map(({ textContent }) => textContent);
    expect(cardIds).toEqual(["e2b-standard", "e2b-large", "cf-standard"]);
    expect(
      [...container.querySelectorAll(".orb-size-picker-group h3")].map(
        ({ textContent }) => textContent,
      ),
    ).toEqual(["E2B", "Cloudflare ContainersNot available"]);
    expect(card("e2b-large")?.querySelector("input")?.disabled).toBe(false);
    const saved = card("cf-standard")?.querySelector("input");
    expect(saved?.checked).toBe(true);
    expect(saved?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Freestyle");
    const link = [...container.querySelectorAll("a")].find(
      ({ textContent }) => textContent === "Orb Providers",
    );
    expect(link?.getAttribute("href")).toBe("/settings/orb-providers");

    await React.act(() => root.unmount());
  });

  it("says no Orb provider is set up when none is, and links to Orb Providers", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const initial = defaults(1);
    const { container, root } = await renderSettings(
      queryClient,
      {
        ...initial,
        catalog: {
          ...initial.catalog,
          profiles: [
            {
              id: "e2b-standard" as RunnerProfileId,
              label: "e2b-standard",
              adapter: "e2b",
              resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
              isolation: "sandbox",
              availability: "available",
              capabilities: [],
            },
          ],
        },
      },
      resolvedOrbs([]),
    );

    expect(
      container.querySelectorAll("label.runner-profile-card"),
    ).toHaveLength(1);
    expect(
      container.querySelector<HTMLInputElement>(
        "label.runner-profile-card input",
      )?.disabled,
    ).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "No Orb provider is set up, so new projects can't start Threads. Add one in Orb Providers.",
    );

    await React.act(() => root.unmount());
  });
});
