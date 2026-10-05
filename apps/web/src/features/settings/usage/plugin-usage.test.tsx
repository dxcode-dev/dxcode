// @vitest-environment happy-dom

import {
  PluginUsageDataSchema,
  WorkspacePluginUsageUserDataSchema,
} from "@dx/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const queries = vi.hoisted(() => ({ useInfiniteQuery: vi.fn() }));

vi.mock("../../../shared/auth/auth-context.js", () => ({
  useAuthenticatedIdentity: () => ({ identity: { id: "user-1" } }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  ...queries,
}));

import { settingsManifest } from "../foundation-sections.js";
import { settingsNavigationRegistrations } from "../settings-navigation.js";
import {
  resolveSettingsSection,
  settingsPath,
} from "../settings-registration.js";
import {
  PersonalPluginUsageSettings,
  PluginUsageMemberTable,
  PluginUsageTable,
  WorkspacePluginUsageSettings,
} from "./plugin-usage.js";

const search = {
  pluginId: "search",
  pluginName: "Web search",
  providerId: "exa",
  providerName: "Exa",
  capability: "web.search",
  unit: "request",
};
const plugins = Schema.decodeUnknownSync(Schema.Array(PluginUsageDataSchema))([
  {
    ...search,
    credentialScope: "personal",
    units: 2,
    events: 2,
    outcomes: { success: 1, error: 1 },
  },
  {
    ...search,
    credentialScope: "deployment",
    units: 1,
    events: 1,
    outcomes: { success: 1, error: 0 },
  },
  {
    pluginId: "speech",
    pluginName: "Dictation",
    providerId: "sarvam",
    providerName: "Sarvam",
    capability: "speech.transcribe",
    credentialScope: "workspace",
    unit: "audio_second",
    units: 42,
    events: 3,
    outcomes: { success: 3, error: 0 },
  },
]);
const pluginUsers = Schema.decodeUnknownSync(
  Schema.Array(WorkspacePluginUsageUserDataSchema),
)([
  {
    userId: "usr_avery",
    userName: "Avery Engineer",
    ...plugins[0],
  },
  {
    userId: "usr_blake",
    userName: "Blake Reviewer",
    ...plugins[1],
  },
]);

const rowsOf = (container: ParentNode) =>
  [...container.querySelectorAll("tbody")].map((group) =>
    [...group.querySelectorAll("tr")].map((row) =>
      [...row.querySelectorAll("th, td")]
        .map((cell) =>
          [...cell.childNodes].map((node) => node.textContent).join(" "),
        )
        .join(" | "),
    ),
  );

const render = (markup: string) => {
  const container = document.createElement("div");
  container.innerHTML = markup;
  return container;
};

const queryResult = (page: unknown) => ({
  data: { pages: [page], pageParams: [undefined] },
  error: null,
  isPending: false,
  refetch: vi.fn(),
});

describe("plugin usage", () => {
  beforeEach(() => {
    queries.useInfiniteQuery.mockReset();
    document.body.replaceChildren();
  });

  it("registers a URL-only section in personal and workspace scope", () => {
    expect(settingsPath({ scope: "personal", section: "plugin-usage" })).toBe(
      "/settings/plugin-usage",
    );
    for (const scope of ["personal", "workspace"] as const) {
      expect(
        resolveSettingsSection(settingsManifest, scope, "plugin-usage"),
      ).toMatchObject({
        found: true,
        registration: { id: `${scope}-plugin-usage`, label: "Plugin usage" },
      });
      expect(
        settingsNavigationRegistrations(scope, settingsManifest[scope]).some(
          ({ id }) => id === `${scope}-plugin-usage`,
        ),
      ).toBe(false);
    }
  });

  it("groups by plugin and provider, names the paying key, and keeps units apart", () => {
    const container = render(
      renderToStaticMarkup(
        <PluginUsageTable rows={plugins} viewer="personal" />,
      ),
    );
    expect(rowsOf(container)).toEqual([
      [
        "Web search Exa",
        "web.search | Your key | 2 requests | 2 1 failed",
        "web.search | Deployment key | 1 request | 1",
      ],
      [
        "Dictation Sarvam",
        "speech.transcribe | Workspace key | 42 audio seconds | 3",
      ],
    ]);
    expect(container.textContent).not.toMatch(/\$|cost|price/i);
  });

  it("names a member's own key as a personal key for workspace readers", () => {
    const container = render(
      renderToStaticMarkup(<PluginUsageMemberTable rows={pluginUsers} />),
    );
    expect(rowsOf(container)).toEqual([
      [
        "Avery Engineer usr_avery",
        "Web search · Exa web.search | Personal key | 2 requests | 2 1 failed",
      ],
      [
        "Blake Reviewer usr_blake",
        "Web search · Exa web.search | Deployment key | 1 request | 1",
      ],
    ]);
  });

  it("shows an explicit empty state", () => {
    expect(
      renderToStaticMarkup(<PluginUsageTable rows={[]} viewer="personal" />),
    ).toContain("No plugin calls in this range.");
  });

  it("renders the personal section from the personal usage query", () => {
    queries.useInfiniteQuery.mockReturnValue(queryResult({ plugins }));
    const container = render(
      renderToStaticMarkup(
        <PersonalPluginUsageSettings onDirtyChange={() => undefined} />,
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Plugin usage");
    expect(rowsOf(container)).toHaveLength(2);
    const [options] = queries.useInfiniteQuery.mock.calls[0] ?? [];
    expect(options.queryKey).toEqual([
      "usage",
      "user-1",
      "personal",
      expect.objectContaining({ limit: 1 }),
    ]);
  });

  it("switches the workspace section between plugins and members", async () => {
    queries.useInfiniteQuery.mockReturnValue(
      queryResult({ plugins, pluginUsers }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() =>
      root.render(
        <WorkspacePluginUsageSettings
          workspaceSlug={"dx-team" as never}
          onDirtyChange={() => undefined}
        />,
      ),
    );
    expect(rowsOf(container)[0]?.[1]).toContain("Personal key");
    expect(container.textContent).not.toContain("Avery Engineer");
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "members")
        ?.click(),
    );
    expect(rowsOf(container).map((group) => group[0])).toEqual([
      "Avery Engineer usr_avery",
      "Blake Reviewer usr_blake",
    ]);
    await act(() => root.unmount());
  });

  it("shows the workspace permission error to members", () => {
    queries.useInfiniteQuery.mockReturnValue({
      data: undefined,
      error: new Error("This workspace usage action is not permitted."),
      isPending: false,
      refetch: vi.fn(),
    });
    const markup = renderToStaticMarkup(
      <WorkspacePluginUsageSettings
        workspaceSlug={"dx-team" as never}
        onDirtyChange={() => undefined}
      />,
    );
    expect(markup).toContain("This workspace usage action is not permitted.");
    expect(markup).not.toContain("Paid with");
  });
});
