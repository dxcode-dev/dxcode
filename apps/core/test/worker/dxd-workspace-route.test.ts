/**
 * The agent's workspace route through dxd, end to end inside Core: the
 * route choice, the Thread execution object, and the guest client, against
 * a fake daemon on a real socket that keeps files in memory.
 *
 * Ways it could fail (tasks/dxd-workspace-route.md):
 * - the flag off still reaches dxd, or the flag on never does;
 * - a daemon without the `sandbox` capability takes requests it can't serve;
 * - file bytes are corrupted crossing as text, or a file larger than one
 *   frame is truncated or misassembled (writes `DXW1`, reads `DXF1`);
 * - a command whose env passes the request frame bound is refused;
 * - output too large to answer inline is lost;
 * - a command resent after the daemon reconnects gets a new `execId`, so
 *   dxd would run it twice;
 * - an operation dxd may have received runs again on the provider.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import {
  DXD_WORKSPACE_ROUTE_FEATURE_ID,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
} from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DXD_RELEASE } from "../../src/execution/dxd/protocol.js";
import {
  DxdRouteUnavailable,
  type DxdSandboxTransport,
  dxdGuestClient,
  dxdRoutedSandbox,
  threadSandboxTransport,
} from "../../src/execution/guest/dxd-guest-client.js";
import {
  chooseWorkspaceSandboxRoute,
  dxdWorkspaceRouteOn,
} from "../../src/execution/guest/workspace-route.js";
import { DaemonUnavailable } from "../../src/threads/daemon-client.js";
import { forwardDaemonUpgrade } from "../../src/threads/daemon-ingress.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = "dxd-route-owner";
const projectId = "prj_00000000-0000-4000-8000-000000000c01";
const threadId = "thr_00000000-0000-4000-8000-000000000c01" as ThreadId;
const DAEMON_KEY = "dxd_workspace-route-test-key-0123456789";
const now = "2026-11-20T03:00:00.000Z";

const seed = async (flag: boolean | undefined) => {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(owner, "Route Owner", "route-owner@example.test", now, now)
    .run();
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, owner, "dxd route"),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId, owner),
      );
    }),
  );
  if (flag !== undefined)
    await env.DB.prepare(
      `INSERT OR REPLACE INTO personal_experimental_feature_preferences
         (user_id, preferences, revision, updated_at) VALUES (?, ?, 1, ?)`,
    )
      .bind(
        owner,
        JSON.stringify([{ id: DXD_WORKSPACE_ROUTE_FEATURE_ID, enabled: flag }]),
        now,
      )
      .run();
  const keyId = `key-${threadId}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO apikey
       (id, configId, referenceId, key, enabled, createdAt, updatedAt)
     VALUES (?, 'daemon-keys', ?, 'hashed', 1, ?, ?)`,
  )
    .bind(keyId, owner, Date.now(), Date.now())
    .run();
  await runInDurableObject(
    env.THREAD_EXECUTION.getByName(threadId),
    async (_instance, state) => {
      await state.storage.put("daemon-authority", {
        threadId,
        generation: "route-generation-1",
        apiKeyId: keyId,
        apiKeyHash: createHash("sha256").update(DAEMON_KEY).digest("hex"),
        release: DXD_RELEASE,
        protocolMajor: 2,
        terminalVersion: 1,
        workloadIdentityVersion: 1,
        runtimeProvider: "e2b",
        runtimeAssurance: "dx_dxd_channel_v1",
      });
    },
  );
  await runInDurableObject(
    env.THREAD_EXECUTION.getByName(threadId),
    async (_instance, state) => {
      state.abort("reload the daemon authority");
    },
  ).catch(() => undefined);
};

interface RequestFrame {
  readonly type: "request";
  readonly generation: string;
  readonly requestId: string;
  readonly operation: Record<string, unknown> & { readonly operation: string };
}

const SANDBOX_CAPABILITIES = {
  terminal: { version: 1 },
  workloadIdentity: { version: 1 },
  files: { version: 1 },
  sandbox: { version: 1 },
};

/** `DXF1 | u32 BE header length | JSON header | raw bytes`. */
const chunkFrame = (header: object, bytes: Uint8Array) => {
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(8 + encoded.byteLength + bytes.byteLength);
  frame.set([0x44, 0x58, 0x46, 0x31]);
  new DataView(frame.buffer).setUint32(4, encoded.byteLength);
  frame.set(encoded, 8);
  frame.set(bytes, 8 + encoded.byteLength);
  return frame;
};

