import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import {
  PluginHost,
  type PluginHostDependencies,
  type PluginInstallRecord,
} from "../../src/plugins/worker-host/host.js";

/*
 * What the host itself refuses, whatever the plugin's runtime was told. On
 * the QuickJS fallback a plugin calls the host directly, so the grants in
 * its call info are only advice there. Ways it could fail:
 *
 * 1. A `live` plugin in an archived Thread starts an agent (a child Thread
 *    billed to the owner), runs a command in the Thread's Orb, asks a
 *    question, or posts.
 * 2. The archived check refuses the same calls in an active Thread.
 */

const install = (network: ReadonlyArray<string> = []): PluginInstallRecord => ({
  pluginId: "plg_host_grants",
  name: "com.example.host-grants",
  displayName: "Host grants",
  scope: "personal",
  targetId: "usr_host_grants",
  version: "1.0.0",
  integrity: "sha256-host-grants",
  tier: "personal-dev",
  code: {
    apiVersion: 1,
    host: "worker",
    entry: "dev.dxcode/index.js",
    modules: [],
    permissions: {
      events: [],
      network: [...network],
      secrets: [],
      tools: [],
      ai: false,
      agents: true,
      shell: true,
      ui: ["prompt"],
      threads: ["post"],
    },
    settings: [],
  } as unknown as PluginInstallRecord["code"],
});

const hostFor = (overrides: Partial<PluginHostDependencies>) =>
  new PluginHost({
    db: env.DB,
    bindings: env as unknown as Bindings,
    install: install(),
    threadId: "thr_host_grants",
    ownerUserId: "usr_host_grants",
    tier: "personal-dev",
    shellGate: {} as never,
    ...overrides,
  });

const archived = /The Thread is archived/;

describe("archived Thread, plugin running live", () => {
  it("refuses agents, commands, prompts, and posts at the host", async () => {
    const host = hostFor({ archivedLive: true });
    // 1.
    await expect(
      host.runAgent({ name: "helper" }, "Summarize the Thread."),
    ).rejects.toThrow(archived);
    await expect(host.exec({ command: "ls" })).rejects.toThrow(archived);
    await expect(
      host.uiPrompt("confirm", { title: "Proceed?" }),
    ).rejects.toThrow(archived);
    await expect(host.threadPost(undefined, "Hello", false)).rejects.toThrow(
      archived,
    );
  });

  it("leaves those calls to their usual checks in an active Thread", async () => {
    const host = hostFor({});
    // 2: each fails later, for its own reason, never as archived.
    const outcomes = await Promise.allSettled([
      host.runAgent({ name: "helper" }, "Summarize the Thread."),
      host.exec({ command: "ls" }),
      host.uiPrompt("confirm", { title: "Proceed?" }),
      host.threadPost(undefined, "Hello", false),
    ]);
    host.close();
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        expect(String(outcome.reason)).not.toMatch(archived);
  });
});
