import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
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
  emptyMcpFields,
  mcpCreateInput,
  mcpFieldsComplete,
  mcpFieldsFor,
  mcpUpdateInput,
  parsePastedHeaders,
} from "./mcp-server-fields.js";

const mutate = vi.hoisted(() =>
  vi.fn(async (_action: unknown): Promise<unknown> => undefined),
);
vi.mock("./mcp-mutations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-mutations.js")>()),
  mcpServersMutationOptions: () => ({ mutationFn: mutate }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { readonly children: ReactNode }) => (
    <a href="/settings/integrations">{children}</a>
  ),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "user-1" as never;
const secret = {
  reference: { version: 1, kind: "environment-variable", id: "env_secret" },
  name: "DOCS_TOKEN",
  kind: "secret",
  enabled: true,
} as unknown as EnvironmentVariableData;
const tool = (name: string, policy: "allow" | "disabled" | "review") =>
  ({
    name,
    description: "",
    inputSchema: {},
    schemaHash: "a".repeat(64),
    approved: policy === "allow",
    reviewRequired: policy !== "allow",
    policy,
    discoveredAt: "2026-10-03T00:00:00.000Z",
  }) as unknown as McpServerData["tools"][number];
const server = (overrides: Partial<McpServerData> = {}) =>
  ({
    id: "mcp_docs",
    scope: "personal",
    name: "Docs",
    moduleId: "docs",
    endpoint: "https://mcp.example.com/mcp",
    transport: "streamable-http",
    authType: "none",
    hasStoredToken: false,
    hasOAuthClientSecret: false,
    signedIn: false,
    headers: [],
    timeoutMs: 10_000,
    enabled: true,
    projectIds: [],
    roles: ["owner", "admin", "member"],
    healthStatus: "healthy",
    tools: [tool("read_page", "allow")],
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

describe("Integrations & MCP", () => {
  it("sends secrets write-only and only the fields that changed", () => {
    const fields = {
      ...emptyMcpFields,
      name: " Docs ",
      endpoint: "x.dev/mcp ",
      moduleId: "docs",
      auth: "none",
    } as const;
    expect(mcpCreateInput(fields)).toEqual({
      name: "Docs",
      endpoint: "https://x.dev/mcp",
      timeoutMs: 10_000,
      authType: "none",
      moduleId: "docs",
    });
    expect(
      mcpCreateInput({ ...fields, auth: "token", token: " t0k " }).authToken,
    ).toBe("t0k");
    expect(mcpFieldsComplete({ ...fields, auth: "token" })).toBe(false);

    const tokenServer = server({ authType: "bearer", hasStoredToken: true });
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
    ).toMatchObject({ authType: "none", authReference: null });
    // A legacy secret reference is left alone until changed.
    const legacy = server({
      authType: "bearer",
      authReference: secret.reference,
    });
    expect(mcpFieldsFor(legacy).auth).toBe("secret");
    expect(mcpUpdateInput(mcpFieldsFor(legacy), legacy)).toEqual({
      name: "Docs",
      endpoint: "https://mcp.example.com/mcp",
    });
    // A stored secret header left blank keeps its value; it is never echoed.
    const headerServer = server({
      headers: [
        { name: "X-Org", secret: false, value: "acme" },
        { name: "X-Api-Key", secret: true },
      ],
    });
    const headerFields = mcpFieldsFor(headerServer);
    expect(mcpUpdateInput(headerFields, headerServer)).not.toHaveProperty(
      "headers",
    );
    expect(
      mcpUpdateInput(
        {
          ...headerFields,
          headers: [
            ...headerFields.headers,
            {
              key: "new",
              name: "X-Team",
              value: "dx",
              secret: false,
              stored: false,
            },
          ],
        },
        headerServer,
      ).headers,
    ).toEqual([
      { name: "X-Org", secret: false, value: "acme" },
      { name: "X-Api-Key", secret: true },
      { name: "X-Team", secret: false, value: "dx" },
    ]);
  });

  it("marks pasted credential headers secret", () => {
    expect(
      parsePastedHeaders(
        "X-Org-Id: acme\nAuthorization: Bearer abc\n-H 'X-Api-Key: k'",
      ).map(({ key: _key, ...header }) => header),
    ).toEqual([
      { name: "X-Org-Id", value: "acme", secret: false, stored: false },
      {
        name: "Authorization",
        value: "Bearer abc",
        secret: true,
        stored: false,
      },
      { name: "X-Api-Key", value: "k", secret: true, stored: false },
    ]);
  });

  it("groups servers and templates, and keeps source control personal", () => {
    const personal = mount([
      server({ tools: [] }),
      server({
        id: "mcp_linear" as never,
        name: "Linear" as never,
        moduleId: "linear" as never,
        endpoint: "https://mcp.linear.app/mcp" as never,
        authType: "oauth",
        tools: [],
      }),
    ]);
    const group = (title: string) =>
      personal.querySelector(`[aria-labelledby="integration-group-${title}"]`)
        ?.textContent ?? "";
    expect(personal.textContent).toContain("Integrations & MCP");
    expect(group("enabled")).toContain("Docs");
    expect(group("enabled")).toContain("Tools not discovered");
    // A configured template leaves Available and asks for its sign-in.
    expect(group("enabled")).toContain("Sign in required");
    expect(group("available")).not.toContain("Linear");
    expect(group("available")).toContain("Notion");
    expect(group("available")).toContain("GitHub");
    expect(personal.textContent).not.toContain("Allow personal MCP servers");
    act(() => root?.unmount());
    container?.remove();

    const workspace = mount([], "team", true);
    expect(workspace.textContent).toContain(
      "Each member connects their own account in personal settings",
    );
    expect(workspace.textContent).not.toContain("Connect GitHub");
    expect(button("Enable Linear MCP server")).toBeDefined();
    expect(button("Allow personal MCP servers")).toBeDefined();
  });

  it("filters cards by search", () => {
    const page = mount([server()]);
    const search = page.querySelector<HTMLInputElement>(
      'input[aria-label="Search integrations"]',
    );
    if (!search) throw new Error("Search field missing");
    act(() => typeInto(search, "feature flags"));
    const names = [
      ...page.querySelectorAll(".integration-tile h3 > span:first-child"),
    ].map((element) => element.textContent);
    expect(names).toContain("PostHog");
    expect(names).toContain("LaunchDarkly");
    expect(names).not.toContain("Docs");
    expect(names).not.toContain("Notion");
  });

  it("connects a template with a bearer token typed in the dialog", async () => {
    mutate.mockResolvedValueOnce(
      server({ id: "mcp_github" as never, authType: "bearer" }),
    );
    mount([]);
    act(() => button("Connect GitHub MCP server")?.click());
    const token = document.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    if (!token) throw new Error("Token field missing");
    const connect = () =>
      document.querySelector<HTMLButtonElement>(
        '[role="dialog"] button[type="submit"]',
      );
    expect(connect()?.disabled).toBe(true);
    act(() => typeInto(token, "secret-token"));
    expect(connect()?.disabled).toBe(false);
    await act(async () => connect()?.click());
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      type: "create",
      input: {
        name: "GitHub",
        endpoint: "https://api.githubcopilot.com/mcp/",
        timeoutMs: 10_000,
        authType: "bearer",
        authToken: "secret-token",
        moduleId: "github",
      },
    });
  });

  it("allows a new tool only through the review dialog", async () => {
    mount([server({ tools: [tool("read_page", "review")] })]);
    act(() => button("Configure Docs")?.click());
    await act(async () => button("read_page: Review")?.click());
    const allow = await vi.waitUntil(() =>
      [
        ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      ].find((item) => item.textContent?.startsWith("Allow")),
    );
    await act(async () => allow.click());
    expect(mutate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Allow read_page?");
    await act(async () => button("Allow tool")?.click());
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      type: "reviewTool",
      serverId: "mcp_docs",
      toolName: "read_page",
      approved: true,
    });
  });

  it("turns an allowed tool off without a dialog", async () => {
    mount([server({ tools: [tool("read_page", "allow")] })]);
    act(() => button("Configure Docs")?.click());
    act(() => button("Expand tools")?.click());
    await act(async () => button("read_page: Allow")?.click());
    const disable = await vi.waitUntil(() =>
      [
        ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      ].find((item) => item.textContent?.startsWith("Disabled")),
    );
    await act(async () => disable.click());
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      type: "reviewTool",
      toolName: "read_page",
      approved: false,
    });
  });
});
