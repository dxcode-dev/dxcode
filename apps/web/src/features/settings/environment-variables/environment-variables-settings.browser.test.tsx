import { EnvironmentVariableDataSchema } from "@dx/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { modelConnectionsQueryOptions } from "../model-routing/model-routing-queries.js";
import {
  environmentVariableHistoryQueryOptions,
  environmentVariablesQueryOptions,
} from "./environment-variables-queries.js";
import { EnvironmentVariablesSettings } from "./environment-variables-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const renderSettings = (children: ReactNode) =>
  renderToStaticMarkup(
    <AuthContext.Provider
      value={{
        identity: {
          id: "usr_test" as never,
          name: "Test User",
          email: "test@example.com",
        },
        logout: () => undefined,
      }}
    >
      <QueryClientProvider client={new QueryClient()}>
        {children}
      </QueryClientProvider>
    </AuthContext.Provider>,
  );

describe("environment variables settings", () => {
  it("remounts the controller when the workspace target changes", async () => {
    const queryClient = new QueryClient();
    const userId = "usr_test" as never;
    const alpha = {
      scope: "workspace",
      workspaceSlug: "alpha" as never,
    } as const;
    const beta = {
      scope: "workspace",
      workspaceSlug: "beta" as never,
    } as const;
    for (const target of [alpha, beta]) {
      queryClient.setQueryData(
        environmentVariablesQueryOptions(userId, target).queryKey,
        { items: [], precedence: ["personal", "project", "workspace"] },
      );
      queryClient.setQueryData(
        environmentVariableHistoryQueryOptions(userId, target).queryKey,
        { pages: [{ items: [] }], pageParams: [undefined] },
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const page = (workspaceSlug: "alpha" | "beta") => (
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
        <QueryClientProvider client={queryClient}>
          <EnvironmentVariablesSettings
            workspaceSlug={workspaceSlug as never}
            workspace={
              {
                id: workspaceSlug,
                displayName: workspaceSlug,
                shortName: workspaceSlug,
                lifecycleState: "active",
                revision: 0,
                role: "owner",
              } as never
            }
            onDirtyChange={() => undefined}
          />
        </QueryClientProvider>
      </AuthContext.Provider>
    );

    await act(() => root.render(page("alpha")));
    const alphaController = container.querySelector(
      ".environment-variables-settings",
    );
    await act(() => root.render(page("beta")));

    expect(container.querySelector(".environment-variables-settings")).not.toBe(
      alphaController,
    );
    await act(() => root.unmount());
    container.remove();
  });

  it("keeps the Auditor role read-only in existing workspace configuration UI", () => {
    const markup = renderSettings(
      <EnvironmentVariablesSettings
        workspaceSlug={"sample-team" as never}
        workspace={
          {
            id: "sample-team",
            displayName: "Sample Team",
            shortName: "sample-team",
            lifecycleState: "active",
            revision: 0,
            role: "auditor",
          } as never
        }
        onDirtyChange={() => undefined}
      />,
    );
    expect(markup).toContain("Read-only workspace values");
    expect(markup).toContain("does not include configuration changes");
    expect(markup).not.toContain("Lock workspace value");
    expect(markup).not.toContain("Bulk Add");
  });

  it("clears a replacement secret when the rotation dialog closes", async () => {
    const queryClient = new QueryClient();
    const userId = "usr_test" as never;
    const target = { scope: "personal" } as const;
    queryClient.setQueryData(
      environmentVariablesQueryOptions(userId, target).queryKey,
      {
        items: [
          Schema.decodeUnknownSync(EnvironmentVariableDataSchema)({
            reference: {
              version: 1,
              kind: "environment-variable",
              id: "env_test",
            },
            name: "API_SECRET",
            kind: "secret",
            enabled: true,
            scope: "personal",
            source: "personal",
            value: "••••••••",
            createdAt: "2026-08-25T10:00:00.000Z",
            updatedAt: "2026-08-25T10:00:00.000Z",
            rotatedAt: "2026-08-25T10:00:00.000Z",
          }),
        ],
        precedence: ["personal", "project", "workspace"],
      },
    );
    queryClient.setQueryData(
      environmentVariableHistoryQueryOptions(userId, target).queryKey,
      { pages: [{ items: [] }], pageParams: [undefined] },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() =>
      root.render(
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
          <QueryClientProvider client={queryClient}>
            <EnvironmentVariablesSettings onDirtyChange={() => undefined} />
          </QueryClientProvider>
        </AuthContext.Provider>,
      ),
    );
    // Rotate sits in the row's menu.
    const openRotate = async () => {
      await act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Manage API_SECRET"]')
          ?.click(),
      );
      const rotate = await vi.waitUntil(() =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (item) => item.textContent === "Rotate",
        ),
      );
      await act(() => rotate.click());
      return vi.waitUntil(() =>
        document.querySelector<HTMLTextAreaElement>('textarea[id$="-rotate"]'),
      );
    };
    const replacement = await openRotate();
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(replacement, "must-not-survive-close");
      replacement.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(replacement.value).toBe("must-not-survive-close");

    await act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')
        ?.click(),
    );
    await vi.waitUntil(
      () => document.querySelector('textarea[id$="-rotate"]') === null,
    );
    expect((await openRotate()).value).toBe("");

    await act(() => root.unmount());
    container.remove();
  });
  it("lists a connected Claude plan read-only and links to Model Routing", async () => {
    const queryClient = new QueryClient();
    const userId = "usr_test" as never;
    const target = { scope: "personal" } as const;
    queryClient.setQueryData(
      environmentVariablesQueryOptions(userId, target).queryKey,
      { items: [], precedence: ["personal", "project", "workspace"] },
    );
    queryClient.setQueryData(
      environmentVariableHistoryQueryOptions(userId, target).queryKey,
      { pages: [{ items: [] }], pageParams: [undefined] },
    );
    queryClient.setQueryData(
      modelConnectionsQueryOptions({ scope: "personal" }, userId).queryKey,
      [
        {
          id: "mcn_claude",
          name: "Claude",
          kind: "provider",
          providerId: "claude-code",
        },
      ] as never,
    );
    const rootRoute = createRootRoute();
    const section = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/$section",
      component: () => (
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
          <QueryClientProvider client={queryClient}>
            <EnvironmentVariablesSettings onDirtyChange={() => undefined} />
          </QueryClientProvider>
        </AuthContext.Provider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([section]),
      history: createMemoryHistory({
        initialEntries: ["/settings/environment-variables"],
      }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() => root.render(<RouterProvider router={router} />));
    const link = await vi.waitUntil(() =>
      [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
        (anchor) => anchor.textContent === "Configured in Model Routing",
      ),
    );
    const row = link.closest("tr");
    expect(row?.textContent).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(row?.textContent).toContain("Subscription");
    expect(row?.querySelector("button")).toBeNull();

    await act(() => link.click());
    await vi.waitUntil(
      () => router.state.location.pathname === "/settings/model-routing",
    );

    await act(() => root.unmount());
    container.remove();
  });
});
