import {
  GetThreadChangesDiffResponseSchema,
  GetThreadChangesResponseSchema,
  PushThreadChangesRequestSchema,
  PushThreadChangesResponseSchema,
  THREAD_CHANGES_SUBPROTOCOL,
  ThreadChangesCaptureId,
  ThreadChangesCommitSha,
  ThreadChangesConflictResponseSchema,
  ThreadChangesInvalidRequestResponseSchema,
  ThreadChangesPath,
  type ThreadChangesRange,
  ThreadChangesRangeSchema,
  ThreadChangesUnavailableResponseSchema,
  ThreadChangesWorktreeId,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Effect, Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { ExecutionWorkspaces } from "../execution/execution-workspaces.js";
import type { AppEnv } from "../http/types.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { SourceMutationRejected } from "../source-control/operations.js";
import {
  executeSourcePush,
  SourcePushHeadChanged,
} from "../source-control/tools.js";
import {
  loadThreadChangesIndex,
  loadThreadChangesPatch,
  type ThreadChangesIndex,
} from "./capture.js";
import {
  makeThreadChangesRepository,
  type ThreadChangesState,
} from "./repository-d1.js";

class InvalidChangesRequest extends Error {}

const success = <S extends Schema.ConstraintEncoder<unknown>>(
  context: Context<AppEnv>,
  schema: S,
  data: unknown,
) =>
  context.json(
    Schema.encodeUnknownSync(schema)({ status: "success", data }),
    200,
  );

const error = (
  context: Context<AppEnv>,
  kind: "invalid" | "conflict" | "unavailable",
) => {
  const requestId = context.get("requestId");
  if (kind === "invalid")
    return context.json(
      Schema.encodeUnknownSync(ThreadChangesInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "THREAD_CHANGES_INVALID_REQUEST",
          message: "The Changes request is invalid.",
          requestId,
        },
      }),
      400,
    );
  if (kind === "conflict")
    return context.json(
      Schema.encodeUnknownSync(ThreadChangesConflictResponseSchema)({
        status: "error",
        data: {
          code: "THREAD_CHANGES_CONFLICT",
          message: "Changes became stale before the operation completed.",
          requestId,
        },
      }),
      409,
    );
  return context.json(
    Schema.encodeUnknownSync(ThreadChangesUnavailableResponseSchema)({
      status: "error",
      data: {
        code: "THREAD_CHANGES_UNAVAILABLE",
        message: "Changes are temporarily unavailable.",
        requestId,
      },
    }),
    503,
  );
};

const requestParams = (
  context: Context<AppEnv>,
  allowed: ReadonlySet<string>,
) => {
  const params = new URL(context.req.url).searchParams;
  for (const [key] of params)
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      throw new InvalidChangesRequest();
  return params;
};

const rangeFrom = (value: string | null): ThreadChangesRange => {
  try {
    if (value === null || value === "all")
      return Schema.decodeUnknownSync(ThreadChangesRangeSchema)({
        kind: "all",
      });
    if (value === "uncommitted")
      return Schema.decodeUnknownSync(ThreadChangesRangeSchema)({
        kind: "uncommitted",
      });
    if (value.startsWith("commit:"))
      return Schema.decodeUnknownSync(ThreadChangesRangeSchema)({
        kind: "commit",
        sha: Schema.decodeUnknownSync(ThreadChangesCommitSha)(value.slice(7)),
      });
  } catch {
    throw new InvalidChangesRequest();
  }
  throw new InvalidChangesRequest();
};

const pathFrom = (value: string | null) => {
  try {
    return Schema.decodeUnknownSync(ThreadChangesPath)(value);
  } catch {
    throw new InvalidChangesRequest();
  }
};

const worktreeFrom = (value: string | null) => {
  try {
    return Schema.decodeUnknownSync(ThreadChangesWorktreeId)(
      value ?? "primary",
    );
  } catch {
    throw new InvalidChangesRequest();
  }
};

const sameRange = (left: ThreadChangesRange, right: ThreadChangesRange) =>
  left.kind === right.kind &&
  (left.kind !== "commit" ||
    (right.kind === "commit" && left.sha === right.sha));

