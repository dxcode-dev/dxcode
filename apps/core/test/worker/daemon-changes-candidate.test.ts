import { env, runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import type { ThreadChangesCaptureId } from "@dx/api";
import { ProjectRepository, type ThreadId, ThreadRepository } from "@dx/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { DXD_RELEASE } from "../../src/execution/dxd/protocol.js";
import { loadThreadChangesIndex } from "../../src/thread-changes/capture.js";
import { makeThreadChangesRepository } from "../../src/thread-changes/repository-d1.js";
import { forwardDaemonUpgrade } from "../../src/threads/daemon-ingress.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = "daemon-candidate-owner";
const projectId = "prj_00000000-0000-4000-8000-000000000b01";
const threadId = "thr_00000000-0000-4000-8000-000000000b01" as ThreadId;
const DAEMON_KEY = "dxd_changes-candidate-test-key-0123456789";
const now = "2026-10-23T03:00:00.000Z";

const seed = async () => {
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(owner, "Candidate Owner", "candidate-owner@example.test", now, now)
    .run();
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, owner, "Daemon candidates"),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId, owner),
      );
    }),
  );
  await env.DB.prepare(`
    INSERT INTO thread_source_snapshot (
      thread_id, project_id, binding_revision, provider,
      repository_full_name, clone_url, default_branch, initial_ref,
      initial_commit_sha, created_at
    ) VALUES (?, ?, 1, 'github', 'owner/repository',
      'https://github.com/owner/repository.git', 'main',
      'refs/heads/main', ?, ?)
  `)
    .bind(threadId, projectId, "a".repeat(40), now)
    .run();
  // The daemon's key, as activation mints it: a D1 row Core confirms behind
  // the hash the Thread's execution object keeps with its authority.
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
        generation: 1,
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
  // Restart the object, as eviction does, so it loads the stored authority.
  await runInDurableObject(
    env.THREAD_EXECUTION.getByName(threadId),
    async (_instance, state) => {
      state.abort("reload the daemon authority");
    },
  ).catch(() => undefined);
};

