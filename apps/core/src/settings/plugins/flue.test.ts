import type { PluginId, PluginToolName } from "@dx/domain";
import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  defineTool: vi.fn((definition) => definition),
  invokePluginLive: vi.fn(async () => ({
    attribution: {
      pluginId: "plg_00000000-0000-4000-8000-000000000045",
      version: "1.0.0",
      invocationId: "pinv_flue",
      capability: "summarize",
    },
    result: { summary: "bounded" },
    truncated: false,
  })),
}));

vi.mock("@flue/runtime", () => ({ defineTool: runtime.defineTool }));
vi.mock("./execution.js", () => ({
  invokePluginLive: runtime.invokePluginLive,
}));

import { createPluginTool } from "./flue.js";

describe("trusted plugin Flue tool", () => {
  it("publishes a stable typed tool and dispatches through the attributed runtime", async () => {
    const pluginId = "plg_00000000-0000-4000-8000-000000000045" as PluginId;
    const tool = createPluginTool("thr_00000000-0000-4000-8000-000000000045", {
      id: pluginId,
      version: "1.0.0",
      name: "summarize" as PluginToolName,
      description: "Summarize input.",
    }) as unknown as {
      readonly name: string;
      readonly harness: boolean;
      readonly run: (input: {
        readonly data: { readonly input: unknown };
        readonly harness: { readonly sandbox: unknown };
      }) => Promise<{ readonly output: unknown }>;
    };

    expect(tool.name).toBe(
      "dx_plg_00000000-0000-4000-8000-000000000045__summarize",
    );
    expect(tool.harness).toBe(true);
    const result = await tool.run({
      data: { input: { text: "reviewed" } },
      harness: { sandbox: "project-sandbox" },
    });
    expect(runtime.invokePluginLive).toHaveBeenCalledWith(
      "thr_00000000-0000-4000-8000-000000000045",
      pluginId,
      "1.0.0",
      { kind: "tool", name: "summarize" },
      { text: "reviewed" },
      "project-sandbox",
    );
    expect(result).toEqual({
      output: {
        attribution: {
          pluginId,
          version: "1.0.0",
          invocationId: "pinv_flue",
          capability: "summarize",
        },
        result: { summary: "bounded" },
        truncated: false,
      },
    });
  });
});