const readCapture = async (context: Context<AppEnv>) => {
  const threadId = Schema.decodeUnknownSync(ThreadId)(
    context.req.param("threadId"),
  );
  const db = await Effect.runPromise(decodeD1Binding(context.env.DB));
  const repository = makeThreadChangesRepository(db);
  let state = await repository.read(threadId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (state?.latestCaptureId === undefined)
      return { threadId, state } as const;
    const storage = context.env.DX_STORAGE;
    if (storage === undefined) throw new Error();
    try {
      const manifest = await loadThreadChangesIndex(
        storage,
        threadId,
        state.latestCaptureId,
      );
      if (
        manifest.generation !== state.latestCaptureGeneration ||
        manifest.fingerprint !== state.latestFingerprint ||
        manifest.capturedAt !== state.latestCapturedAt
      )
        throw new Error();
      return { threadId, state, manifest } as const;
    } catch (cause) {
      if (attempt > 0) throw cause;
      const latest = await repository.read(threadId);
      if (latest?.latestCaptureId === state.latestCaptureId) throw cause;
      state = latest;
    }
  }
  throw new Error();
};

const freshnessFields = (
  state: ThreadChangesState,
  manifest: ThreadChangesIndex,
) => {
  const complete =
    state.activeMutations === 0 && state.dirtySince === undefined;
  return {
    captureId: manifest.captureId,
    freshness: complete ? ("complete" as const) : ("stale" as const),
    capturedAt: manifest.capturedAt,
    ...(state.dirtySince === undefined ? {} : { dirtySince: state.dirtySince }),
  };
};

export const threadChangesRoutes = new Hono<AppEnv>();

// A passive observer. This route deliberately does not resolve a workspace.
threadChangesRoutes.get("/:threadId/changes/events", async (context) => {
  const request = context.req.raw;
  if (
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    request.headers.get("origin") !== new URL(request.url).origin ||
    !(request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim())
      .includes(THREAD_CHANGES_SUBPROTOCOL)
  )
    return context.notFound();
  const namespace = context.env.THREAD_EXECUTION;
  if (namespace === undefined) return context.notFound();
  const threadId = Schema.decodeUnknownSync(ThreadId)(
    context.req.param("threadId"),
  );
  const headers = new Headers({
    upgrade: "websocket",
    "x-dx-thread-id": threadId,
    "sec-websocket-protocol": THREAD_CHANGES_SUBPROTOCOL,
  });
  return namespace
    .get(namespace.idFromName(threadId))
    .fetch(new Request("https://thread.internal/changes/events", { headers }));
});

threadChangesRoutes.get("/:threadId/changes", async (context) => {
  try {
    const params = requestParams(context, new Set(["range"]));
    const range = rangeFrom(params.get("range"));
    const capture = await readCapture(context);
    if (capture.state?.latestCaptureId === undefined)
      return success(context, GetThreadChangesResponseSchema, {
        kind: "missing",
      });
    if (capture.manifest === undefined) throw new Error();
    const selected = capture.manifest.ranges.find((candidate) =>
      sameRange(candidate.range, range),
    );
    if (selected === undefined) return error(context, "invalid");
    return success(context, GetThreadChangesResponseSchema, {
      kind: "changes",
      ...freshnessFields(capture.state, capture.manifest),
      range,
      truncated: selected.truncated,
      baseline: capture.manifest.baseline,
      head: capture.manifest.head,
      ...(capture.manifest.branch === undefined
        ? {}
        : { branch: capture.manifest.branch }),
      ...(capture.manifest.upstreamLabel === undefined
        ? {}
        : { upstreamLabel: capture.manifest.upstreamLabel }),
      ahead: capture.manifest.ahead,
      summary: selected.summary,
      files: selected.files.map(({ patch: _patch, ...file }) => ({
        ...file,
        worktree: file.worktree ?? "primary",
      })),
      worktrees: capture.manifest.worktrees ?? [
        {
          id: "primary",
          name:
            capture.manifest.repositoryName.split("/").at(-1) ??
            capture.manifest.repositoryName,
          head: capture.manifest.head,
          ...(capture.manifest.branch === undefined
            ? {}
            : { branch: capture.manifest.branch }),
        },
      ],
      commits: capture.manifest.commits,
    });
  } catch (cause) {
    return error(
      context,
      cause instanceof InvalidChangesRequest ? "invalid" : "unavailable",
    );
  }
});

