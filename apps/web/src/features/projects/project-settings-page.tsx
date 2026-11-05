import { Dialog } from "@base-ui/react/dialog";
import type {
  OrbResolvedProvider,
  ProjectData,
  SettingsContextData,
} from "@dx/api";
import {
  builtInShipPrompt,
  type CommitAuthorPreference,
  canonicalGitRemoteAlias,
  MAX_PROJECT_REMOTE_ALIASES,
  MAX_SHIP_PROMPT_LENGTH,
  type PluginScope,
  type ProjectId,
  type ProjectShipAction,
  type ProviderRepositoryId,
  type RunnerProfile,
  type RunnerProfileCatalog,
  type RunnerProfileId,
  type UserId,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { Copy, FolderCog, KeyRound, Plus, Upload, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import { useCloseSettingsOnEscape } from "../../shared/navigation/close-settings-on-escape.js";
import { settingsNavigationState } from "../../shared/navigation/settings-return.js";
import { settle } from "../../shared/settle.js";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { Input } from "../../shared/ui/input.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../shared/ui/modal-surface.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { OrbSizePicker } from "../../shared/ui/orb-size-grid.js";
import {
  SettingsCard,
  SettingsFormActions,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  type SettingsSelectOption,
  SettingsToggle,
} from "../../shared/ui/settings.js";
import { Textarea } from "../../shared/ui/textarea.js";
import { UnsavedChangesGuard } from "../../shared/ui/unsaved-changes-guard.js";
import {
  bitbucketConnectionQueryOptions,
  bitbucketRepositoriesQueryOptions,
} from "../settings/integrations/bitbucket-queries.js";
import { orbProvidersQueryOptions } from "../settings/orb-providers/orb-providers-queries.js";
import {
  type ProjectDefaultsTarget,
  projectDefaultsQueryOptions,
} from "../settings/project-defaults/project-defaults-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { ChangeOwnerCard } from "./change-owner-card.js";
import { DeleteProjectCard } from "./delete-project-card.js";
import { AdditionalRepositoriesPicker } from "./new-project-dialog.js";
import { buildProjectMetadataChanges } from "./project-metadata.js";
import {
  rebindProjectSourceMutationOptions,
  updateProjectMutationOptions,
  uploadProjectIconMutationOptions,
} from "./project-mutations.js";
import { ProjectOrbFilesCard } from "./project-orb-files-card.js";
import { ProjectOrbScriptsCard } from "./project-orb-scripts-card.js";
import { projectQueryOptions } from "./project-queries.js";
import { ProjectRepositoryIcon } from "./project-repository-icon.js";
import {
  isProjectSettingsSection,
  type ProjectSettingsSection,
} from "./project-settings-sections.js";
import {
  connectedRepositoryOptions,
  type RepositoryOption,
} from "./repository-options.js";
import { RepositoryPicker } from "./repository-picker.js";
import { sourceGrantsQueryOptions } from "./source-grant-queries.js";

const sections = [
  { id: "general", label: "General", icon: FolderCog },
  {
    id: "orb",
    label: EXECUTION_ENVIRONMENT_DISPLAY_NAME,
    icon: OrbIcon,
  },
  { id: "secrets", label: "Secrets & Env Vars", icon: KeyRound },
] as const;

export function ProjectSettingsPage({
  renderEnvironmentSettings,
}: {
  readonly renderEnvironmentSettings: (
    projectId: ProjectId,
    onDirtyChange: (dirty: boolean) => void,
  ) => React.ReactNode;
}) {
  const params = useParams({ strict: false }) as {
    projectId: ProjectId;
    section?: string;
  };
  const { identity } = useAuthenticatedIdentity();
  const projectQuery = useQuery(
    projectQueryOptions(identity.id, params.projectId),
  );
  const navigate = useNavigate();
  // Escape closes like the Close link; a dirty form's guard asks first.
  useCloseSettingsOnEscape(
    () =>
      void navigate({
        to: "/projects/$projectId",
        params: { projectId: params.projectId },
      }),
  );
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const project = projectQuery.data;
  const section: ProjectSettingsSection = isProjectSettingsSection(
    params.section,
  )
    ? params.section
    : "general";
  const ownerName =
    project?.workspaceId === undefined
      ? identity.name
      : (settingsQuery.data?.workspace?.displayName ?? "Workspace");
  if (project === undefined)
    return (
      <div className="project-settings-state">
        {projectQuery.isPending ? "Loading project…" : "Project not found."}
      </div>
    );
  // A workspace Project's settings belong to its creator and admins.
  const canManage = project.viewerAccess?.canManage !== false;
  return (
    <div className="project-settings-overlay">
      <section
        className="project-settings-modal"
        aria-label={`Project Settings — ${project.name}`}
      >
        <header>
          <strong>Project Settings — {project.name}</strong>
          <Link
            aria-label="Close project settings"
            to="/projects/$projectId"
            params={{ projectId: project.id }}
          >
            <X />
          </Link>
        </header>
        <div className="project-settings-layout">
          <nav aria-label="Project settings sections">
            {sections.map((item) => (
              <Link
                key={item.id}
                className={section === item.id ? "active" : ""}
                to="/projects/$projectId/settings/$section"
                params={{ projectId: project.id, section: item.id }}
              >
                <item.icon />
                {item.label}
              </Link>
            ))}
          </nav>
          <main>
            {canManage ? null : (
              <p className="project-settings-state" role="status">
                Only the project's creator or a workspace admin can change its
                settings.
              </p>
            )}
            {canManage && section === "general" ? (
              <GeneralProjectSettings
                key={project.id}
                project={project}
                ownerName={ownerName}
                userId={identity.id}
                viewer={identity}
                workspace={settingsQuery.data?.workspace}
              />
            ) : null}
            {canManage && section === "orb" ? (
              <OrbProjectSettings
                key={project.id}
                project={project}
                workspace={settingsQuery.data?.workspace}
                settingsPending={
                  settingsQuery.data === undefined &&
                  settingsQuery.error === null
                }
                userId={identity.id}
              />
            ) : null}
            {canManage && section === "secrets" ? (
              <ProjectSecretsSettings
                projectId={project.id}
                renderEnvironmentSettings={renderEnvironmentSettings}
              />
            ) : null}
          </main>
        </div>
      </section>
    </div>
  );
}

const sameUrls = (
  left: ReadonlyArray<RepositoryOption>,
  right: ReadonlyArray<RepositoryOption>,
) =>
  left.map(({ webUrl }) => webUrl.toLowerCase()).join("\n") ===
  right.map(({ webUrl }) => webUrl.toLowerCase()).join("\n");

/** The General form: edits drafted over the last saved project. */
type GeneralDraft = {
  readonly baseline: ProjectData;
  readonly name: string;
  readonly description: string;
  readonly shipAction: ProjectShipAction;
  /** The custom Ship prompt, kept when another behavior is chosen. */
  readonly shipPrompt?: string;
  readonly commitAuthor: CommitAuthorPreference;
  readonly dxCoAuthor: boolean;
  /**
   * Undefined keeps the bound repository; null is text that names none, which
   * Save refuses.
   */
  readonly repository?: RepositoryOption | null;
  /** Undefined keeps the saved list. */
  readonly additional?: ReadonlyArray<RepositoryOption>;
  /** Undefined keeps the saved list. */
  readonly aliases?: ReadonlyArray<string>;
  readonly error?: string;
};

type GeneralAction =
  | {
      readonly type: "edit";
      readonly edit: Partial<
        Pick<
          GeneralDraft,
          | "name"
          | "description"
          | "repository"
          | "additional"
          | "aliases"
          | "shipAction"
          | "shipPrompt"
          | "commitAuthor"
          | "dxCoAuthor"
        >
      >;
    }
  /** Start over from a saved project, dropping every edit. */
  | { readonly type: "reset"; readonly project: ProjectData }
  /** A request saved part of the project; keep the remaining edits. */
  | {
      readonly type: "rebased";
      readonly project: ProjectData;
      readonly rebound?: boolean;
      readonly error?: string;
    }
  | { readonly type: "error"; readonly error?: string };

const generalDraft = (project: ProjectData): GeneralDraft => ({
  baseline: project,
  name: project.name,
  description: project.description ?? "",
  ...savedCommitsAndShip(project),
});

/** The Ship Behavior and commit settings as `project` saved them. */
const savedCommitsAndShip = (project: ProjectData) => ({
  shipAction: project.configuration.shipAction,
  ...(project.configuration.shipPrompt === undefined
    ? {}
    : { shipPrompt: project.configuration.shipPrompt }),
  commitAuthor: project.configuration.commitAuthor.preference,
  dxCoAuthor: project.configuration.dxCoAuthor,
});

/** The Ship and commit fields `draft` changes, as the update request names them. */
const commitsAndShipChanges = (draft: GeneralDraft) => {
  const saved = savedCommitsAndShip(draft.baseline);
  return {
    ...(draft.shipAction === saved.shipAction
      ? {}
      : { shipAction: draft.shipAction }),
    ...(draft.shipPrompt === undefined || draft.shipPrompt === saved.shipPrompt
      ? {}
      : { shipPrompt: draft.shipPrompt }),
    ...(draft.commitAuthor === saved.commitAuthor
      ? {}
      : { commitAuthor: draft.commitAuthor }),
    ...(draft.dxCoAuthor === saved.dxCoAuthor
      ? {}
      : { dxCoAuthor: draft.dxCoAuthor }),
  };
};

const reduceGeneral = (
  draft: GeneralDraft,
  action: GeneralAction,
): GeneralDraft => {
  switch (action.type) {
    case "edit": {
      // A save error describes the draft it refused; editing starts over.
      const { error: _stale, ...rest } = draft;
      return { ...rest, ...action.edit };
    }
    case "reset":
      return generalDraft(action.project);
    case "rebased": {
      const { error: _cleared, repository, ...rest } = draft;
      return {
        ...rest,
        baseline: action.project,
        ...(action.rebound || repository === undefined ? {} : { repository }),
        ...(action.error === undefined ? {} : { error: action.error }),
      };
    }
    case "error": {
      const { error: _cleared, ...rest } = draft;
      return action.error === undefined
        ? rest
        : { ...rest, error: action.error };
    }
  }
};

const failure = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

/**
 * Name, icon, description, and repositories in one card with one Save. The
 * icon uploads as soon as it is chosen and keeps unsaved edits.
 */
function GeneralProjectSettings({
  project,
  ownerName,
  userId,
  viewer,
  workspace,
}: {
  readonly project: ProjectData;
  readonly ownerName: string;
  readonly userId: UserId;
  /** The signed-in person, who authors commits when the project asks for them. */
  readonly viewer: { readonly name: string; readonly email: string };
  readonly workspace: SettingsContextData["workspace"];
}) {
  const queryClient = useQueryClient();
  const updateMutation = useMutation(
    updateProjectMutationOptions(queryClient, userId, project.id),
  );
  const rebindMutation = useMutation(
    rebindProjectSourceMutationOptions(queryClient, userId, project.id),
  );
  const iconMutation = useMutation(
    uploadProjectIconMutationOptions(queryClient, userId, project.id),
  );
  const repositories = useAuthorizedRepositories(userId);
  // The draft starts from the project it mounted with; a newer project
  // replaces it below only while nothing is edited.
  const [draft, dispatch] = React.useReducer(
    reduceGeneral,
    project,
    generalDraft,
  );
  const { baseline } = draft;
  const additionalOptions = repositories.options.filter(
    (option) =>
      option.webUrl.toLowerCase() !== baseline.repository?.webUrl.toLowerCase(),
  );
  const savedAdditional = (baseline.additionalRepositories ?? []).map(
    (repository): RepositoryOption =>
      additionalOptions.find(
        (option) =>
          option.webUrl.toLowerCase() === repository.webUrl.toLowerCase(),
      ) ?? {
        value: `url:${repository.webUrl.toLowerCase()}`,
        label: repository.webUrl,
        fullName: repository.fullName,
        webUrl: repository.webUrl,
      },
  );
  const additional = draft.additional ?? savedAdditional;
  const additionalChanged = !sameUrls(additional, savedAdditional);
  const bound = boundOption(baseline.repository, repositories.options);
  const repositoryChanged =
    draft.repository !== undefined && draft.repository?.value !== bound?.value;
  const savedAliases = baseline.remoteAliases ?? [];
  const aliases = draft.aliases ?? savedAliases;
  const aliasesChanged = aliases.join("\n") !== savedAliases.join("\n");
  const saving =
    updateMutation.isPending ||
    rebindMutation.isPending ||
    iconMutation.isPending;
  const shipAndCommits = commitsAndShipChanges(draft);
  const dirty =
    draft.name !== baseline.name ||
    draft.description !== (baseline.description ?? "") ||
    repositoryChanged ||
    additionalChanged ||
    aliasesChanged ||
    Object.keys(shipAndCommits).length > 0;
  if (baseline.revision < project.revision && !dirty && !saving)
    dispatch({ type: "reset", project });
  const edit = (next: Extract<GeneralAction, { type: "edit" }>["edit"]) =>
    dispatch({ type: "edit", edit: next });
  const save = async () => {
    const metadata = buildProjectMetadataChanges(
      baseline.name,
      draft.name,
      draft.description,
    );
    if (!metadata.ok) {
      dispatch({ type: "error", error: metadata.error });
      return;
    }
    if (repositoryChanged && draft.repository == null) {
      dispatch({ type: "error", error: REPOSITORY_URL_HELP });
      return;
    }
    dispatch({ type: "error" });
    const rebindTo = repositoryChanged ? draft.repository : undefined;
    // Rebind first: when it is refused, nothing else has changed.
    const rebound =
      rebindTo == null
        ? { ok: true as const, value: baseline }
        : await settle(() =>
            rebindMutation.mutateAsync(
              rebindTo.connected === undefined
                ? { revision: baseline.revision, url: rebindTo.webUrl }
                : {
                    revision: baseline.revision,
                    grantId: rebindTo.connected.grantId,
                    provider: rebindTo.connected.provider,
                    ...(rebindTo.connected.workspaceId === undefined
                      ? {}
                      : { workspaceId: rebindTo.connected.workspaceId }),
                    providerRepositoryId: rebindTo.connected
                      .repositoryId as ProviderRepositoryId,
                  },
            ),
          );
    if (!rebound.ok) {
      dispatch({
        type: "error",
        error: failure(rebound.error, "The repository could not be changed."),
      });
      return;
    }
    const saved = await settle(() =>
      updateMutation.mutateAsync({
        revision: rebound.value.revision,
        ...metadata.changes,
        ...shipAndCommits,
        ...(additionalChanged
          ? { additionalRepositories: additional.map(({ webUrl }) => webUrl) }
          : {}),
        ...(aliasesChanged ? { remoteAliases: aliases } : {}),
      }),
    );
    if (saved.ok) dispatch({ type: "reset", project: saved.value });
    // The rebind stands; keep the other edits on top of it.
    else
      dispatch({
        type: "rebased",
        project: rebound.value,
        rebound: true,
        error: failure(saved.error, "Project settings could not be saved."),
      });
  };
  const upload = async (file: File) => {
    dispatch({ type: "error" });
    const saved = await settle(() =>
      iconMutation.mutateAsync({ revision: baseline.revision, file }),
    );
    // The icon has its own request; unsaved edits stay in the form.
    if (saved.ok) dispatch({ type: "rebased", project: saved.value });
    else
      dispatch({
        type: "error",
        error: failure(saved.error, "Icon could not be uploaded."),
      });
    iconMutation.reset();
  };
  return (
    <div className="project-settings-content project-settings-general">
      <SettingsCard className="project-general-card">
        <ProjectIdentityRow
          ownerName={ownerName}
          name={draft.name}
          project={baseline}
          disabled={saving}
          onNameChange={(name) => edit({ name })}
          onIconChosen={(file) => void upload(file)}
        />
        <SettingsRow
          title="Description"
          control={
            <Input
              className="project-description-input"
              aria-label="Project description"
              value={draft.description}
              disabled={saving}
              maxLength={500}
              onChange={(event) => edit({ description: event.target.value })}
            />
          }
        />
        <GitRepositoryRow
          key={`${baseline.repository?.bindingRevision ?? 0}`}
          bound={baseline.repository}
          options={repositories.options}
          value={draft.repository === undefined ? bound : draft.repository}
          loading={repositories.loading}
          hint={repositories.hint}
          disabled={saving}
          connect={repositories.connect}
          retrying={repositories.fetching}
          onRetry={repositories.retry}
          onValueChange={(repository) =>
            edit({ repository: repository ?? null })
          }
        />
        <GitRemoteAliasesSection
          value={aliases}
          disabled={saving}
          onValueChange={(next) => edit({ aliases: next })}
        />
        <ShipBehaviorRow
          action={draft.shipAction}
          prompt={draft.shipPrompt}
          disabled={saving}
          onChange={(shipAction, shipPrompt) =>
            edit({
              shipAction,
              ...(shipPrompt === undefined ? {} : { shipPrompt }),
            })
          }
        />
        <CommitAuthorRows
          author={draft.commitAuthor}
          dxCoAuthor={draft.dxCoAuthor}
          saved={baseline.configuration.commitAuthor}
          viewer={viewer}
          workspace={baseline.workspaceId !== undefined}
          disabled={saving}
          onAuthorChange={(commitAuthor) => edit({ commitAuthor })}
          onCoAuthorChange={(dxCoAuthor) => edit({ dxCoAuthor })}
        />
        <AdditionalRepositoriesSection
          value={additional}
          options={additionalOptions}
          primaryWebUrl={baseline.repository?.webUrl}
          loading={repositories.loading}
          disabled={saving}
          onValueChange={(next) => edit({ additional: next })}
        />
        <SettingsFormActions
          dirty={dirty}
          saving={saving}
          error={draft.error}
          showStatus={false}
          showReset={false}
          onSave={() => void save()}
          onReset={() => undefined}
        />
      </SettingsCard>
      <ChangeOwnerCard
        project={project}
        userId={userId}
        workspace={workspace}
      />
      <DeleteProjectCard project={project} userId={userId} />
      <UnsavedChangesGuard
        dirty={dirty}
        onDiscard={() => dispatch({ type: "reset", project })}
      />
    </div>
  );
}

const shipActionLabels = [
  ["ship", "Ship"],
  ["push", "Push to Branch"],
  ["custom", "Custom Ship"],
] as const satisfies ReadonlyArray<SettingsSelectOption>;

/**
 * The main action in each Thread's Changes pane. Custom Ship opens the prompt
 * editor, which changes only the form: nothing is stored until Save.
 */
function ShipBehaviorRow({
  action,
  prompt,
  disabled,
  onChange,
}: {
  readonly action: ProjectShipAction;
  readonly prompt: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (action: ProjectShipAction, prompt?: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  return (
    <SettingsRow
      title="Ship Behavior"
      description="Choose the main action in the Changes pane of every Thread in this project."
      control={
        <div className="project-ship-control">
          {action === "custom" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => setEditing(true)}
            >
              Edit Prompt
            </Button>
          ) : null}
          <SettingsSelect
            label="Ship Behavior"
            value={action}
            disabled={disabled}
            options={shipActionLabels}
            onValueChange={(next) => {
              if (next === "custom") setEditing(true);
              else onChange(next as ProjectShipAction);
            }}
          />
          {editing ? (
            <ShipPromptDialog
              initial={prompt ?? builtInShipPrompt("ship")}
              onCancel={() => setEditing(false)}
              onUse={(text) => {
                setEditing(false);
                onChange("custom", text);
              }}
            />
          ) : null}
        </div>
      }
    />
  );
}

/** Edits the custom Ship prompt; Use Custom Ship returns it to the form. */
function ShipPromptDialog({
  initial,
  onCancel,
  onUse,
}: {
  readonly initial: string;
  readonly onCancel: () => void;
  readonly onUse: (prompt: string) => void;
}) {
  const [text, setText] = React.useState(initial);
  const input = React.useRef<HTMLTextAreaElement>(null);
  const tooLong = text.length > MAX_SHIP_PROMPT_LENGTH;
  const blank = text.trim() === "";
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <ModalSurface
        className="ship-prompt-dialog"
        ariaLabel="Customize Ship Prompt"
        initialFocus={input}
      >
        <ModalSurfaceHeader>
          <Dialog.Title className="ship-prompt-dialog-title">
            Customize Ship Prompt
          </Dialog.Title>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        <form
          className="ship-prompt-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blank && !tooLong) onUse(text);
          }}
        >
          <Dialog.Description>
            Ship sends this as your message to the agent, exactly as written.
          </Dialog.Description>
          <Textarea
            ref={input}
            aria-label="Custom Ship prompt"
            aria-invalid={tooLong || blank || undefined}
            value={text}
            rows={12}
            onChange={(event) => setText(event.target.value)}
          />
          <span
            className="ship-prompt-dialog-count"
            data-invalid={tooLong || undefined}
          >
            {text.length.toLocaleString("en-US")} /{" "}
            {MAX_SHIP_PROMPT_LENGTH.toLocaleString("en-US")}
          </span>
          <footer>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={blank || tooLong}>
              Use Custom Ship
            </Button>
          </footer>
        </form>
      </ModalSurface>
    </Dialog.Root>
  );
}

