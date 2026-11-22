import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { sha256Hex } from "../../src/runners/repository.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

// The Desktop of a runner Thread is its owner's whole Mac, through the
// machine's RunnerSessionObject and the runner's own connection. Ways it can
// fail, each covered below:
// - a contributor of a shared runner Thread reaches the owner's Mac through
//   the status check, the window list, or the socket;
// - the window list loses the Mac's windows, passes on an entry that is not
//   a window, asks the Thread's dxd, or reports an old runner or voxl (no
//   window mode) as ready;
// - the status check reports ready when the runner said voxl is missing or
//   failed, or loses the runner's words (the build command, the macOS
//   permission), or retries a runner that is offline;
// - the socket goes to the Thread's dxd (THREAD_EXECUTION) instead of the
//   machine's session, or carries the browser's cookies to the runner;
// - frames are not relayed both ways, text and binary are confused, or a
//   message over one Workers message (a keyframe) is not split and joined;
// - a close on one side does not reach the other;
// - a Thread on an Orb changes: it still goes through THREAD_EXECUTION;
// - the macOS permissions the runner reports are lost or malformed ones
//   pass on;
// - opening System Settings reaches a Mac for a contributor, sends a pane
//   other than the two privacy panes, or hides that the Mac is offline.

const appOrigin = "http://dx.test";
const bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "deployed",
  DX_AUTH_URL: appOrigin,
  DX_AUTH_TRUSTED_ORIGINS: appOrigin,
  BETTER_AUTH_SECRET: "runner-desktop-secret-0000000000000000000",
  RUNNER_SESSION: env.RUNNER_SESSION,
} satisfies Bindings;

let sequence = 0;
const signUp = async (label: string) => {
  sequence += 1;
  const email = `runner-desktop-${label}-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    `${appOrigin}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: appOrigin,
        "cf-connecting-ip": `198.51.100.${(sequence % 200) + 20}`,
      },
      body: JSON.stringify({
        name: `Runner ${label}`,
        email,
        password: "runner-desktop-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/better-auth\.session_token=[^;,]+/)?.[0];
  if (cookie === undefined) throw new Error("Expected a session cookie.");
  const userId = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id");
  if (userId === null) throw new Error("Expected a user.");
  return { cookie, userId: Schema.decodeSync(UserId)(userId) };
};

const createThread = async (ownerUserId: UserId) => {
  sequence += 1;
  const suffix = `${Date.now().toString(16).slice(-8)}${String(sequence).padStart(4, "0")}`;
  const projectEntity = project(
    `prj_00000000-0000-4000-8000-${suffix}`,
    ownerUserId,
    `Runner desktop ${suffix}`,
  );
  const threadEntity = thread(
    `thr_00000000-0000-4000-8000-${suffix}`,
    projectEntity.id as ProjectId,
    ownerUserId,
  );
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(projectEntity);
      yield* (yield* ThreadRepository).insert(threadEntity);
    }),
  );
  return threadEntity.id as string;
};

/** A paired Mac whose Thread `threadId` runs on it. */
const pinToMachine = async (ownerUserId: UserId, threadId: string) => {
  const machineId = `rnm_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const token = `dxr_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    `INSERT INTO runner_machine
       (id, owner_user_id, name, os, arch, version, token_sha256, created_at)
     VALUES (?, ?, 'studio-mac', 'macos', 'aarch64', '0.15.0', ?, ?)`,
  )
    .bind(machineId, ownerUserId, await sha256Hex(token), Date.now())
    .run();
  const pinned = await env.DB.prepare(
    `UPDATE execution_workspace
        SET provider = 'runner', runner_profile_id = 'rn.machine',
            account_scope = 'deployment', provider_template = ?
      WHERE thread_id = ?`,
  )
    .bind(machineId, threadId)
    .run();
  expect(pinned.meta.changes).toBe(1);
  return { machineId, token };
};

/** A binary message's bytes: workerd hands a socket's binary as a Blob. */
const bytes = async (data: unknown) =>
  data instanceof Blob
    ? new Uint8Array(await data.arrayBuffer())
    : new Uint8Array(data as ArrayBuffer);

