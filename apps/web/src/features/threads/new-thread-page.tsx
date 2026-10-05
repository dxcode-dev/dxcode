import { Dialog } from "@base-ui/react/dialog";
import type {
  PersonalComposerDefaultsData,
  ProjectData,
  SettingsWorkspaceData,
  UpdatePersonalComposerDefaultsRequest,
} from "@dx/api";
import {
  type ModeId,
  ModelId,
  type ProjectId,
  type RunnerProfileId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { CommandProvider } from "../../shared/commands/command-provider.js";
import {
  NewThreadSurfaceContext,
  type NewThreadSurfaceValue,
} from "../../shared/new-thread-surface.js";
import { Button } from "../../shared/ui/button.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../shared/ui/modal-surface.js";
import {
  projectQueryOptions,
  projectsQueryOptions,
} from "../projects/project-queries.js";
import {
  composerDefaultsQueryOptions,
  updateComposerDefaultsMutationOptions,
} from "../settings/account/composer-defaults-queries.js";
import {
  modelRoutingChoicesQueryOptions,
  modelRoutingGraphQueryOptions,
} from "../settings/model-routing/model-routing-queries.js";
import { orbProvidersQueryOptions } from "../settings/orb-providers/orb-providers-queries.js";
import { projectDefaultsQueryOptions } from "../settings/project-defaults/project-defaults-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import {
  rememberedProjectToResolve,
  effectiveRunnerProfileId as resolveRunnerProfileId,
  startingMode,
  startingModel,
  startingProjectId,
} from "./composer-start.js";
import { useDictation } from "./dictation/use-dictation.js";
import {
  captureScreenshot,
  createPendingImageCollection,
  type PendingImage,
} from "./image-attachments.js";
import { NewThreadComposer } from "./new-thread-composer.js";
import {
  getBrowserNewThreadDraftStore,
  type NewThreadDraftSnapshot,
} from "./new-thread-draft-store.js";
import {
  type InitialThreadCreationAttempt,
  submitNewThread,
} from "./new-thread-submission.js";
import { createThreadMutationOptions } from "./thread-mutations.js";
import { ThreadSessionRegistryContext } from "./thread-session-context.js";

export function NewThreadProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const { identity } = useAuthenticatedIdentity();
  const _pathname = useLocation({ select: (location) => location.pathname });
  const registry = React.useContext(ThreadSessionRegistryContext);
  useQuery(projectDefaultsQueryOptions(identity.id, { scope: "personal" }));
  useQuery(composerDefaultsQueryOptions(identity.id));
  const [invocation, setInvocation] = React.useState<
    { readonly key: number; readonly projectId?: ProjectId } | undefined
  >();
  const returnFocus = React.useRef<{
    readonly element: HTMLElement | null;
    readonly mobileDrawer: boolean;
  }>({ element: null, mobileDrawer: false });
  const finalFocus = React.useCallback(() => {
    if (returnFocus.current.element?.isConnected)
      return returnFocus.current.element;
    return returnFocus.current.mobileDrawer
      ? document.querySelector<HTMLElement>('[aria-label="Open sidebar"]')
      : null;
  }, []);
  const value = React.useMemo<NewThreadSurfaceValue>(
    () => ({
      openNewThread: (projectId) => {
        const element =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        returnFocus.current = {
          element: element === document.body ? null : element,
          mobileDrawer: element?.closest(".mobile-sidebar-drawer") !== null,
        };
        setInvocation({ key: Date.now(), projectId });
      },
      pendingProjectlessCreation: (threadId) => {
        const creation = registry?.creation(threadId as ThreadId);
        if (creation === undefined || creation.project !== undefined)
          return undefined;
        return creation;
      },
      subscribePendingProjectlessCreation: (listener) =>
        registry?.subscribeCreations(listener) ?? (() => undefined),
    }),
    [registry],
  );

  return (
    <NewThreadSurfaceContext.Provider value={value}>
      <CommandProvider onOpenNewThread={() => value.openNewThread()}>
        {children}
      </CommandProvider>
      {invocation === undefined ? null : (
        <NewThreadModal
          key={invocation.key}
          initialProjectId={invocation.projectId}
          finalFocus={finalFocus}
          onClose={() => setInvocation(undefined)}
          onAccepted={() => setInvocation(undefined)}
          routeScoped={false}
        />
      )}
    </NewThreadSurfaceContext.Provider>
  );
}

export function NewThreadPage() {
  const search = useSearch({ from: "/_product/new" });
  const navigate = useNavigate();
  return (
    <NewThreadModal
      initialProjectId={search.project}
      onClose={() => void navigate({ to: "/" })}
      onAccepted={() => {}}
      routeScoped
    />
  );
}

