import type { PersonalAccountData, SettingsFieldError } from "@dx/api";
import {
  initialSettingsFormState,
  reduceSettingsFormState,
  type SettingsFormState,
} from "../settings-form-state.js";

/**
 * The Profile card while the person views or edits it: the last saved
 * account, the names being typed, whether the one-time username change waits
 * for confirmation, and the save status.
 */
export interface AccountProfileDraft {
  readonly baseline: PersonalAccountData;
  readonly displayName: string;
  readonly username: string;
  readonly editing: boolean;
  readonly confirmingUsername: boolean;
  readonly confirmError?: string;
  readonly form: SettingsFormState;
}

export type AccountProfileDraftEvent =
  | { readonly type: "edit" }
  | {
      readonly type: "changed";
      readonly displayName: string;
      readonly username: string;
      /** Whether the names differ from the saved account. */
      readonly dirty: boolean;
    }
  | { readonly type: "cancel" }
  | { readonly type: "confirmUsername" }
  | { readonly type: "confirmOpenChange"; readonly open: boolean }
  | {
      readonly type: "saved";
      readonly account: PersonalAccountData;
      readonly message: string;
    }
  | {
      readonly type: "saveFailed";
      readonly message: string;
      readonly fieldErrors?: ReadonlyArray<SettingsFieldError>;
      /** Whether the save came from the username confirmation. */
      readonly confirming: boolean;
    };

export const initialAccountProfileDraft = (
  account: PersonalAccountData,
): AccountProfileDraft => ({
  baseline: account,
  displayName: account.displayName,
  username: account.username,
  editing: false,
  confirmingUsername: false,
  form: initialSettingsFormState,
});

export const reduceAccountProfileDraft = (
  state: AccountProfileDraft,
  event: AccountProfileDraftEvent,
): AccountProfileDraft => {
  switch (event.type) {
    case "edit":
      return { ...state, editing: true };
    case "changed":
      return {
        ...state,
        displayName: event.displayName,
        username: event.username,
        form: reduceSettingsFormState(state.form, {
          type: event.dirty ? "changed" : "reset",
        }),
      };
    case "cancel":
      return {
        ...state,
        displayName: state.baseline.displayName,
        username: state.baseline.username,
        editing: false,
        form: reduceSettingsFormState(state.form, { type: "reset" }),
      };
    case "confirmUsername":
      return { ...state, confirmError: undefined, confirmingUsername: true };
    case "confirmOpenChange":
      return { ...state, confirmingUsername: event.open };
    case "saved":
      return {
        ...state,
        baseline: event.account,
        displayName: event.account.displayName,
        username: event.account.username,
        editing: false,
        confirmingUsername: false,
        form: reduceSettingsFormState(state.form, {
          type: "saveSucceeded",
          message: event.message,
        }),
      };
    case "saveFailed":
      return {
        ...state,
        // The dialog shows the username's own error, or why the save failed.
        ...(event.confirming
          ? {
              confirmError:
                event.fieldErrors?.find(({ field }) => field === "username")
                  ?.message ?? event.message,
            }
          : {}),
        form: reduceSettingsFormState(state.form, {
          type: "saveFailed",
          message: event.message,
          fieldErrors: event.fieldErrors,
        }),
      };
  }
};