interface StreamFrame {
  readonly stream: number;
  readonly kind: number;
  readonly payload: Uint8Array;
}

/** A fake `dxd runner` on the Mac: its Desktop is a fake voxl. */
const connectRunner = async (
  token: string,
  ensure: () => Record<string, unknown>,
  windows?: () => Record<string, unknown>,
  settings?: (body: unknown) => Record<string, unknown>,
) => {
  const response = await app.request(
    `${appOrigin}/v1/runner/connect`,
    { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } },
    bindings,
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket as WebSocket;
  socket.accept();
  const ops: string[] = [];
  const bodies: unknown[] = [];
  const opens: Array<Record<string, unknown>> = [];
  const frames: StreamFrame[] = [];
  // Binary messages decode asynchronously (Blob); keep their order.
  let decoded = Promise.resolve();
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      const data = event.data;
      decoded = decoded.then(async () => {
        const frame = await bytes(data);
        const view = new DataView(frame.buffer, frame.byteOffset);
        frames.push({
          stream: view.getUint32(0),
          kind: view.getUint8(4),
          payload: frame.subarray(5),
        });
      });
      return;
    }
    const frame = JSON.parse(event.data) as Record<string, unknown>;
    if (frame.type === "stream-open") opens.push(frame);
    if (frame.type !== "request") return;
    const op = frame.op as string;
    ops.push(op);
    bodies.push(frame.body);
    const result =
      op === "desktop.ensure"
        ? ensure()
        : op === "desktop.health"
          ? { ok: true, status: 200, body: "ok" }
          : op === "desktop.windows"
            ? windows?.()
            : op === "desktop.settings"
              ? settings?.(frame.body)
              : undefined;
    const error =
      result === undefined
        ? { code: "invalid", message: `unknown op ${op}` }
        : result.error;
    socket.send(
      JSON.stringify(
        error !== undefined
          ? { type: "reply", id: frame.id, ok: false, error }
          : { type: "reply", id: frame.id, ok: true, result },
      ),
    );
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      version: "0.15.0",
      os: "macos",
      arch: "aarch64",
      sandbox: "seatbelt",
      threads: [],
    }),
  );
  const send = (stream: number, kind: number, payload: Uint8Array) => {
    const frame = new Uint8Array(5 + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, stream);
    frame[4] = kind;
    frame.set(payload, 5);
    socket.send(frame);
  };
  return { socket, ops, bodies, opens, frames, send };
};

const checkDesktop = (threadId: string, cookie: string, extra?: Bindings) =>
  app.request(
    `${appOrigin}/v1/threads/${threadId}/desktop`,
    { headers: { cookie, accept: "application/json" } },
    { ...bindings, ...extra },
  );