/** A daemon's socket to the Thread's execution object, through the ingress. */
const connectDaemon = async () => {
  const response = await forwardDaemonUpgrade(
    new Request(`https://dxd.test/v1/dxd/${threadId}`, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${DAEMON_KEY}`,
      },
    }),
    env.THREAD_EXECUTION,
    threadId,
  );
  const socket = response.webSocket;
  if (socket === null) throw new Error(`No socket (${response.status}).`);
  socket.accept();
  const messages: Array<{ readonly type: string }> = [];
  let closed: { code: number; reason: string } | undefined;
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") messages.push(JSON.parse(event.data));
  });
  socket.addEventListener("close", (event) => {
    closed = { code: event.code, reason: event.reason };
  });
  return {
    socket,
    messages,
    closed: () => closed,
    waitFor: async (type: string) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (messages.some((message) => message.type === type)) return;
        if (closed !== undefined)
          throw new Error(`Closed: ${closed.code} ${closed.reason}`);
        await new Promise((settle) => setTimeout(settle, 20));
      }
      throw new Error(`No ${type} message.`);
    },
  };
};

describe("a daemon's Changes candidate", () => {
  it("keeps the daemon connected and shows a file whose patch holds NUL bytes as binary", async () => {
    await seed();
    const repository = makeThreadChangesRepository(env.DB);
    const mutation = await repository.beginMutation(threadId, 60_000);
    await mutation.release();

    const daemon = await connectDaemon();
    daemon.socket.send(
      JSON.stringify({
        type: "register",
        protocolMajor: 2,
        release: DXD_RELEASE,
        capabilities: {
          terminal: { version: 1 },
          workloadIdentity: { version: 1 },
          files: { version: 1 },
          proxy: { version: 1 },
          memory: { version: 1 },
        },
      }),
    );
    await daemon.waitFor("registered");

    // A Git bundle opens with a text header, so git diffs it as text and its
    // patch carries NUL bytes (third-party/flue/source.bundle did).
    const fingerprint = "d".repeat(64);
    daemon.socket.send(
      JSON.stringify({
        type: "changes-candidate",
        token: mutation.refreshToken,
        outcome: {
          kind: "complete",
          capture: {
            fingerprint,
            baseline: "a".repeat(40),
            head: "a".repeat(40),
            branch: "main",
            upstreamLabel: null,
            ahead: 0,
            commits: [],
            ranges: [
              {
                range: { kind: "all" },
                truncated: false,
                summary: { additions: 3, deletions: 1, files: 2 },
                files: [
                  {
                    path: "third-party/flue/source.bundle",
                    status: "modified",
                    additions: 2,
                    deletions: 1,
                    binary: false,
                    truncated: true,
                    patch:
                      "diff --git a/third-party/flue/source.bundle b/third-party/flue/source.bundle\n@@ -1 +1,2 @@\n-# v2 git bundle\n+# v2 git bundle\n+PACK\u0000\u0000\u0000\u0002\n",
                  },
                  {
                    path: "notes.txt",
                    status: "modified",
                    additions: 1,
                    deletions: 0,
                    binary: false,
                    truncated: false,
                    patch: "@@ -1 +1,2 @@\n line\n+added\n",
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    // The capture publishes; the connection stays up.
    let captureId: ThreadChangesCaptureId | undefined;
    for (
      let attempt = 0;
      attempt < 100 && captureId === undefined;
      attempt += 1
    ) {
      const state = await repository.read(threadId);
      if (state?.latestFingerprint === fingerprint)
        captureId = state.latestCaptureId;
      else await new Promise((settle) => setTimeout(settle, 20));
      expect(daemon.closed()).toBeUndefined();
    }
    if (captureId === undefined)
      throw new Error("The capture never published.");
    const index = await loadThreadChangesIndex(
      env.DX_STORAGE,
      threadId,
      captureId,
    );
    const files = index.ranges[0]?.files ?? [];
    expect(
      files.map(({ path, binary, additions, deletions, patch }) => ({
        path,
        binary,
        additions,
        deletions,
        patchBytes: patch.length,
      })),
    ).toEqual([
      {
        path: "third-party/flue/source.bundle",
        binary: true,
        additions: 2,
        deletions: 1,
        patchBytes: 0,
      },
      {
        path: "notes.txt",
        binary: false,
        additions: 1,
        deletions: 0,
        patchBytes: new TextEncoder().encode("@@ -1 +1,2 @@\n line\n+added\n")
          .byteLength,
      },
    ]);
    expect(daemon.closed()).toBeUndefined();
    daemon.socket.close(1000, "done");
  });

  it("drops a candidate Core cannot read without dropping the daemon", async () => {
    await seed();
    const repository = makeThreadChangesRepository(env.DB);
    const mutation = await repository.beginMutation(threadId, 60_000);
    await mutation.release();
    const daemon = await connectDaemon();
    daemon.socket.send(
      JSON.stringify({
        type: "register",
        protocolMajor: 2,
        release: DXD_RELEASE,
        capabilities: {
          terminal: { version: 1 },
          workloadIdentity: { version: 1 },
          files: { version: 1 },
          proxy: { version: 1 },
          memory: { version: 1 },
        },
      }),
    );
    await daemon.waitFor("registered");
    daemon.socket.send(
      JSON.stringify({
        type: "changes-candidate",
        token: mutation.refreshToken,
        outcome: { kind: "complete", capture: { fingerprint: "not-hex" } },
      }),
    );
    // The daemon's next message is still served on the same connection.
    daemon.socket.send(JSON.stringify({ type: "changes-dirty" }));
    await new Promise((settle) => setTimeout(settle, 500));
    expect(daemon.closed()).toBeUndefined();
    expect(
      (await repository.read(threadId))?.latestFingerprint,
    ).toBeUndefined();
    daemon.socket.close(1000, "done");
  });
});
