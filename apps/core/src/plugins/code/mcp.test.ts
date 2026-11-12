import type { CallToolResult } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codeModules } from "./catalog.js";

const authorization = vi.hoisted(() => ({
  authorizeMcpCall: vi.fn(),
  McpInvocationForbidden: class extends Error {},
}));
vi.mock("../../settings/mcp-servers/execution.js", () => authorization);

import type { Bindings } from "../../http/types.js";
import { codeMcpCall as hostCall } from "./mcp.js";

const bindings = {} as Bindings;
const codeMcpCall = (threadId: string) => hostCall(threadId, bindings);

const connection = {
  id: "mcp_a",
  name: "dx_mcp_a",
  displayName: "Linear",
  endpoint: "https://example.com/mcp",
  timeoutMs: 10_000,
  authenticated: true,
  tools: ["execute"],
};
const module = codeModules([connection])[0];
if (!module) throw new Error("Missing module");
let result: CallToolResult;
/** The fixture tool's `_meta`, and what `resources/read` answers. */
let toolMeta: Record<string, unknown> | undefined;
let resource: (uri: string) => unknown;
const requests: Request[] = [];
const methods: string[] = [];
const transport = vi.fn<typeof fetch>(async (input, init) => {
  const request = new Request(input, init);
  requests.push(request);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const message = (await request.json()) as {
    id?: number;
    method: string;
    params?: Record<string, unknown>;
  };
  methods.push(message.method);
  if (message.id === undefined) return new Response(null, { status: 202 });
  let response: unknown;
  switch (message.method) {
    case "initialize":
      response = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
      break;
    case "tools/list":
      response = {
        tools: [
          {
            name: "execute",
            ...(toolMeta === undefined ? {} : { _meta: toolMeta }),
            inputSchema: { type: "object" },
            outputSchema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
          },
        ],
      };
      break;
    case "tools/call":
      response = result;
      break;
    case "resources/read": {
      const uri = String(message.params?.uri);
      response = resource(uri);
      if (response instanceof Error)
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32002, message: response.message },
        });
      break;
    }
    default:
      throw new Error(`Unexpected MCP request ${message.method}`);
  }
  return Response.json({ jsonrpc: "2.0", id: message.id, result: response });
});

