import type {
  OrbResolvedProvider,
  ProjectData,
  SettingsContextData,
} from "@dx/api";
import type {
  ProjectId,
  ProviderRepositoryId,
  RunnerProfileCatalog,
  RunnerProfileId,
  UserId,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { FolderCog, KeyRound, Upload, X } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import { settingsNavigationState } from "../../shared/navigation/settings-return.js";
import { settle } from "../../shared/settle.js";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { Input } from "../../shared/ui/input.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { OrbSizePicker } from "../../shared/ui/orb-size-grid.js";
import {
  SettingsCard,
  SettingsFormActions,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  type SettingsSelectOption,
} from "../../shared/ui/settings.js";
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
import { AdditionalRepositoriesPicker } from "./new-project-dialog.js";
import { buildProjectMetadataChanges } from "./project-metadata.js";
import {
  rebindProjectSourceMutationOptions,
  updateProjectMutationOptions,
  uploadProjectIconMutationOptions,
} from "./project-mutations.js";
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
import { sourceGrantsQueryOptions } from "./source-grant-queries.js";

const isBitbucketUuid = (value: string) =>
  /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?$/i.test(
    value,
  );

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

/** The repository a Project can be bound to through the person's connections. */
type AuthorizedRepository = {
  readonly key: string;
  readonly provider: "github" | "bitbucket";
  readonly grantId: string;
  readonly workspaceId?: string;
  readonly repositoryId: string;
  readonly fullName: string;
};

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
  /** "" keeps the bound repository. */
  readonly repositoryKey: string;
  /** Undefined keeps the saved list. */
  readonly additional?: ReadonlyArray<RepositoryOption>;
  readonly error?: string;
};

type GeneralAction =
  | {
      readonly type: "edit";
      readonly edit: Partial<
        Pick<
          GeneralDraft,
          "name" | "description" | "repositoryKey" | "additional"
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
  repositoryKey: "",
});

