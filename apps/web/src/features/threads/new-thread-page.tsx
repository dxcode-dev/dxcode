import type {
  PersonalComposerDefaultsData,
  PluginThreadTypeOption,
  ProjectData,
  SettingsWorkspaceData,
  UpdatePersonalComposerDefaultsRequest,
} from "@dx/api";
import { attachmentsUploading } from "@dx/client";
import {
  ModelId,
  type ProjectId,
  type RunnerProfileId,
  type ThinkingLevel,
  type ThreadId,
  type ThreadVisibility,
  type UserId,
  type WorkspaceId,
} from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  canStartThreadsIn,
  rememberedProjectToResolve,
  effectiveRunnerProfileId as resolveRunnerProfileId,
  runnableRunnerProfileId,
  startingMode,
  startingModel,
  startingProjectId,
} from "../../shared/composer-start.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import type { ComposerEmail } from "../../shared/new-thread-surface.js";
import { DialogRoot } from "../../shared/ui/dialog.js";
import { DocumentTitle } from "../../shared/ui/document-title.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../shared/ui/modal-surface.js";
import { pluginViewsCatalogQueryOptions } from "../plugins/plugin-views-queries.js";
import {
  projectQueryOptions,
  projectsQueryOptions,
} from "../projects/project-queries.js";
import {
  composerDefaultsQueryOptions,
  updateComposerDefaultsMutationOptions,
} from "../settings/composer/composer-defaults-queries.js";
import {
  modelRoutingChoicesQueryOptions,
  modelRoutingGraphQueryOptions,
} from "../settings/model-routing/model-routing-queries.js";
import { orbProvidersQueryOptions } from "../settings/orb-providers/orb-providers-queries.js";
import { projectDefaultsQueryOptions } from "../settings/project-defaults/project-defaults-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { claudePlanPick } from "./claude-code-mode-options.js";
import { useWorkspaceDraftText } from "./composer-draft-queries.js";
import { useDictation } from "./dictation/use-dictation.js";
import {
  InlineNewThreadFrame,
  useInlineNewThread,
} from "./inline-new-thread-frame.js";
import {
  modeSlot,
  RECOMMENDED_MODE,
  resolvedPick,
} from "./model-picker-options.js";
import { NewThreadComposer } from "./new-thread-composer.js";
import { NewThreadDialog } from "./new-thread-dialog.js";
import { useDraftImages } from "./new-thread-draft-images.js";
import {
  getBrowserEmailThreadDraftStore,
  getBrowserNewThreadDraftStore,
} from "./new-thread-draft-store.js";
import { newThreadLabel } from "./new-thread-label.js";
import { useWorkspaceMentionMembers } from "./new-thread-mentions.js";
import { useNewThreadRunner } from "./new-thread-runner.js";
import { submitNewThread } from "./new-thread-submission.js";
import { NewThreadToasts } from "./new-thread-toasts.js";
import { pluginAgentModesQueryOptions } from "./plugin-agent-modes-queries.js";
import { useSetupSpotlight } from "./project-setup-banner.js";
import { createThreadMutationOptions } from "./thread-mutations.js";
import { ThreadSessionRegistryContext } from "./thread-session-context.js";

export function NewThreadPage() {
  const search = useSearch({ from: "/_product/new" });
  const navigate = useNavigate();
  return (
    <>
      <DocumentTitle name="New Thread" />
      <NewThreadModal
        initialProjectId={search.project}
        initialPrompt={search.prompt}
        {...(search.type === undefined
          ? {}
          : { initialPluginThreadType: search.type })}
        onClose={() => void navigate({ to: "/" })}
        onAccepted={() => {}}
      />
    </>
  );
}

