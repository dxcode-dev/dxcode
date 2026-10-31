import type { ProjectDefaultsData } from "@dx/api";
import { UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
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
});
