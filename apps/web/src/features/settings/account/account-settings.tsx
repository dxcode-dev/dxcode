import type { PersonalAccountData, SettingsFieldError } from "@dx/api";
import {
  normalizePersonalAccountUsername,
  personalAccountDisplayNameProblem,
  personalAccountUsernameChoiceProblem,
  personalAccountUsernameProblem,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { Input } from "../../../shared/ui/input.js";
import { registeredDeploymentAccountCards } from "../deployment-settings-registration.js";
import { ProfilePicture, ProfilePictureEditor } from "../profile-picture.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsHeading,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  initialAccountProfileDraft,
  reduceAccountProfileDraft,
} from "./account-profile-draft.js";
import { AccountUsageSummary } from "./account-usage-summary.js";
import {
  personalAccountMutationError,
  personalAccountQueryOptions,
  personalAccountThreadCountQueryOptions,
  setPersonalAvatarMutationOptions,
  updatePersonalAccountMutationOptions,
} from "./personal-account-queries.js";

const fieldError = (
  errors: ReadonlyArray<SettingsFieldError>,
  field: "displayName" | "username",
) => errors.find((error) => error.field === field)?.message;

/**
 * The saved profile, shown while the person is not editing it: picture,
 * name, username, and how many Threads they own. The email stays off the
 * page: it can't be changed here and anyone looking at the screen sees it.
 */
function AccountProfileSummary({
  picture,
  account,
  threadCount,
}: {
  readonly picture: React.ReactNode;
  readonly account: PersonalAccountData;
  readonly threadCount: number | undefined;
}) {
  return (
    <div className="account-profile-summary">
      {picture}
      <div className="account-profile-identity">
        <strong>{account.displayName}</strong>
        <span>@{account.username}</span>
      </div>
      {threadCount === undefined ? null : (
        <div className="account-profile-stat">
          <strong className="account-thread-count">
            {threadCount.toLocaleString()}
          </strong>
          <span>{threadCount === 1 ? "Thread" : "Threads"}</span>
        </div>
      )}
    </div>
  );
}