const DX_COMMIT_IDENTITY = "dxcodeagent <agent@dxcode.dev>";

/**
 * Who authors commits in this project's Orbs, and whether dx is credited as
 * co-author of the person's commits. dx as the author is never its own
 * co-author, so the switch applies only to the person's commits.
 */
function CommitAuthorRows({
  author,
  dxCoAuthor,
  saved,
  viewer,
  workspace,
  disabled,
  onAuthorChange,
  onCoAuthorChange,
}: {
  readonly author: CommitAuthorPreference;
  readonly dxCoAuthor: boolean;
  readonly saved: ProjectData["configuration"]["commitAuthor"];
  readonly viewer: { readonly name: string; readonly email: string };
  readonly workspace: boolean;
  readonly disabled: boolean;
  readonly onAuthorChange: (author: CommitAuthorPreference) => void;
  readonly onCoAuthorChange: (dxCoAuthor: boolean) => void;
}) {
  const person =
    saved.preference === "user"
      ? `${saved.name} <${saved.email}>`
      : `${viewer.name} <${viewer.email}>`;
  const description =
    author === "dx"
      ? `Commits made in this project's Orbs are authored by ${DX_COMMIT_IDENTITY}.`
      : workspace
        ? `Each member authors the commits made in their Threads; the project owner's are authored by ${person}.`
        : `Commits made in this project's Orbs are authored by you as ${person}.`;
  return (
    <>
      <SettingsRow
        title="Commit Author"
        description={description}
        control={
          <SettingsSelect
            label="Commit Author"
            value={author}
            disabled={disabled}
            options={[
              ["dx", "dx"],
              ["user", workspace ? "Each member" : "You"],
            ]}
            onValueChange={(next) =>
              onAuthorChange(next as CommitAuthorPreference)
            }
          />
        }
      />
      <SettingsRow
        title="Add dx as co-author"
        description={
          author === "dx"
            ? "dx authors this project's commits, so it is not also their co-author."
            : `Adds Co-authored-by: ${DX_COMMIT_IDENTITY} to commits a person authors in this project.`
        }
        control={
          <SettingsToggle
            label="Add dx as co-author"
            checked={author === "user" && dxCoAuthor}
            disabled={disabled || author === "dx"}
            onCheckedChange={onCoAuthorChange}
          />
        }
      />
    </>
  );
}

