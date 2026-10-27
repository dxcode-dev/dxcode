import type { SettingsFieldError, WorkspaceProfileData } from "@dx/api";
import type { WorkspaceSlug } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settingsNavigationState } from "../../../shared/navigation/settings-return.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { ProfilePicture, ProfilePictureEditor } from "../profile-picture.js";
import {
  initialSettingsFormState,
  reduceSettingsFormState,
  settingsMutationError,
} from "../settings-form-state.js";
import {
  SettingsCard,
  SettingsFormActions,
  SettingsHeading,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { LeaveWorkspaceCard } from "./leave-workspace-card.js";
import {
  type WorkspaceMutation,
  workspaceMutationOptions,
} from "./workspace-mutations.js";

const fieldError = (
  errors: ReadonlyArray<SettingsFieldError>,
  field: "displayName" | "shortName",
) => errors.find((error) => error.field === field)?.message;

function CreateWorkspaceCard({
  onDirtyChange,
  onCreated,
  mutateWorkspace,
  saving = false,
}: {
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onCreated: (workspace: WorkspaceProfileData) => void;
  readonly mutateWorkspace?: (
    mutation: WorkspaceMutation,
  ) => Promise<WorkspaceProfileData>;
  readonly saving?: boolean;
}) {
  const [displayName, setDisplayName] = React.useState("");
  const [shortName, setShortName] = React.useState("");
  const [state, dispatch] = React.useReducer(
    reduceSettingsFormState,
    initialSettingsFormState,
  );
  const displayNameInput = React.useRef<HTMLInputElement>(null);
  const shortNameInput = React.useRef<HTMLInputElement>(null);
  const formId = React.useId();
  const displayNameError = fieldError(state.fieldErrors, "displayName");
  const shortNameError = fieldError(state.fieldErrors, "shortName");

  const change = (nextDisplayName: string, nextShortName: string) => {
    setDisplayName(nextDisplayName);
    setShortName(nextShortName);
    const dirty = nextDisplayName.length > 0 || nextShortName.length > 0;
    dispatch({ type: dirty ? "changed" : "reset" });
    onDirtyChange(dirty);
  };

  const reset = () => {
    setDisplayName("");
    setShortName("");
    dispatch({ type: "reset" });
    onDirtyChange(false);
  };

  const save = async () => {
    if (!state.dirty || saving) return;
    try {
      if (mutateWorkspace === undefined) return;
      const workspace = await mutateWorkspace({
        kind: "create",
        input: { displayName, shortName },
      });
      dispatch({ type: "saveSucceeded", message: "Workspace created." });
      onDirtyChange(false);
      onCreated(workspace);
    } catch (cause) {
      const error = settingsMutationError(
        cause,
        "Workspace could not be created.",
      );
      dispatch({
        type: "saveFailed",
        message: error.message,
        fieldErrors: error.fieldErrors,
      });
      const firstField = error.fieldErrors?.[0]?.field;
      if (firstField === "displayName") displayNameInput.current?.focus();
      if (firstField === "shortName") shortNameInput.current?.focus();
    }
  };

  return (
    <div className="workspace-create-card">
      <SettingsCard title="Create workspace">
        <div className="workspace-create-copy">
          <strong>Start a shared workspace</strong>
          <p>
            You can belong to one workspace. Its short name becomes the
            canonical settings URL.
          </p>
        </div>
        <form
          id={formId}
          className="account-profile-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="account-field">
            <label htmlFor={`${formId}-display-name`}>
              Workspace display name
            </label>
            <Input
              ref={displayNameInput}
              id={`${formId}-display-name`}
              name="displayName"
              autoComplete="organization"
              value={displayName}
              aria-invalid={displayNameError === undefined ? undefined : true}
              aria-describedby={
                displayNameError === undefined
                  ? undefined
                  : `${formId}-display-name-error`
              }
              onChange={(event) => change(event.target.value, shortName)}
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
            <label htmlFor={`${formId}-short-name`}>Short name</label>
            <div className="workspace-short-name-input">
              <span aria-hidden="true">/workspaces/</span>
              <Input
                ref={shortNameInput}
                id={`${formId}-short-name`}
                name="shortName"
                autoCapitalize="none"
                spellCheck={false}
                value={shortName}
                aria-invalid={shortNameError === undefined ? undefined : true}
                aria-describedby={`${formId}-short-name-help${
                  shortNameError === undefined
                    ? ""
                    : ` ${formId}-short-name-error`
                }`}
                onChange={(event) => change(displayName, event.target.value)}
              />
            </div>
            <small id={`${formId}-short-name-help`}>
              Globally unique in this dx deployment. Uppercase input is saved in
              lowercase.
            </small>
            {shortNameError === undefined ? null : (
              <small
                id={`${formId}-short-name-error`}
                className="account-field-error"
              >
                {shortNameError}
              </small>
            )}
          </div>
        </form>
      </SettingsCard>
      <SettingsFormActions
        dirty={state.dirty}
        saving={saving}
        message="No workspace membership yet."
        error={state.status === "error" ? state.message : undefined}
        form={formId}
        onSave={() => void save()}
        onReset={reset}
      />
    </div>
  );
}

function WorkspaceProfileRow({
  workspace,
}: {
  readonly workspace: WorkspaceProfileData;
}) {
  const [workspaceIdCopyState, setWorkspaceIdCopyState] = React.useState<
    "idle" | "copied" | "manual"
  >("idle");
  const copyWorkspaceId = () => {
    if (navigator.clipboard === undefined) {
      setWorkspaceIdCopyState("manual");
      return;
    }
    void navigator.clipboard
      .writeText(workspace.id)
      .then(() => setWorkspaceIdCopyState("copied"))
      .catch(() => setWorkspaceIdCopyState("manual"));
  };
  return (
    <div className="workspace-profile-body">
      <ProfilePicture
        className="settings-workspace-mark"
        name={workspace.displayName}
        url={workspace.avatarUrl}
        fallback="W"
      />
      <dl className="account-profile-details">
        <div>
          <dt>Display name</dt>
          <dd className="workspace-profile-name">
            <span>{workspace.displayName}</span>
            <Button
              className="workspace-id-copy"
              size="icon-xs"
              variant="ghost"
              aria-label={
                workspaceIdCopyState === "copied"
                  ? "Workspace ID copied"
                  : "Copy workspace ID"
              }
              title={
                workspaceIdCopyState === "copied"
                  ? "Workspace ID copied"
                  : "Copy workspace ID"
              }
              onClick={copyWorkspaceId}
            >
              {workspaceIdCopyState === "copied" ? (
                <Check aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
            </Button>
          </dd>
        </div>
        <div>
          <dt>Short name</dt>
          <dd>{workspace.shortName}</dd>
        </div>
        {workspaceIdCopyState === "manual" ? (
          <div>
            <dt>Workspace ID</dt>
            <dd>
              <code className="workspace-id-fallback">{workspace.id}</code>
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function WorkspaceProfileFields({
  formId,
  displayName,
  shortName,
  saving,
  fieldErrors,
  displayNameInput,
  shortNameInput,
  onChange,
}: {
  readonly formId: string;
  readonly displayName: string;
  readonly shortName: string;
  readonly saving: boolean;
  readonly fieldErrors: ReadonlyArray<SettingsFieldError>;
  readonly displayNameInput: React.RefObject<HTMLInputElement | null>;
  readonly shortNameInput: React.RefObject<HTMLInputElement | null>;
  readonly onChange: (displayName: string, shortName: string) => void;
}) {
  const displayNameError = fieldError(fieldErrors, "displayName");
  const shortNameError = fieldError(fieldErrors, "shortName");
  return (
    <div className="workspace-profile-fields">
      <div className="account-field">
        <label htmlFor={`${formId}-display-name`}>Display name</label>
        <Input
          ref={displayNameInput}
          id={`${formId}-display-name`}
          name="displayName"
          autoComplete="organization"
          value={displayName}
          readOnly={saving}
          aria-readonly={saving}
          aria-invalid={displayNameError === undefined ? undefined : true}
          aria-describedby={
            displayNameError === undefined
              ? undefined
              : `${formId}-display-name-error`
          }
          onChange={(event) => onChange(event.target.value, shortName)}
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
        <label htmlFor={`${formId}-short-name`}>Short name</label>
        <div className="workspace-short-name-input">
          <span aria-hidden="true">/workspaces/</span>
          <Input
            ref={shortNameInput}
            id={`${formId}-short-name`}
            name="shortName"
            autoCapitalize="none"
            spellCheck={false}
            value={shortName}
            readOnly={saving}
            aria-readonly={saving}
            aria-invalid={shortNameError === undefined ? undefined : true}
            aria-describedby={`${formId}-short-name-help${
              shortNameError === undefined ? "" : ` ${formId}-short-name-error`
            }`}
            onChange={(event) => onChange(displayName, event.target.value)}
          />
        </div>
        <small id={`${formId}-short-name-help`}>
          Changing this changes the workspace's settings URL.
        </small>
        {shortNameError === undefined ? null : (
          <small
            id={`${formId}-short-name-error`}
            className="account-field-error"
          >
            {shortNameError}
          </small>
        )}
      </div>
    </div>
  );
}

export function WorkspaceProfileForm({
  initialWorkspace,
  onDirtyChange,
  onSaved,
  mutateWorkspace,
  saving = false,
  footer,
}: {
  readonly initialWorkspace: WorkspaceProfileData;
  readonly footer?: React.ReactNode;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onSaved: (workspace: WorkspaceProfileData) => void;
  readonly mutateWorkspace?: (
    mutation: WorkspaceMutation,
  ) => Promise<WorkspaceProfileData>;
  readonly saving?: boolean;
}) {
  const [baseline, setBaseline] = React.useState(initialWorkspace);
  const [displayName, setDisplayName] = React.useState<string>(
    initialWorkspace.displayName,
  );
  const [shortName, setShortName] = React.useState<string>(
    initialWorkspace.shortName,
  );
  const [state, dispatch] = React.useReducer(
    reduceSettingsFormState,
    initialSettingsFormState,
  );
  const [editing, setEditing] = React.useState(false);
  const [avatar, setAvatar] = React.useState<{
    readonly busy: boolean;
    readonly error?: string;
  }>({ busy: false });
  const displayNameInput = React.useRef<HTMLInputElement>(null);
  const shortNameInput = React.useRef<HTMLInputElement>(null);
  const formId = React.useId();
  const draftMatchesBaseline =
    displayName === baseline.displayName && shortName === baseline.shortName;
  if (
    initialWorkspace.revision > baseline.revision &&
    draftMatchesBaseline &&
    !saving
  ) {
    setBaseline(initialWorkspace);
    setDisplayName(initialWorkspace.displayName);
    setShortName(initialWorkspace.shortName);
    dispatch({ type: "reset" });
  }
  const authoritativeBaseline =
    initialWorkspace.revision === baseline.revision
      ? initialWorkspace
      : baseline;
  const canEdit =
    authoritativeBaseline.lifecycleState === "active" &&
    (authoritativeBaseline.role === "owner" ||
      authoritativeBaseline.role === "admin");
  const change = (nextDisplayName: string, nextShortName: string) => {
    setDisplayName(nextDisplayName);
    setShortName(nextShortName);
    const dirty =
      nextDisplayName !== authoritativeBaseline.displayName ||
      nextShortName !== authoritativeBaseline.shortName;
    dispatch({ type: dirty ? "changed" : "reset" });
    onDirtyChange(dirty);
  };

  const updateAvatar = async (file: File | null) => {
    if (!canEdit || mutateWorkspace === undefined) return;
    setAvatar({ busy: true });
    try {
      const workspace = await mutateWorkspace({
        kind: "avatar",
        workspaceSlug: authoritativeBaseline.shortName,
        file,
      });
      setAvatar({ busy: false });
      onSaved(workspace);
    } catch (cause) {
      const error = settingsMutationError(
        cause,
        file === null
          ? "Picture could not be removed."
          : "Picture could not be uploaded.",
      );
      setAvatar({
        busy: false,
        error:
          error.fieldErrors?.find(({ field }) => field === "avatar")?.message ??
          error.message,
      });
    }
  };

  const cancel = () => {
    setDisplayName(authoritativeBaseline.displayName);
    setShortName(authoritativeBaseline.shortName);
    dispatch({ type: "reset" });
    onDirtyChange(false);
    setEditing(false);
  };

  const save = async () => {
    if (!canEdit || !state.dirty || saving) return;
    try {
      if (mutateWorkspace === undefined) return;
      const workspace = await mutateWorkspace({
        kind: "update",
        workspaceSlug: authoritativeBaseline.shortName,
        input: {
          displayName,
          shortName,
          expectedRevision: authoritativeBaseline.revision,
        },
      });
      setBaseline(workspace);
      setDisplayName(workspace.displayName);
      setShortName(workspace.shortName);
      dispatch({
        type: "saveSucceeded",
        message: "Workspace profile saved.",
      });
      onDirtyChange(false);
      setEditing(false);
      onSaved(workspace);
    } catch (cause) {
      const error = settingsMutationError(
        cause,
        "Workspace profile could not be saved.",
      );
      dispatch({
        type: "saveFailed",
        message: error.message,
        fieldErrors: error.fieldErrors,
      });
      const firstField = error.fieldErrors?.[0]?.field;
      if (firstField === "displayName") displayNameInput.current?.focus();
      if (firstField === "shortName") shortNameInput.current?.focus();
    }
  };

  return (
    <div className="workspace-profile-settings">
      <SettingsHeading
        title="Workspace"
        description="Manage this workspace's name and URL."
      />
      <SettingsCard
        title="Workspace profile"
        actions={
          canEdit && !editing ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          ) : undefined
        }
      >
        {editing ? (
          <div className="workspace-profile-body">
            <ProfilePictureEditor
              label="Workspace picture"
              busy={avatar.busy}
              disabled={saving && !avatar.busy}
              error={avatar.error}
              url={authoritativeBaseline.avatarUrl}
              onChange={(file) => void updateAvatar(file)}
            >
              <ProfilePicture
                className="settings-workspace-mark"
                name={baseline.displayName}
                url={authoritativeBaseline.avatarUrl}
                fallback="W"
              />
            </ProfilePictureEditor>
            <form
              id={formId}
              className="workspace-profile-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <WorkspaceProfileFields
                formId={formId}
                displayName={displayName}
                shortName={shortName}
                saving={saving}
                fieldErrors={state.fieldErrors}
                displayNameInput={displayNameInput}
                shortNameInput={shortNameInput}
                onChange={change}
              />
              <footer className="workspace-profile-actions">
                <span aria-live="polite">
                  {state.status === "error" ? state.message : null}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={cancel}
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
          <WorkspaceProfileRow workspace={authoritativeBaseline} />
        )}
      </SettingsCard>
      {footer}
    </div>
  );
}

export function WorkspaceProfileSettings({
  workspace,
  workspaceSlug,
  settingsReturnTo,
  onDirtyChange,
  onWorkspaceChanged,
}: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    workspaceMutationOptions(queryClient, identity.id),
  );
  const navigate = useNavigate();
  if (workspace === undefined || workspaceSlug === undefined) {
    return (
      <CreateWorkspaceCard
        onDirtyChange={onDirtyChange}
        mutateWorkspace={mutation.mutateAsync}
        saving={mutation.isPending}
        onCreated={(created) => {
          onWorkspaceChanged?.(created);
          void navigate({
            to: "/workspaces/$workspaceSlug",
            params: { workspaceSlug: created.shortName as WorkspaceSlug },
            replace: true,
            state: settingsNavigationState(settingsReturnTo),
            ignoreBlocker: true,
          });
        }}
      />
    );
  }
  return (
    <WorkspaceProfileForm
      initialWorkspace={workspace}
      footer={
        workspace.role === "owner" ? undefined : (
          <LeaveWorkspaceCard
            workspaceSlug={workspace.shortName}
            displayName={workspace.displayName}
          />
        )
      }
      mutateWorkspace={mutation.mutateAsync}
      saving={mutation.isPending}
      onDirtyChange={onDirtyChange}
      onSaved={(saved) => {
        onWorkspaceChanged?.(saved);
        if (saved.shortName !== workspaceSlug) {
          void navigate({
            to: "/workspaces/$workspaceSlug",
            params: { workspaceSlug: saved.shortName as WorkspaceSlug },
            replace: true,
            state: settingsNavigationState(settingsReturnTo),
            ignoreBlocker: true,
          });
        }
      }}
    />
  );
}
