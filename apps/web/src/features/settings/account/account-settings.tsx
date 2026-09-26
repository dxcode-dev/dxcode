import type { PersonalAccountData, SettingsFieldError } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import {
  initialSettingsFormState,
  reduceSettingsFormState,
} from "../settings-form-state.js";
import { SettingsBackgroundError } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  personalAccountMutationError,
  personalAccountQueryOptions,
  updatePersonalAccountMutationOptions,
} from "./personal-account-queries.js";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase())
    .join("") || "U";

const fieldError = (
  errors: ReadonlyArray<SettingsFieldError>,
  field: "displayName" | "username",
) => errors.find((error) => error.field === field)?.message;

export function PersonalAccountForm({
  initialAccount,
  onDirtyChange,
  saveAccount,
  saving = false,
}: SettingsSectionProps & {
  readonly initialAccount: PersonalAccountData;
  readonly saveAccount: (input: {
    readonly displayName: string;
    readonly username: string;
  }) => Promise<PersonalAccountData>;
  readonly saving?: boolean;
}) {
  const [baseline, setBaseline] = React.useState(initialAccount);
  const [displayName, setDisplayName] = React.useState<string>(
    initialAccount.displayName,
  );
  const [username, setUsername] = React.useState<string>(
    initialAccount.username,
  );
  const [state, dispatch] = React.useReducer(
    reduceSettingsFormState,
    initialSettingsFormState,
  );
  const [editing, setEditing] = React.useState(false);
  const displayNameInput = React.useRef<HTMLInputElement>(null);
  const usernameInput = React.useRef<HTMLInputElement>(null);
  const formId = React.useId();
  const displayNameError = fieldError(state.fieldErrors, "displayName");
  const usernameError = fieldError(state.fieldErrors, "username");

  const change = (nextDisplayName: string, nextUsername: string) => {
    setDisplayName(nextDisplayName);
    setUsername(nextUsername);
    const dirty =
      nextDisplayName !== baseline.displayName ||
      nextUsername !== baseline.username;
    dispatch({ type: dirty ? "changed" : "reset" });
    onDirtyChange(dirty);
  };

  const reset = () => {
    setDisplayName(baseline.displayName);
    setUsername(baseline.username);
    dispatch({ type: "reset" });
    onDirtyChange(false);
    setEditing(false);
  };

  const save = async () => {
    if (!state.dirty || saving) return;
    try {
      const account = await saveAccount({ displayName, username });
      setBaseline(account);
      setDisplayName(account.displayName);
      setUsername(account.username);
      dispatch({
        type: "saveSucceeded",
        message: "Account settings saved.",
      });
      onDirtyChange(false);
      setEditing(false);
    } catch (cause) {
      const error = personalAccountMutationError(
        cause,
        "Account settings could not be saved.",
      );
      dispatch({
        type: "saveFailed",
        message: error.message,
        fieldErrors: error.fieldErrors,
      });
      const firstField = error.fieldErrors?.[0]?.field;
      if (firstField === "displayName") displayNameInput.current?.focus();
      if (firstField === "username") usernameInput.current?.focus();
    }
  };

  return (
    <div className="account-settings">
      <section className="account-profile-card">
        <header className="account-profile-header">
          <h2>Profile</h2>
          {editing ? null : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          )}
        </header>

        {editing ? (
          <div className="account-profile-editor">
            <span className="account-avatar" aria-hidden="true">
              {initials(baseline.displayName)}
            </span>
            <form
              id={formId}
              className="account-profile-edit-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <div className="account-edit-grid">
                <div className="account-field">
                  <label htmlFor={`${formId}-display-name`}>Display name</label>
                  <Input
                    ref={displayNameInput}
                    id={`${formId}-display-name`}
                    name="displayName"
                    autoComplete="name"
                    value={displayName}
                    disabled={saving}
                    aria-invalid={
                      displayNameError === undefined ? undefined : true
                    }
                    aria-describedby={
                      displayNameError === undefined
                        ? undefined
                        : `${formId}-display-name-error`
                    }
                    onChange={(event) => change(event.target.value, username)}
                  />
                  {displayNameError === undefined ? null : (
                    <small
                      id={`${formId}-display-name-error`}
                      className="account-field-error"
                    >
                      {displayNameError}
                    </small>
                  )}
                </div>

                <div className="account-field">
                  <label htmlFor={`${formId}-email`}>Email</label>
                  <Input
                    id={`${formId}-email`}
                    value={baseline.email}
                    readOnly
                    aria-readonly="true"
                  />
                </div>
              </div>

              <div className="account-field account-username-field">
                <label htmlFor={`${formId}-username`}>Username</label>
                <Input
                  ref={usernameInput}
                  id={`${formId}-username`}
                  name="username"
                  autoComplete="username"
                  value={username}
                  disabled={saving}
                  aria-invalid={usernameError === undefined ? undefined : true}
                  aria-describedby={`${formId}-username-help${
                    usernameError === undefined
                      ? ""
                      : ` ${formId}-username-error`
                  }`}
                  onChange={(event) => change(displayName, event.target.value)}
                />
                <small id={`${formId}-username-help`}>
                  Use 3–32 lowercase letters, numbers, or hyphens.
                </small>
                {usernameError === undefined ? null : (
                  <small
                    id={`${formId}-username-error`}
                    className="account-field-error"
                  >
                    {usernameError}
                  </small>
                )}
              </div>

              <footer className="account-profile-edit-actions">
                <span aria-live="polite">
                  {state.status === "error" ? state.message : null}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={reset}
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  type="submit"
                  disabled={!state.dirty || saving}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </footer>
            </form>
          </div>
        ) : (
          <div className="account-profile-summary">
            <span className="account-avatar" aria-hidden="true">
              {initials(baseline.displayName)}
            </span>
            <dl className="account-profile-details">
              <div>
                <dt>Name</dt>
                <dd>{baseline.displayName}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{baseline.email}</dd>
              </div>
              <div>
                <dt>Username</dt>
                <dd>@{baseline.username}</dd>
              </div>
              <div>
                <dt>Threads</dt>
                <dd className="account-thread-count">{baseline.threadCount}</dd>
              </div>
            </dl>
          </div>
        )}
      </section>
    </div>
  );
}

export function PersonalAccountSettings({
  onDirtyChange,
}: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const account = useQuery(personalAccountQueryOptions(identity.id));
  const updateAccount = useMutation(
    updatePersonalAccountMutationOptions(queryClient, identity.id),
  );

  if (account.isPending && account.data === undefined) {
    return (
      <div className="settings-route-state" aria-busy="true">
        <span className="tool-spinner" />
        <strong>Loading account…</strong>
      </div>
    );
  }
  if (account.data === undefined) {
    return (
      <div className="settings-route-state" role="alert">
        <AlertTriangle />
        <strong>
          {account.error instanceof Error
            ? account.error.message
            : "Account settings could not be loaded."}
        </strong>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void account.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }
  return (
    <>
      {account.error === null ? null : (
        <SettingsBackgroundError onRetry={() => void account.refetch()}>
          Account settings could not be refreshed. Showing the last loaded
          settings.
        </SettingsBackgroundError>
      )}
      <PersonalAccountForm
        initialAccount={account.data}
        onDirtyChange={onDirtyChange}
        saveAccount={updateAccount.mutateAsync}
        saving={updateAccount.isPending}
      />
    </>
  );
}
