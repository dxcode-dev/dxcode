import { describe, expect, it } from "vitest";
import type { PluginHost } from "../../src/plugins/worker-host/host.js";
import {
  QUICKJS_PLUGIN_LIMITS,
  runPluginInQuickJS,
} from "../../src/plugins/worker-host/quickjs-host.js";
import { RUNTIME_MODULE } from "../../src/plugins/worker-host/runtime.js";

/*
 * The QuickJS fallback host shares its Worker isolate's memory with every
 * other request. Each guest timer and host call holds host memory, so the
 * limits must apply when the guest asks, before anything is allocated.
 * Ways it could fail:
 *
 * 1. A guest looping on setTimeout queues timers and promises without end.
 * 2. A guest looping on __host has its call strings copied and queued
 *    before the call limit, which ran later, is checked.
 * 3. A guest passes one large string to many host calls at once, each
 *    copied into host memory.
 * 4. The limits refuse ordinary plugins: many timers over a call, a few
 *    hundred at once, and host calls with modest arguments.
 */

const logged: unknown[] = [];
const host = {
  log: async (...args: unknown[]) => {
    logged.push(args);
  },
} as unknown as PluginHost;

/** Runs `body` as the plugin runtime's dispatch, straight on the bindings. */
const run = (body: string) =>
  runPluginInQuickJS({
    modules: {
      [RUNTIME_MODULE]: `export default class {
  async dispatch() { ${body} }
}`,
    },
    operation: { kind: "dispatch", event: "test", payload: null },
    host,
    wallMs: 20_000,
  });

describe("QuickJS plugin host memory", () => {
  it("stops a guest that sets timers in a loop", async () => {
    // 1.
    await expect(run("for (;;) setTimeout(() => {}, 0);")).rejects.toThrow(
      /more than 1000 timers at once/,
    );
  });

  it("stops a guest that calls the host in a loop before queueing more", async () => {
    // 2.
    logged.length = 0;
    await expect(run('for (;;) __host("log", "[]");')).rejects.toThrow(
      /too many times/,
    );
    expect(logged.length).toBeLessThanOrEqual(QUICKJS_PLUGIN_LIMITS.hostCalls);
  });

  it("stops a guest that passes the host too much data at once", async () => {
    // 3: 20 M characters, many times over, without awaiting.
    await expect(
      run(
        'const big = "x".repeat(20_000_000); for (let i = 0; i < 50; i++) __host("log", big);',
      ),
    ).rejects.toThrow(/too much data/);
  });

  it("runs ordinary plugins", async () => {
    // 4.
    await expect(
      run(`
        for (let i = 0; i < 1200; i++) await new Promise((r) => setTimeout(r, 0));
        await Promise.all(Array.from({ length: 300 }, () => new Promise((r) => setTimeout(r, 1))));
        for (let i = 0; i < 20; i++) await __host("log", JSON.stringify(["info", "x".repeat(100_000), {}]));
        return "done";`),
    ).resolves.toBe("done");
  });
});
