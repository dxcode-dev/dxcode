// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { environmentVariableKeys } from "../environment-variables/environment-variables-queries.js";
import { IntegrationsSettings } from "./integrations-settings.js";
import {
  type EnvironmentVariableData,
  type McpServerData,
  type McpServersTarget,
  mcpServerKeys,
} from "./mcp-queries.js";
import {
  mcpCreateInput,
  mcpFieldsComplete,
  mcpFieldsFor,
  mcpServerHint,
  mcpUpdateInput,
} from "./mcp-server-fields.js";

const mutate = vi.hoisted(() => vi.fn(async (_action: unknown) => undefined));
vi.mock("./mcp-mutations.js", () => ({
  mcpServersMutationOptions: () => ({ mutationFn: mutate }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "user-1" as never;
const secret = {
  reference: { version: 1, kind: "environment-variable", id: "env_secret" },
  name: "DOCS_TOKEN",
  kind: "secret",
  enabled: true,
} as unknown as EnvironmentVariableData;
const tool = (name: string, approved: boolean) =>
  ({
    name,
    description: "",
    inputSchema: {},
    schemaHash: "a".repeat(64),
    approved,
    reviewRequired: !approved,
    discoveredAt: "2026-10-03T00:00:00.000Z",
  }) as unknown as McpServerData["tools"][number];
const server = (overrides: Partial<McpServerData> = {}) =>
  ({
    id: "mcp_docs",
    scope: "personal",
    name: "Docs",
    endpoint: "https://mcp.example.com/mcp",
    transport: "streamable-http",
    hasStoredToken: false,
    timeoutMs: 10_000,
    enabled: true,
    projectIds: [],
    roles: ["owner", "admin", "member"],
    healthStatus: "healthy",
    tools: [tool("read_page", true)],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  }) as McpServerData;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  mutate.mockClear();
});

const mount = (
  items: ReadonlyArray<McpServerData>,
  workspaceSlug?: string,
  allowPersonalServers?: boolean,
) => {
  const target: McpServersTarget =
    workspaceSlug === undefined
      ? { scope: "personal" }
      : { scope: "workspace", workspaceSlug: workspaceSlug as never };
  const queryClient = new QueryClient();
  queryClient.setQueryData(mcpServerKeys.list(userId, target), {
    items,
    canMutate: true,
    ...(allowPersonalServers === undefined ? {} : { allowPersonalServers }),
  });
  queryClient.setQueryData(environmentVariableKeys.list(userId, target), {
    items: [secret],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <AuthContext.Provider
        value={{
          identity: { id: userId, name: "Test", email: "t@example.com" },
          logout: () => undefined,
        }}
      >
        <QueryClientProvider client={queryClient}>
          <IntegrationsSettings
            onDirtyChange={() => undefined}
            {...(workspaceSlug === undefined
              ? {}
              : { workspaceSlug: workspaceSlug as never })}
          />
        </QueryClientProvider>
      </AuthContext.Provider>,
    ),
  );
  return container;
};

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === label ||
      element.getAttribute("aria-label") === label,
  );
const typeInto = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("MCP section", () => {
  it("sends a typed token write-only and clears auth only when asked", () => {
    const fields = {
      name: " Docs ",
      endpoint: "https://x.dev/mcp ",
      auth: "none",
      token: "",
    } as const;
    expect(mcpCreateInput(fields)).toEqual({
      name: "Docs",
      endpoint: "https://x.dev/mcp",
      timeoutMs: 10_000,
    });
    expect(
      mcpCreateInput({ ...fields, auth: "token", token: " t0k " }).authToken,
    ).toBe("t0k");
    expect(mcpFieldsComplete({ ...fields, auth: "token" })).toBe(false);

    const tokenServer = server({ hasStoredToken: true });
    expect(mcpFieldsFor(tokenServer).auth).toBe("token");
    // An empty token keeps the stored one; typing one rotates it.
    expect(
      mcpUpdateInput(mcpFieldsFor(tokenServer), tokenServer),
    ).not.toHaveProperty("authToken");
    expect(mcpFieldsComplete(mcpFieldsFor(tokenServer), tokenServer)).toBe(
      true,
    );
    expect(
      mcpUpdateInput(
        { ...mcpFieldsFor(tokenServer), token: "new" },
        tokenServer,
      ),
    ).toMatchObject({ authToken: "new" });
    expect(
      mcpUpdateInput(
        { ...mcpFieldsFor(tokenServer), auth: "none" },
        tokenServer,
      ),
    ).toMatchObject({ authReference: null });
    // A legacy secret reference is left alone until changed.
    const legacy = server({ authReference: secret.reference });
    expect(mcpFieldsFor(legacy).auth).toBe("secret");
    expect(mcpUpdateInput(mcpFieldsFor(legacy), legacy)).toEqual({
      name: "Docs",
      endpoint: "https://mcp.example.com/mcp",
    });
  });

  it("hints only when a server needs attention", () => {
    expect(mcpServerHint(server())).toBeUndefined();
    expect(mcpServerHint(server({ tools: [] }))).toBe("Tools not discovered");
    expect(
      mcpServerHint(
        server({
          tools: [tool("a", false), tool("b", false), tool("c", true)],
        }),
      ),
    ).toBe("2 tools to review");
    expect(mcpServerHint(server({ healthStatus: "unhealthy" }))).toBe(
      "Unreachable",
    );
  });

  it("shows integrations and MCP personally, and only MCP plus policy in a workspace", () => {
    const personal = mount([server({ tools: [] })]);
    expect(personal.textContent).toContain("MCP & Integrations");
    expect(personal.textContent).toContain("GitHub");
    expect(personal.textContent).toContain("Docs");
    expect(personal.textContent).toContain("Tools not discovered");
    expect(personal.textContent).not.toContain("Allow personal MCP servers");
    act(() => root?.unmount());
    container?.remove();

    const workspace = mount([], "team", true);
    expect(workspace.textContent).not.toContain("GitHub");
    expect(workspace.textContent).toContain("No MCP servers yet.");
    expect(workspace.textContent).toContain("Allow personal MCP servers");
  });

  it("adds a server with a bearer token typed in the dialog", async () => {
    mount([]);
    act(() => button("Add MCP server")?.click());
    const name = document.querySelector<HTMLInputElement>(
      'input[aria-label="Name"]',
    );
    const url = document.querySelector<HTMLInputElement>(
      'input[aria-label="URL"]',
    );
    const auth = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Auth"]',
    );
    if (!name || !url || !auth) throw new Error("Add dialog fields missing");
    expect([...auth.options].map((option) => option.textContent)).toEqual([
      "No token",
      "Bearer token",
    ]);
    act(() => {
      typeInto(name, "Docs");
      typeInto(url, "https://mcp.example.com/mcp");
      auth.value = "token";
      auth.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const token = document.querySelector<HTMLInputElement>(
      'input[aria-label="Token"]',
    );
    if (!token) throw new Error("Token field missing");
    expect(token.type).toBe("password");
    expect(button("Add server")?.disabled).toBe(true);
    act(() => typeInto(token, "secret-token"));
    await act(async () => button("Add server")?.click());
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      type: "create",
      input: {
        name: "Docs",
        endpoint: "https://mcp.example.com/mcp",
        timeoutMs: 10_000,
        authToken: "secret-token",
      },
    });
  });

  it("approves a tool only through the review dialog", async () => {
    mount([server({ tools: [tool("read_page", false)] })]);
    act(() => button("Docs settings")?.click());
    act(() => button("Review read_page")?.click());
    expect(mutate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Approve read_page?");
    await act(async () => button("Approve tool")?.click());
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      type: "reviewTool",
      serverId: "mcp_docs",
      toolName: "read_page",
      approved: true,
    });
  });
});
