import {
  MAX_MCP_TOOL_SCHEMA_BYTES,
  MAX_MCP_TOOLS_PER_SERVER,
  McpServerEndpoint,
  McpToolDescription,
  McpToolInputSchemaJson,
  McpToolName,
  McpToolSchemaHash,
  type StoredMcpServer,
  StoredMcpTool,
} from "@dx/domain";
import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from "@modelcontextprotocol/client";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  blockedHostname,
  contentLengthExceeds,
  isPublicIpAddress,
  type PublicDnsResolver,
  parseIpv4,
  readBounded as readBoundedBytes,
  resolvePublicDns,
} from "../../http/egress.js";

const MAX_MCP_REQUEST_BYTES = 65_536;
export const MAX_MCP_RESPONSE_BYTES = 1_048_576;

export class McpNetworkRejected extends Schema.TaggedError<McpNetworkRejected>()(
  "McpNetworkRejected",
  { code: Schema.String },
) {}

export class McpDiscoveryFailed extends Schema.TaggedError<McpDiscoveryFailed>()(
  "McpDiscoveryFailed",
  { code: Schema.String },
) {}

export type McpDnsResolver = PublicDnsResolver;

export interface McpNetworkOptions {
  readonly resolveDns?: McpDnsResolver;
  readonly fetch?: typeof fetch;
  readonly validateResponse?: (
    request: Request,
    response: Response,
    body: Uint8Array,
    kind: "complete" | "sse-event",
  ) => Promise<void>;
}

const tooLarge = () => new McpNetworkRejected({ code: "PAYLOAD_TOO_LARGE" });

const readBounded = (response: Response, limit: number) =>
  readBoundedBytes(response, limit, tooLarge);

export { isPublicIpAddress };

const responseHeaders = (response: Response) => ({
  status: response.status,
  statusText: response.statusText,
  headers: response.headers,
});

const appendBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
};

const eventBoundary = (
  buffer: Uint8Array,
): { readonly end: number; readonly delimiterLength: number } | undefined => {
  for (let index = 0; index < buffer.byteLength - 1; index += 1) {
    if (buffer[index] === 10 && buffer[index + 1] === 10) {
      return { end: index, delimiterLength: 2 };
    }
    if (buffer[index] === 13 && buffer[index + 1] === 13) {
      return { end: index, delimiterLength: 2 };
    }
    if (
      index < buffer.byteLength - 3 &&
      buffer[index] === 13 &&
      buffer[index + 1] === 10 &&
      buffer[index + 2] === 13 &&
      buffer[index + 3] === 10
    ) {
      return { end: index, delimiterLength: 4 };
    }
  }
  return undefined;
};

const sseData = (frame: Uint8Array): Uint8Array | undefined => {
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(frame)
    .split(/\r?\n/)
    .flatMap((line) =>
      line === "data"
        ? [""]
        : line.startsWith("data:")
          ? [line.slice(5).replace(/^ /, "")]
          : [],
    );
  return lines.length === 0
    ? undefined
    : new TextEncoder().encode(lines.join("\n"));
};

const boundedSseStream = (
  body: ReadableStream<Uint8Array>,
  limit: number,
  validate: (data: Uint8Array) => Promise<void>,
  cleanup: () => void,
): ReadableStream<Uint8Array> => {
  let size = 0;
  let pending: Uint8Array = new Uint8Array();
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > limit) {
          cleanup();
          throw new McpNetworkRejected({ code: "PAYLOAD_TOO_LARGE" });
        }
        pending = appendBytes(pending, chunk);
        while (true) {
          const boundary = eventBoundary(pending);
          if (boundary === undefined) return;
          const frameLength = boundary.end + boundary.delimiterLength;
          const frame = pending.slice(0, boundary.end);
          const encodedFrame = pending.slice(0, frameLength);
          pending = pending.slice(frameLength);
          let data: Uint8Array | undefined;
          try {
            data = sseData(frame);
          } catch {
            cleanup();
            throw new McpNetworkRejected({ code: "INVALID_MCP_RESPONSE" });
          }
          if (data !== undefined) {
            try {
              await validate(data);
            } catch (cause) {
              cleanup();
              throw cause;
            }
          }
          controller.enqueue(encodedFrame);
        }
      },
      async flush(controller) {
        cleanup();
        if (pending.byteLength === 0) return;
        let data: Uint8Array | undefined;
        try {
          data = sseData(pending);
        } catch {
          throw new McpNetworkRejected({ code: "INVALID_MCP_RESPONSE" });
        }
        if (data !== undefined) await validate(data);
        controller.enqueue(pending);
      },
    }),
  );
};

