import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import {
  loadReferenceLifecycleConfig,
  ReferenceLifecycleConfigurationError,
} from "./config.js";
import {
  formatReferenceLifecycleError,
  ReferenceLifecycleError,
} from "./workflow.js";

const token = "reference-token-00000000000000000";

describe("reference lifecycle configuration", () => {
  it("loads a validated base URL, redacted token, and exactly one project selector", async () => {
    const created = await Effect.runPromise(
      loadReferenceLifecycleConfig({
        DX_BASE_URL: "https://dx.example/",
        DX_TEMP_API_TOKEN: token,
        DX_REFERENCE_PROJECT_NAME: "Reference",
      }),
    );
    expect(created.baseUrl.toString()).toBe("https://dx.example/");
    expect(Redacted.value(created.apiToken)).toBe(token);
    expect(created.project).toMatchObject({
      kind: "create",
      name: "Reference",
    });

    const existing = await Effect.runPromise(
      loadReferenceLifecycleConfig({
        DX_BASE_URL: "http://localhost:8787/",
        DX_TEMP_API_TOKEN: token,
        DX_REFERENCE_PROJECT_ID: "prj_00000000-0000-4000-8000-000000000001",
      }),
    );
    expect(existing.project).toMatchObject({ kind: "existing" });
  });

  it.each([
    {
      DX_BASE_URL: "https://user:password@dx.example/",
      DX_TEMP_API_TOKEN: token,
      DX_REFERENCE_PROJECT_NAME: "Reference",
    },
    {
      DX_BASE_URL: "https://dx.example/path",
      DX_TEMP_API_TOKEN: token,
      DX_REFERENCE_PROJECT_NAME: "Reference",
    },
    {
      DX_BASE_URL: "https://dx.example/",
      DX_TEMP_API_TOKEN: token,
      DX_REFERENCE_PROJECT_NAME: "Reference",
      DX_REFERENCE_PROJECT_ID: "prj_00000000-0000-4000-8000-000000000001",
    },
  ])("rejects ambiguous or unsafe configuration", async (environment) => {
    await expect(
      Effect.runPromise(loadReferenceLifecycleConfig(environment)),
    ).rejects.toBeInstanceOf(ReferenceLifecycleConfigurationError);
  });

  it("formats only bounded stage evidence without credentials or content", () => {
    const safe = formatReferenceLifecycleError(
      new ReferenceLifecycleError({
        stage: "abort_active_settlement",
        status: 503,
        ref: "err_safe",
      }),
    );
    expect(JSON.parse(safe)).toEqual({
      status: "error",
      stage: "abort_active_settlement",
      httpStatus: 503,
      ref: "err_safe",
    });
    const unknown = formatReferenceLifecycleError(
      new Error(`${token}: private prompt content`),
    );
    expect(unknown).toBe('{"status":"error","stage":"configuration"}');
    expect(`${safe}${unknown}`).not.toContain(token);
    expect(`${safe}${unknown}`).not.toContain("private prompt content");
  });
});
