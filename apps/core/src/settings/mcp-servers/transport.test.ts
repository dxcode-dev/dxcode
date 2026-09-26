import { StoredMcpServer } from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { readBounded } from "../../http/egress.js";
import {
  createMcpNetworkFetch,
  discoverMcpTools,
  isPublicIpAddress,
  McpNetworkRejected,
  mcpToolContractHash,
  validateMcpEndpoint,
} from "./transport.js";

const publicDns = async () => ["93.184.216.34"];

const server = Schema.decodeSync(StoredMcpServer)({
  id: "mcp_00000000-0000-4000-8000-000000000036",
  target: { scope: "personal", id: "mcp-transport-owner" },
  name: "Synthetic tools",
  endpoint: "https://mcp.example.com/mcp",
  transport: "streamable-http",
  timeoutMs: 5_000,
  enabled: true,
  projectIds: [],
  roles: ["owner", "admin", "member"],
  healthStatus: "unchecked",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
});

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const fakeMcpServer = (
  tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: unknown;
  }>,
) =>
  vi.fn<typeof fetch>(async (input) => {
    const request = new Request(input);
    const message = (await request.json()) as {
      readonly id?: string | number;
      readonly method?: string;
      readonly params?: { readonly protocolVersion?: string };
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "dx-fake-mcp", version: "1.0.0" },
        },
      });
    }
    if (message.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools },
      });
    }
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32_601, message: "Method not found" },
      },
      200,
    );
  });

describe("MCP Streamable HTTP transport", () => {
  it("rejects local, private, documentation, and mixed DNS answers", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.2",
      "::1",
      "fc00::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicIpAddress(address)).toBe(false);
    }
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("192.0.0.8")).toBe(false);
    expect(isPublicIpAddress("192.0.0.9")).toBe(true);
    expect(isPublicIpAddress("192.0.0.10")).toBe(true);
    expect(isPublicIpAddress("198.51.1.10")).toBe(true);
    expect(isPublicIpAddress("203.0.1.10")).toBe(true);
    expect(isPublicIpAddress("::ffff:93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);

    await expect(
      validateMcpEndpoint("https://localhost/mcp"),
    ).rejects.toBeInstanceOf(McpNetworkRejected);
    await expect(
      validateMcpEndpoint("https://mcp.example.com/mcp", async () => [
        "93.184.216.34",
        "10.0.0.1",
      ]),
    ).rejects.toMatchObject({ code: "DNS_PRIVATE_ADDRESS_BLOCKED" });
    await expect(
      validateMcpEndpoint("https://mcp.example.com/mcp", publicDns),
    ).resolves.toBe("https://mcp.example.com/mcp");
  });

  it("pins the exact endpoint, blocks redirects, and enforces streamed response bounds", async () => {
    const redirecting = createMcpNetworkFetch(
      server.endpoint,
      server.timeoutMs,
      {
        resolveDns: publicDns,
        fetch: async () =>
          new Response(null, {
            status: 307,
            headers: { location: "https://other.example.com/mcp" },
          }),
      },
    );
    await expect(
      redirecting(server.endpoint, { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ code: "REDIRECT_BLOCKED" });
    await expect(
      redirecting("https://other.example.com/mcp", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toMatchObject({ code: "ENDPOINT_CHANGED" });

    const oversized = createMcpNetworkFetch(server.endpoint, server.timeoutMs, {
      resolveDns: publicDns,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(700_000));
              controller.enqueue(new Uint8Array(700_000));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      oversized(server.endpoint, { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("cancels a response rejected from its declared content length", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-length": "11" } },
    );

    await expect(
      readBounded(response, 10, () => new Error("too large")),
    ).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
  });

  it("preserves live Streamable HTTP SSE while bounding and validating each event", async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const event = 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    const trailingEvent = 'data: {"jsonrpc":"2.0","id":2,"result":{}}';
    const validated: Array<string> = [];
    const streaming = createMcpNetworkFetch(server.endpoint, server.timeoutMs, {
      resolveDns: publicDns,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              source = controller;
              controller.enqueue(new TextEncoder().encode(event));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      validateResponse: async (_request, _response, body, kind) => {
        validated.push(`${kind}:${new TextDecoder().decode(body)}`);
      },
    });

    const response = await streaming(server.endpoint, {
      method: "POST",
      body: "{}",
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await expect(reader?.read()).resolves.toMatchObject({
      done: false,
      value: new TextEncoder().encode(event),
    });
    expect(validated).toEqual([
      'sse-event:{"jsonrpc":"2.0","id":1,"result":{}}',
    ]);
    source?.enqueue(new TextEncoder().encode(trailingEvent));
    source?.close();
    await expect(reader?.read()).resolves.toMatchObject({
      done: false,
      value: new TextEncoder().encode(trailingEvent),
    });
    await expect(reader?.read()).resolves.toMatchObject({ done: true });
    expect(validated).toEqual([
      'sse-event:{"jsonrpc":"2.0","id":1,"result":{}}',
      'sse-event:{"jsonrpc":"2.0","id":2,"result":{}}',
    ]);
  });

  it("redacts untrusted server error bodies before returning them to the adapter", async () => {
    const credential = "credential-echo-that-must-not-reach-flue";
    const redacting = createMcpNetworkFetch(server.endpoint, server.timeoutMs, {
      resolveDns: publicDns,
      fetch: async () => new Response(credential, { status: 500 }),
    });

    const response = await redacting(server.endpoint, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });

  it("discovers bounded tools from a deterministic fake server with stable contract hashes", async () => {
    const inputSchema = {
      type: "object",
      properties: { project: { type: "string" } },
      required: ["project"],
      additionalProperties: false,
    };
    const fake = fakeMcpServer([
      {
        name: "read_status",
        description: "Read current status",
        inputSchema,
      },
    ]);
    const tools = await Effect.runPromise(
      discoverMcpTools(server, "credential-not-logged", {
        resolveDns: publicDns,
        fetch: fake,
      }),
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "read_status",
      description: "Read current status",
    });
    expect(tools[0]).not.toHaveProperty("approvedSchemaHash");
    expect(tools[0]?.schemaHash).toBe(
      await mcpToolContractHash({
        name: "read_status",
        description: "Read current status",
        inputSchema,
      }),
    );
    expect(JSON.stringify(fake.mock.calls)).not.toContain(
      "credential-not-logged",
    );
  });

  it("rejects duplicate names and tool sets above the review bound", async () => {
    const duplicate = fakeMcpServer([
      { name: "same", inputSchema: { type: "object" } },
      { name: "same", inputSchema: { type: "object" } },
    ]);
    await expect(
      Effect.runPromise(
        discoverMcpTools(server, undefined, {
          resolveDns: publicDns,
          fetch: duplicate,
        }),
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_TOOL_NAME" });

    const tooMany = fakeMcpServer(
      Array.from({ length: 65 }, (_, index) => ({
        name: `tool_${index}`,
        inputSchema: { type: "object" },
      })),
    );
    await expect(
      Effect.runPromise(
        discoverMcpTools(server, undefined, {
          resolveDns: publicDns,
          fetch: tooMany,
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_LIMIT_EXCEEDED" });
  });
});
