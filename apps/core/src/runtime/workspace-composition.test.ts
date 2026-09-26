import { describe, expect, it } from "vitest";
import { RuntimeConfigurationError } from "./composition.js";
import { selectWorkspaceRuntime } from "./workspace-composition.js";

describe("workspace runtime composition", () => {
  it.each([
    ["local", "local-workspace"],
    ["deployed", "e2b-workspace"],
  ] as const)("selects the %s Thread workspace once", (mode, expected) => {
    const local = { name: "local-workspace" };
    const deployed = { name: "e2b-workspace" };

    expect(
      selectWorkspaceRuntime({ DX_RUNTIME_MODE: mode }, { local, deployed })
        .name,
    ).toBe(expected);
  });

  it("fails closed instead of choosing the deployed workspace", () => {
    expect(() =>
      selectWorkspaceRuntime({}, { local: Symbol(), deployed: Symbol() }),
    ).toThrow(RuntimeConfigurationError);
  });
});