export function NewThreadModal({
  presentation = "dialog",
  initialProjectId,
  initialPluginThreadType,
  initialPrompt,
  email,
  finalFocus,
  onClose,
  onAccepted,
}: {
  /** A dialog over the page, or `inline` in the page (InlineNewThread). */
  readonly presentation?: "dialog" | "inline";
  readonly initialProjectId?: ProjectId;
  /** A plugin Thread type, `<plugin>/<type>`, to start as. */
  readonly initialPluginThreadType?: string;
  /** Text the composer opens with, after any draft the person already has. */
  readonly initialPrompt?: string;
  /**
   * Start thread in Mail: the email the Thread starts from, attached in the
   * composer and sent with the prompt.
   */
  readonly email?: ComposerEmail;
  readonly finalFocus?: React.ComponentProps<typeof ModalSurface>["finalFocus"];
  readonly onClose: () => void;
  readonly onAccepted: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const composerDefaultsQuery = useQuery(
    composerDefaultsQueryOptions(identity.id),
  );
  // The starting Project is chosen once when the composer opens, so wait for
  // the first project page; a failed list still opens the composer.
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(identity.id));
  // Wait only for this open's first result. A refetch of a failed list puts
  // the query back to pending; waiting on that again would close the
  // composer on every Retry or window focus.
  const [projectFailuresAtOpen] = React.useState(
    () => projectsQuery.errorUpdateCount,
  );
  const projectsLoading =
    projectsQuery.isPending &&
    projectsQuery.errorUpdateCount === projectFailuresAtOpen;
  // A remembered Project beyond the first page is fetched by ID. It falls back
  // to the first listed Project only if that fetch fails (deleted or no
  // longer accessible).
  const rememberedProjectId =
    composerDefaultsQuery.data === undefined || projectsLoading
      ? undefined
      : rememberedProjectToResolve({
          explicit: initialProjectId,
          remembered: composerDefaultsQuery.data.project,
          listedProjectIds:
            projectsQuery.data?.pages.flatMap((page) =>
              page.items.map(({ id }) => id),
            ) ?? [],
        });
  const rememberedProjectQuery = useQuery({
    ...projectQueryOptions(identity.id, rememberedProjectId as ProjectId),
    enabled: rememberedProjectId !== undefined,
    retry: false,
  });
  if (
    settingsQuery.isPending ||
    composerDefaultsQuery.isPending ||
    projectsLoading ||
    (rememberedProjectId !== undefined && rememberedProjectQuery.isPending)
  )
    return presentation === "inline" ? (
      <InlineNewThreadFrame loading />
    ) : (
      <div className="new-thread-backdrop">
        <span className="sr-only" role="status">
          Loading New Thread draft…
        </span>
      </div>
    );
  if (settingsQuery.isError && presentation === "inline")
    return (
      <InlineNewThreadFrame>
        <div className="notice error-notice" role="alert">
          {settingsQuery.error instanceof Error
            ? settingsQuery.error.message
            : "Settings could not be loaded."}
        </div>
      </InlineNewThreadFrame>
    );
  if (settingsQuery.isError)
    return (
      <DialogRoot open onOpenChange={(open) => !open && onClose()}>
        <ModalSurface
          className="new-thread-dialog"
          ariaLabel={newThreadLabel(email)}
          finalFocus={finalFocus}
        >
          <ModalSurfaceHeader>
            <ModalSurfaceClose />
          </ModalSurfaceHeader>
          <div className="notice error-notice" role="alert">
            {settingsQuery.error instanceof Error
              ? settingsQuery.error.message
              : "Settings could not be loaded."}
          </div>
        </ModalSurface>
      </DialogRoot>
    );
  return (
    <ScopedNewThreadModal
      presentation={presentation}
      initialProjectId={initialProjectId}
      {...(initialPluginThreadType === undefined
        ? {}
        : { initialPluginThreadType })}
      initialPrompt={initialPrompt}
      email={email}
      finalFocus={finalFocus}
      onClose={onClose}
      onAccepted={onAccepted}
      workspaceId={settingsQuery.data.workspace?.id ?? "personal"}
      workspace={settingsQuery.data.workspace}
      dictationAvailable={settingsQuery.data.dictationAvailable === true}
      remembered={composerDefaultsQuery.data ?? NO_COMPOSER_DEFAULTS}
      rememberedProject={
        rememberedProjectId === undefined
          ? undefined
          : rememberedProjectQuery.data
      }
    />
  );
}

const NO_TYPES: ReadonlyArray<PluginThreadTypeOption> = [];

/** Used when remembered composer choices cannot be loaded. */
const NO_COMPOSER_DEFAULTS: PersonalComposerDefaultsData = {
  project: null,
  mode: null,
  model: null,
  runnerProfileId: null,
  autosaveFiles: false,
};

