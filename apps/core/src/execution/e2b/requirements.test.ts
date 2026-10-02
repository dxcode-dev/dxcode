import { E2B_ORB_PROFILES } from "@dx/domain";
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

  it("defaults the E2B timeout to the five-minute inactivity deadline", async () => {
    const result = await load({ DX_E2B_TIMEOUT_MS: undefined });

    expect(result.timeoutMs).toBe(300_000);
    expect(result.timeoutMs).toBe(result.inactivityMs);
  });

  it("uses the selected runner profile template", async () => {
    const result = await Effect.runPromise(
      loadE2BRequirements(bindings(), "selected-profile-template"),
    );

    expect(result.template).toBe("selected-profile-template");
  });

  it.each(E2B_ORB_PROFILES)(
    "passes $id's dedicated E2B template to Sandbox.create",
    async (profile) => {
      const template = `dx-workspace-${profile.templateSuffix}`;
      const result = await Effect.runPromise(
        loadE2BRequirements(bindings(), template),
      );

      expect(result.template).toBe(template);
    },
  );

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
