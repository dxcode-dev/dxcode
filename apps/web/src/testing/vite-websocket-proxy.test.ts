import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

const webRoot = resolve(import.meta.dirname, "../..");
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let vite: ViteDevServer | undefined;
let backend: ReturnType<typeof createHttpServer> | undefined;

afterEach(async () => {
  await vite?.close();
  if (backend !== undefined)
    await new Promise<void>((resolveClose) =>
      backend?.close(() => resolveClose()),
    );
  vite = undefined;
  backend = undefined;
});

const portOf = (server: {
  readonly address: () => string | AddressInfo | null;
}) => {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP server address.");
  return address.port;
};

const upgrade = (port: number, path: string) =>
  new Promise<string>((resolveUpgrade, rejectUpgrade) => {
    const socket = connect(port, "127.0.0.1");
    const origin = `http://127.0.0.1:${port}`;
    const key = randomBytes(16).toString("base64");
    let response = "";
    socket.setTimeout(2_000, () => {
      socket.destroy();
      rejectUpgrade(new Error("WebSocket upgrade timed out."));
    });
    socket.once("error", rejectUpgrade);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (!response.includes("\r\n\r\n")) return;
      socket.destroy();
      resolveUpgrade(response);
    });
    socket.once("connect", () =>
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Origin: ${origin}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      ),
    );
  });

describe("local Vite WebSocket proxy", () => {
  it.each([
    ["preserves the public Host-Origin pair", undefined],
    [
      "rewrites Origin for local production-admission parity",
      "https://core.test",
    ],
  ] as const)("forwards /v1 upgrades and %s", async (_case, requestOrigin) => {
    let forwarded: { readonly host?: string; readonly origin?: string } = {};
    backend = createHttpServer((_request, response) => {
      response.writeHead(404).end();
    });
    backend.on("upgrade", (request, socket) => {
      forwarded = {
        host: request.headers.host,
        origin: request.headers.origin,
      };
      if (
        (requestOrigin ?? `http://${request.headers.host}`) !==
        request.headers.origin
      ) {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}${websocketGuid}`)
        .digest("base64");
      socket.end(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    await new Promise<void>((resolveListen) =>
      backend?.listen(0, "127.0.0.1", resolveListen),
    );

    const previousTarget = process.env.DX_WEB_API_TARGET;
    const previousOrigin = process.env.DX_DEV_REQUEST_ORIGIN;
    process.env.DX_WEB_API_TARGET = `http://127.0.0.1:${portOf(backend)}`;
    if (requestOrigin === undefined) delete process.env.DX_DEV_REQUEST_ORIGIN;
    else process.env.DX_DEV_REQUEST_ORIGIN = requestOrigin;
    try {
      vite = await createViteServer({
        configFile: resolve(webRoot, "vite.config.ts"),
        root: webRoot,
        logLevel: "silent",
        server: { host: "127.0.0.1", port: 0, strictPort: true },
      });
      await vite.listen();
    } finally {
      if (previousTarget === undefined) delete process.env.DX_WEB_API_TARGET;
      else process.env.DX_WEB_API_TARGET = previousTarget;
      if (previousOrigin === undefined)
        delete process.env.DX_DEV_REQUEST_ORIGIN;
      else process.env.DX_DEV_REQUEST_ORIGIN = previousOrigin;
    }

    if (vite.httpServer === null)
      throw new Error("Expected Vite to expose its HTTP server.");
    const vitePort = portOf(vite.httpServer);
    const response = await upgrade(vitePort, "/v1/threads/thr_test/terminal");
    const publicOrigin = `http://127.0.0.1:${vitePort}`;

    expect(response).toMatch(/^HTTP\/1\.1 101 Switching Protocols/);
    expect(forwarded).toEqual({
      host: `127.0.0.1:${vitePort}`,
      origin: requestOrigin ?? publicOrigin,
    });
  });
});