const useNewThreadDraft = (
  userId: UserId,
  workspaceId: WorkspaceId | "personal",
  email: ComposerEmail | undefined,
) => {
  // Core keeps the prompt, so a reload or another device shows it. An
  // email's composer keeps its own, apart from the New Thread draft.
  const text = useWorkspaceDraftText(workspaceId, "new-thread");
  const store =
    email === undefined
      ? getBrowserNewThreadDraftStore({ userId, workspaceId }, text)
      : getBrowserEmailThreadDraftStore(userId, email.mailId);
  return {
    store,
    snapshot: React.useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getServerSnapshot,
    ),
    creation: React.useSyncExternalStore(
      store.subscribe,
      store.getCreation,
      store.getCreation,
    ),
  };
};

/** The first failure's message, in the order the composer reports them. */
const firstErrorMessage = (errors: ReadonlyArray<unknown>) =>
  errors.find((cause): cause is Error => cause instanceof Error)?.message;

/**
 * The composer's Projects: the loaded pages, plus the starting and remembered
 * Projects when they are not in the first page.
 */
function useComposerProjects(
  userId: UserId,
  initialProjectId: ProjectId | undefined,
  rememberedProject: ProjectData | undefined,
) {
  // The modal already fetched the list as it opened; a failure stays failed
  // until Retry instead of refetching as this composer mounts.
  const projectsQuery = useInfiniteQuery({
    ...projectsQueryOptions(userId),
    retryOnMount: false,
  });
  const listedProjects: ReadonlyArray<ProjectData> =
    projectsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const listedSelectedProject = listedProjects.find(
    ({ id }) => id === initialProjectId,
  );
  const selectedProjectQuery = useQuery({
    ...projectQueryOptions(userId, initialProjectId as ProjectId),
    enabled:
      initialProjectId !== undefined && listedSelectedProject === undefined,
  });
  const withSelected =
    listedSelectedProject !== undefined ||
    selectedProjectQuery.data === undefined
      ? listedProjects
      : [selectedProjectQuery.data, ...listedProjects];
  const projects =
    rememberedProject === undefined ||
    withSelected.some(({ id }) => id === rememberedProject.id)
      ? withSelected
      : [rememberedProject, ...withSelected];
  return { projectsQuery, selectedProjectQuery, projects };
}

/**
 * The model and effort chosen in this composer. `undefined` means "not
 * chosen yet", so the remembered value (or Recommended) is derived during
 * render. Someone whose composer last started on a retired mode other than
 * Medium starts on that mode's model and effort, picked as a model.
 */
function useComposerModeSelection(
  userId: UserId,
  remembered: PersonalComposerDefaultsData,
  rememberComposer: (input: UpdatePersonalComposerDefaultsRequest) => void,
) {
  const [chosenModel, setChosenModel] = React.useState<
    { readonly value: string | undefined } | undefined
  >();
  // Last model selection sent from this composer. Deduping against it (not
  // the query cache, which updates asynchronously) keeps rapid changes from
  // dropping the final choice.
  const lastSentSelection = React.useRef<string | undefined>(undefined);
  const rememberSelection = (
    key: string,
    input: UpdatePersonalComposerDefaultsRequest,
  ) => {
    if (lastSentSelection.current === key) return;
    lastSentSelection.current = key;
    rememberComposer(input);
  };
  const [chosenEffort, chooseEffort] = React.useState<ThinkingLevel>();
  const [chosenPlan, chooseClaudePlan] = React.useState<string>();
  // A plugin's agent mode, chosen for this composer only; any model choice
  // replaces it.
  const [pluginAgentMode, choosePluginAgentMode] = React.useState<string>();
  const choicesQuery = useQuery(modelRoutingChoicesQueryOptions(userId));
  const pluginAgentModesQuery = useQuery(pluginAgentModesQueryOptions(userId));
  const rememberedMode = startingMode(remembered.mode);
  const carriedSlot =
    rememberedMode === RECOMMENDED_MODE
      ? undefined
      : modeSlot(choicesQuery.data, rememberedMode);
  const rememberedModel = startingModel(
    remembered.model,
    choicesQuery.data?.models.map(({ canonical }) => canonical),
  );
  const carried =
    chosenModel === undefined &&
    rememberedModel === undefined &&
    carriedSlot !== undefined;
  const model =
    chosenModel !== undefined
      ? chosenModel.value
      : (rememberedModel ?? carriedSlot?.config.model);
  const effort =
    chosenEffort ?? (carried ? carriedSlot?.config.thinking : undefined);
  const chooseModel = (nextModel: string | undefined) => {
    choosePluginAgentMode(undefined);
    setChosenModel({ value: nextModel });
    if (nextModel === undefined) {
      rememberSelection(`mode:${RECOMMENDED_MODE}`, {
        mode: RECOMMENDED_MODE,
        model: null,
      });
      return;
    }
    const modelId = Schema.decodeUnknownOption(ModelId)(nextModel);
    if (Option.isSome(modelId))
      rememberSelection(`model:${modelId.value}`, {
        model: modelId.value,
      });
  };
  return {
    choicesQuery,
    profile: rememberedMode,
    model,
    effort,
    claudePlan: claudePlanPick(choicesQuery.data, chosenPlan).current
      ?.connectionId,
    chooseModel,
    chooseEffort,
    chooseClaudePlan,
    pluginAgentModes: pluginAgentModesQuery.data,
    // A mode a plugin no longer offers is not sent.
    pluginAgentMode: pluginAgentModesQuery.data?.some(
      ({ mode }) => mode === pluginAgentMode,
    )
      ? pluginAgentMode
      : undefined,
    choosePluginAgentMode,
  };
}

