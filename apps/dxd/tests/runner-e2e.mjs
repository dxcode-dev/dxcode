#!/usr/bin/env node
// End-to-end test of `dxd runner` (the one dxd binary as supervisor and as
// every Thread's daemon) against a mock Core.
//
//   node apps/dxd/tests/runner-e2e.mjs --dxd <dxd> [--update <newer dxd>] [--launcher <dx>]
//
// `--launcher` is a host build of apps/desktop (dx.app's launcher); without
// it the test builds one with cargo.
//
// The mock Core speaks the runner contract: pairing, /runner/manifest.json and
// binaries, the runner WebSocket (hello, ping, request/reply), archive
// upload/download, a dxd endpoint that records dxd's `register`, and the
// Desktop (desktop.ensure/health and streams to a fake voxl, fake-voxl.mjs). It drives
// every operation against a temporary root and prints a pass/fail table; it
// exits 1 when any check fails. Runs with full access (the default).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : resolve(process.argv[i + 1]);
};
const DXD = arg("--dxd");
const RUNNER = DXD;
const UPDATE = arg("--update");
const LAUNCHER =
  arg("--launcher") ??
  (() => {
    const manifest = resolve(import.meta.dirname, "../../desktop/Cargo.toml");
    const built = spawnSync(
      "cargo",
      ["build", "--release", "--quiet", "--manifest-path", manifest],
      { stdio: "inherit" },
    );
    if (built.status !== 0) {
      console.error("runner-e2e: building apps/desktop failed");
      process.exit(2);
    }
    return resolve(dirname(manifest), "target/release/dx");
  })();
if (!DXD) {
  console.error("usage: runner-e2e.mjs --dxd <dxd> [--update <newer dxd>]");
  process.exit(2);
}

const sha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const platform = `linux-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` — ${String(detail).slice(0, 300)}` : ""}`,
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return undefined;
};

// ---------- minimal WebSocket server (RFC 6455 text frames) ----------
const acceptKey = (key) =>
  createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
const encodeFrame = (text, opcode = 1) => {
  const payload = Buffer.from(text);
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
const wsAccept = (req, socket, onText, onClose, onBinary) => {
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers["sec-websocket-key"])}\r\n\r\n`,
  );
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let messageOpcode = 1;
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = buffer[0] & 0x80,
        opcode = buffer[0] & 0x0f,
        masked = buffer[1] & 0x80;
      let len = buffer[1] & 0x7f,
        off = 2;
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
      let payload = buffer.subarray(off, off + len);
      if (masked) {
        const m = buffer.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4]));
      }
      buffer = buffer.subarray(off + len);
      if (opcode === 8) {
        socket.end(encodeFrame("", 8));
        onClose?.();
        return;
      }
      if (opcode === 9) {
        socket.write(encodeFrame(payload, 10));
        continue;
      }
      if (opcode === 10) continue;
      if (opcode !== 0) messageOpcode = opcode;
      fragments.push(payload);
      if (fin) {
        const whole = Buffer.concat(fragments);
        fragments = [];
        if (messageOpcode === 2) onBinary?.(whole);
        else onText(whole.toString("utf8"));
      }
    }
  });
  socket.on("close", () => onClose?.());
  socket.on("error", () => {});
  return {
    send: (obj) =>
      socket.write(
        encodeFrame(typeof obj === "string" ? obj : JSON.stringify(obj)),
      ),
    sendBinary: (buffer) => socket.write(encodeFrame(buffer, 2)),
    close: () => socket.destroy(),
  };
};

// ---------- mock Core ----------
const root = mkdtempSync(join(tmpdir(), "dx-runner-e2e-"));
const dxRoot = join(root, "dx");
const token = randomBytes(24).toString("base64url");
const machineId = `rnm_${randomBytes(12).toString("hex")}`;
const PAIR_CODE = "BCDF-GHJK";
const archives = new Map();
const hellos = [];
const dxdRegisters = [];
let runnerSocket;
const pending = new Map();
let manifestUpdate;
// The Desktop: the fake voxl's reports, data messages per stream from the
// runner, and the manifest's voxl entry when a test sets one.
const voxlReports = [];
const streamFrames = new Map();
let voxlAsset;
const voxlKey = `voxl-linux-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
// The manifest's dx.app launcher entry when a test sets one.
let launcherAsset;
const launcherKey = `dx-desktop-linux-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;

const assets = {
  [`dxd-${platform}`]: DXD,
  ...(UPDATE ? { [`dxd-${platform}-next`]: UPDATE } : {}),
};
const manifest = () => ({
  version: "0.15.0",
  assets: {
    [platform]: { path: `/runner/dxd-${platform}`, sha256: sha(DXD) },
    ...(voxlAsset
      ? { [voxlKey]: { path: `/runner/${voxlKey}`, sha256: voxlAsset.sha256 } }
      : {}),
    ...(launcherAsset
      ? {
          [launcherKey]: {
            path: `/runner/${launcherKey}`,
            sha256: launcherAsset.sha256,
          },
        }
      : {}),
  },
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://core");
  const body = async () => {
    const c = [];
    for await (const x of req) c.push(x);
    return Buffer.concat(c).toString("utf8");
  };
  const json = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const authed = req.headers.authorization === `Bearer ${token}`;
  if (req.method === "POST" && url.pathname === "/v1/runner/pair") {
    const input = JSON.parse(await body());
    if (input.code !== PAIR_CODE) return json(403, { error: "wrong code" });
    return json(200, { machineId, token });
  }
  if (req.method === "GET" && url.pathname === "/runner/manifest.json")
    return json(200, manifest());
  if (req.method === "POST" && url.pathname.startsWith("/fake-voxl/")) {
    voxlReports.push({
      event: url.pathname.slice("/fake-voxl/".length),
      ...JSON.parse(await body()),
    });
    return json(200, {});
  }
  if (req.method === "GET" && url.pathname.startsWith("/runner/")) {
    const name = url.pathname.slice("/runner/".length);
    if (voxlAsset && name === voxlKey) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(readFileSync(voxlAsset.file));
    }
    if (launcherAsset && name === launcherKey) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(readFileSync(launcherAsset.file));
    }
    const file = assets[name];
    if (!file) return json(404, {});
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(readFileSync(file));
  }
  const archive = /^\/v1\/runner\/archives\/(thr_[^/]+)$/.exec(url.pathname);
  if (archive) {
    if (!authed) return json(401, {});
    if (req.method === "PUT") {
      archives.set(archive[1], await body());
      return json(200, { stored: true });
    }
    if (req.method === "GET") {
      const s = archives.get(archive[1]);
      if (!s) return json(404, {});
      res.writeHead(200);
      return res.end(s);
    }
  }
  json(404, { error: "not found" });
});
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://core");
  if (url.pathname === "/v1/runner/connect") {
    if (req.headers.authorization !== `Bearer ${token}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const ws = wsAccept(
      req,
      socket,
      (text) => {
        const msg = JSON.parse(text);
        if (msg.type === "hello") {
          hellos.push(msg);
          ws.send({
            type: "hello",
            ...(manifestUpdate ? { update: manifestUpdate } : {}),
          });
        } else if (msg.type === "ping") ws.send({ type: "pong" });
        else if (msg.type === "reply") {
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        }
      },
      () => {
        if (runnerSocket === ws) runnerSocket = undefined;
      },
      (data) => {
        const stream = data.readUInt32BE(0);
        const list = streamFrames.get(stream) ?? [];
        list.push({
          kind: data[4],
          payload: data.subarray(5),
          bytes: data.length,
        });
        streamFrames.set(stream, list);
      },
    );
    runnerSocket = ws;
    return;
  }
  const dxd = /^\/v1\/threads\/(thr_[^/]+)\/dxd$/.exec(url.pathname);
  if (dxd && (req.headers.authorization ?? "").startsWith("Bearer dxd_")) {
    wsAccept(
      req,
      socket,
      (text) => {
        const msg = JSON.parse(text);
        dxdRegisters.push({
          thread: dxd[1],
          type: msg.type,
          protocolMajor: msg.protocolMajor,
          capabilities: msg.capabilities,
        });
      },
      () => {},
    );
    return;
  }
  socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let seq = 0;
