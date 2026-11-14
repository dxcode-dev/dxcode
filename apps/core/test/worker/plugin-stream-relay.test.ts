import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import {
  PluginBundleRepository,
  type PluginId,
  StoredPluginBundle,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECK_FAILURE_LIMIT_MS,
  STREAM_INTERNAL_ORIGIN,
  STREAM_META_HEADER,
  STREAM_OPENS_PER_MINUTE,
} from "../../src/plugins/streams/relay.js";
import { readPluginBundle } from "../../src/settings/plugins/bundles/read-bundle.js";
import { PluginBundleRepositoryD1 } from "../../src/settings/plugins/bundles/repository-d1.js";
import { readZipArchive } from "../../src/settings/plugins/bundles/zip.js";
import { buildZip } from "../../src/settings/plugins/bundles/zip-fixture.js";

// A stream whose minute check cannot run (D1 keeps failing) must not relay
// forever on trust: it ends once checks have failed for five minutes.

const meta = {
  threadId: "thr_00000000-0000-4000-8000-000000000a01",
  pluginId: "plg_00000000-0000-4000-8000-000000000a01",
  pluginName: "com.example.mirror",
  paneId: "mirror",
  tier: "personal-dev",
  bytesPerSecond: 5_000_000,
  requestId: "relay-check-test",
};

const relay = (name: string) => env.PLUGIN_STREAM_RELAY.getByName(name);

/** A viewer socket on the relay, and the close it hears. */
const viewer = async (name: string) => {
  const response = await relay(name).fetch(`${STREAM_INTERNAL_ORIGIN}/viewer`, {
    headers: {
      upgrade: "websocket",
      [STREAM_META_HEADER]: JSON.stringify(meta),
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Expected a viewer socket.");
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code)),
  );
  socket.accept();
  return { socket, closed };
};

/** Makes every query the check runs fail, as a D1 outage would. */
const breakChecks = () =>
  env.DB.exec("ALTER TABLE threads RENAME TO threads_unavailable");
const restoreChecks = () =>
  env.DB.exec("ALTER TABLE threads_unavailable RENAME TO threads").catch(
    () => undefined,
  );

const stored = (name: string) =>
  runInDurableObject(relay(name), (_instance, state) =>
    state.storage.get<{ checkFailures?: number; checkFailingSince?: number }>(
      "stream",
    ),
  );

describe("plugin stream relay checks", () => {
  afterEach(restoreChecks);

  it("keeps a stream through a failed check, then ends it after five minutes of them", async () => {
    const name = "relay-check-fails";
    const { closed } = await viewer(name);
    await breakChecks();

    // One failed check: the stream goes on, and the failure is counted.
    await runDurableObjectAlarm(relay(name));
    const first = await stored(name);
    expect(first?.checkFailures).toBe(1);
    expect(first?.checkFailingSince).toBeTypeOf("number");

    // Checks have been failing for longer than the limit: the next ends it.
    await runInDurableObject(relay(name), async (_instance, state) => {
      const current =
        await state.storage.get<Record<string, unknown>>("stream");
      await state.storage.put("stream", {
        ...current,
        checkFailingSince: Date.now() - CHECK_FAILURE_LIMIT_MS - 1_000,
      });
    });
    await runDurableObjectAlarm(relay(name));
    expect(await closed).toBe(4403);
  });

  it("clears the failure count once a check runs again", async () => {
    const name = "relay-check-recovers";
    const { socket } = await viewer(name);
    await breakChecks();
    await runDurableObjectAlarm(relay(name));
    expect((await stored(name))?.checkFailures).toBe(1);

    await restoreChecks();
    await runDurableObjectAlarm(relay(name));
    const after = await stored(name);
    expect(after?.checkFailures).toBeUndefined();
    expect(after?.checkFailingSince).toBeUndefined();
    socket.close();
  });
});

// --- Who may keep watching ------------------------------------------------
// A viewer's role is not fixed when its socket opens: every minute the
// relay reads each member's share of the Thread again, and opens are
// bounded.

const memberManifest = JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
  name: "com.example.relay-mirror",
  displayName: "Relay mirror",
  version: "1.0.0",
  description: "A trusted pane for the relay test.",
  extensions: {
    "dev.dxcode": {
      apiVersion: 1,
      entry: "dev.dxcode/index.js",
      permissions: { events: [], ui: ["pane"] },
    },
  },
});