/**
 * The selected Project's Orb options: its defaults (size catalog and
 * restrictions), the providers its Threads can start on with whose key pays
 * (bring-your-own keys; polls while a key's template builds), and the size a
 * new Thread starts with.
 */
function useComposerOrb({
  userId,
  project,
  projectId,
  workspace,
  remembered,
  override,
  chooseRunnerProfile,
}: {
  readonly userId: UserId;
  readonly project: ProjectData | undefined;
  readonly projectId: ProjectId | "";
  readonly workspace: SettingsWorkspaceData | undefined;
  readonly remembered: PersonalComposerDefaultsData["runnerProfileId"];
  readonly override: RunnerProfileId | undefined;
  /** Picks a size, as the Orb picker does; Add runner's new machine uses it. */
  readonly chooseRunnerProfile: (runnerProfileId: RunnerProfileId) => void;
}) {
  const defaultsTarget =
    project === undefined
      ? workspace === undefined
        ? { scope: "personal" as const }
        : { scope: "workspace" as const, workspaceSlug: workspace.shortName }
      : project.workspaceId === undefined
        ? { scope: "personal" as const }
        : workspace?.id === project.workspaceId
          ? { scope: "workspace" as const, workspaceSlug: workspace.shortName }
          : undefined;
  const defaultsQuery = useQuery({
    ...projectDefaultsQueryOptions(
      userId,
      defaultsTarget ?? { scope: "personal" },
    ),
    enabled: defaultsTarget !== undefined,
  });
  // A No Project Thread in a workspace starts on the person's own size first.
  const personalDefaultsQuery = useQuery({
    ...projectDefaultsQueryOptions(userId, { scope: "personal" }),
    enabled: projectId === "" && defaultsTarget?.scope === "workspace",
  });
  const orbProvidersQuery = useQuery(
    orbProvidersQueryOptions(
      userId,
      { scope: "personal" },
      projectId === "" ? undefined : projectId,
    ),
  );
  const preferredRunnerProfileId = resolveRunnerProfileId({
    override,
    projectSelected: projectId !== "",
    projectRunnerProfileId: project?.configuration.runnerProfileId,
    remembered,
    personalDefault:
      defaultsTarget?.scope === "workspace"
        ? (personalDefaultsQuery.data?.overrides.runnerProfileId ?? null)
        : null,
    catalog: defaultsQuery.data?.catalog.profiles,
    allowed: defaultsQuery.data?.restrictions.allowedRunnerProfileIds,
    fallback: defaultsQuery.data?.resolved.runnerProfileId.value,
  });
  // The composer's own pick stands; a default moves to a provider the
  // person can use.
  const effectiveRunnerProfileId =
    override !== undefined
      ? preferredRunnerProfileId
      : runnableRunnerProfileId(
          preferredRunnerProfileId,
          defaultsQuery.data?.catalog.profiles,
          orbProvidersQuery.data?.resolved,
        );
  // The person's own machines in the Orb picker, while runners are on.
  const runner = useNewThreadRunner(userId, effectiveRunnerProfileId, {
    providers: orbProvidersQuery.data?.resolved,
    chooseRunnerProfile,
  });
  return {
    defaultsTarget,
    defaultsQuery,
    orbProvidersQuery,
    effectiveRunnerProfileId,
    runner,
  };
}

