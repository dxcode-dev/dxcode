import type { ChoicesData, OrbResolvedProvider } from "@dx/api";
import type { RunnerProfile, RunnerProfileId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../shared/auth/auth-context.js";
import { newThreadOrbProvidersQueryOptions } from "../settings/orb-providers/orb-providers-queries.js";
import { NewThreadComposer } from "./new-thread-composer.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// A new Thread needs an Orb that can start and a model that is served; Core
// refuses the create otherwise (409 ORB_UNAVAILABLE, 422 MODEL_NOT_SERVED).
// The composer keeps Send off until both hold and links to the missing piece.

const profiles = [
  {
    id: "cf.standard-1" as RunnerProfileId,
    label: "standard-1",
    adapter: "cloudflare",
    availability: "available",
    resources: { cpuCores: 0.5, memoryMb: 4096, diskGb: 8 },
  },
] as unknown as ReadonlyArray<RunnerProfile>;

const readyOrb = {
  providerId: "cloudflare",
  scope: "deployment",
  account: null,
  status: "ready",
  unavailableSizes: [],
} as unknown as OrbResolvedProvider;

const mode = (served: boolean) => ({
  mode: "medium",
  config: { model: "anthropic/claude-sonnet-5-5", thinking: "medium" },
  modelName: "Claude Sonnet 5.5",
  source: "default",
  served,
  servingConnectionName: served ? "Anthropic" : null,
});

const servedChoices = {
  modes: [mode(true)],
  models: [
    {
      canonical: "anthropic/claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      connectionId: "conn_1",
      connectionName: "Anthropic",
      contextWindow: 200_000,
      reasoning: true,
      vision: true,
    },
  ],
  claudePlans: [],
} as unknown as ChoicesData;

const unservedChoices = {
  modes: [mode(false)],
  models: [],
  claudePlans: [],
} as unknown as ChoicesData;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root !== undefined) await React.act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function SettingsStub() {
  const { section } = useParams({ strict: false });
  return <p data-testid="settings-section">{section}</p>;
}

const mount = async (setup: {
  readonly runnerOrbs: ReadonlyArray<OrbResolvedProvider>;
  readonly choices: ChoicesData;
  readonly model?: string;
  /** `pnpm dev`: Core never refuses a Thread for its Orb there. */
  readonly localRuntime?: boolean;
}) => {
  const onSubmit = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false } },
  });
  // The provider list the composer reads beside the page's runnerOrbs.
  queryClient.setQueryData(
    newThreadOrbProvidersQueryOptions("user-1" as never, "").queryKey,
    {
      scope: "personal",
      canUpdate: true,
      localRuntime: setup.localRuntime ?? false,
      providers: [],
      personalKeysOnWorkspaceProjects: null,
      resolved: setup.runnerOrbs,
    } as never,
  );
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const composerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <NewThreadComposer
        prompt="Fix the login redirect"
        images={[]}
        textareaRef={React.createRef()}
        submitting={false}
        onPromptChange={vi.fn()}
        onSubmit={onSubmit}
        onRemoveImage={vi.fn()}
        onFiles={vi.fn()}
        onScreenshot={vi.fn()}
        projects={[]}
        projectId=""
        onProjectChange={vi.fn()}
        onLoadMoreProjects={vi.fn()}
        runnerProfiles={profiles}
        runnerOrbs={setup.runnerOrbs}
        runnerProfileId={"cf.standard-1" as RunnerProfileId}
        runnerProfileLoading={false}
        onRunnerProfileChange={vi.fn()}
        onConnectOrbProvider={vi.fn()}
        model={setup.model}
        onModelChange={vi.fn()}
        choices={setup.choices}
        dictationActive={false}
        dictationHideSubmit={false}
      />
    ),
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$section",
    component: SettingsStub,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([composerRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await React.act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider
          value={{
            identity: {
              id: "user-1" as never,
              name: "New Person",
              email: "new@example.com",
            },
            logout: () => undefined,
          }}
        >
          <RouterProvider router={router} />
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
  });
  await React.act(() => router.load());
  const scope = container;
  const send = () =>
    scope.querySelector<HTMLButtonElement>(
      'button[aria-label="Create thread and send"]',
    );
  const setupLink = (name: string) =>
    Array.from(scope.querySelectorAll<HTMLAnchorElement>("a")).find(
      (link) => link.textContent === name,
    );
  // Enter in the prompt submits the form even when the button is disabled.
  const pressEnter = async () => {
    await React.act(async () => scope.querySelector("form")?.requestSubmit());
  };
  return { onSubmit, router, send, setupLink, pressEnter, scope };
};

describe("new Thread Send waits until the Thread can run", () => {
  it("keeps Send off with an Orb setup link when no Orb can start", async () => {
    const view = await mount({ runnerOrbs: [], choices: servedChoices });

    expect(view.send()?.disabled).toBe(true);
    await view.pressEnter();
    expect(view.onSubmit).not.toHaveBeenCalled();
    const link = view.setupLink("Set up an Orb");
    expect(link?.getAttribute("href")).toBe("/settings/orb-providers");
    expect(view.setupLink("Set up a model")).toBeUndefined();

    await React.act(async () => link?.click());
    expect(view.router.state.location.pathname).toBe("/settings/orb-providers");
  });

  it("keeps Send off when the selected Orb's provider is not ready", async () => {
    const view = await mount({
      runnerOrbs: [{ ...readyOrb, scope: "personal", status: "failed" }],
      choices: servedChoices,
    });

    expect(view.send()?.disabled).toBe(true);
    expect(view.setupLink("Set up an Orb")).toBeDefined();
  });

  it("keeps Send off with a model setup link when no model is served", async () => {
    const view = await mount({
      runnerOrbs: [readyOrb],
      choices: unservedChoices,
    });

    expect(view.send()?.disabled).toBe(true);
    await view.pressEnter();
    expect(view.onSubmit).not.toHaveBeenCalled();
    const link = view.setupLink("Set up a model");
    expect(link?.getAttribute("href")).toBe("/settings/model-routing");
    expect(view.setupLink("Set up an Orb")).toBeUndefined();

    await React.act(async () => link?.click());
    expect(view.router.state.location.pathname).toBe("/settings/model-routing");
  });

  it("keeps Send off when the pinned model is not served", async () => {
    const view = await mount({
      runnerOrbs: [readyOrb],
      choices: servedChoices,
      model: "openai/gpt-5.6",
    });

    expect(view.send()?.disabled).toBe(true);
    expect(view.setupLink("Set up a model")).toBeDefined();
  });

  it("enables Send in the local runtime even with no Orb provider", async () => {
    const view = await mount({
      runnerOrbs: [],
      choices: servedChoices,
      localRuntime: true,
    });

    expect(view.send()?.disabled).toBe(false);
    expect(view.setupLink("Set up an Orb")).toBeUndefined();
    await view.pressEnter();
    expect(view.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("enables Send for an account with a ready Orb and a served model", async () => {
    const view = await mount({
      runnerOrbs: [readyOrb],
      choices: servedChoices,
    });

    expect(view.send()?.disabled).toBe(false);
    expect(view.setupLink("Set up an Orb")).toBeUndefined();
    expect(view.setupLink("Set up a model")).toBeUndefined();
    await view.pressEnter();
    expect(view.onSubmit).toHaveBeenCalledTimes(1);
  });
});