/** Name beside its owner, and the icon, which uploads as soon as it is chosen. */
function ProjectIdentityRow({
  ownerName,
  name,
  project,
  disabled,
  onNameChange,
  onIconChosen,
}: {
  readonly ownerName: string;
  readonly name: string;
  readonly project: ProjectData;
  readonly disabled: boolean;
  readonly onNameChange: (name: string) => void;
  readonly onIconChosen: (file: File) => void;
}) {
  return (
    <div className="project-identity-row">
      <div className="project-identity-field">
        <strong>Name</strong>
        <div className="project-name-control">
          <span className="project-owner-initial" aria-hidden="true">
            {ownerName.slice(0, 1).toUpperCase()}
          </span>
          <span className="project-owner-name">{ownerName}</span>
          <span aria-hidden="true">/</span>
          <Input
            className="project-name-input"
            aria-label="Project name"
            value={name}
            disabled={disabled}
            maxLength={64}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </div>
      </div>
      <div className="project-identity-field project-identity-icon">
        <strong>Project Icon</strong>
        <div className="project-icon-control">
          <span className="project-settings-icon">
            {project.iconUrl ? (
              <img src={project.iconUrl} alt="" />
            ) : (
              project.name.slice(0, 1).toUpperCase()
            )}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              document.getElementById("project-icon-input")?.click()
            }
          >
            <Upload aria-hidden="true" />
            Set Icon
          </Button>
          <input
            id="project-icon-input"
            className="visually-hidden"
            type="file"
            aria-label="Project icon image"
            tabIndex={-1}
            disabled={disabled}
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) onIconChosen(file);
            }}
          />
        </div>
      </div>
    </div>
  );
}