export const validateMcpEndpoint = async (
  rawEndpoint: string,
  resolveDns: McpDnsResolver = resolvePublicDns,
) => {
  const decoded = Schema.decodeOption(McpServerEndpoint)(rawEndpoint);
  if (Option.isNone(decoded)) {
    throw new McpNetworkRejected({ code: "ENDPOINT_INVALID" });
  }
  const endpoint = new URL(decoded.value);
  if (blockedHostname(endpoint.hostname)) {
    throw new McpNetworkRejected({ code: "PRIVATE_ADDRESS_BLOCKED" });
  }
  const directAddress = endpoint.hostname.replace(/^\[|\]$/g, "");
  if (parseIpv4(directAddress) !== undefined || directAddress.includes(":")) {
    if (!isPublicIpAddress(directAddress)) {
      throw new McpNetworkRejected({ code: "PRIVATE_ADDRESS_BLOCKED" });
    }
    return decoded.value;
  }
  let addresses: ReadonlyArray<string>;
  try {
    addresses = await resolveDns(endpoint.hostname);
  } catch {
    throw new McpNetworkRejected({ code: "DNS_LOOKUP_FAILED" });
  }
  if (addresses.length === 0) {
    throw new McpNetworkRejected({ code: "DNS_NO_PUBLIC_ADDRESS" });
  }
  if (!addresses.every(isPublicIpAddress)) {
    throw new McpNetworkRejected({ code: "DNS_PRIVATE_ADDRESS_BLOCKED" });
  }
  return decoded.value;
};

const exactEndpoint = (left: URL, right: URL) =>
  left.protocol === right.protocol &&
  left.hostname === right.hostname &&
  left.port === right.port &&
  left.pathname === right.pathname &&
  left.search === right.search;