/** The username, its rules, and its error; read-only once it is fixed. */
function UsernameField({
  id,
  inputRef,
  account,
  value,
  error,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly inputRef: React.Ref<HTMLInputElement>;
  readonly account: PersonalAccountData;
  readonly value: string;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const fixed = !account.usernameChangeAvailable;
  return (
    <div className="account-field account-username-field">
      <label htmlFor={id}>Username</label>
      <Input
        ref={inputRef}
        id={id}
        name="username"
        autoComplete="username"
        value={value}
        disabled={disabled}
        readOnly={fixed}
        aria-readonly={fixed ? "true" : undefined}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={`${id}-help${error === undefined ? "" : ` ${id}-error`}`}
        onChange={(event) => onChange(event.target.value)}
      />
      <small id={`${id}-help`}>
        {fixed
          ? "Your username is fixed."
          : account.usernameNeedsPick
            ? "Pick a username: 3–32 lowercase letters, numbers, or hyphens. This doesn't use up your one change."
            : "You can change your username once. Use 3–32 lowercase letters, numbers, or hyphens."}
      </small>
      {error === undefined ? null : (
        <small id={`${id}-error`} className="account-field-error">
          {error}
        </small>
      )}
    </div>
  );
}

/** The display name, the username, Cancel, and Save. */
function AccountProfileEditForm({
  account,
  displayName,
  username,
  displayNameError,
  usernameError,
  displayNameRef,
  usernameRef,
  saving,
  canSave,
  errorMessage,
  onChange,
  onSave,
  onCancel,
}: {
  readonly account: PersonalAccountData;
  readonly displayName: string;
  readonly username: string;
  readonly displayNameError: string | undefined;
  readonly usernameError: string | undefined;
  readonly displayNameRef: React.Ref<HTMLInputElement>;
  readonly usernameRef: React.Ref<HTMLInputElement>;
  readonly saving: boolean;
  readonly canSave: boolean;
  /** Why the last save failed, when it did. */
  readonly errorMessage: string | undefined;
  readonly onChange: (displayName: string, username: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const formId = React.useId();
  return (
    <form
      id={formId}
      className="account-profile-edit-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="account-edit-grid">
        <div className="account-field">
          <label htmlFor={`${formId}-display-name`}>Display name</label>
          <Input
            ref={displayNameRef}
            id={`${formId}-display-name`}
            name="displayName"
            autoComplete="name"
            value={displayName}
            disabled={saving}
            aria-invalid={displayNameError === undefined ? undefined : true}
            aria-describedby={
              displayNameError === undefined
                ? undefined
                : `${formId}-display-name-error`
            }
            onChange={(event) => onChange(event.target.value, username)}
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

        <UsernameField
          id={`${formId}-username`}
          inputRef={usernameRef}
          account={account}
          value={username}
          error={usernameError}
          disabled={saving}
          onChange={(next) => onChange(displayName, next)}
        />
      </div>

      <footer className="account-profile-edit-actions">
        <span aria-live="polite">{errorMessage ?? null}</span>
        <Button
          size="xs"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button size="xs" type="submit" disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </footer>
    </form>
  );
}

export function PersonalAccountForm({
  initialAccount,
  onDirtyChange,
  saveAccount,
  saving = false,
  changeAvatar,
  avatarSaving = false,
  threadCount,
}: SettingsSectionProps & {
  readonly initialAccount: PersonalAccountData;
  /** How many Threads the person owns; absent until it loads. */
  readonly threadCount?: number;
  readonly saveAccount: (input: {
    readonly displayName: string;
    readonly username: string;
  }) => Promise<PersonalAccountData>;
  readonly saving?: boolean;
  readonly changeAvatar?: (file: File | null) => Promise<PersonalAccountData>;
  readonly avatarSaving?: boolean;
}) {
  const [draft, dispatch] = React.useReducer(
    reduceAccountProfileDraft,
    initialAccount,
    initialAccountProfileDraft,
  );
  const { baseline, displayName, username, editing, form } = draft;
  // The one-time username change waits in the draft for the person to confirm it.
  const { confirmingUsername, confirmError } = draft;
  const [avatarError, setAvatarError] = React.useState<string>();
  const displayNameInput = React.useRef<HTMLInputElement>(null);
  const usernameInput = React.useRef<HTMLInputElement>(null);
  // The server's rules, checked as the person types; the server's own field
  // errors (such as a taken username) show only when these pass.
  const displayNameProblem = personalAccountDisplayNameProblem(displayName);
  const usernameChanges =
    normalizePersonalAccountUsername(username) !== baseline.username;
  const usernameProblem =
    personalAccountUsernameProblem(username) ??
    (usernameChanges
      ? personalAccountUsernameChoiceProblem(username)
      : undefined);
  const displayNameError =
    displayNameProblem ?? fieldError(form.fieldErrors, "displayName");
  const usernameError =
    usernameProblem ?? fieldError(form.fieldErrors, "username");
  const canSave =
    form.dirty &&
    !saving &&
    displayNameProblem === undefined &&
    usernameProblem === undefined;

  const change = (nextDisplayName: string, nextUsername: string) => {
    const dirty =
      nextDisplayName !== baseline.displayName ||
      nextUsername !== baseline.username;
    dispatch({
      type: "changed",
      displayName: nextDisplayName,
      username: nextUsername,
      dirty,
    });
    onDirtyChange(dirty);
  };

  const updateAvatar = async (file: File | null) => {
    if (changeAvatar === undefined) return;
    setAvatarError(undefined);
    try {
      await changeAvatar(file);
    } catch (cause) {
      const error = personalAccountMutationError(
        cause,
        file === null
          ? "Picture could not be removed."
          : "Picture could not be uploaded.",
      );
      setAvatarError(
        error.fieldErrors?.find(({ field }) => field === "avatar")?.message ??
          error.message,
      );
    }
  };

  const picture = (
    <ProfilePicture
      className="account-avatar"
      name={baseline.displayName}
      url={initialAccount.avatarUrl}
      fallback="U"
    />
  );

  const reset = () => {
    dispatch({ type: "cancel" });
    onDirtyChange(false);
  };

  const save = async () => {
    if (!canSave) return;
    // A free pick (away from a placeholder or reserved name) needs no
    // confirmation; the one real change does.
    if (usernameChanges && !baseline.usernameNeedsPick && !confirmingUsername) {
      dispatch({ type: "confirmUsername" });
      return;
    }
    try {
      const account = await saveAccount({ displayName, username });
      dispatch({
        type: "saved",
        account,
        message: "Account settings saved.",
      });
      onDirtyChange(false);
    } catch (cause) {
      const error = personalAccountMutationError(
        cause,
        "Account settings could not be saved.",
      );
      dispatch({
        type: "saveFailed",
        message: error.message,
        fieldErrors: error.fieldErrors,
        confirming: confirmingUsername,
      });
      if (confirmingUsername) return;
      const firstField = error.fieldErrors?.[0]?.field;
      if (firstField === "displayName") displayNameInput.current?.focus();
      if (firstField === "username") usernameInput.current?.focus();
    }
  };

  return (
    <div className="account-settings">
      <SettingsCard
        className="account-profile-card"
        title="Profile"
        actions={
          editing ? undefined : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => dispatch({ type: "edit" })}
            >
              Edit
            </Button>
          )
        }
      >
        {editing ? (
          <div className="account-profile-editor">
            {changeAvatar === undefined ? (
              picture
            ) : (
              <ProfilePictureEditor
                label="Profile picture"
                busy={avatarSaving}
                disabled={saving}
                error={avatarError}
                url={initialAccount.avatarUrl}
                onChange={(file) => void updateAvatar(file)}
              >
                {picture}
              </ProfilePictureEditor>
            )}
            <AccountProfileEditForm
              account={baseline}
              displayName={displayName}
              username={username}
              displayNameError={displayNameError}
              usernameError={usernameError}
              displayNameRef={displayNameInput}
              usernameRef={usernameInput}
              saving={saving}
              canSave={canSave}
              errorMessage={form.status === "error" ? form.message : undefined}
              onChange={change}
              onSave={() => void save()}
              onCancel={reset}
            />
            <ConfirmDialog
              open={confirmingUsername}
              onOpenChange={(open) =>
                dispatch({ type: "confirmOpenChange", open })
              }
              title={`Change your username to @${normalizePersonalAccountUsername(username)}?`}
              description="You can change your username only once. Your old username keeps delivering to you and can't be used by anyone else."
              confirmLabel="Change username"
              pending={saving}
              error={confirmError}
              onConfirm={() => void save()}
            />
          </div>
        ) : (
          <AccountProfileSummary
            picture={picture}
            account={baseline}
            threadCount={threadCount}
          />
        )}
      </SettingsCard>
    </div>
  );
}

export function PersonalAccountSettings({
  onDirtyChange,
}: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const account = useQuery(personalAccountQueryOptions(identity.id));
  const threadCount = useQuery(
    personalAccountThreadCountQueryOptions(identity.id),
  );
  const updateAccount = useMutation(
    updatePersonalAccountMutationOptions(queryClient, identity.id),
  );
  const setAvatar = useMutation(
    setPersonalAvatarMutationOptions(queryClient, identity.id),
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
      <EmptyState
        tone="error"
        icon={<AlertTriangle />}
        title={
          account.error instanceof Error
            ? account.error.message
            : "Account settings could not be loaded."
        }
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void account.refetch()}
          >
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <div className="account-page">
      <SettingsHeading title="Account" />
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
        changeAvatar={setAvatar.mutateAsync}
        avatarSaving={setAvatar.isPending}
        threadCount={threadCount.data?.threadCount}
      />
      {/* A deployment's own cards, such as its plan; public dx has none. */}
      {registeredDeploymentAccountCards.map(({ id, component: Card }) => (
        <Card key={id} />
      ))}
      <AccountUsageSummary userId={identity.id} />
    </div>
  );
}
