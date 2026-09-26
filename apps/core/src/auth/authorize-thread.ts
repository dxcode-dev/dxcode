import type { ThreadNotFoundResponse } from "@dx/api";
import {
  type Principal,
  ThreadId,
  type ThreadLifecycleState,
  ThreadRepository,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Option, Schema } from "effect";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";
import { authorizationLogger } from "../logging.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { ThreadRepositoryD1 } from "../threads/repository-d1.js";

interface ThreadAuthorizationResult {
  readonly authorized: boolean;
  readonly threadId?: ThreadId;
  readonly lifecycleState?: ThreadLifecycleState;
}

export const authorizeThreadRequest = Effect.fn("authorizeThreadRequest")(
  function* (rawThreadId: string, principal: Principal, binding: unknown) {
    const decoded = yield* Schema.decodeEffect(ThreadId)(rawThreadId).pipe(
      Effect.option,
    );
    if (Option.isNone(decoded)) return { authorized: false };

    const threadId = decoded.value;
    const db = yield* decodeD1Binding(binding);
    const repositoryLayer = ThreadRepositoryD1.pipe(
      Layer.provide(D1Client.layer({ db })),
    );
    const lifecycleState = yield* Effect.gen(function* () {
      const repository = yield* ThreadRepository;
      return (yield* repository.findOwnedById(threadId, principal.userId))
        .lifecycleState;
    }).pipe(
      Effect.catchTag("ThreadNotFound", () => Effect.succeed(undefined)),
      Effect.provide(repositoryLayer),
    );

    return {
      authorized: lifecycleState !== undefined,
      threadId,
      lifecycleState,
    } satisfies ThreadAuthorizationResult;
  },
);

const logAuthorization = (
  outcome: "authorized" | "not_found" | "infrastructure_error",
  requestId: string,
  startedAt: number,
  threadId?: ThreadId,
) => {
  const properties = {
    event: "thread_authorization_completed",
    outcome,
    requestId,
    durationMs: Math.round(performance.now() - startedAt),
    ...(threadId === undefined ? {} : { threadId }),
  };
  if (outcome === "authorized") {
    authorizationLogger.info("Thread authorization succeeded.", properties);
  } else if (outcome === "not_found") {
    authorizationLogger.warn(
      "Thread authorization found no owned Thread.",
      properties,
    );
  } else {
    authorizationLogger.error("Thread authorization failed.", properties);
  }
};

export const authorizeThread: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const startedAt = performance.now();
  const requestId = context.get("requestId");

  const result = await Effect.runPromise(
    authorizeThreadRequest(
      context.req.param("threadId") ?? "",
      context.get("principal"),
      context.env.DB,
    ),
  ).catch((cause) => {
    logAuthorization("infrastructure_error", requestId, startedAt);
    throw cause;
  });
  if (!result.authorized) {
    logAuthorization("not_found", requestId, startedAt, result.threadId);
    return context.json<ThreadNotFoundResponse>(
      {
        status: "error",
        data: {
          code: "THREAD_NOT_FOUND",
          message: "Thread not found.",
          requestId,
        },
      },
      404,
    );
  }

  logAuthorization("authorized", requestId, startedAt, result.threadId);
  context.set("threadAuthorizedAt", Date.now());
  context.set(
    "threadLifecycleState",
    result.lifecycleState as ThreadLifecycleState,
  );
  await next();
};
