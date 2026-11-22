#!/usr/bin/env node
// A stand-in for voxl in the runner E2E (runner-e2e.mjs): the same flags
// the supervisor passes (--addr, --port), the password from VOXL_PASSWORD,
// public `GET /healthz`, and `/ws` and `/windows` only with
// `Authorization: Bearer <password>` or `?token=`.
//
// `GET /windows` lists the Mac's windows as dx's voxl patch does (window mode,
// deploy/runner/voxl-patches), with entries the supervisor must drop or cut:
// a 500-character title, no frame, a zero-size frame, an ID past 32 bits.
// --no-windows answers 404, as a voxl without the patch does.
//
// Its WebSocket says hello (with `displays`, as a Mac's voxl does) and echoes:
//
//   text "big"          -> one binary message of BIG_BYTES (a large keyframe)
//   text "close-me"     -> closes with 4001 "bye"
//   text "dw,<id>"      -> every viewer gets a hello naming that window, at its
//                          size; an unknown window gets
//                          {"t":"windowClosed","id":<id>} and the display's hello
//   text "ds,1"         -> every viewer gets the display's hello
//   text "close-window" -> the streamed window closes: every viewer gets
//                          windowClosed, then the display's hello
//   other text          -> "echo:<text>"
//   binary              -> "binary:<length>:<sha256>"
//
// It reports to the mock Core (--report URL): `started` (its password and
// arguments, so the test can look for leaks) and each socket's close.
// --deny-capture prints voxl's Screen Recording warning first, --deny-input
// its Accessibility warning.
import { createHash, timingSafeEqual } from "node:crypto";
import { readlinkSync } from "node:fs";
import { createServer } from "node:http";