describe("Code MCP host calls", () => {
  beforeEach(() => {
    requests.length = 0;
    transport.mockClear();
    result = { structuredContent: { ok: true }, content: [] };
    toolMeta = undefined;
    resource = (uri) => ({
      contents: [
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: `<p>view of ${uri}</p>`,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    });
    authorization.authorizeMcpCall
      .mockReset()
      .mockResolvedValue({ credential: "fixture-key", fetch: transport });
  });
  it("authorizes once per call and sends that credential on every request", async () => {
    expect(
      await codeMcpCall("thr_test")(
        module,
        "execute",
        { n: 1 },
        false,
        new AbortController().signal,
      ),
    ).toEqual({ ok: true });
    expect(authorization.authorizeMcpCall).toHaveBeenCalledOnce();
    expect(authorization.authorizeMcpCall).toHaveBeenCalledWith(
      bindings,
      "thr_test",
      "mcp_a",
      connection.endpoint,
      connection.timeoutMs,
      "execute",
    );
    expect(
      requests
        .filter((request) => request.method === "POST")
        .every(
          (request) =>
            request.headers.get("authorization") === "Bearer fixture-key",
        ),
    ).toBe(true);
  });
  it("normal validation fails but raw returns the complete bad result without an SDK schema error", async () => {
    result = {
      structuredContent: { ok: "bad" },
      content: [{ type: "text", text: "details" }],
    };
    const call = codeMcpCall("thr_test");
    await expect(
      call(module, "execute", {}, false, new AbortController().signal),
    ).rejects.toThrow("preview:");
    expect(
      await call(module, "execute", {}, true, new AbortController().signal),
    ).toEqual(result);
    result = { isError: true, content: [{ type: "text", text: "denied" }] };
    await expect(
      call(module, "execute", {}, false, new AbortController().signal),
    ).rejects.toThrow("denied");
    expect(
      await call(module, "execute", {}, true, new AbortController().signal),
    ).toEqual(result);
  });
  it("raw cannot bypass authorization, transport errors or the reviewed allowlist", async () => {
    const call = codeMcpCall("thr_test");
    await expect(
      call(module, "unreviewed", {}, true, new AbortController().signal),
    ).rejects.toThrow("not reviewed");
    expect(authorization.authorizeMcpCall).not.toHaveBeenCalled();
    authorization.authorizeMcpCall.mockRejectedValueOnce(
      new Error("credential revoked"),
    );
    await expect(
      call(module, "execute", {}, true, new AbortController().signal),
    ).rejects.toThrow("credential revoked");
    authorization.authorizeMcpCall.mockResolvedValueOnce({
      credential: "fixture-key",
      fetch: async () => {
        throw new Error("transport denied");
      },
    });
    await expect(
      call(module, "execute", {}, true, new AbortController().signal),
    ).rejects.toThrow("transport denied");
  });
});

describe("MCP Apps views on Code MCP calls", () => {
  const signal = () => new AbortController().signal;
  beforeEach(() => {
    requests.length = 0;
    methods.length = 0;
    result = { structuredContent: { ok: true }, content: [] };
    toolMeta = { ui: { resourceUri: "ui://fixture/declared" } };
    resource = (uri) => ({
      contents: [
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: `<p>view of ${uri}</p>`,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    });
    authorization.authorizeMcpCall
      .mockReset()
      .mockResolvedValue({ credential: "fixture-key", fetch: transport });
  });
  const callWithViews = async () => {
    const views: unknown[] = [];
    const value = await hostCall("thr_test", bindings, {
      wants: () => true,
      add: (view) => views.push(view),
    })(module, "execute", { n: 2 }, false, signal());
    return { value, views };
  };

  it("reads the view a tool declares and hands it over with the call's input and raw result", async () => {
    result = {
      structuredContent: { ok: true },
      content: [{ type: "text", text: "done" }],
    };
    const { value, views } = await callWithViews();
    expect(value).toEqual({ ok: true });
    expect(views).toEqual([
      {
        server: "Linear",
        tool: "execute",
        resourceUri: "ui://fixture/declared",
        html: "<p>view of ui://fixture/declared</p>",
        prefersBorder: true,
        toolInput: { n: 2 },
        toolResult: result,
      },
    ]);
  });

  it("prefers the view the result names over the declared one", async () => {
    result = {
      structuredContent: { ok: true },
      content: [],
      _meta: { ui: { resourceUri: "ui://fixture/from-result" } },
    };
    const { views } = await callWithViews();
    expect(views).toMatchObject([{ resourceUri: "ui://fixture/from-result" }]);
  });

  it("shows nothing for a URI outside ui://, and does not read it", async () => {
    toolMeta = { ui: { resourceUri: "https://example.com/view.html" } };
    const { value, views } = await callWithViews();
    expect(value).toEqual({ ok: true });
    expect(views).toEqual([]);
    expect(methods).not.toContain("resources/read");
  });

  it("leaves the result alone when the view is not HTML, fails to read, or is too large", async () => {
    resource = (uri) => ({
      contents: [{ uri, mimeType: "application/javascript", text: "alert(1)" }],
    });
    expect(await callWithViews()).toEqual({ value: { ok: true }, views: [] });
    resource = () => new Error("no such resource");
    expect(await callWithViews()).toEqual({ value: { ok: true }, views: [] });
    resource = (uri) => ({
      contents: [
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: "x".repeat(512 * 1_024 + 1),
        },
      ],
    });
    expect(await callWithViews()).toEqual({ value: { ok: true }, views: [] });
  });

  it("decodes a view served as a base64 blob", async () => {
    resource = (uri) => ({
      contents: [
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          blob: btoa("<p>blob view</p>"),
        },
      ],
    });
    const { views } = await callWithViews();
    expect(views).toMatchObject([{ html: "<p>blob view</p>" }]);
  });

  it("reads no view when the caller takes none", async () => {
    await codeMcpCall("thr_test")(module, "execute", {}, false, signal());
    expect(methods).toContain("tools/call");
    expect(methods).not.toContain("resources/read");
  });
});
