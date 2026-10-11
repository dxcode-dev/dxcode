import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../http/types.js";
import {
  loadRuntimeConfiguration,
  RuntimeConfigurationError,
} from "./composition.js";

describe("runtime composition", () => {
  it("fails closed when the setting is absent", async () => {
    const error = await Effect.runPromise(
      Effect.flip(loadRuntimeConfiguration({} satisfies Bindings)),
    );

    expect(error).toBeInstanceOf(RuntimeConfigurationError);
    expect(String(error)).toBe("RuntimeConfigurationError");
  });

  it.each(["preview", "LOCAL"])(
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
      expect(String(error)).not.toContain(value);
    },
  );
});
