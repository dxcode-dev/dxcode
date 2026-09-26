// @vitest-environment happy-dom

import type { SettingsContextData } from "@dx/api";
import { UserId, WorkspaceSlug } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../shared/auth/auth-context.js";
import { settingsKeys } from "./settings-context-queries.js";
import { SettingsPage } from "./settings-page.js";
import type {
  SettingsSectionProps,
  SettingsSectionRegistration,
} from "./settings-registration.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const navigation = vi.hoisted(() => vi.fn(async () => undefined));
const routerLocation = vi.hoisted(() => ({
  searchStr: "",
  state: undefined as unknown,
}));
const linkStates = vi.hoisted(() => ({ values: [] as unknown[] }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    state,
  }: {
    readonly children: React.ReactNode;
    readonly state?: unknown;
  }) => {
    linkStates.values.push(state);
    return <a href="/settings">{children}</a>;
  },
  useLocation: () => routerLocation,
  useNavigate: () => navigation,
  useBlocker: () => ({
    status: "idle",
    proceed: vi.fn(),
    reset: vi.fn(),
  }),
}));

const act = React.act;
const userId = Schema.decodeUnknownSync(UserId)("user-1");
const workspaceA = Schema.decodeUnknownSync(WorkspaceSlug)("workspace-a");
const workspaceB = Schema.decodeUnknownSync(WorkspaceSlug)("workspace-b");

function SensitiveWorkspaceSection({
  workspaceSlug,
  onDirtyChange,
}: SettingsSectionProps) {
  const [secret, setSecret] = React.useState("");
  return (
    <label>
      Sensitive draft for {workspaceSlug}
      <input
        aria-label="Sensitive workspace draft"
        type="password"
        value={secret}
        onChange={(event) => {
          setSecret(event.target.value);
          onDirtyChange(event.target.value !== "");
        }}
      />
    </label>
  );
}

let completePendingSave: (() => void) | undefined;

function DeferredWorkspaceSection({
  workspaceSlug,
  onDirtyChange,
}: SettingsSectionProps) {
  const [draft, setDraft] = React.useState("");
  const save = async () => {
    await new Promise<void>((resolve) => {
      completePendingSave = resolve;
    });
    onDirtyChange(false);
  };
  return (
    <>
      <label>
        Deferred draft for {workspaceSlug}
        <input
          aria-label="Deferred workspace draft"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            onDirtyChange(event.target.value !== "");
          }}
        />
      </label>
      <button type="button" onClick={() => void save()}>
        Save deferred draft
      </button>
    </>
  );
}

const registration: SettingsSectionRegistration = {
  id: "workspace-sensitive-test",
  scope: "workspace",
  label: "Sensitive",
  title: "Sensitive",
  description: "Sensitive workspace test section.",
  icon: (props) => <svg {...props} aria-label="Sensitive" />,
  component: SensitiveWorkspaceSection,
};

const deferredRegistration: SettingsSectionRegistration = {
  ...registration,
  id: "workspace-deferred-test",
  component: DeferredWorkspaceSection,
};

const context = (shortName: WorkspaceSlug): SettingsContextData => ({
  activeScope: "workspace",
  workspace: {
    id: `workspace-${shortName}` as never,
    displayName: String(shortName) as never,
    shortName,
    lifecycleState: "active",
    revision: 0,
    role: "owner",
  },
});