/** The plugin Thread type to start as; one no plugin offers is not sent. */
function usePluginThreadTypeChoice(initial: string | undefined) {
  const [chosen, choosePluginThreadType] = React.useState(initial);
  const pluginThreadTypes =
    useQuery(pluginViewsCatalogQueryOptions()).data?.threadTypes ?? NO_TYPES;
  const pluginThreadType = pluginThreadTypes.some(({ ref }) => ref === chosen)
    ? chosen
    : undefined;
  return { pluginThreadTypes, pluginThreadType, choosePluginThreadType };
}

/**
 * Adds the opener's prompt to the saved draft, and tracks whether the
 * composer is still open: a send outlives it when the user leaves the page
 * mid-create. Leaving saves the draft at once, so the composer on the page
 * (which has no Close) keeps the last words typed before navigating away.
 */
function useComposerOpening(
  draftStore: ReturnType<typeof useNewThreadDraft>["store"],
  initialPrompt: string | undefined,
) {
  const composerOpen = React.useRef(true);
  useMountEffect(() => {
    // The opener's prompt joins the saved draft rather than replacing it.
    if (initialPrompt !== undefined) draftStore.appendPrompt(initialPrompt);
  });
  useMountEffect(() => {
    composerOpen.current = true;
    return () => {
      composerOpen.current = false;
      draftStore.flush();
    };
  });
  return composerOpen;
}

/**
 * The composer's Project, and the Orb size picked in it. The starting
 * Project is fixed when the composer opens, so later project pages or
 * refetches never move a Thread to a Project the person did not pick.
 * Choosing a Project drops the size picked for the last one.
 */
function useComposerProjectChoice(
  initialProjectId: ProjectId | undefined,
  remembered: PersonalComposerDefaultsData,
  projects: ReadonlyArray<ProjectData>,
) {
  const [selectedProjectId, setSelectedProjectId] = React.useState<
    ProjectId | ""
  >(() =>
    startingProjectId({
      explicit: initialProjectId,
      remembered: remembered.project,
      listedProjectIds: projects.flatMap((project) =>
        canStartThreadsIn(project) ? [project.id] : [],
      ),
    }),
  );
  const [runnerProfileOverride, setRunnerProfileOverride] = React.useState<
    RunnerProfileId | undefined
  >();
  const chooseProject = (projectId: ProjectId | "") => {
    setSelectedProjectId(projectId);
    setRunnerProfileOverride(undefined);
  };
  return {
    selectedProjectId,
    chooseProject,
    runnerProfileOverride,
    setRunnerProfileOverride,
  };
}