const openSettings = (
  threadId: string,
  cookie: string,
  body: unknown,
  extra?: Bindings,
) =>
  app.request(
    `${appOrigin}/v1/threads/${threadId}/desktop/settings`,
    {
      method: "POST",
      headers: {
        cookie,
        origin: appOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { ...bindings, ...extra },
  );

const openSocket = (threadId: string, cookie: string, extra?: Bindings) =>
  app.request(
    `${appOrigin}/v1/threads/${threadId}/desktop/ws`,
    {
      headers: {
        cookie,
        origin: appOrigin,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    },
    { ...bindings, ...extra },
  );

const waitFor = async <T>(read: () => T | undefined, ms = 5_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const shareWith = async (
  threadId: string,
  owner: UserId,
  member: UserId,
  access: "view" | "contribute",
) => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Runner team', ?, 1)",
    ).bind(`org-${threadId}`, `runner-${threadId.slice(-12)}`),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         (?1 || '-o', ?1, ?2, 'owner', 1), (?1 || '-m', ?1, ?3, 'member', 2)`,
    ).bind(`org-${threadId}`, owner, member),
    env.DB.prepare(
      `UPDATE threads SET shared_workspace_id = ?, workspace_access = ?,
              contribute_until = ? WHERE id = ?`,
    ).bind(
      `org-${threadId}`,
      access,
      new Date(Date.now() + 3_600_000).toISOString(),
      threadId,
    ),
  ]);
};

describe("A runner Thread's Desktop", () => {
  it("relays the owner's Desktop through the machine's runner, both ways", async () => {
    const owner = await signUp("owner");
    const threadId = await createThread(owner.userId);
    const { token } = await pinToMachine(owner.userId, threadId);
    let ensureReply: Record<string, unknown> = {
      status: "missing",
      detail:
        "voxl is not installed on this Mac. Build it there with `cargo install voxl-server --root ~/.dx/runner/voxl`, then open the Desktop again.",
    };
    let windowsReply: Record<string, unknown> | undefined = {
      ok: true,
      windows: [
        {
          id: 7101,
          app: "Simulator",
          bundleId: "com.apple.iphonesimulator",
          title: "iPhone 16 Pro",
          frame: { x: 120, y: 80.5, w: 402, h: 874 },
          display: 1,
        },
        // Not a window: dropped.
        { id: 0, app: "x", bundleId: "", title: "", frame: {}, display: 1 },
        {
          id: 7102,
          app: "qemu-system-aarch64",
          bundleId: "",
          title: "Android Emulator - Pixel_8:5554",
          frame: { x: 700, y: 60, w: 412, h: 915 },
          display: 2,
        },
      ],
    };
    const runner = await connectRunner(
      token,
      () => ensureReply,
      () => windowsReply,
    );
    // A Thread's dxd is never asked: the Desktop is the machine's.
    const threadExecution = {
      idFromName: () => {
        throw new Error("The Thread's dxd was asked for the Mac's Desktop.");
      },
    } as unknown as DurableObjectNamespace;

    const missing = await checkDesktop(threadId, owner.cookie, {
      THREAD_EXECUTION: threadExecution,
    });
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({
      status: "success",
      data: {
        desktop: "unavailable",
        detail: expect.stringContaining(
          "cargo install voxl-server --root ~/.dx/runner/voxl",
        ),
      },
    });
    expect(runner.ops).toEqual(["desktop.ensure"]);

    ensureReply = {
      status: "failed",
      detail:
        "macOS has not allowed voxl to record this Mac's screen.\nERROR voxl: Screen Recording permission is missing",
    };
    await expect(
      (await checkDesktop(threadId, owner.cookie)).json(),
    ).resolves.toMatchObject({
      data: {
        desktop: "unavailable",
        detail: expect.stringContaining("Screen Recording"),
      },
    });

    // The runner's permissions pass on beside its words; Accessibility off
    // still streams.
    ensureReply = {
      status: "failed",
      detail: "macOS has not allowed dx to record this Mac's screen.",
      permissions: { screenRecording: false, accessibility: false },
    };
    await expect(
      (await checkDesktop(threadId, owner.cookie)).json(),
    ).resolves.toEqual({
      status: "success",
      data: {
        desktop: "unavailable",
        detail: "macOS has not allowed dx to record this Mac's screen.",
        permissions: { screenRecording: false, accessibility: false },
      },
    });
    ensureReply = {
      status: "running",
      detail: "Clicks and typing are off.",
      permissions: { screenRecording: true, accessibility: false },
    };
    await expect(
      (await checkDesktop(threadId, owner.cookie)).json(),
    ).resolves.toEqual({
      status: "success",
      data: {
        desktop: "ready",
        detail: "Clicks and typing are off.",
        permissions: { screenRecording: true, accessibility: false },
        startsViewOnly: true,
      },
    });
    // A malformed report is dropped, never passed on.
    ensureReply = {
      status: "failed",
      detail: "voxl stopped",
      permissions: { screenRecording: "no" },
    };
    await expect(
      (await checkDesktop(threadId, owner.cookie)).json(),
    ).resolves.toEqual({
      status: "success",
      data: { desktop: "unavailable", detail: "voxl stopped" },
    });

    ensureReply = { status: "running" };
    await expect(
      (await checkDesktop(threadId, owner.cookie)).json(),
    ).resolves.toEqual({
      status: "success",
      data: { desktop: "ready", startsViewOnly: true },
    });
    expect(runner.ops.slice(-2)).toEqual(["desktop.ensure", "desktop.health"]);

    // Window mode: the Mac's app windows, from the runner, never the
    // Thread's dxd; `windows` (the Linux app row) stays empty.
    const listWindows = () =>
      app.request(
        `${appOrigin}/v1/threads/${threadId}/desktop/windows`,
        { headers: { cookie: owner.cookie } },
        { ...bindings, THREAD_EXECUTION: threadExecution },
      );
    const windows = await listWindows();
    expect(windows.status).toBe(200);
    expect(windows.headers.get("cache-control")).toBe("no-store");
    await expect(windows.json()).resolves.toEqual({
      status: "success",
      data: {
        desktop: "ready",
        windows: [],
        macWindows: [
          {
            id: 7101,
            app: "Simulator",
            bundleId: "com.apple.iphonesimulator",
            title: "iPhone 16 Pro",
            frame: { x: 120, y: 80.5, w: 402, h: 874 },
            display: 1,
          },
          {
            id: 7102,
            app: "qemu-system-aarch64",
            bundleId: "",
            title: "Android Emulator - Pixel_8:5554",
            frame: { x: 700, y: 60, w: 412, h: 915 },
            display: 2,
          },
        ],
      },
    });
    expect(runner.ops.at(-1)).toBe("desktop.windows");
    // A voxl without window mode, voxl not running, and a runner that
    // predates the op.
    windowsReply = { ok: false, unsupported: true, detail: "old voxl" };
    await expect((await listWindows()).json()).resolves.toMatchObject({
      data: { desktop: "unsupported", windows: [] },
    });
    windowsReply = { ok: false, detail: "The Desktop is not running." };
    await expect((await listWindows()).json()).resolves.toEqual({
      status: "success",
      data: { desktop: "unavailable", windows: [] },
    });
    windowsReply = undefined;
    await expect((await listWindows()).json()).resolves.toMatchObject({
      data: { desktop: "unsupported", windows: [] },
    });

    // The viewer's socket: a stream to voxl through the runner.
    const opened = await openSocket(threadId, owner.cookie, {
      THREAD_EXECUTION: threadExecution,
    });
    expect(opened.status).toBe(101);
    const browser = opened.webSocket as WebSocket;
    browser.accept();
    const received: unknown[] = [];
    let browserClosed: { code: number; reason: string } | undefined;
    browser.addEventListener("message", (event) => received.push(event.data));
    browser.addEventListener("close", (event) => {
      browserClosed = { code: event.code, reason: event.reason };
    });
    const open = await waitFor(() => runner.opens[0]);
    expect(open).toEqual({
      type: "stream-open",
      stream: expect.any(Number),
      path: "/ws",
    });
    const stream = open.stream as number;

    // voxl -> browser: text, then a keyframe larger than one message, in
    // fragments the runner marks with 0x80.
    runner.send(stream, 0, new TextEncoder().encode('{"t":"hello"}'));
    await waitFor(() => (received.length >= 1 ? true : undefined));
    expect(received[0]).toBe('{"t":"hello"}');
    const keyframe = new Uint8Array(1_200_000).map((_, i) => i % 251);
    const chunk = 512 * 1024;
    for (let offset = 0; offset < keyframe.byteLength; offset += chunk)
      runner.send(
        stream,
        offset + chunk >= keyframe.byteLength ? 1 : 0x81,
        keyframe.subarray(offset, offset + chunk),
      );
    await waitFor(() => (received.length >= 2 ? true : undefined));
    expect(await bytes(received[1])).toEqual(keyframe);

    // browser -> voxl: text and binary keep their kinds; a large binary
    // crosses in fragments under 1 MiB.
    browser.send('{"t":"ack"}');
    browser.send(new Uint8Array([0x11, 1, 2]));
    const upload = new Uint8Array(700_000).fill(7);
    browser.send(upload);
    await waitFor(() =>
      runner.frames.filter((f) => f.stream === stream).length >= 4
        ? true
        : undefined,
    );
    const toRunner = runner.frames.filter((f) => f.stream === stream);
    expect(new TextDecoder().decode(toRunner[0]?.payload)).toBe('{"t":"ack"}');
    expect(toRunner[0]?.kind).toBe(0);
    expect(toRunner[1]?.kind).toBe(1);
    expect([...(toRunner[1]?.payload ?? [])]).toEqual([0x11, 1, 2]);
    expect(toRunner.slice(2).map((f) => f.kind)).toEqual([0x81, 1]);
    expect(toRunner.slice(2).every((f) => f.payload.byteLength <= chunk)).toBe(
      true,
    );
    expect(
      toRunner.slice(2).reduce((n, f) => n + f.payload.byteLength, 0),
    ).toBe(upload.byteLength);

    // voxl closes: the browser sees its code and reason.
    const close = new Uint8Array([
      0x0f,
      0xa1,
      ...new TextEncoder().encode("bye"),
    ]);
    runner.send(stream, 2, close);
    await waitFor(() => browserClosed);
    expect(browserClosed).toEqual({ code: 4001, reason: "bye" });

    // The viewer leaves: the runner is told to close voxl's socket.
    const second = await openSocket(threadId, owner.cookie);
    const viewer = second.webSocket as WebSocket;
    viewer.accept();
    const secondOpen = await waitFor(() => runner.opens[1]);
    viewer.close(1000, "tab closed");
    const ended = await waitFor(() =>
      runner.frames.find((f) => f.stream === secondOpen.stream && f.kind === 2),
    );
    expect(
      new DataView(ended.payload.buffer, ended.payload.byteOffset).getUint16(0),
    ).toBe(1000);
    expect(new TextDecoder().decode(ended.payload.subarray(2))).toBe(
      "tab closed",
    );

    // The runner disconnects: open viewers end.
    const third = await openSocket(threadId, owner.cookie);
    const lastViewer = third.webSocket as WebSocket;
    lastViewer.accept();
    let lastClosed: number | undefined;
    lastViewer.addEventListener("close", (event) => {
      lastClosed = event.code;
    });
    await waitFor(() => runner.opens[2]);
    runner.socket.close(1000, "lid closed");
    await waitFor(() => lastClosed);
    expect(lastClosed).toBe(1012);
  });

  it("is the owner's only: a contributor of the shared Thread gets 403", async () => {
    const owner = await signUp("shared-owner");
    const member = await signUp("contributor");
    const threadId = await createThread(owner.userId);
    const { token } = await pinToMachine(owner.userId, threadId);
    const runner = await connectRunner(token, () => ({ status: "running" }));
    await shareWith(threadId, owner.userId, member.userId, "contribute");

    for (const response of [
      await checkDesktop(threadId, member.cookie),
      await openSocket(threadId, member.cookie),
      await openSettings(threadId, member.cookie, { pane: "accessibility" }),
      await app.request(
        `${appOrigin}/v1/threads/${threadId}/desktop/windows`,
        { headers: { cookie: member.cookie } },
        bindings,
      ),
    ]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        data: { code: "RUNNER_THREAD_OWNER_ONLY" },
      });
    }
    expect(runner.ops).toEqual([]);
    expect(runner.opens).toEqual([]);
    // The owner still opens it.
    await expect(
      (await checkDesktop(threadId, owner.cookie)).json(),
    ).resolves.toMatchObject({ data: { desktop: "ready" } });
    runner.socket.close(1000, "done");
  });

  it("refuses a Thread owner whose Thread names someone else's machine", async () => {
    const owner = await signUp("machine-owner");
    const other = await signUp("thread-owner");
    const threadId = await createThread(other.userId);
    // A Thread pinned (wrongly) to another person's machine.
    const { token } = await pinToMachine(owner.userId, threadId);
    const runner = await connectRunner(token, () => ({ status: "running" }));
    for (const response of [
      await checkDesktop(threadId, other.cookie),
      await openSocket(threadId, other.cookie),
    ]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        data: { code: "RUNNER_THREAD_OWNER_ONLY" },
      });
    }
    expect(runner.ops).toEqual([]);
    expect(runner.opens).toEqual([]);
    runner.socket.close(1000, "done");
  });

  it("opens System Settings on the owner's Mac at a privacy pane", async () => {
    const owner = await signUp("settings");
    const threadId = await createThread(owner.userId);
    const { token } = await pinToMachine(owner.userId, threadId);
    let settingsReply: Record<string, unknown> = { opened: true };
    const runner = await connectRunner(
      token,
      () => ({ status: "running" }),
      undefined,
      () => settingsReply,
    );
    const threadExecution = {
      idFromName: () => {
        throw new Error("The Thread's dxd was asked to open System Settings.");
      },
    } as unknown as DurableObjectNamespace;

    for (const pane of ["screen-recording", "accessibility"]) {
      const opened = await openSettings(
        threadId,
        owner.cookie,
        { pane },
        { THREAD_EXECUTION: threadExecution },
      );
      expect(opened.status).toBe(200);
      expect(opened.headers.get("cache-control")).toBe("no-store");
      await expect(opened.json()).resolves.toEqual({
        status: "success",
        data: { opened: true },
      });
    }
    expect(runner.ops).toEqual(["desktop.settings", "desktop.settings"]);
    expect(runner.bodies).toEqual([
      { pane: "screen-recording" },
      { pane: "accessibility" },
    ]);

    // Any other pane, or more than a pane, never reaches the Mac.
    for (const body of [
      { pane: "general" },
      {},
      { pane: "accessibility", url: "x-apple.systempreferences:other" },
    ]) {
      const refused = await openSettings(threadId, owner.cookie, body);
      expect(refused.status).toBe(400);
      await expect(refused.json()).resolves.toMatchObject({
        data: { code: "INVALID_REQUEST" },
      });
    }
    expect(runner.ops).toHaveLength(2);

    // The runner's own refusal comes back in its words.
    settingsReply = {
      error: {
        code: "failed",
        message: "System Settings opens only on a Mac runner.",
      },
    };
    await expect(
      (
        await openSettings(threadId, owner.cookie, { pane: "accessibility" })
      ).json(),
    ).resolves.toEqual({
      status: "success",
      data: {
        opened: false,
        detail: "System Settings opens only on a Mac runner.",
      },
    });
    runner.socket.close(1000, "done");
  });

  it("says the Mac is offline when System Settings cannot open", async () => {
    const owner = await signUp("settings-offline");
    const threadId = await createThread(owner.userId);
    await pinToMachine(owner.userId, threadId);
    const response = await openSettings(threadId, owner.cookie, {
      pane: "screen-recording",
    });
    await expect(response.json()).resolves.toEqual({
      status: "success",
      data: { opened: false, detail: "This machine's runner is offline." },
    });
    // A Thread on an Orb has no Mac to open.
    const orbThread = await createThread(owner.userId);
    expect(
      (await openSettings(orbThread, owner.cookie, { pane: "accessibility" }))
        .status,
    ).toBe(404);
  }, 30_000);

  it("reports an offline Mac without asking twice", async () => {
    const owner = await signUp("offline");
    const threadId = await createThread(owner.userId);
    await pinToMachine(owner.userId, threadId);
    const response = await checkDesktop(threadId, owner.cookie);
    await expect(response.json()).resolves.toEqual({
      status: "success",
      data: {
        desktop: "unavailable",
        detail: "This machine's runner is offline.",
      },
    });
  }, 30_000);

  it("leaves a Thread on an Orb on its Thread execution object", async () => {
    const owner = await signUp("orb");
    const member = await signUp("orb-contributor");
    const threadId = await createThread(owner.userId);
    const urls: string[] = [];
    const threadExecution = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (request: Request) => {
          urls.push(request.url);
          return new Response("ok");
        },
      }),
    } as unknown as DurableObjectNamespace;
    await expect(
      (
        await checkDesktop(threadId, owner.cookie, {
          THREAD_EXECUTION: threadExecution,
        })
      ).json(),
    ).resolves.toEqual({ status: "success", data: { desktop: "ready" } });
    // A contributor of a shared Orb Thread still uses its Desktop.
    await shareWith(threadId, owner.userId, member.userId, "contribute");
    await expect(
      (
        await checkDesktop(threadId, member.cookie, {
          THREAD_EXECUTION: threadExecution,
        })
      ).json(),
    ).resolves.toEqual({ status: "success", data: { desktop: "ready" } });
    expect(urls).toEqual([
      "https://thread-execution/proxy/http",
      "https://thread-execution/proxy/http",
    ]);
  });
});