function NewThreadModal({
  initialProjectId,
  finalFocus,
  onClose,
  onAccepted,
  routeScoped,
}: {
  readonly initialProjectId?: ProjectId;
  readonly finalFocus?: React.ComponentProps<typeof Dialog.Popup>["finalFocus"];
  readonly onClose: () => void;
  readonly onAccepted: () => void;
  readonly routeScoped: boolean;
}) {
  const { identity } = useAuthenticatedIdentity();
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const composerDefaultsQuery = useQuery(
    composerDefaultsQueryOptions(identity.id),
  );
  // The starting Project is chosen once when the composer opens, so wait for
  // the first project page; a failed list still opens the composer.
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(identity.id));
  // A remembered Project beyond the first page is fetched by ID. It falls back
  // to the first listed Project only if that fetch fails (deleted or no
  // longer accessible).
  const rememberedProjectId =
    composerDefaultsQuery.data === undefined || projectsQuery.isPending
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
    projectsQuery.isPending ||
    (rememberedProjectId !== undefined && rememberedProjectQuery.isPending)
  )
    return (
      <div className="new-thread-backdrop">
        <span className="sr-only" role="status">
          Loading New Thread draft…
        </span>
      </div>
    );
  if (settingsQuery.isError)
    return (
      <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
        <ModalSurface
          className="new-thread-dialog"
          ariaLabel="New thread"
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
      </Dialog.Root>
    );
  return (
    <ScopedNewThreadModal
      initialProjectId={initialProjectId}
      finalFocus={finalFocus}
      onClose={onClose}
      onAccepted={onAccepted}
      routeScoped={routeScoped}
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

/** Used when remembered composer choices cannot be loaded. */
const NO_COMPOSER_DEFAULTS: PersonalComposerDefaultsData = {
  project: null,
  mode: null,
  model: null,
  runnerProfileId: null,
};

const useNewThreadDraft = (
  userId: UserId,
  workspaceId: WorkspaceId | "personal",
) => {
  const store = React.useMemo(
    () => getBrowserNewThreadDraftStore({ userId, workspaceId }),
    [userId, workspaceId],
  );
  return {
    store,
    snapshot: React.useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getServerSnapshot,
    ),
  };
};

function NewThreadModalHeader() {
  return (
    <ModalSurfaceHeader>
      <ModalSurfaceClose />
    </ModalSurfaceHeader>
  );
}

function NewThreadDraftWarning({
  warning,
}: {
  readonly warning: NewThreadDraftSnapshot["warning"];
}) {
  if (warning === undefined) return null;
  return (
    <div className="notice" role="status">
      {warning === "too-large"
        ? "This prompt is over the 64 KiB draft limit. It remains open but is not saved."
        : "This draft could not be saved in this browser. It remains available while this composer stays open."}
    </div>
  );
}

function NewThreadError({
  message,
  acceptedThreadId,
  onAccepted,
}: {
  readonly message: string;
  readonly acceptedThreadId?: ThreadId;
  readonly onAccepted: () => void;
}) {
  const navigate = useNavigate();
  const [navigationError, setNavigationError] = React.useState<string>();
  return (
    <div className="notice error-notice">
      {navigationError ?? message}
      {acceptedThreadId === undefined ? null : (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void navigate({
              to: "/threads/$threadId",
              params: { threadId: acceptedThreadId },
            }).then(onAccepted, () => {
              setNavigationError(
                "Thread was created, but still could not be opened.",
              );
            });
          }}
        >
          Open created thread
        </Button>
      )}
    </div>
  );
}

const updatePendingImages = async (
  load: () => Promise<ReadonlyArray<PendingImage>>,
  fallbackError: string,
  setImages: (images: ReadonlyArray<PendingImage>) => void,
  setError: (error?: string) => void,
) => {
  setError(undefined);
  try {
    setImages(await load());
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : fallbackError);
  }
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
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(userId));
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
 * Mode and model choices made in this composer. `undefined` means "not
 * chosen yet", so the remembered value (or default) is derived during render.
 */
