import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { destroyOrbWorker } from "./containers.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("Cloudflare Containers Orb Worker deployment", () => {
  it("removes the application, the Worker, and the image repository with its snapshots", async () => {
    const calls = [];
    const fetch = vi.fn(async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      const path = new URL(url).pathname;
      const result = path.endsWith("/workers/durable_objects/namespaces")
        ? [
            { id: "ns-other", script: "dx-app", class: "RealtimeHub" },
            {
              id: "ns-orb",
              script: "dx-orb-test",
              class: "OrbContainerObject",
            },
          ]
        : path.endsWith("/containers/applications")
          ? [
              { id: "app-orb", durable_objects: { namespace_id: "ns-orb" } },
              { id: "app-other", durable_objects: { namespace_id: "ns-x" } },
            ]
          : null;
      return Response.json({ success: true, result });
    });
    const run = vi.fn((args) =>
      args[2] === "list"
        ? {
            status: 0,
            stdout: JSON.stringify([
              {
                name: "dx-orb-test-orb-orbcontainerobject",
                tags: ["a", "rootfs-snapshot-b"],
              },
              { name: "dx-app-other", tags: ["c"] },
            ]),
          }
        : { status: 0, stdout: "" },
    );
    await destroyOrbWorker({
      workerName: "dx-orb-test",
      accountId: "a".repeat(32),
      apiToken: "token",
      workspaceRoot,
      fetch,
      run,
    });
    expect(calls).toEqual([
      `GET /client/v4/accounts/${"a".repeat(32)}/workers/durable_objects/namespaces`,
      `GET /client/v4/accounts/${"a".repeat(32)}/containers/applications`,
      `DELETE /client/v4/accounts/${"a".repeat(32)}/containers/applications/app-orb`,
      `DELETE /client/v4/accounts/${"a".repeat(32)}/workers/scripts/dx-orb-test`,
    ]);
    expect(run.mock.calls.slice(1).map(([args]) => args[3])).toEqual([
      "dx-orb-test-orb-orbcontainerobject:a",
      "dx-orb-test-orb-orbcontainerobject:rootfs-snapshot-b",
    ]);
  });
});