const reduceGeneral = (
  draft: GeneralDraft,
  action: GeneralAction,
): GeneralDraft => {
  switch (action.type) {
    case "edit":
      return { ...draft, ...action.edit };
    case "reset":
      return generalDraft(action.project);
    case "rebased": {
      const { error: _cleared, ...rest } = draft;
      return {
        ...rest,
        baseline: action.project,
        ...(action.rebound ? { repositoryKey: "" } : {}),
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
}: {
  readonly project: ProjectData;
  readonly ownerName: string;
  readonly userId: UserId;
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
  const rebindChoices = repositories.authorized.filter(
    (repository) =>
      baseline.repository === undefined ||
      repository.provider !== baseline.repository.provider ||
      repository.fullName.toLowerCase() !==
        baseline.repository.fullName.toLowerCase(),
  );
  const rebindTo = rebindChoices.find(({ key }) => key === draft.repositoryKey);
  const saving =
    updateMutation.isPending ||
    rebindMutation.isPending ||
    iconMutation.isPending;
  const dirty =
    draft.name !== baseline.name ||
    draft.description !== (baseline.description ?? "") ||
    rebindTo !== undefined ||
    additionalChanged;
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
    dispatch({ type: "error" });
    // Rebind first: when it is refused, nothing else has changed.
    const rebound =
      rebindTo === undefined
        ? { ok: true as const, value: baseline }
        : await settle(() =>
            rebindMutation.mutateAsync({
              revision: baseline.revision,
              grantId: rebindTo.grantId,
              provider: rebindTo.provider,
              ...(rebindTo.workspaceId === undefined
                ? {}
                : { workspaceId: rebindTo.workspaceId }),
              providerRepositoryId:
                rebindTo.repositoryId as ProviderRepositoryId,
            }),
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
        ...(additionalChanged
          ? { additionalRepositories: additional.map(({ webUrl }) => webUrl) }
          : {}),
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
          bound={baseline.repository}
          choices={rebindChoices}
          value={rebindTo === undefined ? "" : draft.repositoryKey}
          hint={repositories.hint}
          disabled={saving}
          retrying={repositories.fetching}
          onRetry={repositories.retry}
          onValueChange={(repositoryKey) => edit({ repositoryKey })}
        />
        <AdditionalRepositoriesSection
          value={additional}
          options={additionalOptions}
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
      <UnsavedChangesGuard
        dirty={dirty}
        onDiscard={() => dispatch({ type: "reset", project })}
      />
    </div>
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

/** The bound repository, and the authorized ones it can be rebound to. */
function GitRepositoryRow({
  bound,
  choices,
  value,
  hint,
  disabled,
  retrying,
  onRetry,
  onValueChange,
}: {
  readonly bound: ProjectData["repository"];
  readonly choices: ReadonlyArray<AuthorizedRepository>;
  readonly value: string;
  readonly hint?: string;
  readonly disabled: boolean;
  readonly retrying: boolean;
  readonly onRetry?: () => void;
  readonly onValueChange: (repositoryKey: string) => void;
}) {
  return (
    <SettingsRow
      title="Git Repository"
      description={hint}
      control={
        <div className="project-repository-control">
          <SettingsSelect
            label="Authorized repository"
            value={value}
            disabled={disabled || choices.length === 0}
            onValueChange={onValueChange}
            options={[
              ["", bound?.fullName ?? "No repository"],
              ...choices.map(
                (repository): SettingsSelectOption => [
                  repository.key,
                  `${repository.provider === "github" ? "GitHub" : "Bitbucket"} · ${repository.fullName}`,
                ],
              ),
            ]}
          />
          {bound === undefined ? null : (
            <a
              className={buttonVariants({ size: "icon-xs", variant: "ghost" })}
              href={bound.webUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open repository"
              title="Open repository"
            >
              <ProjectRepositoryIcon provider={bound.provider} />
            </a>
          )}
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

/** Other repositories cloned beside the primary one, listed with Remove. */
function AdditionalRepositoriesSection({
  value,
  options,
  loading,
  disabled,
  onValueChange,
}: {
  readonly value: ReadonlyArray<RepositoryOption>;
  readonly options: ReadonlyArray<RepositoryOption>;
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
  // Private and workspace Projects bind repositories the current user reaches
  // through their own connections.
  const authorized: ReadonlyArray<AuthorizedRepository> = [
    ...(grantsQuery.data ?? []).flatMap((grant) =>
      grant.ownerScope === "personal" &&
      grant.status === "active" &&
      grant.installationStatus === "active"
        ? grant.repositories.map((repository) => ({
            key: `github:${grant.id}:${repository.id}`,
            provider: "github" as const,
            grantId: grant.id,
            repositoryId: repository.id,
            fullName: repository.fullName,
          }))
        : [],
    ),
    ...(bitbucketConnection === undefined
      ? []
      : bitbucketRepositories.flatMap((repository) =>
          isBitbucketUuid(repository.id) &&
          isBitbucketUuid(repository.workspaceId)
            ? [
                {
                  key: `bitbucket:${bitbucketConnection.id}:${repository.id}`,
                  provider: "bitbucket" as const,
                  grantId: bitbucketConnection.id,
                  workspaceId: repository.workspaceId,
                  repositoryId: repository.id,
                  fullName: repository.fullName,
                },
              ]
            : [],
        )),
  ];
  const loading =
    grantsQuery.isPending ||
    bitbucketConnectionQuery.isPending ||
    (bitbucketConnection !== undefined && bitbucketRepositoriesQuery.isPending);
  const failed =
    grantsQuery.error !== null ||
    bitbucketConnectionQuery.error !== null ||
    bitbucketRepositoriesQuery.error !== null;
  return {
    authorized,
    options: connectedRepositoryOptions(
      grantsQuery.data ?? [],
      bitbucketConnection?.id,
      bitbucketRepositories,
    ),
    loading,
    hint: loading
      ? "Loading authorized repositories…"
      : failed
        ? "Your repositories could not be loaded."
        : authorized.length === 0
          ? "Connect GitHub or Bitbucket to choose a repository."
          : undefined,
    fetching:
      grantsQuery.isFetching ||
      bitbucketConnectionQuery.isFetching ||
      bitbucketRepositoriesQuery.isFetching,
    retry:
      loading || (!failed && authorized.length > 0)
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
  ].flatMap((adapter) => {
    const name =
      catalog.providers?.find((provider) => provider.adapter === adapter)
        ?.displayName ?? adapter;
    const profiles = catalog.profiles.filter(
      (profile) => profile.adapter === adapter,
    );
    if (resolved.some(({ providerId }) => providerId === adapter))
      return [{ key: adapter, name, available: true, profiles }];
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