function useComposerModeSelection(
  userId: UserId,
  recovery: { readonly profile: ModeId; readonly model?: string } | undefined,
  remembered: PersonalComposerDefaultsData,
  rememberComposer: (input: UpdatePersonalComposerDefaultsRequest) => void,
) {
  const [chosenProfile, setChosenProfile] = React.useState<ModeId | undefined>(
    recovery?.profile,
  );
  const [chosenModel, setChosenModel] = React.useState<
    { readonly value: string | undefined } | undefined
  >(recovery === undefined ? undefined : { value: recovery.model });
  // Last mode/model selection sent from this composer. Deduping against it
  // (not the query cache, which updates asynchronously) keeps rapid changes
  // from dropping the final choice.
  const lastSentSelection = React.useRef<string | undefined>(undefined);
  const rememberSelection = (
    key: string,
    input: UpdatePersonalComposerDefaultsRequest,
  ) => {
    if (lastSentSelection.current === key) return;
    lastSentSelection.current = key;
    rememberComposer(input);
  };
  const choicesQuery = useQuery(modelRoutingChoicesQueryOptions(userId));
  const profile = chosenProfile ?? startingMode(remembered.mode);
  const model =
    chosenModel === undefined
      ? startingModel(
          remembered.model,
          choicesQuery.data?.models.map(({ canonical }) => canonical),
        )
      : chosenModel.value;
  const chooseProfile = (nextProfile: ModeId) => {
    setChosenProfile(nextProfile);
    // Choosing a mode replaces any pinned model, including one that is
    // remembered but hidden because it is not currently offered.
    setChosenModel({ value: undefined });
    rememberSelection(`mode:${nextProfile}`, {
      mode: nextProfile,
      model: null,
    });
  };
  const chooseModel = (nextModel: string | undefined) => {
    setChosenModel({ value: nextModel });
    // Clearing the model only happens alongside a mode choice, which
    // saves both together.
    if (nextModel === undefined) return;
    const modelId = Schema.decodeUnknownOption(ModelId)(nextModel);
    if (Option.isSome(modelId))
      rememberSelection(`model:${modelId.value}`, {
        model: modelId.value,
      });
  };
  return { choicesQuery, profile, model, chooseProfile, chooseModel };
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
}: {
  readonly userId: UserId;
  readonly project: ProjectData | undefined;
  readonly projectId: ProjectId | "";
  readonly workspace: SettingsWorkspaceData | undefined;
  readonly remembered: PersonalComposerDefaultsData["runnerProfileId"];
  readonly override: RunnerProfileId | undefined;
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
  const orbProvidersQuery = useQuery(
    orbProvidersQueryOptions(
      userId,
      { scope: "personal" },
      projectId === "" ? undefined : projectId,
    ),
  );
  const effectiveRunnerProfileId = resolveRunnerProfileId({
    override,
    projectSelected: projectId !== "",
    projectRunnerProfileId: project?.configuration.runnerProfileId,
    remembered,
    catalog: defaultsQuery.data?.catalog.profiles,
    allowed: defaultsQuery.data?.restrictions.allowedRunnerProfileIds,
    fallback: defaultsQuery.data?.resolved.runnerProfileId.value,
  });
  return {
    defaultsTarget,
    defaultsQuery,
    orbProvidersQuery,
    effectiveRunnerProfileId,
  };
}

