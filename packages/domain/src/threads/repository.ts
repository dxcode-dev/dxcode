import { Context, type Effect, type Schema } from "effect";
import type { OrbProviderId } from "../orb-providers/index.js";
import type { Page, PageRequest } from "../pagination/page.js";
import type {
  InvalidPageCursor,
  PersistenceUnavailable,
  ThreadNotFound,
} from "../persistence/errors.js";
import type { ProjectId } from "../projects/project-id.js";
import type { ProjectReader } from "../projects/project-reader.js";
import type { ThreadSourceAdmission } from "../source-control/source-control.js";
import type { UserId } from "../users/user-id.js";
import type { Thread, ThreadColor } from "./thread.js";
import type { ThreadId } from "./thread-id.js";
import type { ThreadTitle } from "./thread-title.js";

/** Fields an owner may change; `color: null` returns the Thread to auto. */
export interface ThreadUpdate {
  readonly title?: ThreadTitle;
  readonly color?: ThreadColor | null;
}

export interface ThreadListRequest extends PageRequest {
  readonly lifecycleState?: "active" | "archived";
  /**
   * Roots: Threads not listed under a parent. Children: one parent's child
   * Threads. Absent lists every Thread.
   */
  readonly tree?:
    | { readonly kind: "roots" }
    | { readonly kind: "children"; readonly parentThreadId: ThreadId };
}

/**
 * The Orb a Thread is pinned to at creation, recorded on its execution
 * workspace in the same write as the Thread: provider, size (runner
 * profile), and whose key pays. A person's or workspace's own key also
 * pins its provider account and the template built there.
 */
export interface ThreadExecutionPin {
  readonly provider: Exclude<OrbProviderId, "local">;
  readonly runnerProfileId: string;
  readonly credentialScope: "deployment" | "workspace" | "personal";
  readonly credentialOwnerId: string | null;
  readonly credentialAccount: string | null;
  readonly providerTemplate: string | null;
}

/**
 * A new Thread's first message, written with its row and held until the
 * Thread's agent admits it, so creation can answer before the agent starts.
 */
export interface ThreadInitialDispatchDraft {
  /** The agent dispatch request, encoded as JSON. */
  readonly requestJson: string;
  /** The message's files, linked to the Thread once it is admitted. */
  readonly attachmentIds: ReadonlyArray<string>;
  readonly senderUserId: string;
}

export interface ThreadRepositoryShape {
  readonly insert: (
    thread: Thread,
    source?: ThreadSourceAdmission,
    executionPin?: ThreadExecutionPin,
    /** The Claude plan a Claude Code Thread is bound to for its life. */
    claudeConnectionId?: string,
    initialDispatch?: ThreadInitialDispatchDraft,
    /**
     * The owner's workspace a Thread created with `workspace` visibility is
     * shared with, as View. A child takes its family's sharing instead.
     */
    sharedWorkspaceId?: string,
  ) => Effect.Effect<void, Schema.SchemaError | PersistenceUnavailable>;
  readonly findOwnedById: (
    threadId: ThreadId,
    reader: ProjectReader,
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
  readonly setPinnedAtOwned: (
    threadId: ThreadId,
    ownerUserId: UserId,
    pinnedAt: Thread["pinnedAt"],
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
  /**
   * Snoozes an active root Thread until `snoozedUntil`, or wakes it when
   * undefined. Fails with ThreadNotFound for a Thread it may not snooze.
   */
  readonly setSnoozedUntilOwned: (
    threadId: ThreadId,
    ownerUserId: UserId,
    snoozedUntil: Thread["snoozedUntil"],
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
  /** Renames or recolors; a rename also ends a pending generated title. */
  readonly updateOwned: (
    threadId: ThreadId,
    ownerUserId: UserId,
    update: ThreadUpdate,
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
  readonly setLifecycleStateOwned: (
    threadId: ThreadId,
    ownerUserId: UserId,
    lifecycleState: Thread["lifecycleState"],
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
  readonly listOwned: (
    reader: ProjectReader,
    projectId: ProjectId | undefined,
    request: ThreadListRequest,
  ) => Effect.Effect<
    Page<Thread>,
    Schema.SchemaError | PersistenceUnavailable | InvalidPageCursor
  >;
  /**
   * The child Threads that list under these roots, as the children list
   * filters them: unpinned, in the given lifecycle state, in reachable
   * projects. At most `perParent` per parent, most recent activity first.
   */
  readonly listChildrenOwned: (
    reader: ProjectReader,
    parentThreadIds: ReadonlyArray<ThreadId>,
    lifecycleState: "active" | "archived",
    perParent: number,
  ) => Effect.Effect<
    ReadonlyArray<Thread>,
    Schema.SchemaError | PersistenceUnavailable
  >;
}

export class ThreadRepository extends Context.Service<
  ThreadRepository,
  ThreadRepositoryShape
>()("@dx/domain/threads/ThreadRepository") {}
