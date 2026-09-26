import { Dialog } from "@base-ui/react/dialog";
import type { ProjectData, SettingsWorkspaceData } from "@dx/api";
import type {
  ModeId,
  ProjectId,
  RunnerProfileId,
  ThreadId,
  UserId,
  WorkspaceId,
} from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
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
  modelRoutingChoicesQueryOptions,
  modelRoutingGraphQueryOptions,
} from "../settings/model-routing/model-routing-queries.js";
import { projectDefaultsQueryOptions } from "../settings/project-defaults/project-defaults-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
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
  if (settingsQuery.isPending)
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
    />
  );
}

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

function ScopedNewThreadModal({
  initialProjectId,
  finalFocus,
  onClose,
  onAccepted,
  routeScoped,
  workspaceId,
  workspace,
  dictationAvailable,
}: {
  readonly initialProjectId?: ProjectId;
  readonly finalFocus?: React.ComponentProps<typeof Dialog.Popup>["finalFocus"];
  readonly onClose: () => void;
  readonly onAccepted: () => void;
  readonly routeScoped: boolean;
  readonly workspaceId: WorkspaceId | "personal";
  readonly workspace?: SettingsWorkspaceData;
  readonly dictationAvailable: boolean;
}) {
  const navigate = useNavigate();
  const returnPath = useLocation({ select: (location) => location.href });
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const registry = React.useContext(ThreadSessionRegistryContext);
  const [recovery] = React.useState(() =>
    routeScoped ? registry?.claimFailedCreation() : undefined,
  );
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(identity.id));
  const listedProjects: ReadonlyArray<ProjectData> =
    projectsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const listedSelectedProject = listedProjects.find(
    ({ id }) => id === initialProjectId,
  );
  const selectedProjectQuery = useQuery({
    ...projectQueryOptions(identity.id, initialProjectId as ProjectId),
    enabled:
      initialProjectId !== undefined && listedSelectedProject === undefined,
  });
  const projects =
    listedSelectedProject !== undefined ||
    selectedProjectQuery.data === undefined
      ? listedProjects
      : [selectedProjectQuery.data, ...listedProjects];
  const createThreadMutation = useMutation(
    createThreadMutationOptions(queryClient, identity.id),
  );
  const [selectedProjectId, setSelectedProjectId] = React.useState<
    ProjectId | ""
  >(recovery?.project?.id ?? initialProjectId ?? listedProjects[0]?.id ?? "");
  const [profile, setProfile] = React.useState<ModeId>(
    recovery?.profile ?? "medium",
  );
  const [model, setModel] = React.useState<string | undefined>(recovery?.model);
  const choicesQuery = useQuery(modelRoutingChoicesQueryOptions(identity.id));
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
  const selectedProject = projects.find(({ id }) => id === effectiveProjectId);
  const defaultsTarget =
    selectedProject === undefined
      ? workspace === undefined
        ? { scope: "personal" as const }
        : { scope: "workspace" as const, workspaceSlug: workspace.shortName }
      : selectedProject.workspaceId === undefined
        ? { scope: "personal" as const }
        : workspace?.id === selectedProject.workspaceId
          ? { scope: "workspace" as const, workspaceSlug: workspace.shortName }
          : undefined;
  const defaultsQuery = useQuery({
    ...projectDefaultsQueryOptions(
      identity.id,
      defaultsTarget ?? { scope: "personal" },
    ),
    enabled: defaultsTarget !== undefined,
  });
  const effectiveRunnerProfileId =
    runnerProfileOverride ??
    selectedProject?.configuration.runnerProfileId ??
    defaultsQuery.data?.resolved.runnerProfileId.value;
  const submitting = sending || createThreadMutation.isPending;
  const visibleError =
    error ??
    (createThreadMutation.error instanceof Error
      ? createThreadMutation.error.message
      : undefined) ??
    (projectsQuery.error instanceof Error
      ? projectsQuery.error.message
      : undefined) ??
    (selectedProjectQuery.error instanceof Error
      ? selectedProjectQuery.error.message
      : undefined) ??
    (defaultsQuery.error instanceof Error
      ? defaultsQuery.error.message
      : undefined);

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
          }}
          runnerProfiles={defaultsQuery.data?.catalog.profiles}
          runnerProfileId={effectiveRunnerProfileId}
          runnerProfileLoading={
            defaultsQuery.isFetching && defaultsQuery.data === undefined
          }
          allowedRunnerProfileIds={
            defaultsQuery.data?.restrictions.allowedRunnerProfileIds
          }
          onRunnerProfileChange={setRunnerProfileOverride}
          onRunnerProfileRetry={
            defaultsTarget === undefined
              ? undefined
              : () => void defaultsQuery.refetch()
          }
          onProfileChange={setProfile}
          onModelChange={setModel}
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
