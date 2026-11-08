// The Desktop half of dx-orb-check: talks to the running Desktop the way the
// dx web viewer and an agent do, with Node's built-in WebSocket and fetch.
//
//   node dx-orb-check.mjs stream <seconds>    H.264 frames on voxl's /ws
//   node dx-orb-check.mjs screen [out.png]    voxl's /screenshot of the display
//   node dx-orb-check.mjs cdp [out.png]       Chromium DevTools: version and a screenshot
//
// Each prints one JSON line and exits non-zero when the check fails.
import { writeFileSync } from "node:fs";

const [command, argument] = process.argv.slice(2);
const desktop = "127.0.0.1:5900";

const done = (ok, detail) => {
  console.log(JSON.stringify({ ok, ...detail }));
  process.exit(ok ? 0 : 1);
};

const open = (url) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener(
      "error",
      (event) => reject(new Error(event.message ?? "websocket error")),
      { once: true },
    );
  });

if (command === "stream") {
  // voxl's protocol (its web/src/protocol.ts): JSON text from the server
  // (hello, ping), binary messages that start with a type byte (0x01: an
  // H.264 stripe update, 16-byte header), and short text commands back: an
  // ack for every frame and a pong for every ping, as its viewer sends.
  const seconds = Number(argument ?? 3);
  const started = performance.now();
  const socket = await open(`ws://${desktop}/ws`);
  let hello = null;
  let frames = 0;
  let keyframes = 0;
  let bytes = 0;
  let firstFrameMs = null;
  const seen = new Set();
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data);
      if (message.t === "hello") {
        hello = message;
        // Video on and a keyframe now, as voxl's own viewer asks on connect.
        socket.send("v,1");
        socket.send("kf");
      }
      if (message.t === "ping") socket.send(`po,${message.s}`);
      return;
    }
    const b = new Uint8Array(event.data);
    bytes += b.length;
    if (b[0] !== 0x01) return;
    const key = (b[1] & 1) === 1;
    const frame = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0;
    firstFrameMs ??= Math.round(performance.now() - started);
    if (key) keyframes++;
    if (!seen.has(frame)) {
      seen.add(frame);
      frames++;
      socket.send(`a,${frame}`);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  socket.close();
  done(hello !== null && frames > 0 && keyframes > 0, {
    check: "desktop.stream",
    size: hello === null ? null : `${hello.w}x${hello.h}`,
    stripes: hello?.stripes?.length ?? 1,
    frames,
    keyframes,
    firstFrameMs,
    kbps: Math.round((bytes * 8) / 1000 / seconds),
  });
} else if (command === "screen") {
  const response = await fetch(`http://${desktop}/screenshot`).catch(
    () => null,
  );
  const png =
    response?.ok === true ? Buffer.from(await response.arrayBuffer()) : null;
  if (png !== null && argument) writeFileSync(argument, png);
  done(png !== null && png.length > 100, {
    check: "desktop.screen",
    screenshotBytes: png?.length ?? 0,
  });
} else if (command === "cdp") {
  const base = "http://127.0.0.1:9222";
  let version = null;
  for (let attempt = 0; attempt < 60 && version === null; attempt++) {
    version = await fetch(`${base}/json/version`)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    if (version === null) await new Promise((r) => setTimeout(r, 500));
  }
  if (version === null)
    done(false, {
      check: "desktop.chromium",
      error: "DevTools did not answer on 127.0.0.1:9222",
    });
  const targets = await (await fetch(`${base}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page)
    done(false, {
      check: "desktop.chromium",
      browser: version.Browser,
      error: "no page",
    });
  const socket = await open(page.webSocketDebuggerUrl);
  const screenshot = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) {
        clearTimeout(timer);
        resolve(message.result?.data ?? null);
      }
    });
    socket.send(
      JSON.stringify({
        id: 1,
        method: "Page.captureScreenshot",
        params: { format: "png" },
      }),
    );
  });
  socket.close();
  const bytes = screenshot === null ? null : Buffer.from(screenshot, "base64");
  if (bytes !== null && argument) writeFileSync(argument, bytes);
  const png = bytes === null ? 0 : bytes.length;
  done(png > 100, {
    check: "desktop.chromium",
    browser: version.Browser,
    screenshotBytes: png,
  });
} else {
  done(false, { error: `unknown command ${command}` });
}