const request = (op, thread, body = {}, timeoutMs = 60000) =>
  new Promise((resolveReply) => {
    if (!runnerSocket)
      return resolveReply({ ok: false, error: { code: "offline" } });
    const id = `req_${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolveReply({ ok: false, error: { code: "timeout" } });
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolveReply(msg);
    });
    runnerSocket.send({ type: "request", id, op, thread, body });
  });

// ---------- drive the runner ----------
// The person's own home folder, as full access links it into each Thread.
const ownHome = join(root, "own-home");
for (const dir of [
  ".ssh",
  "Library/Keychains",
  ".config/gh",
  ".config/dx",
  ".rustup",
  ".cargo",
])
  mkdirSync(join(ownHome, dir), { recursive: true });
writeFileSync(join(ownHome, ".ssh/marker"), "own-ssh\n");
writeFileSync(join(ownHome, ".gitconfig"), "[user]\n\tname = Own Person\n");
writeFileSync(join(ownHome, ".env"), "OWN_SECRET=1\n");
const env = {
  ...process.env,
  HOME: ownHome,
  DX_RUNNER_SELF_CONTAINED_BYTES: "0",
  // Linux runners have no Desktop; this turns on the test one.
  DX_RUNNER_DESKTOP_TEST: "1",
};
delete env.DX_RUNNER_HANDOFF;
// Async: the mock Core runs in this process, so a blocking spawn would
// deadlock any CLI command that calls it.
const cli = (...args) =>
  new Promise((done) => {
    const child = spawn(RUNNER, ["runner", "--root", dxRoot, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
let runnerProcess;
const startRunner = () => {
  runnerProcess = spawn(RUNNER, ["runner", "--root", dxRoot, "run"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  runnerProcess.stderr.on(
    "data",
    (d) => process.env.E2E_VERBOSE && process.stderr.write(d),
  );
  return runnerProcess;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const dxdPids = () =>
  spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((l) => l.includes(`${dxRoot}/threads/`) && l.includes("--config"))
    .map((l) => Number(l.trim().split(/\s+/)[0]));

const T = "thr_0b0e2e00-1111-4222-8333-444455556666";
const H = "/home/user";
try {
  const bad = await cli("pair", "--server", ORIGIN, "--code", "XXXX-XXXX");
  check(
    "pair: wrong code is refused",
    bad.status !== 0 && !existsSync(join(dxRoot, "runner/config.json")),
    bad.stderr,
  );
  const pair = await cli(
    "pair",
    "--server",
    ORIGIN,
    "--code",
    PAIR_CODE,
    "--name",
    "e2e-box",
  );
  const configPath = join(dxRoot, "runner/config.json");
  check(
    "pair: writes config 0600",
    pair.status === 0 && (statSync(configPath).mode & 0o777) === 0o600,
    pair.stderr,
  );
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  check(
    "pair: config has machineId and token",
    config.machineId === machineId && config.token === token,
  );
  const doctor = await cli("doctor");
  check(
    "doctor: full access (no sandbox) is the default",
    doctor.status === 0 && doctor.stdout.includes('"sandbox": "none"'),
    doctor.stdout + doctor.stderr,
  );

  startRunner();
  const hello = await waitFor(() => hellos[0]);
  check(
    "connect: hello with version, os, arch, sandbox",
    hello?.version && hello.os === "linux" && hello.sandbox === "none",
    JSON.stringify(hello),
  );

  let r = await request("ensure", T, { existingOnly: true });
  check(
    "ensure existingOnly on a new Thread: not-found",
    !r.ok && r.error.code === "not-found",
    JSON.stringify(r),
  );
  r = await request("ensure", T, {
    existingOnly: false,
    prepareSourceWorkspace: false,
  });
  check(
    "ensure: creates the folder, cwd is the guest repo",
    r.ok &&
      r.result.cwd === `${H}/workspace/repo` &&
      existsSync(join(dxRoot, "threads", T, "home/workspace/repo")),
    JSON.stringify(r),
  );

  r = await request("exec", T, {
    command: `echo "$HOME|$PWD|$FOO"; echo hi > ${H}/workspace/repo/a.txt; echo err >&2; exit 3`,
    env: { FOO: `${H}/x` },
  });
  const home = join(dxRoot, "threads", T, "home");
  check(
    "exec: HOME, cwd, env and command translate /home/user",
    r.ok &&
      r.result.stdout.trim() === `${home}|${home}/workspace/repo|${home}/x` &&
      r.result.exitCode === 3 &&
      r.result.stderr.trim() === "err",
    JSON.stringify(r),
  );
  check(
    "exec: wrote inside the Thread",
    readFileSync(join(home, "workspace/repo/a.txt"), "utf8") === "hi\n",
  );
  // Full access: the person's own Rust toolchain and gh login, though HOME
  // is the Thread's folder.
  r = await request("exec", T, {
    command: 'printf %s "$RUSTUP_HOME|$CARGO_HOME"',
  });
  const own = (dir) =>
    existsSync(join(ownHome, dir)) ? join(ownHome, dir) : "";
  check(
    "exec: full access finds the person's own rustup and cargo",
    r.ok && r.result.stdout === `${own(".rustup")}|${own(".cargo")}`,
    JSON.stringify(r.result),
  );
  // Full access: the host's PATH (the person's tools) before a request's.
  r = await request("exec", T, {
    command: 'printf %s "$PATH"',
    env: { PATH: "/dx-request-bin:/usr/bin" },
  });
  {
    const dirs = r.ok ? r.result.stdout.split(":") : [];
    check(
      "exec: with full access the host PATH comes first, then a request's",
      dirs.includes("/dx-request-bin") &&
        dirs.filter((d) => d === "/usr/bin").length === 1 &&
        dirs.indexOf("/usr/bin") < dirs.indexOf("/dx-request-bin"),
      JSON.stringify(r.result),
    );
  }
  // Full access: a Git config the machine lacks (an Orb's dx-terminal one)
  // does not hide the person's ~/.gitconfig.
  r = await request("exec", T, {
    command: "git config user.name",
    env: { GIT_CONFIG_GLOBAL: `${H}/.local/state/dx-terminal/gitconfig` },
  });
  check(
    "full access: git reads the person's ~/.gitconfig when the requested config is missing",
    r.ok && r.result.stdout.trim() === "Own Person",
    JSON.stringify(r.result),
  );
  // Full access: the Thread's home links to the person's own entries, so
  // their keys, Keychain, Git setup, and logins are where tools look.
  const threadHome = join(dxRoot, "threads", T, "home");
  const linkTo = (name) => {
    try {
      return readlinkSync(join(threadHome, name));
    } catch {
      return undefined;
    }
  };
  r = await request("exec", T, { command: "cat ~/.ssh/marker" });
  check(
    "full access: the Thread's home links to the person's .ssh, Library, .gitconfig and .config entries",
    r.ok &&
      r.result.stdout === "own-ssh\n" &&
      linkTo(".ssh") === join(ownHome, ".ssh") &&
      linkTo("Library") === join(ownHome, "Library") &&
      linkTo(".gitconfig") === join(ownHome, ".gitconfig") &&
      linkTo(".config/gh") === join(ownHome, ".config/gh") &&
      !existsSync(join(threadHome, ".config/dx")) &&
      linkTo(".config") === undefined &&
      linkTo(".env") === undefined &&
      linkTo("workspace") === undefined,
    JSON.stringify(r.result),
  );
  r = await request("exec", T, {
    command: "env | cut -d= -f1 | sort | tr '\\n' ' '",
  });
  check(
    "exec: clean environment (no inherited secrets)",
    r.ok &&
      !r.result.stdout.includes("E2E_") &&
      !/ (SSH_AUTH_SOCK|GITHUB_TOKEN|AWS_) /.test(r.result.stdout) &&
      r.result.stdout.includes("HOME"),
    r.result?.stdout,
  );

  r = await request("write", T, {
    path: `${H}/workspace/repo/dir/b.txt`,
    contents: Buffer.from("bee").toString("base64"),
  });
  const read = await request("read", T, {
    path: `${H}/workspace/repo/dir/b.txt`,
  });
  check(
    "write + read round trip",
    r.ok &&
      read.ok &&
      Buffer.from(read.result.contents, "base64").toString() === "bee",
    JSON.stringify(read),
  );
  r = await request("stat", T, { path: `${H}/workspace/repo/dir` });
  check(
    "stat: directory",
    r.ok && r.result.directory && !r.result.file,
    JSON.stringify(r),
  );
  r = await request("readdir", T, { path: `${H}/workspace/repo` });
  check(
    "readdir: names",
    r.ok &&
      r.result.entries.includes("a.txt") &&
      r.result.entries.includes("dir"),
    JSON.stringify(r),
  );
  r = await request("mkdir", T, {
    path: `${H}/workspace/repo/x/y`,
    recursive: true,
  });
  const rm = await request("rm", T, {
    path: `${H}/workspace/repo/x`,
    recursive: true,
    force: true,
  });
  check(
    "mkdir -p + rm -rf",
    r.ok && rm.ok && !existsSync(join(home, "workspace/repo/x")),
  );
  r = await request("rm", T, {
    path: `${H}/workspace/repo/missing`,
    force: true,
  });
  check("rm force on a missing path is fine", r.ok);

  r = await request("read", T, { path: "/etc/passwd" });
  check(
    "refuses a path outside /home/user",
    !r.ok && r.error.code === "invalid",
    JSON.stringify(r),
  );
  r = await request("read", T, { path: `${H}/../../etc/passwd` });
  check(
    "refuses a .. escape",
    !r.ok && r.error.code === "invalid",
    JSON.stringify(r),
  );
  await request("exec", T, { command: `ln -s /etc ${H}/workspace/repo/link` });
  r = await request("read", T, { path: `${H}/workspace/repo/link/passwd` });
  check(
    "refuses to traverse a symlink",
    !r.ok && r.error.code === "invalid",
    JSON.stringify(r),
  );
  await request("rm", T, { path: `${H}/workspace/repo/link`, force: true });
  r = await request("read", "thr_../../etc", { path: `${H}/x` });
  check("refuses an invalid Thread id", !r.ok && r.error.code === "invalid");

  r = await request("exec", T, { command: "sleep 30", timeoutMs: 500 });
  check(
    "exec timeout ends the command",
    !r.ok && r.error.code === "timeout",
    JSON.stringify(r),
  );
  r = await request("exec", T, {
    command: "(sleep 312 &) ; sleep 313 & echo started",
  });
  await sleep(300);
  const leftovers = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((l) => /^sleep 31[23]$/.test(l.trim()));
  check(
    "exec leaves no background processes",
    r.ok && leftovers.length === 0,
    leftovers.join(","),
  );

  // Git: the source repo with an origin (incremental bundle), plus a repo with no origin.
  const origin = join(root, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const gitEnv =
    "export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t";
  r = await request("exec", T, {
    command: `${gitEnv}; set -e; rm -rf ${H}/workspace/repo; git clone -q file://${origin} ${H}/workspace/repo 2>/dev/null || git init -q -b main ${H}/workspace/repo; cd ${H}/workspace/repo; git remote get-url origin >/dev/null 2>&1 || git remote add origin file://${origin}; echo one > README; git add README; git commit -qm one; git push -q origin main; git checkout -qb feature; echo two >> README; git commit -qam two; echo wip >> README; echo new > untracked.txt; echo notes > ${H}/workspace/notes.md; mkdir -p ${H}/workspace/repos; git init -q -b main ${H}/workspace/repos/local; cd ${H}/workspace/repos/local; echo l > l.txt; git add l.txt; git commit -qm l; echo dirty >> l.txt; git status --short; cd ${H}/workspace/repo; git push -q origin feature; git clone -q --depth 1 --branch feature file://${origin} ${H}/workspace/repos/shallow; cd ${H}/workspace/repos/shallow; echo s > s.txt; test "$(git rev-parse --is-shallow-repository)" = true`,
    timeoutMs: 60000,
  });
  check(
    "git: repos prepared in the Thread",
    r.ok && r.result.exitCode === 0,
    JSON.stringify(r).slice(0, 400),
  );
  r = await request("snapshot", T, {});
  check(
    "snapshot: workspace context",
    r.ok && r.result.directoryListing.includes("README"),
    JSON.stringify(r),
  );

  // dxd
  const endpoint = `ws://127.0.0.1:${server.address().port}/v1/threads/${T}/dxd`;
  r = await request("daemon", T, { existingOnly: true, endpoint });
  check(
    "daemon without a key first: credential-required",
    r.ok && r.result.status === "credential-required",
    JSON.stringify(r),
  );
  r = await request(
    "daemon",
    T,
    {
      existingOnly: true,
      endpoint,
      apiKey: `dxd_${randomBytes(24).toString("hex")}`,
    },
    120000,
  );
  check(
    "daemon: dxd installed in ~/.dx/runner/bin and started",
    r.ok &&
      r.result.status === "running" &&
      sha(join(dxRoot, "runner/bin/dxd")) === sha(DXD),
    JSON.stringify(r),
  );
  const registered = await waitFor(
    () => dxdRegisters.find((m) => m.thread === T),
    20000,
  );
  check(
    "daemon: dxd connected to Core and registered",
    registered?.type === "register",
    JSON.stringify(dxdRegisters),
  );
  const dxdConfig = join(dxRoot, "threads", T, "daemon/config.json");
  const written = JSON.parse(readFileSync(dxdConfig, "utf8"));
  check(
    "daemon: config 0600, localRuntime home/state, selfUpdate false",
    (statSync(dxdConfig).mode & 0o777) === 0o600 &&
      written.localRuntime.homeDirectory === home &&
      written.localRuntime.selfUpdate === false,
    JSON.stringify(written.localRuntime),
  );
  const desktopOff = await waitFor(
    () => dxdRegisters.find((m) => m.thread === T && m.capabilities),
    5000,
  );
  check(
    "daemon: registers terminal, no desktop",
    desktopOff?.capabilities?.terminal && !desktopOff.capabilities.desktop,
    JSON.stringify(desktopOff?.capabilities),
  );
  r = await request("daemon", T, { existingOnly: true, endpoint });
  check(
    "daemon again without a key: running (config reused)",
    r.ok && r.result.status === "running",
  );
  r = await request("daemon", T, {
    existingOnly: true,
    endpoint: "wss://evil.example/v1/threads/thr_other/dxd",
    apiKey: "dxd_xxxxxxxxxxxxxxxxxxxxxxxx",
  });
  check(
    "daemon: refuses another Thread's endpoint",
    !r.ok && r.error.code === "invalid",
  );

  // Idle memory: the supervisor and one Thread's dxd after 5 s of quiet.
  await sleep(5000);
  const rss = (pid) => {
    try {
      return Number(
        /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1],
      );
    } catch {
      return NaN;
    }
  };
  const idle = {
    supervisorKiB: rss(runnerProcess.pid),
    threadDxdKiB: rss(dxdPids()[0]),
  };
  console.log(`idle RSS: ${JSON.stringify(idle)}`);
  check(
    "idle RSS measured (supervisor and one Thread dxd under 20 MiB each)",
    idle.supervisorKiB < 20480 && idle.threadDxdKiB < 20480,
    JSON.stringify(idle),
  );

  // Runner crash leaves dxd orphaned; the next runner ends it and starts a new one.
  const before = dxdPids();
  runnerProcess.kill("SIGKILL");
  await sleep(500);
  check(
    "after a runner crash its dxd is still running",
    before.length === 1 && alive(before[0]),
    before.join(","),
  );
  hellos.length = 0;
  dxdRegisters.length = 0;
  startRunner();
  await waitFor(() => hellos[0]);
  const reRegistered = await waitFor(
    () => dxdRegisters.find((m) => m.thread === T),
    20000,
  );
  const after = dxdPids();
  check(
    "restart: leftover dxd ended, a new one registered",
    !alive(before[0]) &&
      after.length === 1 &&
      after[0] !== before[0] &&
      reRegistered,
    `${before} -> ${after}`,
  );

  // Archive and restore.
  r = await request(
    "archive",
    T,
    { uploadUrl: `/v1/runner/archives/${T}` },
    180000,
  );
  const threadDir = join(dxRoot, "threads", T);
  check(
    "archive: uploaded, folder deleted, dxd stopped",
    r.ok && archives.has(T) && !existsSync(threadDir) && dxdPids().length === 0,
    JSON.stringify(r),
  );
  const snap = JSON.parse(archives.get(T) ?? "{}");
  check(
    "archive: incremental bundle for the repo with origin, full for the local one",
    snap.repos?.find((x) => x.path === "repo")?.mode === "bundle" &&
      snap.repos?.find((x) => x.path === "repos/local")?.mode === "bundle-full",
    JSON.stringify(snap.repos?.map((x) => [x.path, x.mode])),
  );
  r = await request("archive", T, {
    uploadUrl: "https://elsewhere.example/steal",
  });
  check(
    "archive: refuses an upload URL on another origin",
    !r.ok && r.error.code === "invalid",
  );
  r = await request("ensure", T, { existingOnly: true });
  check(
    "ensure existingOnly after archive: not-found",
    !r.ok && r.error.code === "not-found",
  );
  r = await request(
    "ensure",
    T,
    { existingOnly: true, restore: { url: `/v1/runner/archives/${T}` } },
    180000,
  );
  check(
    "ensure with restore: rebuilt",
    r.ok && r.result.restored === true,
    JSON.stringify(r),
  );
  r = await request("exec", T, {
    command: `cd ${H}/workspace/repo && git status --short --branch && git log --oneline | wc -l && cat README untracked.txt ../notes.md && cd ../repos/local && git status --short && cat l.txt && cd ../shallow && git status --short && cat s.txt`,
  });
  const out = r.result?.stdout ?? "";
  check(
    "restore: branch, commits, uncommitted edit, untracked file, notes, second repo, shallow clone",
    r.ok &&
      out.includes("## feature") &&
      out.includes(" M README") &&
      out.includes("?? untracked.txt") &&
      /\n\s*2\n/.test(out) &&
      out.includes("one\ntwo\nwip") &&
      out.includes("notes") &&
      out.includes(" M l.txt") &&
      out.includes("?? s.txt") &&
      out.includes("l\ndirty"),
    out,
  );

  r = await request("threads", "", {});
  check(
    "threads: lists the Thread",
    r.ok && r.result.threads.some((t) => t.id === T),
    JSON.stringify(r),
  );

  // Self-update.
  if (UPDATE) {
    const nextVersion = spawnSync(UPDATE, ["runner", "version"], {
      encoding: "utf8",
      env: { ...env, DX_RUNNER_HANDOFF: "1" },
    }).stdout.trim();
    manifestUpdate = {
      version: nextVersion,
      assets: {
        [platform]: {
          url: `/runner/dxd-${platform}-next`,
          sha256: sha(UPDATE),
        },
      },
    };
    hellos.length = 0;
    runnerSocket?.close();
    const updated = await waitFor(
      () => hellos.find((h) => h.version === nextVersion),
      60000,
    );
    check(
      `self-update: runner restarted as ${nextVersion}`,
      updated &&
        readFileSync(join(dxRoot, "runner/bin/version"), "utf8") ===
          nextVersion &&
        sha(join(dxRoot, "runner/bin/dxd")) === sha(UPDATE) &&
        existsSync(join(dxRoot, "runner/bin/previous")),
      JSON.stringify(hellos),
    );
    manifestUpdate = undefined;
  }
  manifestUpdate = {
    version: "0.0.1",
    assets: {
      [platform]: { url: `/runner/dxd-${platform}`, sha256: sha(RUNNER) },
    },
  };
  r = await request("ping", "", {});
  check("self-update: an older version is ignored", r.ok);
  manifestUpdate = undefined;

  r = await request(
    "daemon",
    T,
    {
      existingOnly: true,
      endpoint,
      apiKey: `dxd_${randomBytes(24).toString("hex")}`,
    },
    120000,
  );
  await waitFor(() => dxdPids().length === 1);

  // ---------- the Desktop: voxl outside the sandbox, via the supervisor ----------
  const runnerDir = join(dxRoot, "runner");
  const fakeVoxl = resolve(import.meta.dirname, "fake-voxl.mjs");
  const voxlWrapper = (path, ...extra) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `#!/bin/sh\nexec '${process.execPath}' '${fakeVoxl}' --report '${ORIGIN}' ${extra.join(" ")} "$@"\n`,
    );
    chmodSync(path, 0o755);
  };
  const started = () => voxlReports.filter((x) => x.event === "started");
  const killVoxl = async () => {
    for (const s of started())
      try {
        process.kill(s.pid, "SIGKILL");
      } catch {}
    // The supervisor reaps it on its next desktop.ensure.
    await sleep(200);
  };
  // One stream's whole messages as Core would join them.
  const joined = (stream) => {
    const out = [];
    let parts = [];
    for (const f of streamFrames.get(stream) ?? []) {
      parts.push(f.payload);
      if ((f.kind & 0x80) === 0) {
        out.push({ kind: f.kind, payload: Buffer.concat(parts) });
        parts = [];
      }
    }
    return out;
  };
  const dataFrame = (stream, kind, payload) => {
    const head = Buffer.alloc(5);
    head.writeUInt32BE(stream, 0);
    head[4] = kind;
    return Buffer.concat([head, payload]);
  };
  const toRunner = (stream, kind, payload) => {
    const chunk = 512 * 1024;
    if (payload.length <= chunk)
      return runnerSocket.sendBinary(dataFrame(stream, kind, payload));
    for (let off = 0; off < payload.length; off += chunk)
      runnerSocket.sendBinary(
        dataFrame(
          stream,
          off + chunk >= payload.length ? kind : kind | 0x80,
          payload.subarray(off, off + chunk),
        ),
      );
  };
  const nextMessage = (stream, predicate, ms = 10000) =>
    waitFor(() => joined(stream).find(predicate), ms);
  const closeOf = (m) => ({
    code: m.payload.length >= 2 ? m.payload.readUInt16BE(0) : undefined,
    reason: m.payload.subarray(2).toString("utf8"),
  });

  r = await request("desktop.ensure", T, {});
  check(
    "desktop.ensure without voxl: missing, with the build command",
    r.ok &&
      r.result.status === "missing" &&
      r.result.detail.includes(
        "cargo install voxl-server --root ~/.dx/runner/voxl",
      ),
    JSON.stringify(r),
  );
  r = await request("desktop.windows", T, {});
  check(
    "desktop.windows before voxl runs: not running",
    r.ok && r.result.ok === false && /not running/.test(r.result.detail),
    JSON.stringify(r),
  );
  runnerSocket.send({ type: "stream-open", stream: 40, path: "/ws" });
  const notRunning = await nextMessage(40, (m) => m.kind === 2);
  check(
    "stream to a Desktop that is not running: closed 1011",
    notRunning && closeOf(notRunning).code === 1011,
    JSON.stringify(notRunning && closeOf(notRunning)),
  );

  voxlWrapper(join(runnerDir, "voxl/bin/voxl"));
  r = await request("desktop.ensure", T, {}, 60000);
  const voxl = started()[0];
  check(
    "desktop.ensure starts the local voxl build on 127.0.0.1:6911",
    r.ok &&
      r.result.status === "running" &&
      voxl?.args.join(" ").includes("--addr 127.0.0.1 --port 6911"),
    JSON.stringify({ r, voxl }),
  );
  const password = voxl?.password ?? "";
  check(
    "voxl gets a fresh 256-bit password and a minimal environment",
    /^[0-9a-f]{64}$/.test(password) &&
      !voxl.envKeys.includes("DX_RUNNER_DESKTOP_TEST"),
    JSON.stringify(voxl?.envKeys),
  );
  r = await request("desktop.ensure", T, {});
  check(
    "desktop.ensure again: the same voxl keeps running",
    r.ok && r.result.status === "running" && started().length === 1,
    JSON.stringify(r),
  );
  r = await request("desktop.health", T, {});
  check(
    "desktop.health: voxl's /healthz through the supervisor",
    r.ok && r.result.ok === true && r.result.body === "ok",
    JSON.stringify(r),
  );

  // The password reaches nothing a Thread can read.
  const grep = spawnSync(
    "grep",
    ["-rl", password, join(dxRoot, "threads"), runnerDir],
    {
      encoding: "utf8",
    },
  );
  const dxdEnvirons = dxdPids().map((pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      return "";
    }
  });
  check(
    "the password is on no disk under ~/.dx and not in a Thread's dxd",
    password &&
      grep.stdout.trim() === "" &&
      dxdEnvirons.length === 1 &&
      !dxdEnvirons.some(
        (e) => e.includes(password) || e.includes("VOXL_PASSWORD"),
      ),
    grep.stdout,
  );

  // A Thread command without the password is refused by voxl. (Linux has
  // no Seatbelt; on a Mac the profile's port deny stops it earlier, see
  // sandbox.rs `seatbelt_denies_the_desktop_port`.)
  r = await request("exec", T, {
    command:
      "exec 3<>/dev/tcp/127.0.0.1/6911 && printf 'GET /ws HTTP/1.1\\r\\nHost: 127.0.0.1:6911\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n' >&3 && head -1 <&3",
  });
  check(
    "a Thread command without the password: 401",
    r.ok && r.result.stdout.includes(" 401 "),
    JSON.stringify(r.result),
  );
  const upgrade = (headers, path = "/ws") =>
    new Promise((done) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: 6911,
        path,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          ...headers,
        },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        done(res.statusCode);
      });
      req.on("response", (res) => done(res.statusCode));
      req.on("error", (e) => done(e.message));
      req.end();
    });
  const wrong = await upgrade({ authorization: `Bearer ${"0".repeat(64)}` });
  const missing = await upgrade({});
  const right = await upgrade({ authorization: `Bearer ${password}` });
  check(
    "voxl refuses a wrong or missing password, admits the right one",
    wrong === 401 && missing === 401 && right === 101,
    `${wrong} ${missing} ${right}`,
  );

  // A stream: browser -> Core -> runner -> voxl and back.
  runnerSocket.send({ type: "stream-open", stream: 42, path: "/ws" });
  const voxlHello = await nextMessage(42, (m) => m.kind === 0);
  check(
    "stream: voxl's first text message reaches Core",
    voxlHello && JSON.parse(voxlHello.payload.toString()).t === "hello",
    voxlHello?.payload.toString(),
  );
  toRunner(42, 0, Buffer.from("hi from the browser"));
  const echo = await nextMessage(
    42,
    (m) => m.kind === 0 && m.payload.toString() === "echo:hi from the browser",
  );
  check(
    "stream: text both ways",
    echo,
    JSON.stringify(joined(42).map((m) => m.payload.toString().slice(0, 60))),
  );
  const small = Buffer.from([0, 1, 2, 250, 255]);
  toRunner(42, 1, small);
  const smallEcho = await nextMessage(42, (m) =>
    m.payload.toString().startsWith(`binary:5:`),
  );
  check(
    "stream: binary to voxl",
    smallEcho?.payload.toString() ===
      `binary:5:${createHash("sha256").update(small).digest("hex")}`,
    smallEcho?.payload.toString(),
  );
  const large = randomBytes(1_200_000);
  toRunner(42, 1, large);
  const largeEcho = await nextMessage(42, (m) =>
    m.payload.toString().startsWith(`binary:1200000:`),
  );
  check(
    "stream: a 1.2 MB browser message in 512 KiB fragments reaches voxl whole",
    largeEcho?.payload.toString() ===
      `binary:1200000:${createHash("sha256").update(large).digest("hex")}`,
    largeEcho?.payload.toString(),
  );
  toRunner(42, 0, Buffer.from("big"));
  const big = await nextMessage(42, (m) => m.kind === 1);
  const expected = Buffer.alloc(1_500_000);
  for (let i = 0; i < expected.length; i++) expected[i] = i % 251;
  const bigFrames = (streamFrames.get(42) ?? []).filter(
    (f) => (f.kind & 0x7f) === 1,
  );
  check(
    "stream: voxl's 1.5 MB binary arrives in fragments under 1 MiB and joins whole",
    big?.payload.equals(expected) &&
      bigFrames.length >= 3 &&
      bigFrames.every((f) => f.bytes < 1024 * 1024) &&
      (bigFrames.at(-1).kind & 0x80) === 0,
    `${bigFrames.map((f) => `${f.kind}:${f.bytes}`).join(",")}`,
  );
  toRunner(42, 2, Buffer.from([0x03, 0xe8, ...Buffer.from("viewer left")]));
  const voxlSawClose = await waitFor(() =>
    voxlReports.find((x) => x.event === "closed"),
  );
  check(
    "stream: a close from Core closes voxl's socket",
    voxlSawClose &&
      voxlSawClose.code === 1000 &&
      voxlSawClose.reason === "viewer left",
    JSON.stringify(voxlSawClose),
  );
  runnerSocket.send({ type: "stream-open", stream: 43, path: "/ws" });
  await nextMessage(43, (m) => m.kind === 0);
  toRunner(43, 0, Buffer.from("close-me"));
  const closed = await nextMessage(43, (m) => m.kind === 2);
  check(
    "stream: voxl's close (4001 bye) reaches Core",
    closed && closeOf(closed).code === 4001 && closeOf(closed).reason === "bye",
    JSON.stringify(closed && closeOf(closed)),
  );
  runnerSocket.send({ type: "stream-open", stream: 44, path: "/other" });
  const otherPath = await nextMessage(44, (m) => m.kind === 2);
  check(
    "stream: a path other than /ws is refused",
    otherPath && closeOf(otherPath).code === 1008,
    JSON.stringify(otherPath && closeOf(otherPath)),
  );

  // Window mode (dx's voxl patch): the Mac's windows, and a viewer
  // switching the stream between one window and the display through the relay.
  r = await request("desktop.windows", T, {});
  const listed = r.result?.windows ?? [];
  check(
    "desktop.windows: voxl's window list through the supervisor, checked and cut",
    r.ok &&
      r.result.ok === true &&
      listed.length === 2 &&
      isDeepStrictEqual(listed[0], {
        id: 7101,
        app: "Simulator",
        bundleId: "com.apple.iphonesimulator",
        title: "iPhone 16 Pro",
        frame: { x: 120, y: 80, w: 402, h: 874 },
        display: 1,
      }) &&
      listed[1].id === 7102 &&
      listed[1].title.length === 200,
    JSON.stringify(r).slice(0, 400),
  );
  const voxlTexts = (stream) =>
    joined(stream)
      .filter((m) => m.kind === 0)
      .map((m) => JSON.parse(m.payload.toString()))
      .filter((m) => m.t === "hello" || m.t === "windowClosed");
  const nextVoxlText = async (stream, count, predicate) =>
    waitFor(() => {
      const all = voxlTexts(stream);
      return all.length >= count && predicate(all.slice(count - 1))
        ? all.slice(count - 1)
        : undefined;
    });
  runnerSocket.send({ type: "stream-open", stream: 46, path: "/ws" });
  runnerSocket.send({ type: "stream-open", stream: 47, path: "/ws" });
  await nextVoxlText(46, 1, () => true);
  await nextVoxlText(47, 1, () => true);
  toRunner(46, 0, Buffer.from("dw,7101"));
  const [toWindow] =
    (await nextVoxlText(46, 2, ([h]) => h.displays?.window?.id === 7101)) ?? [];
  const [otherViewer] =
    (await nextVoxlText(47, 2, ([h]) => h.displays?.window?.id === 7101)) ?? [];
  check(
    "window mode: dw,<id> from one viewer streams that window to every viewer",
    toWindow?.w === 804 &&
      toWindow.h === 1748 &&
      toWindow.displays.window.app === "Simulator" &&
      otherViewer?.w === 804,
    JSON.stringify(voxlTexts(46)),
  );
  toRunner(46, 0, Buffer.from("ds,1"));
  const [toDisplay] =
    (await nextVoxlText(46, 3, ([h]) => h.displays && !h.displays.window)) ??
    [];
  check(
    "window mode: ds,<display> goes back to the whole screen",
    toDisplay?.w === 2940 && toDisplay.displays.window === undefined,
    JSON.stringify(voxlTexts(46)),
  );
  toRunner(46, 0, Buffer.from("dw,9999"));
  const refused = await nextVoxlText(46, 4, (m) => m.length >= 2);
  check(
    "window mode: a window that is gone is refused with windowClosed",
    refused?.[0]?.t === "windowClosed" &&
      refused[0].id === 9999 &&
      refused[1]?.displays?.window === undefined,
    JSON.stringify(voxlTexts(46)),
  );
  toRunner(46, 0, Buffer.from("dw,7102"));
  await nextVoxlText(46, 6, ([h]) => h.displays?.window?.id === 7102);
  toRunner(46, 0, Buffer.from("close-window"));
  // Stream 47 saw: hello, 7101, display, 7102, then windowClosed and hello.
  const fellBack = await nextVoxlText(47, 5, (m) => m.length >= 2);
  check(
    "window mode: the window closes, viewers are told and get the whole screen",
    fellBack?.[0]?.t === "windowClosed" &&
      fellBack[0].id === 7102 &&
      fellBack[1]?.t === "hello" &&
      fellBack[1].displays.window === undefined,
    JSON.stringify(voxlTexts(47)),
  );
  for (const stream of [46, 47]) toRunner(stream, 2, Buffer.from([0x03, 0xe8]));
  await waitFor(
    () => voxlReports.filter((x) => x.event === "closed").length >= 3,
  );

  // The deployment's voxl: SHA-256-checked, preferred over a local build.
  const assetFile = join(root, "voxl-asset");
  voxlWrapper(assetFile, "--from-manifest");
  const voxlFile = join(runnerDir, "bin/voxl");
  const app = join(runnerDir, "dx.app");
  const appExe = join(app, "Contents/MacOS/dx");
  const appSource = join(runnerDir, "dx.app.sha256");
  const viaLauncher = (s) => s?.parentExe?.endsWith("dx.app/Contents/MacOS/dx");
  voxlAsset = { file: assetFile, sha256: "0".repeat(64) };
  await killVoxl();
  r = await request("desktop.ensure", T, {}, 60000);
  check(
    "a manifest voxl whose SHA-256 does not match is not installed",
    r.ok &&
      r.result.status === "running" &&
      !existsSync(voxlFile) &&
      !started().at(-1).args.includes("--from-manifest"),
    JSON.stringify(r),
  );
  voxlAsset = { file: assetFile, sha256: sha(assetFile) };
  await killVoxl();
  r = await request("desktop.ensure", T, {}, 60000);
  check(
    "the manifest's voxl-<os>-<arch> is downloaded to ~/.dx/runner/bin/voxl and used",
    r.ok &&
      r.result.status === "running" &&
      sha(voxlFile) === voxlAsset.sha256 &&
      !existsSync(app) &&
      started().at(-1).args.includes("--from-manifest") &&
      !viaLauncher(started().at(-1)) &&
      started().at(-1).password !== password,
    JSON.stringify(r),
  );

  // Its launcher: dx.app (dev.dx.app.desktop, named dx) starts voxl.
  launcherAsset = { file: LAUNCHER, sha256: sha(LAUNCHER) };
  await killVoxl();
  r = await request("desktop.ensure", T, {}, 60000);
  const plist = existsSync(join(app, "Contents/Info.plist"))
    ? readFileSync(join(app, "Contents/Info.plist"), "utf8")
    : "";
  check(
    "the manifest's dx-desktop launcher becomes ~/.dx/runner/dx.app, which starts bin/voxl with its arguments and password",
    r.ok &&
      r.result.status === "running" &&
      sha(appExe) === launcherAsset.sha256 &&
      readFileSync(appSource, "utf8").trim() === launcherAsset.sha256 &&
      /<key>CFBundleIdentifier<\/key><string>dev\.dx\.app\.desktop<\/string>/.test(
        plist,
      ) &&
      /<key>CFBundleName<\/key><string>dx<\/string>/.test(plist) &&
      viaLauncher(started().at(-1)) &&
      started().at(-1).args.includes("--from-manifest") &&
      started().at(-1).envKeys.includes("VOXL_PASSWORD") ===
        started().at(-2)?.envKeys?.includes("VOXL_PASSWORD"),
    JSON.stringify({ r, last: started().at(-1) }),
  );

  // A new voxl replaces bin/voxl and leaves dx.app (and its grants) alone.
  const appInode = statSync(appExe).ino;
  const plistBefore = plist;
  const nextVoxl = join(root, "voxl-asset-next");
  voxlWrapper(nextVoxl, "--from-manifest", "--next");
  voxlAsset = { file: nextVoxl, sha256: sha(nextVoxl) };
  await killVoxl();
  r = await request("desktop.ensure", T, {}, 60000);
  check(
    "a voxl update replaces bin/voxl only: dx.app stays byte for byte and still starts it",
    r.ok &&
      r.result.status === "running" &&
      sha(voxlFile) === voxlAsset.sha256 &&
      statSync(appExe).ino === appInode &&
      readFileSync(join(app, "Contents/Info.plist"), "utf8") === plistBefore &&
      viaLauncher(started().at(-1)) &&
      started().at(-1).args.includes("--next"),
    JSON.stringify({ r, last: started().at(-1) }),
  );

  // Signing on a Mac changes the launcher file; the recorded download keeps
  // it from being fetched again.
  await killVoxl();
  // The launcher exits with the voxl it started; then its file is free.
  await sleep(500);
  writeFileSync(
    appExe,
    Buffer.concat([readFileSync(appExe), Buffer.from("signed")]),
  );
  r = await request("desktop.ensure", T, {}, 60000);
  check(
    "an installed dx.app is reused while the manifest's launcher SHA-256 stays the same",
    r.ok &&
      r.result.status === "running" &&
      statSync(appExe).ino === appInode &&
      readFileSync(appExe).subarray(-6).toString() === "signed" &&
      viaLauncher(started().at(-1)),
    JSON.stringify(r),
  );

  // Stopping voxl stops the launcher and the voxl it started: an
  // Accessibility restart (nobody watching) stops the old process group.
  const denyInput = join(root, "voxl-asset-deny-input");
  voxlWrapper(denyInput, "--from-manifest", "--deny-input");
  voxlAsset = { file: denyInput, sha256: sha(denyInput) };
  await killVoxl();
  r = await request("desktop.ensure", T, {}, 60000);
  const beforeRestart = started().at(-1);
  const parentOf = (pid) =>
    Number(
      readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1],
    );
  const launcherPid = parentOf(beforeRestart.pid);
  r = await request("desktop.ensure", T, {}, 60000);
  await sleep(300);
  const gone = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  check(
    "restarting voxl stops its launcher and the voxl it started",
    r.ok &&
      viaLauncher(beforeRestart) &&
      started().at(-1).pid !== beforeRestart.pid &&
      gone(beforeRestart.pid) &&
      gone(launcherPid),
    JSON.stringify({ r, before: beforeRestart.pid, launcherPid }),
  );
  voxlAsset = undefined;
  launcherAsset = undefined;
  await killVoxl();
  rmSync(app, { recursive: true });
  rmSync(appSource);
  rmSync(voxlFile);

  // macOS has not allowed Screen Recording: failed, with voxl's words.
  voxlWrapper(join(runnerDir, "voxl/bin/voxl"), "--deny-capture");
  await killVoxl();
  r = await request("desktop.ensure", T, {}, 60000);
  check(
    "Screen Recording denied: failed with voxl's log tail, and voxl stopped",
    r.ok &&
      r.result.status === "failed" &&
      r.result.detail.includes("Screen Recording permission is missing") &&
      (await waitFor(() => !alive(started().at(-1).pid), 5000)),
    JSON.stringify(r),
  );
  // A voxl without dx's window-mode patch (the upstream build).
  voxlWrapper(join(runnerDir, "voxl/bin/voxl"), "--no-windows");
  r = await request("desktop.ensure", T, {}, 60000);
  check(
    "once allowed, the next desktop.ensure starts voxl again",
    r.ok && r.result.status === "running",
    JSON.stringify(r),
  );
  r = await request("desktop.windows", T, {});
  check(
    "desktop.windows with a voxl that predates window mode: unsupported",
    r.ok && r.result.ok === false && r.result.unsupported === true,
    JSON.stringify(r),
  );

  // Accessibility not allowed: voxl runs, input is off, and the runner says
  // how to turn it on; reopening (no viewer) starts voxl again to re-check.
  voxlWrapper(join(runnerDir, "voxl/bin/voxl"), "--deny-input");
  await killVoxl();
  r = await request("desktop.ensure", T, {}, 60000);
  check(
    "Accessibility denied: running, with how to turn it on",
    r.ok &&
      r.result.status === "running" &&
      r.result.detail?.includes(
        "System Settings › Privacy & Security › Accessibility",
      ),
    JSON.stringify(r),
  );
  runnerSocket.send({ type: "stream-open", stream: 45, path: "/ws" });
  await nextMessage(45, (m) => m.kind === 0);
  const watched = started().length;
  r = await request("desktop.ensure", T, {}, 60000);
  check(
    "Accessibility denied while someone watches: voxl keeps running",
    r.ok && r.result.status === "running" && started().length === watched,
    JSON.stringify(r),
  );
  toRunner(45, 2, Buffer.from([0x03, 0xe8]));
  await waitFor(
    () => voxlReports.filter((x) => x.event === "closed").length >= 4,
  );
  await sleep(300);
  voxlWrapper(join(runnerDir, "voxl/bin/voxl"));
  r = await request("desktop.ensure", T, {}, 60000);
  check(
    "Accessibility allowed, Desktop reopened: voxl restarts and input is on",
    r.ok &&
      r.result.status === "running" &&
      r.result.detail === undefined &&
      started().length === watched + 1,
    JSON.stringify(r),
  );
  const lastVoxl = started().at(-1).pid;

  r = await request("pause", T, {});
  check(
    "pause: dxd stopped",
    r.ok && (await waitFor(() => dxdPids().length === 0, 5000)) !== undefined,
  );
  r = await request("destroy", T, {});
  check(
    "destroy: folder deleted",
    r.ok && !existsSync(join(dxRoot, "threads", T)),
  );

  // Ctrl-C stops dxd and jobs.
  await request("ensure", T, { existingOnly: false });
  await request(
    "daemon",
    T,
    {
      existingOnly: true,
      endpoint,
      apiKey: `dxd_${randomBytes(24).toString("hex")}`,
    },
    120000,
  );
  await waitFor(() => dxdPids().length === 1);
  const job = request("exec", T, { command: "sleep 314", timeoutMs: 600000 });
  await sleep(500);
  const pid = [
    ...spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).stdout.split(
      "\n",
    ),
  ].find((l) => l.trim().endsWith("sleep 314"));
  const runnerPid = spawnSync("pgrep", ["-f", `${dxRoot} run`], {
    encoding: "utf8",
  })
    .stdout.trim()
    .split("\n")[0];
  process.kill(Number(runnerPid), "SIGINT");
  await sleep(1500);
  const sleeps = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((l) => l.trim() === "sleep 314");
  check(
    "Ctrl-C: runner stops its jobs and every dxd",
    pid && sleeps.length === 0 && dxdPids().length === 0,
    `${sleeps} ${dxdPids()}`,
  );
  check(
    "Ctrl-C: runner stops voxl",
    lastVoxl && (await waitFor(() => !alive(lastVoxl), 5000)),
  );
  void job;

  // A runner started in the foreground (no login service) is still running
  // when the person uninstalls; uninstall stops it.
  startRunner();
  await waitFor(() => runnerSocket !== undefined, 20000);
  const foreground = runnerProcess;
  const un = await cli("uninstall");
  await waitFor(
    () => foreground.exitCode !== null || foreground.signalCode !== null,
    10000,
  );
  check(
    "uninstall: stops a runner running in the foreground",
    foreground.exitCode !== null || foreground.signalCode !== null,
    un.stdout + un.stderr,
  );
  check(
    "uninstall: removes ~/.dx/runner and ~/.dx/threads",
    un.status === 0 &&
      !existsSync(join(dxRoot, "runner")) &&
      !existsSync(join(dxRoot, "threads")),
    un.stdout + un.stderr,
  );
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  for (const p of dxdPids())
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  try {
    runnerProcess?.kill("SIGKILL");
  } catch {}
  server.close();
  rmSync(root, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
console.table(
  results.map(({ name, ok }) => ({
    check: name,
    result: ok ? "pass" : "FAIL",
  })),
);
process.exit(failed.length === 0 ? 0 : 1);