/** `DXW1 | u32 BE JSON length | JSON request frame | raw bytes`. */
const splitWriteFrame = (data: ArrayBuffer) => {
  const bytes = new Uint8Array(data);
  expect([...bytes.subarray(0, 4)]).toEqual([0x44, 0x58, 0x57, 0x31]);
  const length = new DataView(data).getUint32(4);
  return {
    frame: JSON.parse(
      new TextDecoder().decode(bytes.subarray(8, 8 + length)),
    ) as RequestFrame,
    payload: bytes.slice(8 + length),
  };
};

const VERSION = `sha256:${"e".repeat(64)}`;

/**
 * A daemon on a real socket through the ingress. It keeps files in memory,
 * answers commands from `commands`, and records every request it got.
 */
const connectDaemon = async (
  capabilities: Record<string, unknown> = SANDBOX_CAPABILITIES,
) => {
  const response = await forwardDaemonUpgrade(
    new Request(`https://dxd.test/v1/dxd/${threadId}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${DAEMON_KEY}` },
    }),
    env.THREAD_EXECUTION,
    threadId,
  );
  const socket = response.webSocket;
  if (socket === null) throw new Error(`No socket (${response.status}).`);
  socket.accept();
  let generation = "";
  const daemon = {
    socket,
    requests: [] as Array<RequestFrame & { readonly payloadBytes?: number }>,
    files: new Map<string, Uint8Array>(),
    staged: new Map<string, Uint8Array>(),
    outputs: new Map<string, Uint8Array>(),
    /** Answer a command, or `undefined` to leave it unanswered. */
    exec: (
      _operation: Record<string, unknown>,
    ): Record<string, unknown> | undefined => ({
      kind: "exec",
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
    }),
    respond: (requestId: string, result: unknown) =>
      socket.send(
        JSON.stringify({ type: "response", generation, requestId, result }),
      ),
  };
  const sendChunk = (requestId: string, bytes: Uint8Array, offset: number) => {
    const length = Math.max(0, bytes.byteLength - offset);
    const slice = bytes.subarray(offset, offset + Math.min(length, 4 << 20));
    for (let start = 0; start < slice.byteLength || start === 0; ) {
      const piece = slice.subarray(start, start + 256 * 1024);
      socket.send(
        chunkFrame(
          {
            generation,
            requestId,
            version: VERSION,
            sizeBytes: bytes.byteLength,
            offset: offset + start,
          },
          piece,
        ),
      );
      start += piece.byteLength;
      if (piece.byteLength === 0) break;
    }
  };
  const handle = (frame: RequestFrame, payload?: Uint8Array) => {
    daemon.requests.push({
      ...frame,
      ...(payload === undefined ? {} : { payloadBytes: payload.byteLength }),
    });
    const operation = frame.operation;
    const path = operation.path as string;
    switch (operation.operation) {
      case "sandbox.exec": {
        const result = daemon.exec(
          operation.staged === true
            ? {
                ...operation,
                ...JSON.parse(
                  new TextDecoder().decode(
                    daemon.staged.get(operation.execId as string),
                  ),
                ),
              }
            : operation,
        );
        if (result !== undefined) daemon.respond(frame.requestId, result);
        return;
      }
      case "sandbox.stage": {
        const before =
          daemon.staged.get(operation.execId as string) ?? new Uint8Array();
        const next = new Uint8Array(
          (operation.offset as number) + (payload?.byteLength ?? 0),
        );
        next.set(before.subarray(0, operation.offset as number));
        next.set(payload ?? new Uint8Array(), operation.offset as number);
        daemon.staged.set(operation.execId as string, next);
        daemon.respond(frame.requestId, { kind: "staged" });
        return;
      }
      case "sandbox.output":
        sendChunk(
          frame.requestId,
          daemon.outputs.get(
            `${operation.execId}:${operation.stream}`,
          ) as Uint8Array,
          operation.offset as number,
        );
        return;
      case "sandbox.read": {
        const content = daemon.files.get(path);
        if (content === undefined)
          daemon.respond(frame.requestId, {
            kind: "failure",
            code: "not-found",
            message: "No such file or directory (os error 2)",
          });
        else sendChunk(frame.requestId, content, operation.offset as number);
        return;
      }
      case "sandbox.write": {
        const key = `upload:${operation.upload}`;
        const staged = daemon.staged.get(key) ?? new Uint8Array();
        const next = new Uint8Array(operation.sizeBytes as number);
        next.set(staged.subarray(0, next.byteLength));
        next.set(payload ?? new Uint8Array(), operation.offset as number);
        daemon.staged.set(key, next);
        if (operation.last === true) {
          daemon.files.set(path, next);
          daemon.respond(frame.requestId, { kind: "written" });
        } else daemon.respond(frame.requestId, { kind: "staged" });
        return;
      }
      case "sandbox.stat": {
        const content = daemon.files.get(path);
        daemon.respond(
          frame.requestId,
          content === undefined
            ? { kind: "missing" }
            : {
                kind: "stat",
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
                sizeBytes: content.byteLength,
              },
        );
        return;
      }
      case "sandbox.readdir":
        daemon.respond(frame.requestId, {
          kind: "entries",
          names: [...daemon.files.keys()]
            .filter((name) => name.startsWith(`${path}/`))
            .map((name) => name.slice(path.length + 1))
            .filter((name) => !name.includes("/")),
        });
        return;
      case "sandbox.mkdir":
        daemon.respond(frame.requestId, { kind: "done" });
        return;
      case "sandbox.rm":
        daemon.respond(
          frame.requestId,
          daemon.files.delete(path) || operation.force === true
            ? { kind: "done" }
            : {
                kind: "failure",
                code: "not-found",
                message: "No such file or directory (os error 2)",
              },
        );
        return;
    }
  };
  let registered: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    registered = resolve;
  });
  // Messages are handled in order; a binary one may arrive as a Blob.
  let queue = Promise.resolve();
  socket.addEventListener("message", (event) => {
    queue = queue.then(() => receive(event.data));
  });
  const receive = async (data: unknown) => {
    if (typeof data !== "string") {
      const buffer =
        data instanceof Blob
          ? await data.arrayBuffer()
          : ArrayBuffer.isView(data)
            ? data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength,
              )
            : (data as ArrayBuffer);
      const { frame, payload } = splitWriteFrame(buffer as ArrayBuffer);
      expect(frame.generation).toBe(generation);
      handle(frame, payload);
      return;
    }
    const message = JSON.parse(data);
    if (message.type === "registered") {
      generation = message.generation;
      registered();
      // A live daemon heartbeats; the route needs a fresh one.
      const beat = setInterval(() => {
        try {
          socket.send(
            JSON.stringify({
              type: "heartbeat",
              generation,
              terminal: {
                terminalVersion: 1,
                terminal: "default",
                state: "absent",
              },
            }),
          );
        } catch {
          clearInterval(beat);
        }
      }, 1_000);
      socket.addEventListener("close", () => clearInterval(beat));
    }
    if (message.type === "readiness-ping")
      socket.send(JSON.stringify({ ...message, type: "readiness-pong" }));
    if (message.type === "request") handle(message);
  };
  socket.send(
    JSON.stringify({
      type: "register",
      protocolMajor: 2,
      release: DXD_RELEASE,
      capabilities,
    }),
  );
  await ready;
  return daemon;
};

