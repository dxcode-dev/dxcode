// @vitest-environment happy-dom

import {
  type EnvironmentVariableAuditEventData,
  EnvironmentVariableDataSchema,
} from "@dx/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DateTime, Schema } from "effect";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { settingsManifest } from "../foundation-sections.js";
import {
  resolveSettingsSection,
  settingsPath,
} from "../settings-registration.js";
import { EnvironmentVariableHistory } from "./environment-variable-controls.js";
import {
  environmentVariableHistoryQueryOptions,
  environmentVariablesQueryOptions,
} from "./environment-variables-queries.js";
import {
  EnvironmentVariablesSettings,
  ProjectEnvironmentVariablesSettings,
} from "./environment-variables-settings.js";

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
  it("registers both exact settings slugs", () => {
    expect(
      resolveSettingsSection(
        settingsManifest,
        "personal",
        "environment-variables",
      ),
    ).toMatchObject({
      found: true,
      registration: {
        id: "personal-environment-variables",
        label: "Secrets & Env Vars",
      },
    });
    expect(
      resolveSettingsSection(
        settingsManifest,
        "workspace",
        "environment-variables",
      ),
    ).toMatchObject({
      found: true,
      registration: { id: "workspace-environment-variables" },
    });
    expect(
      settingsPath({ scope: "personal", section: "environment-variables" }),
    ).toBe("/settings/environment-variables");
    expect(
      settingsPath({
        scope: "workspace",
        workspaceSlug: "sample-team" as never,
        section: "environment-variables",
      }),
    ).toBe("/workspaces/sample-team/environment-variables");
  });

  it("renders the same compact values UI for personal, project, and workspace scopes", () => {
    const personal = renderSettings(
      <EnvironmentVariablesSettings onDirtyChange={() => undefined} />,
    );
    const workspace = renderSettings(
      <EnvironmentVariablesSettings
        workspaceSlug={"sample-team" as never}
        workspace={
          {
            id: "sample-team",
            displayName: "Sample Team",
            shortName: "sample-team",
            lifecycleState: "active",
            revision: 0,
            role: "owner",
          } as never
        }
        onDirtyChange={() => undefined}
      />,
    );
    const project = renderSettings(
      <ProjectEnvironmentVariablesSettings
        projectId={"prj_test" as never}
        onDirtyChange={() => undefined}
      />,
    );

    expect(workspace).toBe(personal);
    expect(project).toBe(personal);
    for (const markup of [personal, project, workspace]) {
      expect(markup).toContain("Values");
      expect(markup).toContain("Bulk Add");
      expect(markup).toContain("History");
      expect(markup).not.toContain("Bulk import");
      expect(markup).not.toContain("Precedence and snapshots");
      expect(markup).not.toContain("Personal or owned project");
      expect(markup).not.toMatch(/demo secret|private key/i);
    }
  });

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

  it("keeps loaded history visible when an older page fails", () => {
    const first = {
      id: "eva_00000000-0000-4000-8000-000000000001",
      variableId: "env_00000000-0000-4000-8000-000000000001",
      name: "BUILD_CHANNEL",
      kind: "variable",
      action: "created",
      actorUserId: "usr_00000000-0000-4000-8000-000000000001",
      actorName: "Test User",
      requestId: "req_test_1",
      occurredAt: DateTime.makeUnsafe("2026-08-25T12:00:00.000Z"),
    } as unknown as EnvironmentVariableAuditEventData;
    const failedMarkup = renderToStaticMarkup(
      <EnvironmentVariableHistory
        loading={false}
        moreError="Older history is unavailable."
        items={[first]}
        hasMore
        loadingMore={false}
        onReload={() => undefined}
        onLoadMore={() => undefined}
      />,
    );
    expect(failedMarkup).toContain("created BUILD_CHANNEL");
    expect(failedMarkup).toContain("Older history is unavailable.");
    expect(failedMarkup).toContain("Load older events");
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
    const rotate = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Rotate",
    );
    await act(() => rotate?.click());
    const replacement = document.querySelector<HTMLInputElement>(
      'input[id$="-rotate"]',
    );
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(replacement, "must-not-survive-close");
      replacement?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(replacement?.value).toBe("must-not-survive-close");

    await act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')
        ?.click(),
    );
    await act(() => rotate?.click());
    expect(
      document.querySelector<HTMLInputElement>('input[id$="-rotate"]')?.value,
    ).toBe("");

    await act(() => root.unmount());
    container.remove();
  });
});
