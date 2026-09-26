import { type FlueVitePluginApi, flue } from "@flue/vite";
import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";

describe("Flue agent registration", () => {
  it("semantically scans exactly one stable dx agent", async () => {
    const plugins = flue();
    await resolveConfig(
      {
        configFile: false,
        root: new URL("../..", import.meta.url).pathname,
        plugins,
      },
      "build",
    );
    const plugin = plugins.find(
      (candidate) =>
        (candidate.api as FlueVitePluginApi | undefined)?.resolved !==
        undefined,
    );
    expect(plugin).toBeDefined();
    const api = plugin?.api as FlueVitePluginApi;

    expect(api.resolved?.agents).toEqual([
      expect.objectContaining({
        filePath: expect.stringMatching(/\/src\/agents\/dx-agent\.ts$/),
        exportName: "DxAgent",
        identity: "dx-agent",
        className: "FlueDxAgentAgent",
        bindingName: "FLUE_DX_AGENT_AGENT",
      }),
    ]);
  });

  it("resolves dx's canonical flush cadence through the Flue plugin", async () => {
    const plugins = flue({ canonicalFlushDelayMs: 750 });
    await resolveConfig(
      {
        configFile: false,
        root: new URL("../..", import.meta.url).pathname,
        plugins,
      },
      "build",
    );
    const plugin = plugins.find(
      (candidate) =>
        (candidate.api as FlueVitePluginApi | undefined)?.resolved !==
        undefined,
    );
    const api = plugin?.api as FlueVitePluginApi;

    expect(api.resolved?.project.canonicalFlushDelayMs).toBe(750);
  });
});
