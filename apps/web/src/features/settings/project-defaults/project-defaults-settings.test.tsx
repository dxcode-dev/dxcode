// @vitest-environment happy-dom

import type { ProjectDefaultsData } from "@dx/api";
import { RunnerProfile, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { RunnerProfileCard } from "../../../shared/ui/runner-profile-card.js";
import { settingsManifest } from "../foundation-sections.js";
import {
  resolveSettingsSection,
  settingsPath,
} from "../settings-registration.js";
import {
  type ProjectDefaultsTarget,
  projectDefaultsKeys,
} from "./project-defaults-queries.js";
import { ProjectDefaultsSettings } from "./project-defaults-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { readonly children: React.ReactNode }) => (
    <a href="/projects">{children}</a>
  ),
}));

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const target = { scope: "personal" } as const satisfies ProjectDefaultsTarget;

const defaults = (
  revision: number,
  shipAction: ProjectDefaultsData["overrides"]["shipAction"] = null,
): ProjectDefaultsData => ({
  scope: "personal",
  revision,
  overrides: {
    shipAction,
    commitAuthor: null,
    signingPreference: null,
    runnerProfileId: null,
  },
  resolved: {
    shipAction: { value: shipAction ?? "commit", source: "deployment" },
    commitAuthor: { value: "dx", source: "deployment" },
    signingPreference: { value: "disabled", source: "deployment" },
    runnerProfileId: {
      value: "e2b-standard" as never,
      source: "deployment",
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

const renderSettings = async (
  queryClient: QueryClient,
  initial: ProjectDefaultsData,
) => {
  queryClient.setQueryData(projectDefaultsKeys.detail(userId, target), initial);
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

const selectShipAction = (container: HTMLElement, value: "ship" | "commit") => {
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Default ship behavior"]',
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
  it("registers exact personal and workspace settings routes distinct from the project library", () => {
    expect(settingsPath({ scope: "personal", section: "projects" })).toBe(
      "/settings/projects",
    );
    expect(
      settingsPath({
        scope: "workspace",
        workspaceSlug: "dx-team" as never,
        section: "projects",
      }),
    ).toBe("/workspaces/dx-team/projects");
    expect(
      resolveSettingsSection(settingsManifest, "personal", "projects"),
    ).toMatchObject({
      found: true,
      registration: {
        id: "personal-project-defaults",
        label: "Project Defaults",
      },
    });
    expect(
      resolveSettingsSection(settingsManifest, "workspace", "projects"),
    ).toMatchObject({
      found: true,
      registration: { id: "workspace-project-defaults" },
    });
    expect(settingsPath({ scope: "personal", section: "projects" })).not.toBe(
      "/projects",
    );
  });

  it("renders deployment-owned resources and capabilities without hosted SKU branding", () => {
    const profile = Schema.decodeUnknownSync(RunnerProfile)({
      id: "e2b-standard",
      label: "Standard workspace",
      adapter: "e2b",
      resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
      isolation: "sandbox",
      availability: "available",
      costLabel: "Deployment managed",
      capabilities: [
        "git",
        "environment-variables",
        "internet-access",
        "persistent-workspace",
        "pause-resume",
      ],
    });
    const markup = renderToStaticMarkup(
      <RunnerProfileCard
        profile={profile}
        selected
        disabled={false}
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain('type="radio"');
    expect(markup).toContain("checked");
    expect(markup).toContain("Standard workspace");
    expect(markup).toContain("2 CPU");
    expect(markup).toContain("4 GB memory");
    expect(markup).toContain("20 GB disk");
    expect(markup).toContain("sandbox isolation");
    expect(markup).toContain("environment variables");
    expect(markup).toContain("Deployment managed");
    expect(markup).not.toMatch(/\bAmp\b|orb|credits|per hour|\$\d/i);
  });

  it("keeps the saved confirmation mounted through the authoritative Query write", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const saved = defaults(4, "ship");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "success", data: saved }));
    vi.stubGlobal("fetch", fetchMock);
    const { container, root } = await renderSettings(queryClient, defaults(3));

    selectShipAction(container, "ship");
    const save = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Save",
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
        Response.json({ status: "success", data: defaults(5, "ship") }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { container, root } = await renderSettings(queryClient, defaults(3));

    const select = selectShipAction(container, "ship");
    await React.act(() =>
      queryClient.setQueryData(
        projectDefaultsKeys.detail(userId, target),
        defaults(4, "commit"),
      ),
    );
    expect(select?.value).toBe("ship");

    const save = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Save",
    );
    await React.act(async () => save?.click());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      expectedRevision: 3,
      overrides: { shipAction: "ship" },
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
    const select = selectShipAction(container, "ship");
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
        'select[aria-label="Default ship behavior"]',
      ),
    ).toBe(select);
    expect(select?.value).toBe("ship");
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
});