function ScopedNewThreadModal({
  initialProjectId,
  finalFocus,
  onClose,
  onAccepted,
  routeScoped,
  workspaceId,
  workspace,
  dictationAvailable,
  remembered,
  rememberedProject,
}: {
  readonly initialProjectId?: ProjectId;
  readonly finalFocus?: React.ComponentProps<typeof Dialog.Popup>["finalFocus"];
  readonly onClose: () => void;
  readonly onAccepted: () => void;
  readonly routeScoped: boolean;
  readonly workspaceId: WorkspaceId | "personal";
  readonly workspace?: SettingsWorkspaceData;
  readonly dictationAvailable: boolean;
  readonly remembered: PersonalComposerDefaultsData;
  /** The remembered Project when it is not in the first loaded page. */
  readonly rememberedProject?: ProjectData;
}) {
  const navigate = useNavigate();
  const returnPath = useLocation({ select: (location) => location.href });
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const registry = React.useContext(ThreadSessionRegistryContext);
  const [recovery] = React.useState(() =>
    routeScoped ? registry?.claimFailedCreation() : undefined,
  );
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
  // The starting Project is fixed when the composer opens, so later project
  // pages or refetches never move a thread to a Project the user did not pick.
  const [selectedProjectId, setSelectedProjectId] = React.useState<
    ProjectId | ""
  >(() =>
    startingProjectId({
      explicit:
        recovery === undefined
          ? initialProjectId
          : (recovery.project?.id ?? ""),
      remembered: remembered.project,
      listedProjectIds: projects.map(({ id }) => id),
    }),
  );
  const { choicesQuery, profile, model, chooseProfile, chooseModel } =
    useComposerModeSelection(
      identity.id,
      recovery,
      remembered,
      rememberComposer,
    );
  const routingGraphQuery = useQuery(
    modelRoutingGraphQueryOptions({ scope: "personal" }, identity.id),
  );
  const { store: draftStore, snapshot: draft } = useNewThreadDraft(
    identity.id,
    workspaceId,
  );
  const prompt = draft.text;
  const [imageCollection] = React.useState(() => {
    const collection = createPendingImageCollection();
    if (recovery !== undefined) collection.restore(recovery.images);
    return collection;
  });
  const [images, setImages] = React.useState<ReadonlyArray<PendingImage>>(
    recovery?.images ?? [],
  );
  const [sending, setSending] = React.useState(false);
  const [runnerProfileOverride, setRunnerProfileOverride] = React.useState<
    RunnerProfileId | undefined
  >(recovery?.runnerProfileId);
  const submittingRef = React.useRef(false);
  const initialCreationAttempt = React.useRef<
    InitialThreadCreationAttempt | undefined
  >(
    recovery === undefined
      ? undefined
      : {
          threadId: recovery.id,
          projectId: recovery.project?.id,
          profile: recovery.profile,
          model: recovery.model,
          runnerProfileId: recovery.runnerProfileId,
          body: recovery.body,
          attachmentIds: recovery.images.map(({ id }) => id),
        },
  );
  const [error, setError] = React.useState<string | undefined>(recovery?.error);
  const [acceptedNavigationTarget, setAcceptedNavigationTarget] =
    React.useState<ThreadId>();
  const [optimisticThreadId, setOptimisticThreadId] =
    React.useState<ThreadId>();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const effectiveProjectId = selectedProjectId;
  const {
    defaultsTarget,
    defaultsQuery,
    orbProvidersQuery,
    effectiveRunnerProfileId,
  } = useComposerOrb({
    userId: identity.id,
    project: projects.find(({ id }) => id === effectiveProjectId),
    projectId: effectiveProjectId,
    workspace,
    remembered: remembered.runnerProfileId,
    override: runnerProfileOverride,
  });
  const submitting = sending || createThreadMutation.isPending;
  const visibleError =
    error ??
    firstErrorMessage([
      createThreadMutation.error,
      projectsQuery.error,
      selectedProjectQuery.error,
      defaultsQuery.error,
    ]);

  const submit = async (submittedPrompt = prompt) => {
    if (
      submittingRef.current ||
      (!submittedPrompt.trim() && images.length === 0)
    )
      return;
    submittingRef.current = true;
    setSending(true);
    setError(undefined);
    try {
      if (registry === undefined)
        throw new Error("The Thread session registry is unavailable.");
      await submitNewThread({
        submittedPrompt,
        effectiveProjectId,
        profile,
        model,
        runnerProfileId: effectiveRunnerProfileId,
        projects,
        imageCollection,
        setImages,
        registry,
        create: createThreadMutation.mutateAsync,
        navigate,
        routeScoped,
        returnPath,
        draftStore,
        onAccepted,
        onAcceptedNavigationFailure: setAcceptedNavigationTarget,
        setOptimisticThreadId,
        initialCreationAttempt,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The thread could not be started.",
      );
    } finally {
      submittingRef.current = false;
      setSending(false);
    }
  };

  const dictation = useDictation({
    enabled: dictationAvailable,
    session: draftStore.dictation,
    onChange: draftStore.setText,
    onSend: (text) => void submit(text),
    textareaRef,
  });

  if (optimisticThreadId !== undefined) return null;

  const addFiles = (files: ReadonlyArray<File>) =>
    updatePendingImages(
      () => imageCollection.addFiles(files),
      "Images could not be attached.",
      setImages,
      setError,
    );

  const takeScreenshot = () =>
    updatePendingImages(
      () => imageCollection.addGenerated(captureScreenshot),
      "The screenshot could not be captured.",
      setImages,
      setError,
    );

  const close = () => {
    draftStore.flush();
    imageCollection.dispose();
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <ModalSurface
        className="new-thread-dialog"
        ariaLabel="New thread"
        initialFocus={textareaRef}
        finalFocus={finalFocus}
      >
        <NewThreadModalHeader />
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
          profile={profile}
          model={model}
          choices={choicesQuery.data}
          routingGraph={routingGraphQuery.data}
          onProjectChange={(projectId) => {
            setSelectedProjectId(projectId);
            setRunnerProfileOverride(undefined);
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
          onProfileChange={chooseProfile}
          onModelChange={chooseModel}
          dictationControls={dictation.controls}
          dictationActive={dictation.active}
          dictationHideSubmit={dictation.hideSubmit}
          footer={
            <>
              <NewThreadDraftWarning warning={draft.warning} />
              {visibleError === undefined ? null : (
                <NewThreadError
                  message={visibleError}
                  acceptedThreadId={acceptedNavigationTarget}
                  onAccepted={onAccepted}
                />
              )}
            </>
          }
        />
      </ModalSurface>
    </Dialog.Root>
  );
}
