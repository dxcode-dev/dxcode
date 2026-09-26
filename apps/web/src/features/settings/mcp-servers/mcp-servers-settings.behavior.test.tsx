// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  serverRefetch: vi.fn(),
  environmentRefetch: vi.fn(),
  projectsRefetch: vi.fn(),
  fetchNextPage: vi.fn(),
  ownedReadError: null as Error | null,
  projectError: null as Error | null,
  projectNextPageError: false,
  projectPages: [{ items: [{ id: "project_first", name: "First project" }] }],
  mcpMutate: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({}),
    useMutation: () => ({ mutateAsync: mocks.mcpMutate, reset: vi.fn() }),
    useQuery: (options: { queryKey: ReadonlyArray<unknown> }) =>
      options.queryKey[0] === "mcp-servers"
        ? {
            data: {
              canMutate: true,
              items: [
                {
                  id: "server_test",
                  name: "Test server",
                  endpoint: "https://mcp.example.com",
                  transport: "streamable-http",
                  healthStatus: "healthy",
                  enabled: true,
                  timeoutMs: 10_000,
                  projectIds: ["project_later"],
                  roles: ["owner"],
                  tools: [],
                },
              ],
            },
            error: mocks.ownedReadError,
            isPending: false,
            refetch: mocks.serverRefetch,
          }
        : {
            data: { items: [] },
            error: mocks.ownedReadError,
            isPending: false,
            refetch: mocks.environmentRefetch,
          },
    useInfiniteQuery: () => ({
      data: { pages: mocks.projectPages },
      error: mocks.projectError,
      isPending: false,
      hasNextPage: mocks.projectPages.length === 1,
      isFetchingNextPage: false,
      isFetchNextPageError: mocks.projectNextPageError,
      refetch: mocks.projectsRefetch,
      fetchNextPage: mocks.fetchNextPage,
    }),
  };
});

import { McpServersSettings } from "./mcp-servers-settings.js";

describe("MCP server settings owned reads", () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderSettings = () => {
    act(() => {
      root.render(
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
          <McpServersSettings onDirtyChange={() => undefined} />
        </AuthContext.Provider>,
      );
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.projectPages = [
      { items: [{ id: "project_first", name: "First project" }] },
    ];
    mocks.projectError = null;
    mocks.projectNextPageError = false;
    mocks.ownedReadError = null;
    mocks.mcpMutate.mockReset().mockResolvedValue(undefined);
    mocks.fetchNextPage.mockImplementation(() => {
      mocks.projectPages = [
        ...mocks.projectPages,
        { items: [{ id: "project_later", name: "Later project" }] },
      ];
      return Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("retries every failed read owned by the page", () => {
    mocks.ownedReadError = new Error("Owned read failed");
    mocks.projectError = new Error("Projects failed");
    renderSettings();
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    act(() => retry?.click());

    expect(mocks.serverRefetch).toHaveBeenCalledOnce();
    expect(mocks.environmentRefetch).toHaveBeenCalledOnce();
    expect(mocks.projectsRefetch).toHaveBeenCalledOnce();
  });

  it("loads continuation projects and preserves a later-page grant in the editor", () => {
    renderSettings();
    const more = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "More projects",
    );
    act(() => more?.click());
    renderSettings();

    expect(mocks.fetchNextPage).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Later project");

    const edit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Edit"),
    );
    act(() => edit?.click());
    const laterGrants = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter((input) =>
      input.parentElement?.textContent?.includes("Later project"),
    );
    expect(laterGrants.some((input) => input.checked)).toBe(true);
  });

  it("keeps loaded servers visible and offers retry after project continuation fails", () => {
    mocks.projectError = new Error("later page failed");
    mocks.projectNextPageError = true;
    renderSettings();

    expect(container.textContent).toContain("Test server");
    expect(container.textContent).toContain(
      "More projects could not be loaded: later page failed",
    );
    const more = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "More projects",
    );
    act(() => more?.click());
    expect(mocks.fetchNextPage).toHaveBeenCalledOnce();
  });
});
