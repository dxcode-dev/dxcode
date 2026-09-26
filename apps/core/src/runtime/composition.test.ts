import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../http/types.js";
import {
  loadRuntimeConfiguration,
  RuntimeConfigurationError,
  selectRuntimeAdapters,
} from "./composition.js";

const load = (DX_RUNTIME_MODE?: string) =>
  Effect.runPromise(
    loadRuntimeConfiguration({ DX_RUNTIME_MODE } satisfies Bindings),
  );

describe("runtime composition", () => {
  it("fails closed when the setting is absent", async () => {
    const error = await Effect.runPromise(
      Effect.flip(loadRuntimeConfiguration({} satisfies Bindings)),
    );

    expect(error).toBeInstanceOf(RuntimeConfigurationError);
    expect(String(error)).toBe("RuntimeConfigurationError");
  });

  it.each([
    [
      "local",
      {
        mode: "local",
        executionAdapter: "local",
        modelAdapter: "fixture",
      },
    ],
    [
      "deployed",
      {
        mode: "deployed",
        executionAdapter: "e2b",
        modelAdapter: "cloudflare",
      },
    ],
  ] as const)(
    "decodes the closed %s configuration",
    async (value, expected) => {
      await expect(load(value)).resolves.toEqual(expected);
    },
  );

  it("selects execution and model adapters as one exhaustive pair", async () => {
    const local = Object.freeze({ execution: Symbol("local"), model: 1 });
    const deployed = Object.freeze({ execution: Symbol("e2b"), model: 2 });
    const adapters = { local, deployed };

    expect(selectRuntimeAdapters(await load("local"), adapters)).toBe(local);
    expect(selectRuntimeAdapters(await load("deployed"), adapters)).toBe(
      deployed,
    );
  });

  it.each(["preview", "LOCAL", "", "e2b"])(
    "fails closed for unknown value %s",
    async (value) => {
      const error = await Effect.runPromise(
        Effect.flip(
          loadRuntimeConfiguration({
            DX_RUNTIME_MODE: value,
          } satisfies Bindings),
        ),
      );

      expect(error).toBeInstanceOf(RuntimeConfigurationError);
      if (value !== "") expect(String(error)).not.toContain(value);
    },
  );
});