function ScopedNewThreadModal({
  presentation,
  initialProjectId,
  initialPluginThreadType,
  initialPrompt,
  email,
  finalFocus,
  onClose,
  onAccepted,
  workspaceId,
  workspace,
  dictationAvailable,
  remembered,
  rememberedProject,
}: {
  readonly presentation: "dialog" | "inline";
  readonly initialProjectId?: ProjectId;
  /** Text the composer opens with, after any draft the person already has. */
  readonly initialPrompt?: string;
  readonly email?: ComposerEmail;
  readonly finalFocus?: React.ComponentProps<typeof ModalSurface>["finalFocus"];
  readonly onClose: () => void;
  readonly onAccepted: () => void;
  readonly workspaceId: WorkspaceId | "personal";
  readonly workspace?: SettingsWorkspaceData;
  readonly dictationAvailable: boolean;
  readonly remembered: PersonalComposerDefaultsData;
  /** The remembered Project when it is not in the first loaded page. */
  readonly rememberedProject?: ProjectData;
  readonly initialPluginThreadType?: string;
}) {
  const navigate = useNavigate();
  const { pluginThreadTypes, pluginThreadType, choosePluginThreadType } =
    usePluginThreadTypeChoice(initialPluginThreadType);
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const registry = React.useContext(ThreadSessionRegistryContext);
  const { projectsQuery, selectedProjectQuery, projects } = useComposerProjects(
    identity.id,
    initialProjectId,
    rememberedProject,
  );
  const createThreadMutation = useMutation(
    createThreadMutationOptions(queryClient, identity.id),
  );
  const rememberComposer = useMutation(
    updateComposerDefaultsMutationOptions(queryClient, identity.id),
  ).mutate;
  const {
    selectedProjectId,
    chooseProject,
    runnerProfileOverride,
    setRunnerProfileOverride,
  } = useComposerProjectChoice(initialProjectId, remembered, projects);
  const {
    choicesQuery,
    profile,
    model,
    effort,
    claudePlan,
    chooseModel,
    chooseEffort,
    chooseClaudePlan,
    pluginAgentModes,
    pluginAgentMode,
    choosePluginAgentMode,
  } = useComposerModeSelection(identity.id, remembered, rememberComposer);
  const routingGraphQuery = useQuery(
    modelRoutingGraphQueryOptions({ scope: "personal" }, identity.id),
  );
  const {
    store: draftStore,
    snapshot: draft,
    creation,
  } = useNewThreadDraft(identity.id, workspaceId, email);
  const prompt = draft.text;
  // Only a workspace member can share; elsewhere the Thread stays private.
  const [chosenVisibility, setVisibility] =
    React.useState<ThreadVisibility>("private");
  const visibility = workspace === undefined ? "private" : chosenVisibility;
  const mentionMembers = useWorkspaceMentionMembers(identity.id, workspace);
  const composerOpen = useComposerOpening(draftStore, initialPrompt);
  const [error, setError] = React.useState<string>();
  const { imageCollection, images, setImages, addFiles, takeScreenshot } =
    useDraftImages(draftStore, setError);
  const [acceptedNavigationTarget, setAcceptedNavigationTarget] =
    React.useState<ThreadId>();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const effectiveProjectId = selectedProjectId;
  const {
    defaultsTarget,
    defaultsQuery,
    orbProvidersQuery,
    effectiveRunnerProfileId,
    runner,
  } = useComposerOrb({
    userId: identity.id,
    project: projects.find(({ id }) => id === effectiveProjectId),
    projectId: effectiveProjectId,
    workspace,
    remembered: remembered.runnerProfileId,
    override: runnerProfileOverride,
    chooseRunnerProfile: setRunnerProfileOverride,
  });
  // The draft store owns the send, so a composer reopened mid-send shows it.
  const submitting = creation.sending;
  const visibleError =
    error ??
    firstErrorMessage([
      // A failed first page has its own toast, with Retry.
      projectsQuery.data === undefined ? null : projectsQuery.error,
      selectedProjectQuery.error,
      defaultsQuery.error,
    ]);

  const submit = async (submittedPrompt = prompt) => {
    if (
      draftStore.getCreation().sending ||
      (!submittedPrompt.trim() && images.length === 0 && email === undefined) ||
      attachmentsUploading(images)
    )
      return;
    setError(undefined);
    if (registry === undefined) {
      setError("The Thread session registry is unavailable.");
      return;
    }
    try {
      // Recommended is sent as the model and effort it stands for now, so
      // the Thread keeps them even if Recommended changes later.
      const pick = resolvedPick({ choices: choicesQuery.data, model, effort });
      await submitNewThread({
        submittedPrompt,
        effectiveProjectId,
        profile,
        model: pick?.model ?? model,
        effort: pick?.effort,
        claudePlan,
        ...(pluginAgentMode === undefined ? {} : { pluginAgentMode }),
        ...(pluginThreadType === undefined ? {} : { pluginThreadType }),
        runnerProfileId: effectiveRunnerProfileId,
        ...runner.createProps,
        visibility,
        projects,
        imageCollection,
        setImages,
        registry,
        create: createThreadMutation.mutateAsync,
        navigate,
        draftStore,
        onAccepted,
        onAcceptedNavigationFailure: setAcceptedNavigationTarget,
        composerOpen: () => composerOpen.current,
        ...(email === undefined
          ? {}
          : { email: { mailId: email.mailId, subject: email.subject } }),
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The thread could not be started.",
      );
    }
  };

  const dictation = useDictation({
    enabled: dictationAvailable,
    session: draftStore.dictation,
    onChange: draftStore.setText,
    onSend: (text) => void submit(text),
    textareaRef,
  });

  // A send in flight carries on after the composer closes: Core finishes
  // it, and the sidebar keeps showing the Thread as being created.
  const close = () => {
    draftStore.flush();
    onClose();
  };

  useInlineComposerFocus(
    presentation === "inline",
    textareaRef,
    draftStore,
    chooseProject,
  );

  const setup = useSetupSpotlight(effectiveProjectId, draftStore, textareaRef);
  const composer = (
    <>
      <NewThreadComposer
        prompt={prompt}
        images={images}
        textareaRef={textareaRef}
        submitting={submitting}
        onPromptChange={draftStore.setText}
        onSubmit={() => {
          if (!dictation.interceptSubmit()) void submit();
        }}
        onRemoveImage={(image) => setImages(imageCollection.remove(image.id))}
        onFiles={(files) => void addFiles(files)}
        onScreenshot={() => void takeScreenshot()}
        projects={projects}
        hasMoreProjects={projectsQuery.hasNextPage}
        loadingMoreProjects={projectsQuery.isFetchingNextPage}
        onLoadMoreProjects={() => void projectsQuery.fetchNextPage()}
        projectId={effectiveProjectId}
        model={model}
        effort={effort}
        choices={choicesQuery.data}
        routingGraph={routingGraphQuery.data}
        onProjectChange={(projectId) => {
          chooseProject(projectId);
          rememberComposer({
            project: projectId === "" ? "none" : projectId,
          });
        }}
        runnerProfiles={defaultsQuery.data?.catalog.profiles}
        runnerProviders={defaultsQuery.data?.catalog.providers}
        runnerOrbs={orbProvidersQuery.data?.resolved}
        runnerProfileId={effectiveRunnerProfileId}
        runnerProfileLoading={
          defaultsQuery.isFetching && defaultsQuery.data === undefined
        }
        allowedRunnerProfileIds={
          defaultsQuery.data?.restrictions.allowedRunnerProfileIds
        }
        onRunnerProfileChange={(runnerProfileId) => {
          setRunnerProfileOverride(runnerProfileId);
          rememberComposer({ runnerProfileId });
        }}
        onRunnerProfileRetry={
          defaultsTarget === undefined
            ? undefined
            : () => void defaultsQuery.refetch()
        }
        {...runner.pickerProps}
        onConnectOrbProvider={() =>
          void navigate({
            to: "/settings/$section",
            params: { section: "orb-providers" },
          })
        }
        onModelChange={chooseModel}
        onEffortChange={chooseEffort}
        claudePlan={claudePlan}
        onClaudePlanChange={chooseClaudePlan}
        pluginAgentModes={pluginAgentModes}
        pluginAgentMode={pluginAgentMode}
        onPluginAgentModeChange={choosePluginAgentMode}
        pluginThreadTypes={pluginThreadTypes}
        pluginThreadType={pluginThreadType}
        onPluginThreadTypeChange={choosePluginThreadType}
        dictationControls={dictation.controls}
        dictationActive={dictation.active}
        dictationHideSubmit={dictation.hideSubmit}
        visibility={visibility}
        onVisibilityChange={workspace === undefined ? undefined : setVisibility}
        mentionMembers={mentionMembers}
        email={email}
      />
      <NewThreadToasts
        warning={draft.warning}
        onRetryStalled={creation.stalled ? creation.retry : undefined}
        projectsFailure={
          projectsQuery.isError && projectsQuery.data === undefined
            ? {
                count: projectsQuery.errorUpdateCount,
                retry: () => void projectsQuery.refetch(),
              }
            : undefined
        }
        error={visibleError}
        acceptedThreadId={acceptedNavigationTarget}
        onAccepted={onAccepted}
      />
    </>
  );
  if (presentation === "inline")
    return (
      <InlineNewThreadFrame spotlight={setup}>{composer}</InlineNewThreadFrame>
    );
  return (
    <NewThreadDialog
      email={email}
      textareaRef={textareaRef}
      finalFocus={finalFocus}
      onClose={close}
      prompt={prompt}
      submitting={submitting}
      onPromptChange={draftStore.setText}
      spotlight={setup}
    >
      {composer}
    </NewThreadDialog>
  );
}

/**
 * Inline, "new Thread" focuses this composer: in a Project when it names
 * one, with its prompt added to the draft, the caret at the end.
 */
function useInlineComposerFocus(
  enabled: boolean,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  draftStore: { readonly appendPrompt: (prompt: string) => void },
  chooseProject: (projectId: ProjectId) => void,
) {
  useInlineNewThread(
    enabled
      ? (projectId, addedPrompt) => {
          if (projectId !== undefined) chooseProject(projectId);
          if (addedPrompt !== undefined) draftStore.appendPrompt(addedPrompt);
          const textarea = textareaRef.current;
          if (textarea === null) return;
          textarea.focus();
          textarea.setSelectionRange(
            textarea.value.length,
            textarea.value.length,
          );
        }
      : undefined,
  );
}
