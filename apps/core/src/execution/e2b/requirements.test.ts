import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../http/types.js";
import { loadE2BRequirements } from "./requirements.js";

const bindings = (overrides: Partial<Bindings> = {}): Bindings =>
  ({
    E2B_API_KEY: "e2b-secret",
    DX_E2B_TEMPLATE: "dx-workspace",
    DX_E2B_TIMEOUT_MS: "300000",
    DX_ENV: "test",
    ...overrides,
  }) as Bindings;

const load = (overrides?: Partial<Bindings>) =>
  Effect.runPromise(loadE2BRequirements(bindings(overrides)));

describe("loadE2BRequirements", () => {
  it("loads bounded requirements without exposing the secret in its shape", async () => {
    const result = await load();

    expect(result).toEqual({
      apiKey: result.apiKey,
      template: "dx-workspace",
      timeoutMs: 300_000,
      inactivityMs: 300_000,
      dxEnv: "test",
    });
    expect(Object.keys(result)).toEqual([
      "apiKey",
      "dxEnv",
      "template",
      "timeoutMs",
      "inactivityMs",
    ]);
    expect(Redacted.value(result.apiKey)).toBe("e2b-secret");
    expect(String(result.apiKey)).not.toContain("e2b-secret");
  });

  it.each([
    ["E2B_API_KEY", ""],
    ["DX_E2B_TEMPLATE", "x".repeat(129)],
    ["DX_E2B_TIMEOUT_MS", "59999"],
    ["DX_E2B_TIMEOUT_MS", "3600001"],
    ["DX_WORKSPACE_INACTIVITY_MS", "59999"],
    ["DX_WORKSPACE_INACTIVITY_MS", "3600001"],
    ["DX_ENV", ""],
    ["DX_ENV", "contains spaces"],
  ] as const)(
    "rejects invalid %s without reflecting its value",
    async (key, value) => {
      const error = await Effect.runPromise(
        Effect.flip(loadE2BRequirements(bindings({ [key]: value }))),
      );

      expect(String(error)).not.toContain(value || "e2b-secret");
      expect(String(error)).toContain("ExecutionWorkspaceConfigurationError");
    },
  );
});