const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const BIG_BYTES = 1_500_000;
const password = process.env.VOXL_PASSWORD ?? "";
const report = flag("--report");
const post = (path, body) =>
  report === undefined
    ? Promise.resolve()
    : fetch(`${report}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }).catch(() => {});

if (process.argv.includes("--deny-capture"))
  console.error(
    "ERROR voxl: Screen Recording permission is missing: allow voxl (or the terminal running it) in System Settings > Privacy & Security > Screen Recording, then restart it",
  );

if (process.argv.includes("--deny-input"))
  console.error(
    "WARN voxl: Accessibility permission is missing, so input is ignored: allow voxl (or the terminal running it) in System Settings > Privacy & Security > Accessibility",
  );

const same = (a, b) =>
  a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
const admitted = (req) => {
  const url = new URL(req.url, "http://voxl");
  const given =
    (req.headers.authorization ?? "").replace(/^Bearer /, "") ||
    url.searchParams.get("token") ||
    "";
  return same(Buffer.from(given), Buffer.from(password));
};

const frame = (payload, opcode) => {
  const n = payload.length;
  const head =
    n < 126
      ? Buffer.from([0x80 | opcode, n])
      : n < 65536
        ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
        : (() => {
            const b = Buffer.alloc(10);
            b[0] = 0x80 | opcode;
            b[1] = 127;
            b.writeBigUInt64BE(BigInt(n), 2);
            return b;
          })();
  return Buffer.concat([head, payload]);
};

// The Mac's windows; ids 7101 and 7102 are pickable.
const WINDOWS = [
  {
    id: 7101,
    app: "Simulator",
    bundleId: "com.apple.iphonesimulator",
    title: "iPhone 16 Pro",
    frame: { x: 120, y: 80, w: 402, h: 874 },
    display: 1,
  },
  {
    id: 7102,
    app: "qemu-system-aarch64",
    bundleId: "",
    title: "Android Emulator - Pixel_8:5554".padEnd(500, "."),
    frame: { x: 700, y: 60, w: 412, h: 915 },
    display: 1,
  },
  { id: 7103, app: "No frame", bundleId: "x", title: "" },
  {
    id: 7104,
    app: "Flat",
    bundleId: "x",
    title: "",
    frame: { x: 0, y: 0, w: 0, h: 40 },
    display: 1,
  },
  {
    id: 2 ** 32,
    app: "Too big",
    bundleId: "x",
    title: "",
    frame: { x: 0, y: 0, w: 60, h: 40 },
    display: 1,
  },
];
const DISPLAY = { w: 2940, h: 1912 };
/** The window every viewer streams (window mode), or undefined: the display. */
let target;
const sockets = new Set();
const hello = () =>
  JSON.stringify({
    t: "hello",
    os: "macos",
    w: target ? target.frame.w * 2 : DISPLAY.w,
    h: target ? target.frame.h * 2 : DISPLAY.h,
    displays: {
      selected: 1,
      available: [{ id: 1, name: "Display 1 · Main" }],
      ...(target
        ? { window: { id: target.id, app: target.app, title: target.title } }
        : {}),
    },
  });

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://voxl");
  if (url.pathname === "/healthz") {
    res.writeHead(200);
    return res.end("ok");
  }
  if (
    url.pathname === "/windows" &&
    admitted(req) &&
    !process.argv.includes("--no-windows")
  ) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ windows: WINDOWS }));
  }
  res.writeHead(admitted(req) ? 404 : 401);
  res.end();
});
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://voxl");
  if (url.pathname !== "/ws" || !admitted(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(
      `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    )
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const sendText = (text) => socket.write(frame(Buffer.from(text), 1));
  sockets.add(sendText);
  socket.on("close", () => sockets.delete(sendText));
  const everyone = (text) => {
    for (const send of sockets) send(text);
  };
  sendText(hello());
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let opcodeOfMessage = 0;
  let closed = false;
  const close = (code, reason) => {
    if (closed) return;
    closed = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    socket.end(frame(body, 8));
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = buffer[0] & 0x80;
      const opcode = buffer[0] & 0x0f;
      const masked = buffer[1] & 0x80;
      let len = buffer[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buffer.length < off + len) return;
      const payload = Buffer.from(buffer.subarray(off, off + len));
      if (masked) {
        const m = buffer.subarray(maskOff, maskOff + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i % 4];
      }
      buffer = buffer.subarray(off + len);
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.subarray(2).toString("utf8");
        void post("/fake-voxl/closed", { code, reason });
        close(1000, "");
        return;
      }
      if (opcode === 9) {
        socket.write(frame(payload, 10));
        continue;
      }
      if (opcode === 10) continue;
      if (opcode !== 0) opcodeOfMessage = opcode;
      fragments.push(payload);
      if (!fin) continue;
      const whole = Buffer.concat(fragments);
      fragments = [];
      if (opcodeOfMessage === 2) {
        const sha = createHash("sha256").update(whole).digest("hex");
        sendText(`binary:${whole.length}:${sha}`);
        continue;
      }
      const text = whole.toString("utf8");
      if (text === "big") {
        const big = Buffer.alloc(BIG_BYTES);
        for (let i = 0; i < big.length; i++) big[i] = i % 251;
        socket.write(frame(big, 2));
      } else if (text === "close-me") close(4001, "bye");
      else if (/^dw,\d+$/.test(text)) {
        const id = Number(text.slice(3));
        const picked = WINDOWS.slice(0, 2).find((w) => w.id === id);
        if (picked === undefined) {
          sendText(JSON.stringify({ t: "windowClosed", id }));
          sendText(hello());
        } else {
          target = picked;
          everyone(hello());
        }
      } else if (text === "ds,1") {
        target = undefined;
        everyone(hello());
      } else if (text === "close-window" && target !== undefined) {
        const id = target.id;
        target = undefined;
        everyone(JSON.stringify({ t: "windowClosed", id }));
        everyone(hello());
      } else sendText(`echo:${text}`);
    }
  });
  socket.on("error", () => {});
});

const port = Number(flag("--port") ?? 6901);
const addr = flag("--addr") ?? "127.0.0.1";
server.listen(port, addr, () => {
  console.error(`listening on http://${addr}:${port}`);
  void post("/fake-voxl/started", {
    pid: process.pid,
    password,
    args: process.argv.slice(2),
    envKeys: Object.keys(process.env).sort(),
    // Who started it: the supervisor itself, or dx.app's launcher.
    parentExe: (() => {
      try {
        return readlinkSync(`/proc/${process.ppid}/exe`);
      } catch {
        return undefined;
      }
    })(),
  });
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => process.exit(0));