describe("SettingsPage workspace lifetime", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    completePendingSave = undefined;
    navigation.mockClear();
    linkStates.values = [];
    routerLocation.searchStr = "";
    routerLocation.state = undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      settingsKeys.context(userId, {
        scope: "workspace",
        workspaceSlug: workspaceA,
      }),
      context(workspaceA),
    );
    queryClient.setQueryData(
      settingsKeys.context(userId, {
        scope: "workspace",
        workspaceSlug: workspaceB,
      }),
      context(workspaceB),
    );
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const page = (
    workspaceSlug: WorkspaceSlug,
    sectionRegistration = registration,
  ) => (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider
        value={{
          identity: {
            id: userId,
            name: "Test User",
            email: "test@example.com",
          },
          logout: vi.fn(),
        }}
      >
        <SettingsPage
          scope="workspace"
          workspaceSlug={workspaceSlug}
          registration={sectionRegistration}
        />
      </AuthContext.Provider>
    </QueryClientProvider>
  );

  it.each([
    ["Personal", { scope: "personal", registration } as const],
    [
      "Workspace",
      {
        scope: "workspace",
        workspaceSlug: workspaceA,
        registration,
      } as const,
    ],
  ])(
    "closes %s settings when Escape is not consumed",
    async (_label, props) => {
      routerLocation.state = { settingsReturnTo: "/previous-page" };
      queryClient.setQueryData(
        settingsKeys.context(userId, { scope: "personal" }),
        { activeScope: "personal" },
      );
      window.history.pushState(null, "", "/previous-page");
      window.history.pushState(null, "", "/settings");
      const back = vi.spyOn(window.history, "back");
      await act(() =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <AuthContext.Provider
              value={{
                identity: {
                  id: userId,
                  name: "Test User",
                  email: "test@example.com",
                },
                logout: vi.fn(),
              }}
            >
              <SettingsPage {...props} />
            </AuthContext.Provider>
          </QueryClientProvider>,
        ),
      );

      await act(() =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );

      expect(back).not.toHaveBeenCalled();
      expect(navigation).toHaveBeenCalledWith({
        href: "/previous-page",
        replace: true,
      });
    },
  );

  it("returns to the captured DX screen after an OAuth callback", async () => {
    routerLocation.searchStr = "?github=installed&return_to=%2Fprevious-page";
    window.history.pushState(null, "", "/previous-page");
    window.history.pushState(null, "", "/login/oauth/authorize");
    window.history.pushState(
      null,
      "",
      "/settings/integrations?github=installed",
    );
    const back = vi.spyOn(window.history, "back");
    await act(() => root.render(page(workspaceA)));

    await act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    expect(back).not.toHaveBeenCalled();
    expect(navigation).toHaveBeenCalledWith({
      href: "/previous-page",
      replace: true,
    });
  });

  it("preserves the OAuth return route when navigating between settings sections", async () => {
    routerLocation.searchStr = "?github=installed&return_to=%2Fprevious-page";
    await act(() => root.render(page(workspaceA)));

    const settingsStateUpdaters = linkStates.values.filter(
      (state): state is (previous: unknown) => unknown =>
        typeof state === "function",
    );

    expect(settingsStateUpdaters.length).toBeGreaterThan(0);
    for (const stateUpdater of settingsStateUpdaters) {
      expect(stateUpdater({})).toEqual({
        settingsReturnTo: "/previous-page",
      });
    }
  });

  it("returns to home instead of an external history entry without a DX return", async () => {
    window.history.pushState(null, "", "/previous-external-page");
    window.history.pushState(null, "", "/settings/integrations");
    const back = vi.spyOn(window.history, "back");
    await act(() => root.render(page(workspaceA)));

    await act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    expect(back).not.toHaveBeenCalled();
    expect(navigation).toHaveBeenCalledWith({ href: "/", replace: true });
  });

  it("leaves Escape to an open dialog instead of closing settings", async () => {
    const back = vi.spyOn(window.history, "back");
    await act(() => root.render(page(workspaceA)));
    const dialog = document.body.appendChild(document.createElement("div"));
    dialog.setAttribute("role", "dialog");

    await act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    expect(back).not.toHaveBeenCalled();
    dialog.remove();
  });

  it("closes settings after shortcut recording leaves a proposal mounted", async () => {
    const back = vi.spyOn(window.history, "back");
    await act(() => root.render(page(workspaceA)));
    const editor = document.body.appendChild(
      document.createElement("fieldset"),
    );
    editor.className = "shortcut-editor";

    await act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    expect(back).not.toHaveBeenCalled();
    expect(navigation).toHaveBeenCalledWith({
      href: "/",
      replace: true,
    });
    editor.remove();
  });

  it("leaves Escape to an actively recording shortcut", async () => {
    const back = vi.spyOn(window.history, "back");
    await act(() => root.render(page(workspaceA)));
    const recording = document.body.appendChild(document.createElement("span"));
    recording.className = "shortcut-recording";

    await act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    expect(back).not.toHaveBeenCalled();
    recording.remove();
  });

  it("remounts a cached section when its workspace changes", async () => {
    await act(() => root.render(page(workspaceA)));
    const draft = container.querySelector<HTMLInputElement>(
      '[aria-label="Sensitive workspace draft"]',
    );
    expect(draft).not.toBeNull();

    await act(() => {
      if (draft === null) return;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(draft, "workspace-a-secret");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(draft?.value).toBe("workspace-a-secret");
    expect(container.textContent).toContain("Unsaved changes");

    await act(() => root.render(page(workspaceB)));

    const nextDraft = container.querySelector<HTMLInputElement>(
      '[aria-label="Sensitive workspace draft"]',
    );
    expect(nextDraft).not.toBe(draft);
    expect(nextDraft?.value).toBe("");
    expect(container.textContent).toContain("Sensitive draft for workspace-b");
    expect(container.textContent).not.toContain("Unsaved changes");
  });

  it("ignores a previous workspace completion after the next workspace becomes dirty", async () => {
    await act(() => root.render(page(workspaceA, deferredRegistration)));
    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save deferred draft",
    );
    await act(() => save?.click());
    expect(completePendingSave).toBeTypeOf("function");

    await act(() => root.render(page(workspaceB, deferredRegistration)));
    const draft = container.querySelector<HTMLInputElement>(
      '[aria-label="Deferred workspace draft"]',
    );
    await act(() => {
      if (draft === null) return;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(draft, "workspace-b-draft");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Unsaved changes");

    await act(async () => completePendingSave?.());

    expect(draft?.value).toBe("workspace-b-draft");
    expect(container.textContent).toContain("Unsaved changes");
  });

  it("keeps a cached section and its draft mounted when a background refetch fails", async () => {
    await act(() => root.render(page(workspaceA)));
    const draft = container.querySelector<HTMLInputElement>(
      '[aria-label="Sensitive workspace draft"]',
    );
    await act(() => {
      if (draft === null) return;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(draft, "draft-that-must-survive");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unavailable")));

    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: settingsKeys.context(userId, {
          scope: "workspace",
          workspaceSlug: workspaceA,
        }),
        exact: true,
      });
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          queryClient.getQueryState(
            settingsKeys.context(userId, {
              scope: "workspace",
              workspaceSlug: workspaceA,
            }),
          )?.error,
        ).toBeInstanceOf(Error),
      );
    });

    const retainedDraft = container.querySelector<HTMLInputElement>(
      '[aria-label="Sensitive workspace draft"]',
    );
    expect(retainedDraft).toBe(draft);
    expect(retainedDraft?.value).toBe("draft-that-must-survive");
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Showing the last loaded settings.",
      ),
    );
    expect(container.textContent).toContain("Unsaved changes");
  });
});
