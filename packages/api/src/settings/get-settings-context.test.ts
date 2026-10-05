import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  GetSettingsContextForbiddenResponseSchema,
  GetSettingsContextInvalidRequestResponseSchema,
  GetSettingsContextResponseSchema,
  GetWorkspaceSettingsContextParamsSchema,
} from "./get-settings-context.js";

describe("settings context API schemas", () => {
  it("decodes personal and administered-workspace contexts", () => {
    expect(
      Schema.decodeUnknownSync(GetSettingsContextResponseSchema)({
        status: "success",
        data: { activeScope: "personal" },
      }),
    ).toEqual({ status: "success", data: { activeScope: "personal" } });
    expect(
      Schema.decodeUnknownSync(GetSettingsContextResponseSchema)({
        status: "success",
        data: {
          activeScope: "workspace",
          workspace: {
            id: "workspace-id",
            displayName: "DX Team",
            shortName: "dx-team",
            lifecycleState: "active",
            revision: 0,
            role: "admin",
          },
        },
      }),
    ).toMatchObject({ data: { workspace: { shortName: "dx-team" } } });
    expect(() =>
      Schema.decodeUnknownSync(GetSettingsContextResponseSchema)({
        status: "success",
        data: { activeScope: "workspace" },
      }),
    ).toThrow();
  });

  it("exposes the resolved Speech provider for dictation without its credential", () => {
    const dictation = {
      providerId: "sarvam",
      displayName: "Sarvam",
      scope: "personal",
    };
    expect(
      Schema.decodeUnknownSync(GetSettingsContextResponseSchema)({
        status: "success",
        data: { activeScope: "personal", dictationAvailable: true, dictation },
      }).data,
    ).toMatchObject({ dictationAvailable: true, dictation });
    expect(() =>
      Schema.decodeUnknownSync(GetSettingsContextResponseSchema)({
        status: "success",
        data: {
          activeScope: "personal",
          dictationAvailable: true,
          dictation: { ...dictation, scope: "everyone" },
        },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(GetSettingsContextResponseSchema)({
        status: "success",
        data: { activeScope: "personal", dictationAvailable: false },
      }).data,
    ).toMatchObject({ dictationAvailable: false });
  });

  it("rejects invalid workspace slugs", () => {
    expect(() =>
      Schema.decodeUnknownSync(GetWorkspaceSettingsContextParamsSchema)({
        workspaceSlug: "Not Valid",
      }),
    ).toThrow();
  });

  it("keeps invalid-field and forbidden errors distinct", () => {
    expect(
      Schema.decodeUnknownSync(GetSettingsContextInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_SETTINGS_SCOPE",
          message: "Settings scope validation failed.",
          requestId: "request-1",
          fieldErrors: [
            { field: "workspaceSlug", message: "Use a valid workspace slug." },
          ],
        },
      }).data.fieldErrors,
    ).toHaveLength(1);
    expect(
      Schema.decodeUnknownSync(GetSettingsContextForbiddenResponseSchema)({
        status: "error",
        data: {
          code: "SETTINGS_SCOPE_FORBIDDEN",
          message: "The settings scope is unavailable for this user.",
          requestId: "request-2",
        },
      }).data.code,
    ).toBe("SETTINGS_SCOPE_FORBIDDEN");
  });
});