/** An owner, their Thread, and their personal plugin with a pane. */
const ownerWithPlugin = async (sequence: number) => {
  const userId = `usr_relay_owner_${sequence}` as UserId;
  const projectId = `prj_relay_${sequence}`;
  const threadId = `thr_00000000-0000-4000-9000-${String(700 + sequence).padStart(12, "0")}`;
  const timestamp = "2026-11-13T12:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(userId, userId, `${userId}@example.com`),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Relay', ?, ?)",
    ).bind(projectId, userId, timestamp, timestamp),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(threadId, projectId, userId, timestamp, timestamp),
  ]);
  const bundle = await Effect.runPromise(
    readZipArchive(
      await buildZip([
        { name: "plugin.json", content: memberManifest },
        {
          name: "dev.dxcode/index.js",
          content:
            'import { definePlugin } from "@dxcode/plugin";\nexport default definePlugin(() => {});\n',
        },
      ]),
      { maxArchiveBytes: 1024 * 1024, maxEntries: 100 },
    ).pipe(
      Effect.flatMap((archive) =>
        readPluginBundle(archive, { root: "", fallbackName: "fixture" }),
      ),
    ),
  );
  const pluginId =
    `plg_00000000-0000-4000-8000-${String(700 + sequence).padStart(12, "0")}` as PluginId;
  await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* PluginBundleRepository;
      yield* repository.insert(
        Schema.decodeUnknownSync(StoredPluginBundle)({
          id: pluginId,
          target: { scope: "personal", id: userId },
          name: bundle.manifest.name,
          enabled: true,
          version: bundle.version,
          manifest: bundle.manifest,
          source: { type: "zip", label: "fixture.zip" },
          integrity: bundle.integrity,
          installedAt: timestamp,
          installedByUserId: userId,
          updatedAt: timestamp,
        }),
        bundle.codeModules,
      );
    }).pipe(Effect.provide(PluginBundleRepositoryD1(env.DB))),
  );
  return { userId, threadId, pluginId };
};

const viewerOf = async (
  name: string,
  streamMeta: Record<string, unknown>,
  viewerUserId: string,
  viewerIsOwner: boolean,
) => {
  const response = await relay(name).fetch(`${STREAM_INTERNAL_ORIGIN}/viewer`, {
    headers: {
      upgrade: "websocket",
      [STREAM_META_HEADER]: JSON.stringify({
        ...streamMeta,
        viewerUserId,
        viewerIsOwner,
      }),
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Expected a viewer socket.");
  let closedWith: number | undefined;
  socket.addEventListener("close", (event) => {
    closedWith = event.code;
  });
  socket.accept();
  return { socket, closedWith: () => closedWith };
};

describe("plugin stream relay viewers", () => {
  it("cuts off a member who no longer shares the Thread, and keeps its owner", async () => {
    const { userId, threadId, pluginId } = await ownerWithPlugin(1);
    const name = `${threadId}:${pluginId}:mirror`;
    const streamMeta = {
      ...meta,
      threadId,
      pluginId,
      pluginName: "com.example.relay-mirror",
    };
    const owner = await viewerOf(name, streamMeta, userId, true);
    // A member whose share was removed: no grant on the Thread any more.
    const member = await viewerOf(name, streamMeta, "usr_relay_removed", false);
    await runDurableObjectAlarm(relay(name));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(member.closedWith()).toBe(4403);
    expect(owner.closedWith()).toBeUndefined();
    owner.socket.close();
  });

  it("refuses opens past the limit a minute", async () => {
    const name = "relay-open-limit";
    const statuses: number[] = [];
    for (let open = 0; open <= STREAM_OPENS_PER_MINUTE; open++) {
      const response = await relay(name).fetch(
        `${STREAM_INTERNAL_ORIGIN}/viewer`,
        {
          headers: {
            upgrade: "websocket",
            [STREAM_META_HEADER]: JSON.stringify({
              ...meta,
              viewerUserId: "usr_relay_loop",
              viewerIsOwner: true,
            }),
          },
        },
      );
      statuses.push(response.status);
      response.webSocket?.accept();
      response.webSocket?.close();
    }
    expect(
      statuses
        .slice(0, STREAM_OPENS_PER_MINUTE)
        .every((status) => status === 101),
    ).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
