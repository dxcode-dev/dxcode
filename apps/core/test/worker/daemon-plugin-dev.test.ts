/**
 * `dxd plugin dev` through the real Thread execution object (#2399). The
 * ingress streams the body through unread, so the object holds the cap,
 * and only after the key checks out. Ways it could fail, each checked
 * below:
 * - a body over the cap is read whole once the key checks out;
 * - a key for another Thread gets past the object;
 * - a folder within the cap no longer reaches the reload.
 */
import { ProjectRepository, ThreadRepository, UserId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  forwardDaemonPluginDev,
  MAX_PLUGIN_DEV_BODY_BYTES,
} from "../../src/threads/daemon-ingress.js";
import { chunkedBody } from "./chunked-body.js";
import { project, thread } from "./fixtures.js";
import {
  DAEMON_KEY,
  seedDaemonAuthority,
  wokenNamespace,
} from "./r2-harness.js";
import { runRepositories } from "./runtime.js";

const owner = Schema.decodeSync(UserId)("plugin-dev-owner");
const projectEntity = project(
  "prj_00000000-0000-4000-8000-000000002399",
  owner,
  "Plugin dev",
);
const threadEntity = thread(
  "thr_00000000-0000-4000-8000-000000002399",
  projectEntity.id,
  owner,
);

const seed = async () => {
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(projectEntity);
      yield* (yield* ThreadRepository).insert(threadEntity);
    }),
  );
  await seedDaemonAuthority(threadEntity.id, owner);
};

const pluginDev = (body: BodyInit, key = DAEMON_KEY) =>
  forwardDaemonPluginDev(
    new Request(`https://dxd.test/v1/dxd/${threadEntity.id}/plugin-dev`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body,
    }),
    wokenNamespace({}),
    threadEntity.id,
  );

describe("dxd plugin dev", () => {
  it("holds the body cap in the Thread execution object, after the key (#2399)", async () => {
    await seed();

    const over = chunkedBody({
      totalBytes: MAX_PLUGIN_DEV_BODY_BYTES + 64 * 1024,
      chunkBytes: 64 * 1024,
    });
    const refused = await pluginDev(over.stream);
    expect(refused.status).toBe(413);

    const stranger = await pluginDev(
      JSON.stringify({ folder: "/tmp/p", files: [] }),
      "dxd_not-this-threads-key-0123456789",
    );
    expect(stranger.status).toBe(401);

    // Within the cap, the folder reaches the reload, which judges it.
    const invalid = await pluginDev(JSON.stringify({ folder: 1 }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ outcome: "invalid" });
  });
});