export const createMcpNetworkFetch = (
  endpoint: string,
  timeoutMs: number,
  options: McpNetworkOptions = {},
): typeof fetch => {
  const expected = new URL(endpoint);
  const fetchImpl = options.fetch ?? fetch;
  const resolveDns = options.resolveDns ?? resolvePublicDns;
  return async (input, init) => {
    const request = new Request(input, init);
    const requestUrl = new URL(request.url);
    if (!exactEndpoint(expected, requestUrl)) {
      throw new McpNetworkRejected({ code: "ENDPOINT_CHANGED" });
    }
    await validateMcpEndpoint(request.url, resolveDns);
    if (request.body !== null) {
      await readBounded(
        new Response(request.clone().body),
        MAX_MCP_REQUEST_BYTES,
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let streaming = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    };
    try {
      const response = await fetchImpl(
        new Request(request, { redirect: "manual", signal: controller.signal }),
      );
      if (response.status >= 300 && response.status < 400) {
        throw new McpNetworkRejected({ code: "REDIRECT_BLOCKED" });
      }
      if (!response.ok) {
        return new Response(null, { status: response.status });
      }
      if (
        response.body !== null &&
        response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        if (contentLengthExceeds(response, MAX_MCP_RESPONSE_BYTES)) {
          throw new McpNetworkRejected({ code: "PAYLOAD_TOO_LARGE" });
        }
        streaming = true;
        return new Response(
          boundedSseStream(
            response.body,
            MAX_MCP_RESPONSE_BYTES,
            (body) =>
              options.validateResponse?.(
                request,
                response,
                body,
                "sse-event",
              ) ?? Promise.resolve(),
            cleanup,
          ),
          responseHeaders(response),
        );
      }
      const body = await readBounded(response, MAX_MCP_RESPONSE_BYTES);
      await options.validateResponse?.(request, response, body, "complete");
      return new Response(
        body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer,
        responseHeaders(response),
      );
    } catch (cause) {
      if (cause instanceof McpNetworkRejected) throw cause;
      throw new McpNetworkRejected({
        code: controller.signal.aborted ? "REQUEST_TIMEOUT" : "REQUEST_FAILED",
      });
    } finally {
      if (!streaming) cleanup();
    }
  };
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const sha256 = async (input: string) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const mcpToolContractHash = async (tool: {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}) =>
  sha256(
    canonicalJson({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }),
  );

const storedTool = Effect.fn("mcpStoredTool")(function* (
  tool: Tool,
  discoveredAt: DateTime.Utc,
) {
  const inputSchemaJson = canonicalJson(tool.inputSchema);
  if (
    new TextEncoder().encode(inputSchemaJson).byteLength >
    MAX_MCP_TOOL_SCHEMA_BYTES
  ) {
    return yield* new McpDiscoveryFailed({ code: "TOOL_SCHEMA_TOO_LARGE" });
  }
  if (tool.execution?.taskSupport === "required") {
    return yield* new McpDiscoveryFailed({ code: "TASK_TOOL_UNSUPPORTED" });
  }
  return yield* Schema.decodeUnknownEffect(Schema.toType(StoredMcpTool))({
    name: tool.name,
    description: tool.description ?? "",
    inputSchemaJson,
    schemaHash: yield* Effect.promise(() => mcpToolContractHash(tool)),
    discoveredAt,
  });
});

export const discoverMcpTools = Effect.fn("discoverMcpTools")(function* (
  server: StoredMcpServer,
  credential: string | undefined,
  networkOptions: McpNetworkOptions = {},
) {
  const discoveredAt = yield* DateTime.now;
  const client = new Client({ name: "dx-mcp-discovery", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(server.endpoint),
    {
      fetch: createMcpNetworkFetch(
        server.endpoint,
        server.timeoutMs,
        networkOptions,
      ),
      ...(credential === undefined
        ? {}
        : { authProvider: { token: async () => credential } }),
    },
  );
  const tools = yield* Effect.tryPromise({
    try: async () => {
      await client.connect(transport);
      const output: Array<Tool> = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
        const page = await client.listTools(
          cursor === undefined ? undefined : { cursor },
          { timeout: server.timeoutMs },
        );
        output.push(...page.tools);
        if (output.length > MAX_MCP_TOOLS_PER_SERVER) {
          throw new McpDiscoveryFailed({ code: "TOOL_LIMIT_EXCEEDED" });
        }
        if (page.nextCursor === undefined) return output;
        if (cursors.has(page.nextCursor)) {
          throw new McpDiscoveryFailed({ code: "CURSOR_REPEATED" });
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw new McpDiscoveryFailed({ code: "PAGE_LIMIT_EXCEEDED" });
    },
    catch: (cause) =>
      cause instanceof McpDiscoveryFailed
        ? cause
        : new McpDiscoveryFailed({ code: "CONNECTION_FAILED" }),
  }).pipe(
    Effect.ensuring(Effect.promise(() => client.close()).pipe(Effect.ignore)),
  );
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      return yield* new McpDiscoveryFailed({ code: "DUPLICATE_TOOL_NAME" });
    }
    names.add(tool.name);
  }
  return yield* Effect.all(
    tools.map((tool) => storedTool(tool, discoveredAt)),
    { concurrency: 4 },
  );
});

export const decodeMcpToolContract = (tool: StoredMcpTool) => ({
  name: Schema.decodeSync(McpToolName)(tool.name),
  description: Schema.decodeSync(McpToolDescription)(tool.description),
  inputSchema: JSON.parse(
    Schema.decodeSync(McpToolInputSchemaJson)(tool.inputSchemaJson),
  ) as unknown,
  schemaHash: Schema.decodeSync(McpToolSchemaHash)(tool.schemaHash),
});