threadChangesRoutes.get("/:threadId/changes/diff", async (context) => {
  try {
    const params = requestParams(
      context,
      new Set(["range", "path", "captureId", "worktree"]),
    );
    const range = rangeFrom(params.get("range"));
    const path = pathFrom(params.get("path"));
    const worktree = worktreeFrom(params.get("worktree"));
    let expectedCaptureId: ThreadChangesCaptureId | undefined;
    if (params.has("captureId")) {
      try {
        expectedCaptureId = Schema.decodeUnknownSync(ThreadChangesCaptureId)(
          params.get("captureId"),
        );
      } catch {
        throw new InvalidChangesRequest();
      }
    }
    const capture = await readCapture(context);
    if (
      capture.state?.latestCaptureId === undefined ||
      capture.manifest === undefined
    )
      return error(context, "invalid");
    if (
      expectedCaptureId !== undefined &&
      expectedCaptureId !== capture.manifest.captureId
    )
      return error(context, "conflict");
    const selected = capture.manifest.ranges.find((candidate) =>
      sameRange(candidate.range, range),
    );
    const file = selected?.files.find(
      (candidate) =>
        candidate.path === path &&
        (candidate.worktree ?? "primary") === worktree,
    );
    if (file === undefined) return error(context, "invalid");
    const { patch: _reference, ...fileMetadata } = file;
    const metadata = { ...fileMetadata, worktree };
    let patch: string;
    try {
      patch = await loadThreadChangesPatch(
        context.env.DX_STORAGE as R2Bucket,
        capture.threadId,
        capture.manifest.captureId,
        range,
        path,
        worktree,
        capture.manifest,
      );
    } catch (cause) {
      // Publication can retire this immutable object between the index and patch read.
      const latest = await readCapture(context);
      if (latest.manifest?.captureId !== capture.manifest.captureId)
        return error(context, "conflict");
      throw cause;
    }
    return success(context, GetThreadChangesDiffResponseSchema, {
      kind: "diff",
      ...freshnessFields(capture.state, capture.manifest),
      range,
      file: metadata,
      patch,
    });
  } catch (cause) {
    return error(
      context,
      cause instanceof InvalidChangesRequest ? "invalid" : "unavailable",
    );
  }
});

threadChangesRoutes.post("/:threadId/changes/push", async (context) => {
  let body: typeof PushThreadChangesRequestSchema.Type;
  try {
    body = Schema.decodeUnknownSync(PushThreadChangesRequestSchema)(
      await context.req.json(),
      { onExcessProperty: "error" },
    );
  } catch {
    return error(context, "invalid");
  }
  try {
    const capture = await readCapture(context);
    if (
      capture.state?.latestCaptureId === undefined ||
      capture.manifest === undefined ||
      capture.manifest.captureId !== body.expectedCaptureId ||
      freshnessFields(capture.state, capture.manifest).freshness !== "complete"
    )
      return error(context, "conflict");
    const branch = capture.manifest.branch;
    if (branch === undefined) return error(context, "unavailable");
    const sandbox =
      await ExecutionWorkspaces.existingSandboxFactory.createSandbox({
        id: capture.threadId,
      });
    const resumedCapture = await readCapture(context);
    if (
      resumedCapture.state?.latestCaptureId === undefined ||
      resumedCapture.manifest === undefined ||
      resumedCapture.state.mutationGeneration <=
        capture.state.mutationGeneration ||
      resumedCapture.manifest.head !== capture.manifest.head ||
      freshnessFields(resumedCapture.state, resumedCapture.manifest)
        .freshness !== "complete"
    )
      return error(context, "conflict");
    const result = await executeSourcePush(
      {
        threadId: capture.threadId,
        sandbox,
        branch,
        idempotencyKey: body.idempotencyKey,
        expectedHead: capture.manifest.head,
      },
      { bindings: context.env },
    );
    return success(context, PushThreadChangesResponseSchema, {
      kind: "pushed",
      status: result.status,
      ...(result.status === "pushed" ? { sha: result.sha } : {}),
    });
  } catch (cause) {
    return error(
      context,
      cause instanceof SourcePushHeadChanged ||
        cause instanceof SourceMutationRejected
        ? "conflict"
        : "unavailable",
    );
  }
});
