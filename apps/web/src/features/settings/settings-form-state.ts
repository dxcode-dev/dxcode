import type { SettingsFieldError } from "@dx/api";
import { ApiError } from "../../shared/api/client.js";

export interface SettingsFormState {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly status: "idle" | "saved" | "error";
  readonly message?: string;
  readonly fieldErrors: ReadonlyArray<SettingsFieldError>;
}

export type SettingsFormEvent =
  | { readonly type: "changed" }
  | { readonly type: "saveStarted" }
  | { readonly type: "saveSucceeded"; readonly message: string }
  | {
      readonly type: "saveFailed";
      readonly message: string;
      readonly fieldErrors?: ReadonlyArray<SettingsFieldError>;
    }
  | { readonly type: "reset" };

export const initialSettingsFormState: SettingsFormState = {
  dirty: false,
  saving: false,
  status: "idle",
  fieldErrors: [],
};

export const settingsMutationError = (cause: unknown, fallback: string) => {
  if (!(cause instanceof ApiError) || !cause.hasValidatedPayload) {
    return { message: fallback, fieldErrors: undefined };
  }
  return {
    message: cause.message,
    fieldErrors: cause.fieldErrors,
  };
};

export const reduceSettingsFormState = (
  state: SettingsFormState,
  event: SettingsFormEvent,
): SettingsFormState => {
  switch (event.type) {
    case "changed":
      return {
        dirty: true,
        saving: false,
        status: "idle",
        fieldErrors: [],
      };
    case "saveStarted":
      return {
        ...state,
        saving: true,
        status: "idle",
        message: undefined,
        fieldErrors: [],
      };
    case "saveSucceeded":
      return {
        dirty: false,
        saving: false,
        status: "saved",
        message: event.message,
        fieldErrors: [],
      };
    case "saveFailed":
      return {
        dirty: true,
        saving: false,
        status: "error",
        message: event.message,
        fieldErrors: event.fieldErrors ?? [],
      };
    case "reset":
      return initialSettingsFormState;
  }
};
