import type { CallToolResult } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codeModules } from "./catalog.js";

const authorization = vi.hoisted(() => ({
  createAuthorizedMcpFetch: vi.fn(),
  resolveMcpCredential: vi.fn(),
}));
vi.mock("../../settings/mcp-servers/execution.js", () => authorization);

import { codeMcpCall } from "./mcp.js";

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
const requests: Request[] = [];
const transport = vi.fn<typeof fetch>(async (input, init) => {
  const request = new Request(input, init);
  requests.push(request);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const message = (await request.json()) as {
    id?: number;
    method: string;
    params?: Record<string, unknown>;
  };
  if (message.id === undefined) return new Response(null, { status: 202 });
  let response: unknown;
  switch (message.method) {
    case "initialize":
      response = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
      break;
    case "tools/list":
      response = {
        tools: [
          {
            name: "execute",
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
    authorization.createAuthorizedMcpFetch
      .mockReset()
      .mockReturnValue(transport);
    authorization.resolveMcpCredential
      .mockReset()
      .mockResolvedValue("fixture-key");
  });
  it("uses the same credential and admission fetch path as direct MCP mounting", async () => {
    expect(
      await codeMcpCall("thr_test")(
        module,
        "execute",
        { n: 1 },
        false,
        new AbortController().signal,
      ),
    ).toEqual({ ok: true });
    expect(authorization.resolveMcpCredential).toHaveBeenCalledWith(
      "thr_test",
      "mcp_a",
    );
    expect(authorization.createAuthorizedMcpFetch).toHaveBeenCalledWith(
      "thr_test",
      "mcp_a",
      connection.endpoint,
      connection.timeoutMs,
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
    expect(authorization.resolveMcpCredential).not.toHaveBeenCalled();
    authorization.resolveMcpCredential.mockRejectedValueOnce(
      new Error("credential revoked"),
    );
    await expect(
      call(module, "execute", {}, true, new AbortController().signal),
    ).rejects.toThrow("credential revoked");
    authorization.createAuthorizedMcpFetch.mockReturnValueOnce(async () => {
      throw new Error("transport denied");
    });
    await expect(
      call(module, "execute", {}, true, new AbortController().signal),
    ).rejects.toThrow("transport denied");
  });
});