const providerSandbox = (calls: Array<string>) =>
  new Proxy(
    {},
    {
      // Not a thenable: the routed sandbox awaits it.
      get: (_target, method: string) =>
        method === "then"
          ? undefined
          : async (..._args: Array<unknown>) => {
              calls.push(method);
              return method === "exec"
                ? { stdout: "provider\n", stderr: "", exitCode: 0 }
                : undefined;
            },
    },
  ) as Sandbox;

const bytes = (size: number, seed: number) => {
  const content = new Uint8Array(size);
  for (let index = 0; index < size; index += 1)
    content[index] = (index * 31 + seed) % 256;
  return content;
};

/**
 * Byte equality without a deep-equal walk, which would stall this isolate
 * (and the fake daemon's heartbeats) for seconds on megabytes.
 */
const sameBytes = (left: Uint8Array | undefined, right: Uint8Array) =>
  left !== undefined &&
  left.byteLength === right.byteLength &&
  left.every((value, index) => value === right[index]);

let daemons: Array<{ readonly socket: WebSocket }> = [];
afterEach(() => {
  for (const daemon of daemons) daemon.socket.close(1000, "done");
  daemons = [];
});

describe("the dxd workspace route", () => {
  it("runs the agent's commands and file access through dxd when the owner turned it on", async () => {
    await seed(true);
    const daemon = await connectDaemon();
    daemons.push(daemon);
    const route = await chooseWorkspaceSandboxRoute({
      bindings: env,
      threadId,
      provider: "e2b",
      flag: dxdWorkspaceRouteOn(env.DB, threadId),
      waitMs: 2_000,
    });
    expect(route).toEqual({ route: "dxd", release: DXD_RELEASE });

    const providerCalls: Array<string> = [];
    const sandbox = dxdRoutedSandbox({
      client: dxdGuestClient(threadSandboxTransport(env, threadId)),
      cwd: "/home/user/workspace/repo",
      provider: async () => providerSandbox(providerCalls),
      onFallback: (operation) => providerCalls.push(`fallback:${operation}`),
    });

    // A 2.5 MB binary write crosses as three raw `DXW1` chunks.
    const written = bytes(2_500_000, 7);
    await sandbox.writeFile("big.bin", written);
    const writes = daemon.requests.filter(
      (request) => request.operation.operation === "sandbox.write",
    );
    expect(
      writes.map(({ operation, payloadBytes }) => ({
        path: operation.path,
        offset: operation.offset,
        last: operation.last,
        payloadBytes,
      })),
    ).toEqual([
      {
        path: "/home/user/workspace/repo/big.bin",
        offset: 0,
        last: false,
        payloadBytes: 1_048_576,
      },
      {
        path: "/home/user/workspace/repo/big.bin",
        offset: 1_048_576,
        last: false,
        payloadBytes: 1_048_576,
      },
      {
        path: "/home/user/workspace/repo/big.bin",
        offset: 2_097_152,
        last: true,
        payloadBytes: 402_848,
      },
    ]);
    expect(
      sameBytes(daemon.files.get("/home/user/workspace/repo/big.bin"), written),
    ).toBe(true);

    // A 5 MB file reads back in two ranges, byte for byte.
    const large = bytes(5 * 1024 * 1024 + 3, 11);
    daemon.files.set("/home/user/large.bin", large);
    expect(
      sameBytes(await sandbox.readFileBuffer("/home/user/large.bin"), large),
    ).toBe(true);
    expect(
      daemon.requests
        .filter((request) => request.operation.operation === "sandbox.read")
        .map(({ operation }) => [operation.offset, operation.length]),
    ).toEqual([
      [0, 4 * 1024 * 1024],
      [4 * 1024 * 1024, 1024 * 1024 + 3],
    ]);
    await expect(sandbox.readFile("missing.txt")).rejects.toThrow(
      /^ENOENT: .*open '\/home\/user\/workspace\/repo\/missing.txt'$/,
    );

    // A command carries its cwd and env; its answer is the command's.
    daemon.exec = (operation) => ({
      kind: "exec",
      exitCode: 3,
      timedOut: false,
      stdout: `${operation.cwd} ${(operation.env as Record<string, string>).NAME}\n`,
      stderr: "warning\n",
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    await expect(
      sandbox.exec("echo", { cwd: "sub", env: { NAME: "value" } }),
    ).resolves.toEqual({
      stdout: "/home/user/workspace/repo/sub value\n",
      stderr: "warning\n",
      exitCode: 3,
    });

    // Output too large to answer inline is read from dxd's output file.
    const output = new TextEncoder().encode("line\n".repeat(1_000_000));
    daemon.exec = (operation) => {
      daemon.outputs.set(`${operation.execId}:stdout`, output);
      return {
        kind: "exec",
        exitCode: 0,
        timedOut: false,
        stdout: null,
        stderr: "",
        stdoutBytes: output.byteLength,
        stderrBytes: 0,
      };
    };
    const big = await sandbox.exec("yes line | head -n 1000000");
    expect(big.stdout).toBe("line\n".repeat(1_000_000));

    // An env past the request frame crosses staged, then runs.
    daemon.exec = (operation) => ({
      kind: "exec",
      exitCode: 0,
      timedOut: false,
      stdout: `${(operation.env as Record<string, string>).LARGE.length}\n`,
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    const staged = await sandbox.exec("printenv LARGE | wc -c", {
      env: { LARGE: "x".repeat(2_500_000) },
    });
    expect(staged.stdout).toBe("2500000\n");
    const stagedExec = daemon.requests.at(-1)?.operation;
    expect(stagedExec).toMatchObject({
      operation: "sandbox.exec",
      staged: true,
    });
    expect(stagedExec?.command).toBeUndefined();

    await expect(sandbox.stat("big.bin")).resolves.toEqual({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    });
    await expect(sandbox.exists("big.bin")).resolves.toBe(true);
    await expect(sandbox.exists("absent")).resolves.toBe(false);
    await expect(sandbox.readdir("/home/user")).resolves.toEqual(["large.bin"]);
    await sandbox.mkdir("nested/dir", { recursive: true });
    await sandbox.rm("big.bin");
    await expect(sandbox.rm("big.bin")).rejects.toThrow(/^ENOENT/);
    await sandbox.rm("big.bin", { force: true });
    expect(providerCalls).toEqual([]);
  });

  it("keeps the provider route when the flag is off or the daemon predates the route", async () => {
    await seed(false);
    expect(
      await chooseWorkspaceSandboxRoute({
        bindings: env,
        threadId,
        provider: "e2b",
        flag: dxdWorkspaceRouteOn(env.DB, threadId),
      }),
    ).toEqual({ route: "provider", reason: "flag-off" });
    expect(
      await chooseWorkspaceSandboxRoute({
        bindings: env,
        threadId,
        provider: "local",
        flag: Promise.resolve(true),
      }),
    ).toEqual({ route: "provider", reason: "unsupported" });
    expect(
      await chooseWorkspaceSandboxRoute({
        bindings: env,
        threadId,
        provider: "runner",
        flag: Promise.resolve(true),
      }),
    ).toEqual({ route: "provider", reason: "unsupported" });

    const older = await connectDaemon({
      terminal: { version: 1 },
      workloadIdentity: { version: 1 },
      files: { version: 1 },
    });
    daemons.push(older);
    expect(
      await chooseWorkspaceSandboxRoute({
        bindings: env,
        threadId,
        provider: "e2b",
        flag: Promise.resolve(true),
        waitMs: 600,
      }),
    ).toEqual({ route: "provider", reason: "outdated" });
    // A request that reaches it anyway is refused, never sent.
    const client = dxdGuestClient(threadSandboxTransport(env, threadId));
    await expect(client.exists("/home/user")).rejects.toBeInstanceOf(
      DxdRouteUnavailable,
    );
    expect(older.requests).toEqual([]);
  });

  it("resends a command with the same execId after the daemon reconnects", async () => {
    await seed(true);
    const first = await connectDaemon();
    first.exec = () => undefined;
    const client = dxdGuestClient(threadSandboxTransport(env, threadId));
    const run = client.exec("long-running", { timeoutMs: 60_000 });
    for (let turn = 0; turn < 200 && first.requests.length === 0; turn += 1)
      await new Promise((settle) => setTimeout(settle, 10));
    const sent = first.requests[0];
    expect(sent?.operation.operation).toBe("sandbox.exec");
    // The daemon restarts mid-command.
    first.socket.close(1012, "restart");

    const second = await connectDaemon();
    daemons.push(second);
    second.exec = () => ({
      kind: "exec",
      exitCode: 7,
      timedOut: false,
      stdout: "late\n",
      stderr: "",
      stdoutBytes: 5,
      stderrBytes: 0,
    });
    await expect(run).resolves.toEqual({
      stdout: "late\n",
      stderr: "",
      exitCode: 7,
      timedOut: false,
    });
    const resent = second.requests.find(
      (request) => request.operation.operation === "sandbox.exec",
    );
    expect(resent?.requestId).toBe(sent?.requestId);
    expect(resent?.operation.execId).toBe(sent?.operation.execId);
  });

  it("runs on the provider only what dxd never received", async () => {
    const fallbacks: Array<string> = [];
    const providerCalls: Array<string> = [];
    const routed = (transport: DxdSandboxTransport) =>
      dxdRoutedSandbox({
        client: dxdGuestClient(transport),
        cwd: "/home/user",
        provider: async () => providerSandbox(providerCalls),
        onFallback: (operation) => fallbacks.push(operation),
      });
    const unavailable = (outcome: "known" | "unknown") =>
      new DaemonUnavailable({
        message: "Thread daemon is unavailable.",
        outcome,
      });

    // Never dispatched: the provider runs it.
    let attempts = 0;
    const never = routed({
      request: async () => {
        attempts += 1;
        throw unavailable("known");
      },
    });
    await expect(never.exec("true")).resolves.toMatchObject({
      stdout: "provider\n",
    });
    expect(attempts).toBe(3);
    expect(fallbacks).toEqual(["exec"]);
    expect(providerCalls).toEqual(["exec"]);

    // Lost after dispatch: resent with the same execId, never the provider.
    const execIds: Array<unknown> = [];
    const flaky = routed({
      request: async (operation) => {
        execIds.push((operation as { execId?: unknown }).execId);
        if (execIds.length === 1) throw unavailable("unknown");
        return {
          kind: "exec",
          exitCode: 0,
          timedOut: false,
          stdout: "dxd\n",
          stderr: "",
          stdoutBytes: 4,
          stderrBytes: 0,
        };
      },
    });
    await expect(flaky.exec("true")).resolves.toMatchObject({
      stdout: "dxd\n",
    });
    expect(new Set(execIds).size).toBe(1);

    // Dispatched once, then unreachable: it fails, it does not run twice.
    let calls = 0;
    const gone = routed({
      request: async () => {
        calls += 1;
        throw unavailable(calls === 1 ? "unknown" : "known");
      },
    });
    await expect(gone.exec("true")).rejects.toThrow(/may still be running/);
    expect(providerCalls).toEqual(["exec"]);
  });

  // Review of PR #2305. Ways it could fail: a command whose large output
  // cannot be fetched runs again on the provider; a file that keeps changing
  // comes back as a silent prefix; a command dxd could not even start is
  // treated as possibly run; a request dx itself refuses is retried as
  // "may still be running"; Stop leaves the command running on dxd.
  it("never runs a command twice, and reports what did not run as such", async () => {
    const providerCalls: Array<string> = [];
    const routed = (transport: DxdSandboxTransport) =>
      dxdRoutedSandbox({
        client: dxdGuestClient(transport),
        cwd: "/home/user",
        provider: async () => providerSandbox(providerCalls),
        onFallback: () => undefined,
      });
    const unavailable = (outcome: "known" | "unknown") =>
      new DaemonUnavailable({
        message: "Thread daemon is unavailable.",
        outcome,
      });

    // The command ran; reading its 2 MB of output failed before dispatch.
    const ranOnce = routed({
      request: async (operation) => {
        if (operation.operation === "sandbox.output")
          throw unavailable("known");
        return {
          kind: "exec",
          exitCode: 0,
          timedOut: false,
          stdout: null,
          stderr: "",
          stdoutBytes: 2_000_000,
          stderrBytes: 0,
        };
      },
    });
    await expect(ranOnce.exec("pnpm build")).rejects.toThrow(
      /^The command ran \(exit 0\); its stdout could not be read/,
    );
    expect(providerCalls).toEqual([]);

    // A file that changes on every read is an error, never a prefix.
    let reads = 0;
    const changing = routed({
      request: async (operation) => {
        reads += 1;
        const offset = (operation as { offset: number }).offset;
        return {
          kind: "sandbox-chunk",
          version: `sha256:${String(reads % 10).repeat(64)}`,
          sizeBytes: 6 * 1024 * 1024,
          offset,
          bytes: new Uint8Array(
            Math.min(4 * 1024 * 1024, 6 * 1024 * 1024 - offset),
          ),
        };
      },
    });
    await expect(changing.readFileBuffer("/home/user/log")).rejects.toThrow(
      /^EIO: the file kept changing while it was read, open/,
    );
    expect(providerCalls).toEqual([]);

    // dxd could not prepare the command (a full disk): it never started,
    // so the provider runs it.
    const notStarted = routed({
      request: async () => ({
        kind: "failure",
        code: "not-started",
        message: "No space left on device (os error 28)",
      }),
    });
    await expect(notStarted.exec("rm -rf node_modules")).resolves.toMatchObject(
      { stdout: "provider\n" },
    );
    expect(providerCalls).toEqual(["exec"]);

    // A request dx refuses is answered as invalid at once, not retried.
    const client = dxdGuestClient(threadSandboxTransport(env, threadId));
    const started = Date.now();
    await expect(client.stat(`/${"a".repeat(5_000)}`)).rejects.toThrow(
      /^EINVAL: /,
    );
    expect(Date.now() - started).toBeLessThan(1_000);

    // Stop: the abort reaches dxd as a cancel of the same command.
    const sent: Array<Record<string, unknown>> = [];
    let finish: (value: unknown) => void = () => undefined;
    const stoppable = dxdGuestClient({
      request: (operation) => {
        sent.push(operation as Record<string, unknown>);
        if (operation.operation === "sandbox.exec")
          return new Promise((resolve) => {
            finish = resolve as (value: unknown) => void;
          });
        return Promise.resolve({ kind: "done" });
      },
    });
    const stop = new AbortController();
    const running = stoppable.exec("sleep 600", { signal: stop.signal });
    await new Promise((settle) => setTimeout(settle, 10));
    stop.abort();
    await new Promise((settle) => setTimeout(settle, 10));
    expect(sent.map(({ operation }) => operation)).toEqual([
      "sandbox.exec",
      "sandbox.cancel",
    ]);
    expect(sent[1]?.execId).toBe(sent[0]?.execId);
    finish({
      kind: "exec",
      exitCode: 143,
      timedOut: false,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    await expect(running).resolves.toMatchObject({ exitCode: 143 });
  });
});
