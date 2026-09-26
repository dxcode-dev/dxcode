import { describe, expect, it } from "vitest";
import { ApiError } from "../../shared/api/client.js";
import {
  initialSettingsFormState,
  reduceSettingsFormState,
  settingsMutationError,
} from "./settings-form-state.js";

describe("settings form state", () => {
  it.each([null, undefined, "request failed"])(
    "uses the fallback for a non-object mutation cause: %s",
    (cause) => {
      expect(
        settingsMutationError(cause, "Settings could not be saved."),
      ).toEqual({
        message: "Settings could not be saved.",
        fieldErrors: undefined,
      });
    },
  );

  it("preserves decoded API messages and field errors", () => {
    expect(
      settingsMutationError(
        new ApiError(
          400,
          "Settings validation failed.",
          "INVALID_SETTINGS",
          [{ field: "name", message: "Enter a valid name." }],
          undefined,
          true,
        ),
        "Settings could not be saved.",
      ),
    ).toEqual({
      message: "Settings validation failed.",
      fieldErrors: [{ field: "name", message: "Enter a valid name." }],
    });
  });

  it.each([
    new Error("Internal decoder details"),
    new ApiError(500, "Unvalidated response message"),
    {
      message: "Untrusted message",
      fieldErrors: [{ field: 42, message: { unsafe: true } }],
    },
  ])("rejects unvalidated object-shaped mutation errors", (cause) => {
    expect(
      settingsMutationError(cause, "Settings could not be saved."),
    ).toEqual({
      message: "Settings could not be saved.",
      fieldErrors: undefined,
    });
  });

  it("tracks dirty, saving, saved, and reset transitions", () => {
    const dirty = reduceSettingsFormState(initialSettingsFormState, {
      type: "changed",
    });
    expect(dirty).toMatchObject({ dirty: true, status: "idle" });
    const saving = reduceSettingsFormState(dirty, { type: "saveStarted" });
    expect(saving).toMatchObject({ dirty: true, saving: true });
    const saved = reduceSettingsFormState(saving, {
      type: "saveSucceeded",
      message: "Settings saved.",
    });
    expect(saved).toMatchObject({
      dirty: false,
      saving: false,
      status: "saved",
      message: "Settings saved.",
    });
    expect(reduceSettingsFormState(saved, { type: "reset" })).toEqual(
      initialSettingsFormState,
    );
  });

  it("preserves field validation errors without clearing dirty state", () => {
    const failed = reduceSettingsFormState(
      { ...initialSettingsFormState, dirty: true, saving: true },
      {
        type: "saveFailed",
        message: "Settings scope validation failed.",
        fieldErrors: [
          { field: "workspaceSlug", message: "Use a valid workspace slug." },
        ],
      },
    );
    expect(failed).toMatchObject({
      dirty: true,
      saving: false,
      status: "error",
      fieldErrors: [{ field: "workspaceSlug" }],
    });
  });
});
