import {
  type ProjectData,
  type ThreadAgentInitializationData,
  threadAgentUrl,
} from "@dx/api";
import type {
  ModeId,
  RunnerProfileId,
  ThinkingLevel,
  ThreadId,
  ThreadTitle,
} from "@dx/domain";
import {
  type AbsentConversation,
  createThreadAgentClient,
  isAuthorizationError,
  type ThreadAgentClient,
} from "./thread-agent-client.js";

/**
 * How long a live stream gets to deliver what the realtime hub announced
 * before it counts as deaf and opens again. The hub is usually a moment
 * ahead of a healthy stream; this keeps a deaf one's updates within ~3 s.
 */
export const QUIET_STREAM_MS = 1_500;

/** The most Threads, and the most new-Thread creations, kept at once. */
const RETAINED = 8;

/** The parts of a Flue agent session the registry drives. */
export interface ThreadAgentSessionControl {
  start(): void;
  stop(): void;
  dispose(): void;
  refresh(): void;
  getSnapshot(): { readonly incarnation: string | undefined };
}

/** A Thread the registry keeps: its agent client, Flue session, and UI parts. */
export interface RetainedThreadCore<Session> {
  readonly id: ThreadId;
  /** Set from the Thread detail, which loads alongside the history. */
  agentInitialization?: ThreadAgentInitializationData;
  readonly client: ThreadAgentClient;
  readonly session: Session;
  readonly conversation: AbsentConversation;
  readonly presentation: Map<string, unknown>;
  readonly presentationListeners: Set<() => void>;
  disposed: boolean;
}

/** Records the Thread detail's agent initialization unless one is set. */
export const initializeRetainedThread = <
  Entry extends RetainedThreadCore<unknown>,
>(
  entry: Entry,
  agentInitialization: ThreadAgentInitializationData,
): Entry => {
  entry.agentInitialization ??= agentInitialization;
  return entry;
};

/** Whether Stop was pressed while a send is being admitted. */
export interface PendingSubmissionControl {
  readonly stopRequested: () => boolean;
  readonly setStopRequested: (requested: boolean) => void;
}

export const createPendingSubmissionControl = (): PendingSubmissionControl => {
  let requested = false;
  return {
    stopRequested: () => requested,
    setStopRequested: (next) => {
      requested = next;
    },
  };
};

/** A new Thread shown before Flue has it, with the UI's attachments (`Image`). */
export interface OptimisticThreadCreation<Image> {
  readonly id: ThreadId;
  readonly project?: ProjectData;
  readonly title: ThreadTitle;
  readonly profile: ModeId;
  readonly model?: string;
  /** The effort sent with a picked model. */
  readonly effort?: ThinkingLevel;
  readonly runnerProfileId?: RunnerProfileId;
  readonly body: string;
  readonly images: ReadonlyArray<Image>;
  /** Epoch milliseconds when the user sent it; orders its sidebar row. */
  readonly startedAt: number;
  readonly submissionId?: string;
}

/** What the registry hears about a retained Thread from the UI's dx data. */
export interface RetainedThreadEvents {
  /** Reading the Thread or its Project failed. */
  readonly failed: (error: unknown) => void;
  /** The Thread's detail changed after it first loaded. */
  readonly changed: () => void;
  /** dx said the Thread changed (a realtime hint); its detail is read again. */
  readonly invalidated: () => void;
}

/**
 * The platform and data parts a UI gives the registry: how Flue sessions
 * are made, how requests reach dx, the UI's own per-Thread parts (`Extra`),
 * and its view of each Thread's dx data.
 */
export interface ThreadSessionHost<Session, Extra, Image> {
  readonly fetch: typeof globalThis.fetch;
  /** The dx origin, for request URLs Flue leaves relative. */
  readonly origin: () => string;
  readonly createSession: (client: ThreadAgentClient) => Session;
  readonly createExtra: () => Extra;
  /** Releases a removed Thread's `Extra`, after its session is disposed. */
  readonly disposeExtra: (extra: Extra) => void;
  readonly disposeImages: (images: ReadonlyArray<Image>) => void;
  /** The Thread's first message has not reached its agent yet. */
  readonly awaitingAgent: (id: ThreadId) => boolean;
  /** Reports the Thread's dx data to `events` until the release it returns. */
  readonly watch: (id: ThreadId, events: RetainedThreadEvents) => () => void;
}

