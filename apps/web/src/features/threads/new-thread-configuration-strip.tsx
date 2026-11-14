import type {
  ChoicesData,
  GraphData,
  OrbResolvedProvider,
  PluginAgentModeData,
  PluginThreadTypeOption,
  ProjectData,
} from "@dx/api";
import {
  isClaudeCodeModel,
  orbProviderBetaFeature,
  type ProjectId,
  type RunnerProfile,
  type RunnerProfileId,
  type RunnerProviderPresentation,
  type ThinkingLevel,
  type ThreadVisibility,
} from "@dx/domain";
import { ArrowRight, Folder, LoaderCircle, Plus, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import * as React from "react";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { useNewProjectSurface } from "../../shared/new-project-surface.js";
import { Button } from "../../shared/ui/button.js";
import { chipVariants } from "../../shared/ui/chip-variants.js";
import {
  ChoiceSelectEmpty,
  ChoiceSelectItem,
  ChoiceSelectItemText,
  ChoiceSelectLabel,
  ChoiceSelectList,
  ChoiceSelectPopup,
  ChoiceSelectRoot,
  ChoiceSelectSearch,
  ChoiceSelectSeparator,
  ChoiceSelectTrigger,
  ChoiceSelectValue,
} from "../../shared/ui/choice-select.js";
import {
  MenuItemHint,
  MenuItemText,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../shared/ui/menu.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { OrbProviderLogo } from "../../shared/ui/orb-provider-logo.js";
import { ClaudePlanPicker } from "./claude-code-mode.js";
import { ModelPicker } from "./model-picker.js";
import { NewThreadOptionsMenu } from "./new-thread-options-menu.js";

const shortcutSnapshot = () => 0;

const focusModelSearch = () =>
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>('input[aria-label="Search models"]')
      ?.focus(),
  );

const REPOSITORY_LABELS = {
  git: "Git",
  github: "GitHub",
  bitbucket: "Bitbucket",
  gitlab: "GitLab",
  forgejo: "Forgejo",
} as const;
/**
 * Why a workspace Project cannot start Threads for this user: Threads clone
 * through the user's own source-control connection.
 */
const unavailableHint = (project: ProjectData) => {
  const threads = project.viewerAccess?.threads;
  if (threads === undefined || threads.status === "available") return;
  const provider = REPOSITORY_LABELS[threads.provider];
  return threads.status === "connect"
    ? `Connect ${provider}`
    : `No ${provider} access`;
};

function ProjectOption({ project }: { readonly project: ProjectData }) {
  const hint = unavailableHint(project);
  return (
    <ChoiceSelectItem
      value={project.id}
      className="project-picker-option"
      disabled={hint !== undefined}
    >
      <ChoiceSelectItemText
        className="dx-picker-item-label project-picker-name"
        title={project.name}
      >
        {project.name}
      </ChoiceSelectItemText>
      {project.repository ? (
        <span
          className="project-picker-repository"
          title={hint ?? project.repository.fullName}
        >
          <span>{project.repository.fullName}</span>
          <small>
            {hint ?? REPOSITORY_LABELS[project.repository.provider]}
          </small>
        </span>
      ) : null}
    </ChoiceSelectItem>
  );
}

/** The picker entry that opens the New Project dialog instead of choosing. */
const NEW_PROJECT = "new-project";

function ProjectPicker({
  projects,
  projectId,
  locked,
  hasMoreProjects,
  loadingMoreProjects,
  onLoadMoreProjects,
  onProjectChange,
  projectTriggerRef,
}: {
  readonly projects: ReadonlyArray<ProjectData>;
  readonly projectId: ProjectId | "";
  readonly locked: boolean;
  readonly hasMoreProjects: boolean;
  readonly loadingMoreProjects: boolean;
  readonly onLoadMoreProjects: () => void;
  readonly onProjectChange: (id: ProjectId | "") => void;
  readonly projectTriggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [projectQuery, setProjectQuery] = React.useState("");
  const [recentProjectIds, setRecentProjectIds] = React.useState<
    ReadonlyArray<ProjectId>
  >([]);
  const NewProject = useNewProjectSurface();
  // Mounted on first use, so the composer loads repositories only then, and
  // kept so the dialog's close animation runs.
  const [newProjectMounted, setNewProjectMounted] = React.useState(false);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  const chooseProject = (id: ProjectId | "") => {
    if (id !== "")
      setRecentProjectIds((current) =>
        [id, ...current.filter((recent) => recent !== id)].slice(0, 5),
      );
    onProjectChange(id);
  };
  const projectName =
    projects.find(({ id }) => id === projectId)?.name ?? "No Project";
  const visibleProjects = projects.filter((project) =>
    [project.name, project.repository?.fullName ?? ""].some((value) =>
      value.toLowerCase().includes(projectQuery.trim().toLowerCase()),
    ),
  );
  const recentIds = new Set([
    ...(projectId ? [projectId] : []),
    ...recentProjectIds,
  ]);
  const recentProjects = visibleProjects.filter((project) =>
    recentIds.has(project.id),
  );
  const otherProjects = visibleProjects.filter(
    (project) => !recentIds.has(project.id),
  );
  return (
    <ChoiceSelectRoot
      value={projectId || "no-project"}
      disabled={locked}
      onOpenChange={(open) => {
        if (!open) setProjectQuery("");
      }}
      onValueChange={(value) => {
        if (value === null) return;
        if (value === NEW_PROJECT) {
          setNewProjectMounted(true);
          setNewProjectOpen(true);
          return;
        }
        chooseProject(value === "no-project" ? "" : (value as ProjectId));
      }}
    >
      <ChoiceSelectTrigger
        variant="bare"
        ref={projectTriggerRef}
        className={chipVariants({
          variant: "soft",
          size: "lg",
          className: "new-thread-config-pill new-thread-project",
        })}
        aria-label={`Project: ${projectName}`}
        title={`Project: ${projectName}`}
      >
        <Folder aria-hidden="true" />
        <span className="new-thread-project-prefix">Project: </span>
        <ChoiceSelectValue>{projectName}</ChoiceSelectValue>
      </ChoiceSelectTrigger>
      <ChoiceSelectPopup
        className="project-picker-popup"
        sideOffset={8}
        collisionPadding={12}
      >
        <ChoiceSelectSearch
          aria-label="Filter projects"
          placeholder="Choose a project…"
          value={projectQuery}
          onChange={(event) => setProjectQuery(event.target.value)}
          trailing={<ShortcutKeycaps keycaps={["⌃", "J"]} />}
        />
        <ChoiceSelectList className="project-picker-list">
          <ChoiceSelectItem
            value="no-project"
            className="project-picker-option"
          >
            <ChoiceSelectItemText className="dx-picker-item-label project-picker-name">
              No Project
            </ChoiceSelectItemText>
          </ChoiceSelectItem>
          {recentProjects.length > 0 ? (
            <>
              <ChoiceSelectLabel>Recent</ChoiceSelectLabel>
              {recentProjects.map((project) => (
                <ProjectOption key={project.id} project={project} />
              ))}
            </>
          ) : null}
          {otherProjects.length > 0 ? (
            <>
              <ChoiceSelectLabel>Projects</ChoiceSelectLabel>
              {otherProjects.map((project) => (
                <ProjectOption key={project.id} project={project} />
              ))}
            </>
          ) : null}
          {visibleProjects.length === 0 ? (
            <ChoiceSelectEmpty>
              {projectQuery.trim() ? "No projects found." : "No projects yet."}
            </ChoiceSelectEmpty>
          ) : null}
          {hasMoreProjects ? (
            <button
              type="button"
              className="dx-picker-action thread-context-load-more"
              disabled={loadingMoreProjects}
              onClick={onLoadMoreProjects}
            >
              {loadingMoreProjects ? "Loading…" : "More projects"}
            </button>
          ) : null}
          {NewProject === undefined ? null : (
            <>
              <ChoiceSelectSeparator />
              <ChoiceSelectItem
                value={NEW_PROJECT}
                check={false}
                className="project-picker-option project-picker-new"
              >
                <Plus aria-hidden="true" />
                <ChoiceSelectItemText className="dx-picker-item-label project-picker-name">
                  New Project
                </ChoiceSelectItemText>
              </ChoiceSelectItem>
            </>
          )}
        </ChoiceSelectList>
      </ChoiceSelectPopup>
      {newProjectMounted && NewProject !== undefined ? (
        // The dialog renders its own New Project button, which /projects
        // shows. Here the picker entry opens it, so `hidden` (display: none)
        // keeps that button out of view, the Tab order, and the accessibility
        // tree; the dialog itself portals to the body.
        // TODO(#1138): once #1383 and #1348 merge, give NewProjectDialog a
        // controlled open/onOpenChange without its trigger and drop this span.
        <span hidden>
          <NewProject
            open={newProjectOpen}
            onOpenChange={(open) => {
              setNewProjectOpen(open);
              if (!open)
                requestAnimationFrame(() => projectTriggerRef.current?.focus());
            }}
            onCreated={(project) => chooseProject(project.id)}
          />
        </span>
      ) : null}
    </ChoiceSelectRoot>
  );
}

/** What a pause keeps: the tooltip on a provider's row in the Orb picker. */
const pauseResumeNote = (
  preserves: RunnerProviderPresentation["pauseResume"],
) =>
  preserves === "processes"
    ? "Pause keeps running processes"
    : preserves === "filesystem"
      ? "Pause keeps files; processes restart"
      : "No pause and resume";

/**
 * Orb sizes grouped by provider, in catalog order: only the providers in the
 * resolved set (the ones a new Thread can start on), each with the key it
 * runs on, and only the sizes that key's account can run. The catalog alone
 * lists providers the person may not have connected, so nothing is offered
 * before the resolved set loads.
 */
const runnerProfileGroups = (
  profiles: ReadonlyArray<RunnerProfile>,
  providers: ReadonlyArray<RunnerProviderPresentation>,
  orbs: ReadonlyArray<OrbResolvedProvider>,
) =>
  [...new Set(profiles.map(({ adapter }) => adapter))].flatMap((adapter) => {
    const orb = orbs.find(({ providerId }) => providerId === adapter);
    if (orb === undefined) return [];
    return [
      {
        adapter,
        orb,
        provider: providers.find((provider) => provider.adapter === adapter),
        profiles: profiles.filter(
          (profile) =>
            profile.adapter === adapter &&
            !orb.unavailableSizes.some(({ id }) => id === profile.id),
        ),
      },
    ];
  });

/** A person's or workspace's own account; the deployment's needs no words. */
const orbKeyOwner = (scope: OrbResolvedProvider["scope"]) =>
  scope === "personal"
    ? "Your account"
    : scope === "workspace"
      ? "Workspace account"
      : undefined;

/**
 * The quiet hint after a provider's name: why it cannot start yet, else whose
 * account it runs on. Absent for a ready deployment provider.
 */
const orbProviderHint = (orb: OrbResolvedProvider) =>
  orb.status === "preparing"
    ? "Preparing…"
    : orb.status === "failed"
      ? "Setup failed"
      : orbKeyOwner(orb.scope);

/** The picker's compact provider name ("Cloudflare"); settings keep the long one. */
const orbProviderName = (provider: RunnerProviderPresentation) =>
  provider.shortName ?? provider.displayName;

const formatOrbResources = ({ resources }: RunnerProfile) =>
  `${resources.cpuCores} CPU · ${Number((resources.memoryMb / 1024).toFixed(1))} GiB`;

/** One empty list, so an absent prop keeps a stable identity. */
const NO_THREAD_TYPES: ReadonlyArray<PluginThreadTypeOption> = [];
/**
 * The new-Thread Orb picker: one row per provider in the resolved set, each
 * opening a submenu of its sizes. A dot marks the selected size. Until the
 * resolved set loads (groups undefined) the trigger says so, with a spinner,
 * and does not open.
 */
function OrbPicker({
  groups,
  selectedProfile,
  selectedName,
  disabled,
  isProfileAllowed,
  onSelect,
}: {
  readonly groups: ReturnType<typeof runnerProfileGroups> | undefined;
  readonly selectedProfile: RunnerProfile;
  readonly selectedName: string;
  readonly disabled: boolean;
  readonly isProfileAllowed: (profile: RunnerProfile) => boolean;
  readonly onSelect: (runnerProfileId: RunnerProfileId) => void;
}) {
  return (
    <MenuRoot disabled={disabled || groups === undefined}>
      <MenuTrigger
        className={chipVariants({
          variant: "soft",
          size: "lg",
          className: "new-thread-config-pill new-thread-orb-size",
        })}
        aria-label={
          groups === undefined ? "Loading your Orb providers" : selectedName
        }
        aria-busy={groups === undefined || undefined}
        title={
          groups === undefined ? "Loading your Orb providers…" : selectedName
        }
      >
        {groups === undefined ? (
          <LoaderCircle className="spin" aria-hidden="true" />
        ) : (
          // The provider shows as its logo; the menu and label name it.
          <OrbProviderLogo
            providerId={selectedProfile.adapter}
            className="orb-provider-logo"
          />
        )}
        <span>
          {groups === undefined ? "Loading Orbs…" : selectedProfile.label}
        </span>
      </MenuTrigger>
      <MenuPopup
        className="orb-picker-popup"
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={12}
      >
        {groups?.map((group) => {
          const hint = orbProviderHint(group.orb);
          return (
            <MenuSubmenuRoot key={group.adapter}>
              <MenuSubmenuTrigger
                className="orb-picker-provider"
                title={
                  group.orb?.description ??
                  pauseResumeNote(group.provider?.pauseResume ?? null)
                }
              >
                <OrbProviderLogo
                  providerId={group.adapter}
                  className="orb-provider-logo"
                />
                <span className="orb-picker-provider-name">
                  {group.orb?.displayName ??
                    (group.provider === undefined
                      ? group.adapter
                      : orbProviderName(group.provider))}
                  {group.orb?.displayName !== undefined ||
                  orbProviderBetaFeature(group.adapter) === undefined ? null : (
                    <span className="orb-provider-beta">Beta</span>
                  )}
                </span>
                {hint === undefined ? null : (
                  <MenuItemHint>{hint}</MenuItemHint>
                )}
              </MenuSubmenuTrigger>
              <MenuPopup
                className="orb-picker-popup"
                sideOffset={6}
                collisionPadding={12}
              >
                <MenuRadioGroup
                  value={selectedProfile.id}
                  onValueChange={(value: RunnerProfileId) => onSelect(value)}
                >
                  {group.profiles.map((runnerProfile) => (
                    <MenuRadioItem
                      key={runnerProfile.id}
                      className="orb-picker-size"
                      value={runnerProfile.id}
                      label={runnerProfile.label}
                      closeOnClick
                      disabled={
                        runnerProfile.availability !== "available" ||
                        group.orb.status !== "ready" ||
                        !isProfileAllowed(runnerProfile)
                      }
                    >
                      <MenuItemText
                        title={runnerProfile.label}
                        description={formatOrbResources(runnerProfile)}
                      />
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </MenuSubmenuRoot>
          );
        })}
      </MenuPopup>
    </MenuRoot>
  );
}

/** The Orb picker's pill: a soft, large Chip. */
const ORB_PILL = chipVariants({
  variant: "soft",
  size: "lg",
  className: "new-thread-config-pill new-thread-orb-size",
});
/**
 * The composer's Orb slot: connect a provider when there is none, retry
 * when the options or providers failed to load, else the Orb picker.
 */
function NewThreadOrbSlot({
  locked,
  runnerProfiles,
  runnerProviders,
  runnerOrbs,
  runnerOrbsFailed,
  onRunnerOrbsRetry,
  runnerProfileId,
  runnerProfileLoading,
  allowedRunnerProfileIds,
  onRunnerProfileChange,
  onRunnerProfileRetry,
  onConnectOrbProvider,
}: {
  readonly locked: boolean;
  readonly runnerProfiles: ReadonlyArray<RunnerProfile>;
  readonly runnerProviders: ReadonlyArray<RunnerProviderPresentation>;
  readonly runnerOrbs: ReadonlyArray<OrbResolvedProvider> | undefined;
  readonly runnerOrbsFailed: boolean;
  readonly onRunnerOrbsRetry: (() => void) | undefined;
  readonly runnerProfileId: RunnerProfileId | undefined;
  readonly runnerProfileLoading: boolean;
  readonly allowedRunnerProfileIds:
    | ReadonlyArray<RunnerProfileId>
    | null
    | undefined;
  readonly onRunnerProfileChange:
    | ((runnerProfileId: RunnerProfileId) => void)
    | undefined;
  readonly onRunnerProfileRetry: (() => void) | undefined;
  readonly onConnectOrbProvider: (() => void) | undefined;
}) {
  const selectedRunnerProfile = runnerProfiles.find(
    ({ id }) => id === runnerProfileId,
  );
  const selectedRunnerProvider = runnerProviders.find(
    ({ adapter }) => adapter === selectedRunnerProfile?.adapter,
  );
  const runnerGroups =
    runnerOrbs === undefined
      ? undefined
      : runnerProfileGroups(runnerProfiles, runnerProviders, runnerOrbs);
  const selectedOrb = runnerOrbs?.find(
    ({ providerId }) => providerId === selectedRunnerProfile?.adapter,
  );
  const selectedOrbOwner =
    selectedOrb === undefined ? undefined : orbKeyOwner(selectedOrb.scope);
  // The deployment's own name for its account wins, as in the menu, over
  // the name of the provider underneath it.
  const selectedProviderName =
    selectedOrb?.displayName ??
    (selectedRunnerProvider === undefined
      ? undefined
      : orbProviderName(selectedRunnerProvider));
  const selectedOrbName =
    selectedRunnerProfile === undefined
      ? ""
      : `Orb: ${selectedProviderName === undefined ? "" : `${selectedProviderName} `}${selectedRunnerProfile.label}${selectedOrbOwner === undefined ? "" : `, ${selectedOrbOwner.toLowerCase()}`}`;
  const canRetryRunnerProfiles = onRunnerProfileRetry !== undefined;
  const allowedRunnerProfileIdSet =
    allowedRunnerProfileIds === null || allowedRunnerProfileIds === undefined
      ? undefined
      : new Set(allowedRunnerProfileIds);
  return runnerOrbs !== undefined && runnerOrbs.length === 0 ? (
    // No provider runs this person's Threads yet: connecting one is the
    // only thing to choose.
    <button
      type="button"
      className={ORB_PILL}
      disabled={locked || onConnectOrbProvider === undefined}
      onClick={onConnectOrbProvider}
    >
      <OrbIcon aria-hidden="true" />
      <span>Connect an Orb provider</span>
    </button>
  ) : selectedRunnerProfile === undefined ? (
    <button
      type="button"
      className={ORB_PILL}
      aria-label={
        runnerProfileLoading
          ? "Orb"
          : canRetryRunnerProfiles
            ? "Orb options unavailable. Retry"
            : "Orb options unavailable"
      }
      title={
        runnerProfileLoading
          ? "Loading Orb options"
          : canRetryRunnerProfiles
            ? "Orb options unavailable. Retry"
            : "Orb options unavailable"
      }
      disabled={locked || runnerProfileLoading || !canRetryRunnerProfiles}
      onClick={onRunnerProfileRetry}
    >
      <OrbIcon aria-hidden="true" />
      <span>Orb</span>
    </button>
  ) : runnerOrbs === undefined && runnerOrbsFailed ? (
    // Without the provider list no size can be offered; the rest of the
    // composer stays usable and a send starts on the starting size.
    <button
      type="button"
      className={ORB_PILL}
      aria-label="Orb providers didn't load. Retry"
      title="Orb providers didn't load. Retry"
      disabled={locked || onRunnerOrbsRetry === undefined}
      onClick={onRunnerOrbsRetry}
    >
      <RotateCw aria-hidden="true" />
      <span>Retry Orbs</span>
    </button>
  ) : (
    <OrbPicker
      groups={runnerGroups}
      selectedProfile={selectedRunnerProfile}
      selectedName={selectedOrbName}
      disabled={locked || onRunnerProfileChange === undefined}
      isProfileAllowed={(runnerProfile) =>
        allowedRunnerProfileIdSet === undefined ||
        allowedRunnerProfileIdSet.has(runnerProfile.id)
      }
      onSelect={(value) => onRunnerProfileChange?.(value)}
    />
  );
}

export function NewThreadConfigurationStrip({
  projects,
  projectId,
  model,
  effort,
  onEffortChange = () => undefined,
  choices,
  routingGraph,
  locked,
  submitting,
  ready,
  retrying,
  hasMoreProjects = false,
  loadingMoreProjects = false,
  onLoadMoreProjects = () => undefined,
  onProjectChange,
  runnerProfiles = [],
  runnerProviders = [],
  runnerOrbs,
  runnerOrbsFailed = false,
  onRunnerOrbsRetry,
  runnerProfileId,
  runnerProfileLoading = false,
  allowedRunnerProfileIds,
  onRunnerProfileChange,
  onRunnerProfileRetry,
  onConnectOrbProvider,
  onModelChange,
  claudePlan,
  onClaudePlanChange,
  pluginAgentModes,
  pluginAgentMode,
  onPluginAgentModeChange,
  pluginThreadTypes = NO_THREAD_TYPES,
  pluginThreadType,
  onPluginThreadTypeChange,
  dictationControls,
  dictationActive = false,
  dictationHideSubmit = false,
  visibility = "private",
  onVisibilityChange,
}: {
  readonly projects: ReadonlyArray<ProjectData>;
  readonly projectId: ProjectId | "";
  /** The picked model; undefined is Recommended. */
  readonly model?: string;
  /** The picked effort; undefined is the model's own default. */
  readonly effort?: ThinkingLevel;
  readonly onEffortChange?: (effort: ThinkingLevel) => void;
  readonly choices?: ChoicesData;
  readonly routingGraph?: GraphData;
  readonly locked: boolean;
  readonly submitting: boolean;
  readonly ready: boolean;
  readonly retrying: boolean;
  readonly hasMoreProjects?: boolean;
  readonly loadingMoreProjects?: boolean;
  readonly onLoadMoreProjects?: () => void;
  readonly onProjectChange: (projectId: ProjectId | "") => void;
  readonly runnerProfiles?: ReadonlyArray<RunnerProfile>;
  readonly runnerProviders?: ReadonlyArray<RunnerProviderPresentation>;
  /** The providers a new Thread can start on, with whose key pays. */
  readonly runnerOrbs?: ReadonlyArray<OrbResolvedProvider>;
  /** The provider list failed or timed out and is not being fetched again. */
  readonly runnerOrbsFailed?: boolean;
  readonly onRunnerOrbsRetry?: () => void;
  readonly runnerProfileId?: RunnerProfileId;
  readonly runnerProfileLoading?: boolean;
  readonly allowedRunnerProfileIds?: ReadonlyArray<RunnerProfileId> | null;
  readonly onRunnerProfileChange?: (runnerProfileId: RunnerProfileId) => void;
  readonly onRunnerProfileRetry?: () => void;
  /** Opens Orb Providers settings, for a person with no provider. */
  readonly onConnectOrbProvider?: () => void;
  readonly onModelChange: (model: string | undefined) => void;
  /** The Claude plan a Claude Code Thread is bound to; unset, dx picks one. */
  readonly claudePlan?: string;
  readonly onClaudePlanChange?: (connectionId: string | undefined) => void;
  readonly pluginAgentModes?: ReadonlyArray<PluginAgentModeData>;
  readonly pluginAgentMode?: string;
  readonly onPluginAgentModeChange?: (mode: string | undefined) => void;
  /** Thread types the person's plugins offer. */
  readonly pluginThreadTypes?: ReadonlyArray<PluginThreadTypeOption>;
  readonly pluginThreadType?: string;
  readonly onPluginThreadTypeChange?: (type: string | undefined) => void;
  readonly dictationControls?: ReactNode;
  readonly dictationActive?: boolean;
  readonly dictationHideSubmit?: boolean;
  readonly visibility?: ThreadVisibility;
  /** Absent outside a workspace: the options menu has nothing to offer. */
  readonly onVisibilityChange?: (visibility: ThreadVisibility) => void;
}) {
  const [modePickerOpen, setModePickerOpen] = React.useState(false);
  const projectTriggerRef = React.useRef<HTMLButtonElement>(null);
  const openAndFocusModePicker = () => {
    setModePickerOpen(true);
    focusModelSearch();
  };
  const shortcutHandler = (event: KeyboardEvent) => {
    if (
      locked ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      !event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !["s", "j"].includes(event.key.toLowerCase())
    )
      return;
    event.preventDefault();
    if (event.key.toLowerCase() === "j") projectTriggerRef.current?.click();
    else openAndFocusModePicker();
  };
  const subscribeToShortcut = (_onStoreChange: () => void) => {
    window.addEventListener("keydown", shortcutHandler);
    return () => window.removeEventListener("keydown", shortcutHandler);
  };
  React.useSyncExternalStore(
    subscribeToShortcut,
    shortcutSnapshot,
    shortcutSnapshot,
  );

  return (
    <footer className="new-thread-config-strip">
      <NewThreadOrbSlot
        locked={locked}
        runnerProfiles={runnerProfiles}
        runnerProviders={runnerProviders}
        runnerOrbs={runnerOrbs}
        runnerOrbsFailed={runnerOrbsFailed}
        onRunnerOrbsRetry={onRunnerOrbsRetry}
        runnerProfileId={runnerProfileId}
        runnerProfileLoading={runnerProfileLoading}
        allowedRunnerProfileIds={allowedRunnerProfileIds}
        onRunnerProfileChange={onRunnerProfileChange}
        onRunnerProfileRetry={onRunnerProfileRetry}
        onConnectOrbProvider={onConnectOrbProvider}
      />
      <ProjectPicker
        projects={projects}
        projectId={projectId}
        locked={locked}
        hasMoreProjects={hasMoreProjects}
        loadingMoreProjects={loadingMoreProjects}
        onLoadMoreProjects={onLoadMoreProjects}
        onProjectChange={onProjectChange}
        projectTriggerRef={projectTriggerRef}
      />
      <ModelPicker
        model={model}
        choices={choices}
        routingGraph={routingGraph}
        locked={locked}
        open={modePickerOpen}
        onOpenChange={setModePickerOpen}
        onModelChange={onModelChange}
        effort={effort}
        onEffortChange={onEffortChange}
        {...(pluginAgentModes === undefined ? {} : { pluginAgentModes })}
        {...(pluginAgentMode === undefined ? {} : { pluginAgentMode })}
        {...(onPluginAgentModeChange === undefined
          ? {}
          : { onPluginAgentModeChange })}
      />
      {pluginAgentMode === undefined &&
      model !== undefined &&
      isClaudeCodeModel(model) &&
      onClaudePlanChange !== undefined ? (
        <ClaudePlanPicker
          choices={choices}
          model={model}
          plan={claudePlan}
          locked={locked}
          onPlanChange={onClaudePlanChange}
        />
      ) : null}
      <NewThreadOptionsMenu
        visibility={visibility}
        locked={locked}
        onVisibilityChange={onVisibilityChange}
        threadTypes={pluginThreadTypes}
        threadType={pluginThreadType}
        onThreadTypeChange={onPluginThreadTypeChange}
      />
      <span className="new-thread-config-spacer" />
      {dictationControls}
      {dictationHideSubmit ? null : (
        <Button
          type="submit"
          size="icon-sm"
          shape="round"
          busy={submitting}
          className="new-thread-submit"
          aria-label={
            retrying ? "Retry sending message" : "Create thread and send"
          }
          aria-busy={submitting || undefined}
          disabled={submitting || (!ready && !dictationActive)}
        >
          {submitting ? (
            // The same pending mark dictation shows while it transcribes.
            <span
              className="processing-dot dictation-processing-dot"
              aria-hidden="true"
            />
          ) : retrying ? (
            "↻"
          ) : (
            <ArrowRight />
          )}
        </Button>
      )}
    </footer>
  );
}