const REPOSITORY_URL_HELP =
  "Enter an HTTPS Git URL without credentials, such as https://github.com/owner/repo.";

/** The bound repository as a picker option: its connection's, or its URL. */
const boundOption = (
  repository: ProjectData["repository"],
  options: ReadonlyArray<RepositoryOption>,
): RepositoryOption | undefined =>
  repository === undefined
    ? undefined
    : (options.find(
        (option) =>
          option.connected?.provider === repository.provider &&
          option.webUrl.toLowerCase() === repository.webUrl.toLowerCase(),
      ) ?? {
        value: `url:${repository.webUrl.toLowerCase()}`,
        label: repository.webUrl,
        fullName: repository.fullName,
        webUrl: repository.webUrl,
      });

/**
 * The repository URL, edited in place or picked from the person's
 * connections, with Clone to copy a `git clone` command for the saved one.
 */
function GitRepositoryRow({
  bound,
  options,
  value,
  loading,
  hint,
  connect,
  disabled,
  retrying,
  onRetry,
  onValueChange,
}: {
  readonly bound: ProjectData["repository"];
  readonly options: ReadonlyArray<RepositoryOption>;
  /** Null: the field names no repository; Save says why. */
  readonly value: RepositoryOption | null | undefined;
  readonly loading: boolean;
  readonly hint?: string;
  /** No connection reaches a repository: link to the integrations that add one. */
  readonly connect: boolean;
  readonly disabled: boolean;
  readonly retrying: boolean;
  readonly onRetry?: () => void;
  readonly onValueChange: (repository: RepositoryOption | undefined) => void;
}) {
  return (
    <SettingsRow
      title="Git Repository"
      description={hint}
      control={
        <div className="project-repository-control">
          <RepositoryPicker
            inPlace
            options={options}
            value={value ?? undefined}
            loading={loading ? "Loading repositories…" : undefined}
            disabled={disabled}
            onValueChange={onValueChange}
          />
          {bound === undefined ? null : (
            <>
              <a
                className={buttonVariants({
                  size: "icon-xs",
                  variant: "ghost",
                })}
                href={bound.webUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Open repository"
                title="Open repository"
              >
                <ProjectRepositoryIcon provider={bound.provider} />
              </a>
              <Button
                size="xs"
                variant="outline"
                title="Copy a git clone command"
                onClick={() =>
                  copyCloneCommand(bound.cloneUrl ?? `${bound.webUrl}.git`)
                }
              >
                <Copy aria-hidden="true" />
                Clone
              </Button>
            </>
          )}
          {connect ? <ConnectRepositoryLink /> : null}
          {onRetry === undefined ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={retrying}
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
        </div>
      }
    />
  );
}

const copyCloneCommand = (cloneUrl: string) => {
  const command = `git clone ${cloneUrl}`;
  if (navigator.clipboard === undefined) {
    toast(command, { description: "Copy this command to clone." });
    return;
  }
  void navigator.clipboard
    .writeText(command)
    .then(() => toast.success("Copied git clone command"))
    .catch(() =>
      toast(command, { description: "Copy this command to clone." }),
    );
};

/**
 * Other URLs of the same repository, such as a mirror or an SSH remote. dx
 * recognizes the project by them; nothing clones them.
 */
function GitRemoteAliasesSection({
  value,
  disabled,
  onValueChange,
}: {
  readonly value: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onValueChange: (value: ReadonlyArray<string>) => void;
}) {
  const [text, setText] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);
  const full = value.length >= MAX_PROJECT_REMOTE_ALIASES;
  const add = () => {
    const alias = canonicalGitRemoteAlias(text);
    if (alias === undefined) {
      setInvalid(true);
      return;
    }
    if (!value.some((saved) => saved.toLowerCase() === alias.url.toLowerCase()))
      onValueChange([...value, alias.url]);
    setText("");
    setInvalid(false);
  };
  return (
    <div className="project-additional-repositories project-remote-aliases">
      <div className="settings-row-copy">
        <div className="settings-row-title">
          <strong>Git Remote Aliases</strong>
        </div>
        <p>
          {invalid
            ? "Enter an HTTPS or SSH Git URL without credentials."
            : "Other URLs of this repository, such as a mirror or an SSH remote."}
        </p>
      </div>
      {value.length === 0 ? null : (
        <ul aria-label="Git remote aliases">
          {value.map((alias) => (
            <li key={alias} title={alias}>
              <span>{alias}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${alias}`}
                disabled={disabled}
                onClick={() =>
                  onValueChange(value.filter((saved) => saved !== alias))
                }
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="project-remote-alias-form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          className="project-remote-alias-input"
          aria-label="Git remote alias"
          aria-invalid={invalid || undefined}
          placeholder="git@github.com:owner/repo.git"
          value={text}
          disabled={disabled || full}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
          }}
        />
        <Button
          type="submit"
          size="xs"
          variant="outline"
          aria-label="Add alias"
          disabled={disabled || full || text.trim() === ""}
        >
          <Plus aria-hidden="true" />
          Add
        </Button>
      </form>
    </div>
  );
}

/** Opens the GitHub and Bitbucket connections in Integrations & MCP. */
function ConnectRepositoryLink() {
  const returnTo = useLocation({ select: (location) => location.href });
  return (
    <Link
      className={buttonVariants({ size: "xs", variant: "outline" })}
      to="/settings/$section"
      params={{ section: "integrations" }}
      state={settingsNavigationState(returnTo)}
    >
      Connect
    </Link>
  );
}

/** Other repositories cloned beside the primary one, listed with Remove. */
function AdditionalRepositoriesSection({
  value,
  options,
  primaryWebUrl,
  loading,
  disabled,
  onValueChange,
}: {
  readonly value: ReadonlyArray<RepositoryOption>;
  readonly options: ReadonlyArray<RepositoryOption>;
  readonly primaryWebUrl: string | undefined;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly onValueChange: (value: ReadonlyArray<RepositoryOption>) => void;
}) {
  return (
    <div className="project-additional-repositories">
      <div className="settings-row-copy">
        <div className="settings-row-title">
          <strong>Additional Repositories</strong>
        </div>
        <p>
          Clone other repositories into ~/workspace/repos in this project's
          Orbs.
        </p>
      </div>
      {value.length === 0 ? null : (
        <ul aria-label="Additional repositories">
          {value.map((repository) => (
            <li key={repository.value} title={repository.webUrl}>
              <span>
                {repository.connected === undefined
                  ? repository.webUrl
                  : repository.fullName}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${repository.fullName}`}
                disabled={disabled}
                onClick={() =>
                  onValueChange(
                    value.filter(({ value: key }) => key !== repository.value),
                  )
                }
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AdditionalRepositoriesPicker
        addTrigger
        options={options}
        primaryWebUrl={primaryWebUrl}
        value={value}
        loading={loading ? "Loading repositories…" : undefined}
        disabled={disabled}
        onValueChange={onValueChange}
      />
    </div>
  );
}

/**
 * GitHub and Bitbucket repositories the person's own connections reach, as
 * rebind choices and as additional-repository options, with a short hint when
 * they are loading, unreachable, or absent.
 */
function useAuthorizedRepositories(userId: UserId) {
  const grantsQuery = useQuery(sourceGrantsQueryOptions(userId));
  const bitbucketConnectionQuery = useQuery(
    bitbucketConnectionQueryOptions(userId),
  );
  const bitbucketConnection =
    bitbucketConnectionQuery.data?.connection?.status === "active"
      ? bitbucketConnectionQuery.data.connection
      : undefined;
  const bitbucketRepositoriesQuery = useQuery(
    bitbucketRepositoriesQueryOptions(userId, bitbucketConnection?.id),
  );
  const bitbucketRepositories =
    bitbucketConnection !== undefined &&
    bitbucketRepositoriesQuery.data?.connectionId === bitbucketConnection.id
      ? bitbucketRepositoriesQuery.data.repositories
      : [];
  const loading =
    grantsQuery.isPending ||
    bitbucketConnectionQuery.isPending ||
    (bitbucketConnection !== undefined && bitbucketRepositoriesQuery.isPending);
  const failed =
    grantsQuery.error !== null ||
    bitbucketConnectionQuery.error !== null ||
    bitbucketRepositoriesQuery.error !== null;
  // Private and workspace Projects bind repositories the current user reaches
  // through their own connections.
  const options = connectedRepositoryOptions(
    grantsQuery.data ?? [],
    bitbucketConnection?.id,
    bitbucketRepositories,
  );
  return {
    options,
    loading,
    hint: loading
      ? "Loading authorized repositories…"
      : failed
        ? "Your repositories could not be loaded."
        : options.length === 0
          ? "Connect GitHub or Bitbucket to choose a repository."
          : undefined,
    connect: !loading && !failed && options.length === 0,
    fetching:
      grantsQuery.isFetching ||
      bitbucketConnectionQuery.isFetching ||
      bitbucketRepositoriesQuery.isFetching,
    retry:
      loading || !failed
        ? undefined
        : () => {
            void Promise.all([
              grantsQuery.refetch(),
              bitbucketConnectionQuery.refetch(),
              ...(bitbucketConnection === undefined
                ? []
                : [bitbucketRepositoriesQuery.refetch()]),
            ]);
          },
  };
}

/**
 * Who bills an Orb on the account a Thread in this project starts on: the
 * provider, for a person's or workspace's own connection. The deployment's
 * account has no note; its sizes show the deployment's own cost label.
 */
const orbBillingNote = (scope: PluginScope, providerName: string) =>
  scope === "deployment"
    ? undefined
    : `Billed by ${providerName} to ${
        scope === "workspace" ? "the workspace's" : "your"
      } account, paused when inactive`;

type OrbSizeGroupDraft = {
  readonly key: RunnerProfile["adapter"];
  readonly name: string;
  readonly hint?: string;
  readonly billing?: string;
  readonly available: boolean;
  readonly profiles: ReadonlyArray<RunnerProfile>;
};

/**
 * The Orb sizes this person can choose for the project, grouped by provider in
 * catalog order: only providers in the resolved set (the same set the
 * new-Thread picker offers). A saved default on a provider outside that set
 * keeps a group holding just that size, marked not available, so it is not
 * silently lost. One available provider needs no heading.
 */
const orbSizeGroups = (
  catalog: RunnerProfileCatalog,
  resolved: ReadonlyArray<OrbResolvedProvider>,
  savedProfileId: RunnerProfileId,
) => {
  const groups = [
    ...new Set(catalog.profiles.map(({ adapter }) => adapter)),
  ].flatMap((adapter): ReadonlyArray<OrbSizeGroupDraft> => {
    const provider = catalog.providers?.find(
      (provider) => provider.adapter === adapter,
    );
    const name = provider?.displayName ?? adapter;
    const profiles = catalog.profiles.filter(
      (profile) => profile.adapter === adapter,
    );
    const account = resolved.find(({ providerId }) => providerId === adapter);
    if (account !== undefined) {
      const billing = orbBillingNote(
        account.scope,
        provider?.shortName ?? name,
      );
      return [
        {
          key: adapter,
          name,
          ...(billing === undefined ? {} : { billing }),
          available: true,
          profiles,
        },
      ];
    }
    const saved = profiles.filter(({ id }) => id === savedProfileId);
    return saved.length === 0
      ? []
      : [
          {
            key: adapter,
            name,
            hint: "Not available",
            available: false,
            profiles: saved,
          },
        ];
  });
  const labelled =
    groups.length > 1 || groups.some((group) => !group.available);
  return groups.map(({ name, ...group }) => ({
    ...group,
    ...(labelled ? { name } : {}),
    label: `${name} sizes`,
  }));
};

function OrbProjectSettings({
  project,
  workspace,
  settingsPending,
  userId,
}: {
  readonly project: ProjectData;
  readonly workspace?: SettingsContextData["workspace"];
  readonly settingsPending: boolean;
  readonly userId: UserId;
}) {
  const workspaceId = workspace?.id;
  const workspaceSlug = workspace?.shortName;
  const defaultsTarget =
    project.workspaceId !== undefined &&
    workspaceId === project.workspaceId &&
    workspaceSlug !== undefined
      ? { scope: "workspace" as const, workspaceSlug }
      : project.workspaceId === undefined
        ? { scope: "personal" as const }
        : undefined;
  const workspaceUnavailable =
    project.workspaceId !== undefined && workspace?.id !== project.workspaceId;
  if (workspaceUnavailable && settingsPending)
    return <p>Loading workspace settings…</p>;
  if (workspaceUnavailable || defaultsTarget === undefined)
    return <p role="alert">Workspace settings are unavailable.</p>;
  return (
    <ResolvedOrbProjectSettings
      project={project}
      userId={userId}
      defaultsTarget={defaultsTarget}
    />
  );
}

function ResolvedOrbProjectSettings({
  project,
  userId,
  defaultsTarget,
}: {
  readonly project: ProjectData;
  readonly userId: UserId;
  readonly defaultsTarget: ProjectDefaultsTarget;
}) {
  const queryClient = useQueryClient();
  const defaults = useQuery(
    projectDefaultsQueryOptions(userId, defaultsTarget),
  );
  // The providers this person's Threads in the project can start on.
  const orbProviders = useQuery(
    orbProvidersQueryOptions(userId, { scope: "personal" }, project.id),
  );
  const updateMutation = useMutation(
    updateProjectMutationOptions(queryClient, userId, project.id),
  );
  const [baseline, setBaseline] = React.useState(project);
  const [runnerProfileId, setRunnerProfileId] = React.useState<RunnerProfileId>(
    project.configuration.runnerProfileId,
  );
  const allowedIds = defaults.data?.restrictions.allowedRunnerProfileIds;
  const allowedRunnerProfileIds =
    allowedIds == null ? undefined : new Set(allowedIds);
  const saving = updateMutation.isPending;
  const dirty = runnerProfileId !== baseline.configuration.runnerProfileId;
  if (baseline.revision < project.revision && !dirty && !saving) {
    setBaseline(project);
    setRunnerProfileId(project.configuration.runnerProfileId);
  }
  const save = async () => {
    try {
      const saved = await updateMutation.mutateAsync({
        revision: baseline.revision,
        runnerProfileId,
      });
      setBaseline(saved);
      setRunnerProfileId(saved.configuration.runnerProfileId);
    } catch {}
  };
  const groups =
    defaults.data === undefined || orbProviders.data === undefined
      ? undefined
      : orbSizeGroups(
          defaults.data.catalog,
          orbProviders.data.resolved,
          baseline.configuration.runnerProfileId,
        );
  const unavailable = new Set(
    groups?.flatMap((group) =>
      group.available ? [] : group.profiles.map(({ id }) => id),
    ),
  );
  return (
    <div className="project-settings-content project-settings-orb">
      <SettingsHeading
        title={EXECUTION_ENVIRONMENT_DISPLAY_NAME}
        description={
          <>
            Choose the {EXECUTION_ENVIRONMENT_DISPLAY_NAME} size that dx uses
            for this Project's Threads. Choose additional repositories to clone
            in{" "}
            <Link
              to="/projects/$projectId/settings/$section"
              params={{ projectId: project.id, section: "general" }}
            >
              General
            </Link>
            .
          </>
        }
      />
      <SettingsCard
        className="project-orb-size-card"
        title={`${EXECUTION_ENVIRONMENT_DISPLAY_NAME} Size`}
        description="Each Thread can still pick a different size when it starts."
        variant="outline"
      >
        {groups === undefined ? null : (
          <div className="project-orb-size-picker">
            <OrbSizePicker
              groups={groups}
              selectedId={runnerProfileId}
              isDisabled={(profile) =>
                saving ||
                unavailable.has(profile.id) ||
                profile.availability !== "available" ||
                (allowedRunnerProfileIds !== undefined &&
                  !allowedRunnerProfileIds.has(profile.id))
              }
              onSelect={setRunnerProfileId}
            />
          </div>
        )}
        {defaults.error ? (
          <p role="alert">Orb sizes could not be loaded.</p>
        ) : null}
        {orbProviders.error ? (
          <p role="alert">
            {EXECUTION_ENVIRONMENT_DISPLAY_NAME} providers could not be loaded.
          </p>
        ) : null}
        <SettingsFormActions
          dirty={dirty}
          saving={saving}
          error={
            updateMutation.error instanceof Error
              ? updateMutation.error.message
              : undefined
          }
          showStatus={false}
          showReset={false}
          onSave={() => void save()}
          onReset={() => undefined}
        />
      </SettingsCard>
      <UnsavedChangesGuard
        dirty={dirty}
        onDiscard={() =>
          setRunnerProfileId(baseline.configuration.runnerProfileId)
        }
      />
      <ProjectOrbScriptsCard projectId={project.id} userId={userId} />
      <ProjectOrbFilesCard projectId={project.id} userId={userId} />
    </div>
  );
}

function ProjectSecretsSettings({
  projectId,
  renderEnvironmentSettings,
}: {
  readonly projectId: ProjectId;
  readonly renderEnvironmentSettings: (
    projectId: ProjectId,
    onDirtyChange: (dirty: boolean) => void,
  ) => React.ReactNode;
}) {
  const returnTo = useLocation({ select: (location) => location.href });
  // The environment-variables form reports an entry typed but not added.
  const [dirty, setDirty] = React.useState(false);
  return (
    <div className="project-settings-content project-settings-secrets">
      <SettingsHeading
        title="Secrets & Env Vars"
        description={
          <>
            Secrets and environment variables are set in the Orbs that run this
            project's dx Threads, in <code>~/.env</code> and new Terminal
            shells. All values are encrypted at rest. Project entries override
            workspace entries with the same name, and{" "}
            <Link
              to="/settings/$section"
              params={{ section: "environment-variables" }}
              state={settingsNavigationState(returnTo)}
            >
              personal entries
            </Link>{" "}
            override both.
          </>
        }
      />
      {renderEnvironmentSettings(projectId, setDirty)}
      <UnsavedChangesGuard dirty={dirty} onDiscard={() => setDirty(false)} />
    </div>
  );
}