/** Stores capabilities, never Flue history or dx HTTP entities. Selection is a
 * committed route activation, not a preload, hover, render or query refresh. */
export class ThreadSessionRegistryCore<
  Session extends ThreadAgentSessionControl,
  Extra extends object,
  Image,
> {
  private readonly entries = new Map<
    ThreadId,
    RetainedThreadCore<Session> & Extra
  >();
  private readonly releases = new Map<ThreadId, () => void>();
  private readonly creations = new Map<
    ThreadId,
    OptimisticThreadCreation<Image>
  >();
  private readonly creationListeners = new Set<() => void>();
  private creationSnapshot: ReadonlyArray<OptimisticThreadCreation<Image>> = [];
  private active:
    | { entry: RetainedThreadCore<Session> & Extra; generation: number }
    | undefined;
  private generation = 0;
  /**
   * Threads shown beside the page's own, such as a Space's child next to
   * the Space's chat: live alongside the active Thread, by how many views
   * show each.
   */
  private readonly alongside = new Map<
    RetainedThreadCore<Session> & Extra,
    number
  >();

  constructor(
    private readonly host: ThreadSessionHost<Session, Extra, Image>,
  ) {}

  readonly subscribeCreations = (listener: () => void) => {
    this.creationListeners.add(listener);
    return () => this.creationListeners.delete(listener);
  };

  creation(id: ThreadId): OptimisticThreadCreation<Image> | undefined {
    return this.creations.get(id);
  }

  /** Every creation in flight or not yet seen in Flue, oldest first. */
  readonly pendingCreations = (): ReadonlyArray<
    OptimisticThreadCreation<Image>
  > => this.creationSnapshot;

  beginCreation(creation: OptimisticThreadCreation<Image>): void {
    const previous = this.creations.get(creation.id);
    if (previous !== undefined && previous !== creation)
      this.host.disposeImages(previous.images);
    this.creations.delete(creation.id);
    this.creations.set(creation.id, creation);
    while (this.creations.size > RETAINED) {
      const oldest = this.creations.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.creations.get(oldest);
      this.creations.delete(oldest);
      this.host.disposeImages(evicted?.images ?? []);
    }
    this.notifyCreations();
  }

  acceptCreation(id: ThreadId, submissionId: string): void {
    const creation = this.creations.get(id);
    if (creation === undefined) return;
    this.creations.set(id, { ...creation, submissionId });
    this.notifyCreations();
  }

  completeCreation(id: ThreadId, submissionId: string): void {
    const creation = this.creations.get(id);
    if (creation?.submissionId !== submissionId) return;
    this.creations.delete(id);
    this.host.disposeImages(creation.images);
    this.notifyCreations();
  }

  failCreation(id: ThreadId): OptimisticThreadCreation<Image> | undefined {
    const creation = this.creations.get(id);
    // Admission is final: keep the optimistic projection until Flue exposes the
    // matching receipt and completeCreation releases its attachment previews.
    if (creation === undefined || creation.submissionId !== undefined)
      return undefined;
    this.creations.delete(id);
    this.notifyCreations();
    return creation;
  }

  private notifyCreations(): void {
    this.creationSnapshot = [...this.creations.values()];
    for (const listener of this.creationListeners) listener();
  }

  /** Needs only the Thread id, so history loads alongside the Thread detail. */
  prepare(
    id: ThreadId,
    agentUrl: string = threadAgentUrl(id),
  ): RetainedThreadCore<Session> & Extra {
    const existing = this.entries.get(id);
    if (existing !== undefined) return existing;
    const conversation: AbsentConversation = { absent: false };
    const client = createThreadAgentClient({
      agentUrl,
      fetch: this.host.fetch,
      origin: this.host.origin(),
      initialData: () => entry.agentInitialization,
      // History read the instance: every Thread made with a first message.
      instanceObserved: () =>
        entry.session.getSnapshot().incarnation !== undefined,
      awaitingAgent: () => this.host.awaitingAgent(id),
      conversation,
    });
    const entry: RetainedThreadCore<Session> & Extra = {
      id,
      client,
      conversation,
      session: this.host.createSession(client),
      presentation: new Map(),
      presentationListeners: new Set(),
      ...this.host.createExtra(),
      disposed: false,
    };
    return entry;
  }

  /**
   * Makes the Thread the page's live one, stopping the one before it, or,
   * with `alongside`, keeps it live beside the page's own Thread, as an
   * embedded Thread is, until its view lets go.
   */
  activate(
    entry: RetainedThreadCore<Session> & Extra,
    { alongside = false }: { readonly alongside?: boolean } = {},
  ): () => void {
    if (entry.disposed) return () => {};
    this.retain(entry);
    if (alongside) {
      const views = this.alongside.get(entry) ?? 0;
      this.alongside.set(entry, views + 1);
      entry.session.start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (this.alongside.get(entry) ?? 1) - 1;
        if (left > 0) {
          this.alongside.set(entry, left);
          return;
        }
        this.alongside.delete(entry);
        if (this.active?.entry !== entry) entry.session.stop();
      };
    }
    const previous = this.active?.entry;
    if (previous !== undefined && !this.alongside.has(previous))
      previous.session.stop();
    const generation = ++this.generation;
    this.active = { entry, generation };
    entry.session.start();
    return () => {
      if (this.active?.generation !== generation) return;
      if (!this.alongside.has(entry)) entry.session.stop();
      this.active = undefined;
    };
  }

  /** Keeps the Thread among the eight most recent, watching its access. */
  private retain(entry: RetainedThreadCore<Session> & Extra): void {
    const retained = this.entries.has(entry.id);
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
    if (!retained) {
      // The realtime hub says on time that the Thread changed, and the
      // Thread's detail is read again. A live stream that delivers nothing
      // within QUIET_STREAM_MS may have stopped hearing new messages: it
      // opens again, so they show as on a new page. One that delivers stays.
      const shown = () =>
        !entry.disposed &&
        (this.active?.entry === entry || this.alongside.has(entry));
      let quietCheck: ReturnType<typeof setTimeout> | undefined;
      const release = this.host.watch(entry.id, {
        failed: (error) => {
          if (isAuthorizationError(error)) this.remove(entry.id);
        },
        // The Thread changed while its conversation was absent, as when
        // someone writes a new Space's first message: read it once more.
        changed: () => {
          if (!entry.conversation.absent) return;
          entry.conversation.absent = false;
          entry.session.refresh();
        },
        invalidated: () => {
          if (quietCheck !== undefined || !shown()) return;
          const position = entry.client.streamPosition();
          if (position === undefined) return;
          quietCheck = setTimeout(() => {
            quietCheck = undefined;
            if (shown() && entry.client.streamPosition() === position)
              entry.client.followAgain();
          }, QUIET_STREAM_MS);
        },
      });
      this.releases.set(entry.id, () => {
        release();
        clearTimeout(quietCheck);
      });
    }
    while (this.entries.size > RETAINED) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.remove(oldest);
    }
  }

  remove(id: ThreadId): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (this.active?.entry === entry) this.active = undefined;
    this.alongside.delete(entry);
    entry.disposed = true;
    this.entries.delete(id);
    this.releases.get(id)?.();
    this.releases.delete(id);
    for (const listener of entry.presentationListeners) listener();
    entry.presentationListeners.clear();
    entry.presentation.clear();
    entry.session.dispose();
    this.host.disposeExtra(entry);
  }

  clear(): void {
    for (const id of this.entries.keys()) this.remove(id);
    for (const creation of this.creations.values())
      this.host.disposeImages(creation.images);
    this.creations.clear();
    this.notifyCreations();
  }
}
