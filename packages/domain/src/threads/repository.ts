import { Context, type Effect, type Schema } from "effect";
import type { Page, PageRequest } from "../pagination/page.js";
import type {
  InvalidPageCursor,
  PersistenceUnavailable,
  ThreadNotFound,
} from "../persistence/errors.js";
import type { ProjectId } from "../projects/project-id.js";
import type { ThreadSourceAdmission } from "../source-control/source-control.js";
import type { UserId } from "../users/user-id.js";
import type { Thread } from "./thread.js";
import type { ThreadId } from "./thread-id.js";

export interface ThreadListRequest extends PageRequest {
  readonly lifecycleState?: "active" | "archived";
}

/**
 * The Orb a Thread is pinned to at creation, recorded on its execution
 * workspace in the same write as the Thread: provider, size (runner
 * profile), and whose key pays. A person's or workspace's own key also
 * pins its provider account and the template built there.
 */
export interface ThreadExecutionPin {
  readonly provider: "e2b" | "cloudflare";
  readonly runnerProfileId: string;
  readonly credentialScope: "deployment" | "workspace" | "personal";
  readonly credentialOwnerId: string | null;
  readonly credentialAccount: string | null;
  readonly providerTemplate: string | null;
}

export interface ThreadRepositoryShape {
  readonly insert: (
    thread: Thread,
    source?: ThreadSourceAdmission,
    executionPin?: ThreadExecutionPin,
  ) => Effect.Effect<void, Schema.SchemaError | PersistenceUnavailable>;
  readonly findOwnedById: (
    threadId: ThreadId,
    ownerUserId: UserId,
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
  readonly setLifecycleStateOwned: (
    threadId: ThreadId,
    ownerUserId: UserId,
    lifecycleState: Thread["lifecycleState"],
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
  readonly listOwned: (
    ownerUserId: UserId,
    projectId: ProjectId | undefined,
    request: ThreadListRequest,
  ) => Effect.Effect<
    Page<Thread>,
    Schema.SchemaError | PersistenceUnavailable | InvalidPageCursor
  >;
}

export class ThreadRepository extends Context.Service<
  ThreadRepository,
  ThreadRepositoryShape
>()("@dx/domain/threads/ThreadRepository") {}
