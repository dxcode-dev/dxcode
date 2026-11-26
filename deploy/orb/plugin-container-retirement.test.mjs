import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertApprovedDurableObjectDeletion } from "../../scripts/approved-durable-object-deletions.mjs";
import {
  orbWorkerConfig,
  PLUGIN_CONTAINER_DELETION_TAG,
  pluginContainerRetirement,
} from "./containers.mjs";

/**
 * Deleting the retired plugin container class from a stage's Orb Worker
 * (wiki/release-operations.md "Retiring a Durable Object class").
 *
 * Ways it could fail, each covered below:
 * - it deletes while the stage's Core still binds the class, and Cloudflare
 *   fails the Orb Worker deploy (staging and production on the release that
 *   ships plugins-next, whose Core of the release before binds it);
 * - an API read fails and it deletes on a guess;
 * - a stage that already deleted it is not idempotent (a later deploy drops
 *   the migration, or the stub comes back);
 * - the config deletes but still exports the stub, or keeps but drops it;
 * - a deletion no owner approved passes the gate.
 */

const ORB = "dx-orb-stage";
const CORE = "dx-app-stage";
const namespace = {
  id: "ns-plugin",
  script: ORB,
  class: "PluginContainerObject",
};
const reader =
  (routes) =>
  async (path, { missing = false } = {}) => {
    const answer = routes[path];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) {
      if (missing) return undefined;
      throw new Error(`unexpected read ${path}`);
    }
    return answer;
  };
const namespaces = "/workers/durable_objects/namespaces?per_page=1000";
const coreSettings = `/workers/scripts/${CORE}/settings`;

describe("plugin container retirement", () => {
  it("keeps the class while Core still binds it, and says why", async () => {
    const decision = await pluginContainerRetirement({
      workerName: ORB,
      coreWorkerName: CORE,
      read: reader({
        [namespaces]: [namespace],
        [coreSettings]: {
          bindings: [
            {
              type: "durable_object_namespace",
              name: "PLUGIN_CONTAINER",
              class_name: "PluginContainerObject",
              script_name: ORB,
            },
          ],
        },
      }),
    });
    expect(decision).toEqual({
      delete: false,
      reason: `${CORE} still binds PluginContainerObject as PLUGIN_CONTAINER; the class stays until Core deploys without it`,
    });
  });

  it("never deletes on a failed read", async () => {
    const refused = new Error("Cloudflare request GET failed (503).");
    expect(
      await pluginContainerRetirement({
        workerName: ORB,
        coreWorkerName: CORE,
        read: reader({ [namespaces]: refused }),
      }),
    ).toMatchObject({ delete: false });
    expect(
      await pluginContainerRetirement({
        workerName: ORB,
        coreWorkerName: CORE,
        read: reader({ [namespaces]: [namespace], [coreSettings]: refused }),
      }),
    ).toMatchObject({ delete: false });
    expect(
      await pluginContainerRetirement({
        workerName: ORB,
        coreWorkerName: undefined,
        read: reader({ [namespaces]: [namespace] }),
      }),
    ).toMatchObject({ delete: false });
  });

  it("deletes once Core has dropped the binding, naming the namespace whose application goes", async () => {
    expect(
      await pluginContainerRetirement({
        workerName: ORB,
        coreWorkerName: CORE,
        read: reader({
          [namespaces]: [namespace],
          [coreSettings]: {
            bindings: [
              {
                type: "durable_object_namespace",
                name: "ORB_CONTAINER",
                class_name: "OrbContainerObject",
                script_name: ORB,
              },
            ],
          },
        }),
      }),
    ).toEqual({
      delete: true,
      namespaceId: "ns-plugin",
      reason: `${CORE} no longer binds PluginContainerObject`,
    });
  });

  it("is idempotent: a stage with no namespace of the class keeps deleting it", async () => {
    const decision = await pluginContainerRetirement({
      workerName: ORB,
      coreWorkerName: CORE,
      read: reader({
        [namespaces]: [{ ...namespace, script: "dx-orb-other-stage" }],
      }),
    });
    expect(decision).toMatchObject({ delete: true, namespaceId: undefined });
  });

  it("deploys without the stub and with the migration only when it deletes", () => {
    const workspaceRoot = "/repo";
    const kept = orbWorkerConfig({ workerName: ORB, workspaceRoot });
    const deleted = orbWorkerConfig({
      workerName: ORB,
      workspaceRoot,
      deletePluginContainer: true,
    });
    expect(kept.main).toBe(
      resolve(
        workspaceRoot,
        "apps/core/src/execution/cloudflare/orb-worker-with-plugin-container.ts",
      ),
    );
    expect(kept.migrations.map(({ tag }) => tag)).not.toContain(
      PLUGIN_CONTAINER_DELETION_TAG,
    );
    expect(deleted.main).toBe(
      resolve(
        workspaceRoot,
        "apps/core/src/execution/cloudflare/orb-worker.ts",
      ),
    );
    expect(deleted.migrations.at(-1)).toEqual({
      tag: "v4-remove-plugin-container",
      deleted_classes: ["PluginContainerObject"],
    });
  });

  it("refuses a deletion no owner approved", () => {
    expect(() =>
      assertApprovedDurableObjectDeletion("orb", "v4-remove-plugin-container", [
        "PluginContainerObject",
      ]),
    ).not.toThrow();
    expect(() =>
      assertApprovedDurableObjectDeletion("orb", "v4-remove-plugin-container", [
        "OrbContainerObject",
      ]),
    ).toThrow(/no owner approved/);
    expect(() =>
      assertApprovedDurableObjectDeletion("core", "v14-anything", [
        "RealtimeHub",
      ]),
    ).toThrow(/no owner approved/);
  });
});
