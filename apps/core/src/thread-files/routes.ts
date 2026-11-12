import {
  GetThreadFileResponseSchema,
  GetThreadFileTreeResponseSchema,
  SaveThreadFileRequestSchema,
  SaveThreadFileResponseSchema,
  THREAD_FILES_MAX_UPLOAD_BYTES,
  ThreadFilesConflictResponseSchema,
  ThreadFilesCursor,
  ThreadFilesEntryNotFoundResponseSchema,
  ThreadFilesInvalidRequestResponseSchema,
  ThreadFilesPath,
  ThreadFilesUnavailableResponseSchema,
  ThreadFilesWorktreeId,
  WriteThreadFilesRequestSchema,
  WriteThreadFilesResponseSchema,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { DxdChangesRefresh } from "../execution/dxd/protocol.js";
import { readBoundedBody } from "../http/bounded-body.js";
import { decodeJsonBody } from "../http/request-decoding.js";
import { requestServerTiming } from "../http/server-timing.js";
import type { AppEnv } from "../http/types.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";
import { runResidentThreadChangesMutation } from "../thread-changes/coordinator.js";
import { queueThreadChangesRefresh } from "../threads/daemon-client.js";
import {
  listThreadFilesThroughDaemon,
  readThreadFileThroughDaemon,
  saveThreadFileThroughDaemon,
  ThreadFilesConflict,
  ThreadFilesInvalid,
  ThreadFilesMissing,
  type ThreadFilesWrite,
  uploadThreadFileThroughDaemon,
  writeThreadFilesThroughDaemon,
} from "./service.js";

interface ResidentFiles {
  readonly list: typeof listThreadFilesThroughDaemon;
  readonly read: typeof readThreadFileThroughDaemon;
  readonly write: (
    bindings: AppEnv["Bindings"],
    threadId: ThreadId,
    write: ThreadFilesWrite,
    worktree?: ThreadFilesWorktreeId,
  ) => Promise<{ readonly kind: "changed" }>;
  readonly upload: (
    bindings: AppEnv["Bindings"],
    threadId: ThreadId,
    path: ThreadFilesPath,
    bytes: Uint8Array,
    worktree?: ThreadFilesWorktreeId,
  ) => Promise<{ readonly kind: "changed" }>;
  readonly save: (
    bindings: AppEnv["Bindings"],
    threadId: ThreadId,
    path: Parameters<typeof saveThreadFileThroughDaemon>[2],
    expectedVersion: Parameters<typeof saveThreadFileThroughDaemon>[3],
    content: string,
    worktree?: Parameters<typeof saveThreadFileThroughDaemon>[6],
  ) => ReturnType<typeof saveThreadFileThroughDaemon>;
}

/**
 * Every Files write runs under the Thread's Changes mutation lease, as the
 * agent's writes do, and hands dxd the lease's refresh so Changes captures
 * the result.
 */
const underChangesLease = async <A>(
  bindings: AppEnv["Bindings"],
  threadId: ThreadId,
  allowMissingSource: boolean,
  operation: (refresh?: DxdChangesRefresh) => Promise<A>,
) => {
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  return runResidentThreadChangesMutation({
    db,
    threadId,
    allowMissingSource,
    residentRefresh: (refresh) =>
      queueThreadChangesRefresh(bindings, threadId, refresh),
    operation,
  });
};

const residentWrites = (
  allowMissingSource: boolean,
): Pick<ResidentFiles, "save" | "write" | "upload"> => ({
  save: (bindings, threadId, path, expectedVersion, content, worktree) =>
    underChangesLease(bindings, threadId, allowMissingSource, (refresh) =>
      saveThreadFileThroughDaemon(
        bindings,
        threadId,
        path,
        expectedVersion,
        content,
        refresh,
        worktree,
      ),
    ),
  write: (bindings, threadId, write, worktree) =>
    underChangesLease(bindings, threadId, allowMissingSource, (refresh) =>
      writeThreadFilesThroughDaemon(
        bindings,
        threadId,
        write,
        refresh,
        worktree,
      ),
    ),
  upload: (bindings, threadId, path, bytes, worktree) =>
    underChangesLease(bindings, threadId, allowMissingSource, (refresh) =>
      uploadThreadFileThroughDaemon(
        bindings,
        threadId,
        path,
        bytes,
        refresh,
        worktree,
      ),
    ),
});

const residentFiles: ResidentFiles = {
  list: listThreadFilesThroughDaemon,
  read: readThreadFileThroughDaemon,
  ...residentWrites(false),
};

const localResidentFiles: ResidentFiles = {
  ...residentFiles,
  ...residentWrites(true),
};

const decode = <S extends Schema.Constraint>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(
    schema as unknown as Schema.ConstraintDecoder<S["Type"]>,
  )(value) as S["Type"];

const errorResponse = (context: Context<AppEnv>, cause: unknown) => {
  const requestId = context.get("requestId");
  if (cause instanceof ThreadFilesInvalid)
    return context.json(
      Schema.encodeUnknownSync(ThreadFilesInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "THREAD_FILES_INVALID_REQUEST",
          message: "The Files request is invalid.",
          requestId,
        },
      }),
      400,
    );
  if (cause instanceof ThreadFilesMissing)
    return context.json(
      Schema.encodeUnknownSync(ThreadFilesEntryNotFoundResponseSchema)({
        status: "error",
        data: {
          code: "THREAD_FILES_ENTRY_NOT_FOUND",
          message: "The requested workspace entry was not found.",
          requestId,
        },
      }),
      404,
    );
  if (cause instanceof ThreadFilesConflict)
    return context.json(
      Schema.encodeUnknownSync(ThreadFilesConflictResponseSchema)({
        status: "error",
        data: {
          code: "THREAD_FILES_CONFLICT",
          message: "The file changed before the operation completed.",
          requestId,
        },
      }),
      409,
    );
  return context.json(
    Schema.encodeUnknownSync(ThreadFilesUnavailableResponseSchema)({
      status: "error",
      data: {
        code: "THREAD_FILES_UNAVAILABLE",
        message: "Files are temporarily unavailable.",
        requestId,
      },
    }),
    503,
  );
};

const decodePath = (value: string | undefined) => {
  try {
    return decode(ThreadFilesPath, value);
  } catch {
    throw new ThreadFilesInvalid();
  }
};

const decodeCursor = (value: string | undefined) => {
  if (value === undefined) return undefined;
  try {
    return decode(ThreadFilesCursor, value);
  } catch {
    throw new ThreadFilesConflict();
  }
};

const decodeWorktree = (value: string | undefined) => {
  if (value === undefined) return undefined;
  try {
    return decode(ThreadFilesWorktreeId, value);
  } catch {
    throw new ThreadFilesInvalid();
  }
};

const decodeThreadId = (value: string | undefined) => {
  try {
    return decode(ThreadId, value);
  } catch {
    throw new ThreadFilesInvalid();
  }
};

const rejectUnknownQuery = (
  context: Context<AppEnv>,
  allowed: ReadonlySet<string>,
) => {
  const params = new URL(context.req.url).searchParams;
  for (const [key] of params)
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      throw new ThreadFilesInvalid();
  return params;
};

const makeThreadFilesRoutes = () => {
  const routes = new Hono<AppEnv>();
  const configuredResident = residentFiles;
  const localResident = localResidentFiles;

  routes.get("/:threadId/files", async (context) => {
    try {
      const query = rejectUnknownQuery(
        context,
        new Set(["path", "cursor", "worktree", "snapshot"]),
      );
      const snapshot = query.get("snapshot");
      if (snapshot !== null && snapshot !== "allow")
        throw new ThreadFilesInvalid();
      const pathValue = query.get("path") ?? undefined;
      const path = pathValue === undefined ? undefined : decodePath(pathValue);
      const cursor = decodeCursor(query.get("cursor") ?? undefined);
      const worktree = decodeWorktree(query.get("worktree") ?? undefined);
      const threadId = decodeThreadId(context.req.param("threadId"));
      const selected = selectWorkspaceRuntime(context.env, {
        local: localResident,
        deployed: configuredResident,
      });
      const timing = requestServerTiming(context);
      let workspaceTiming: string | undefined;
      const data = await selected.list(
        context.env,
        threadId,
        path,
        cursor,
        worktree,
        {
          // Only the first page of the root has a snapshot.
          allowSnapshot:
            snapshot === "allow" && path === undefined && cursor === undefined,
          observe: (headers) => {
            workspaceTiming = headers.get("server-timing") ?? undefined;
          },
        },
      );
      timing.mark("workspace");
      context.header(
        "Server-Timing",
        [timing.header(), ...(workspaceTiming ? [workspaceTiming] : [])].join(
          ", ",
        ),
      );
      return context.json(
        Schema.encodeUnknownSync(GetThreadFileTreeResponseSchema)({
          status: "success",
          data,
        }),
      );
    } catch (cause) {
      return errorResponse(context, cause);
    }
  });

  routes.get("/:threadId/files/:path{.+}", async (context) => {
    try {
      const query = rejectUnknownQuery(context, new Set(["worktree"]));
      const threadId = decodeThreadId(context.req.param("threadId"));
      const path = decodePath(context.req.param("path"));
      const worktree = decodeWorktree(query.get("worktree") ?? undefined);
      const selected = selectWorkspaceRuntime(context.env, {
        local: localResident,
        deployed: configuredResident,
      });
      const data = await selected.read(context.env, threadId, path, worktree);
      return context.json(
        Schema.encodeUnknownSync(GetThreadFileResponseSchema)({
          status: "success",
          data,
        }),
      );
    } catch (cause) {
      return errorResponse(context, cause);
    }
  });

  routes.patch("/:threadId/files/:path{.+}", async (context) => {
    try {
      const query = rejectUnknownQuery(context, new Set(["worktree"]));
      const body = await Effect.runPromise(
        decodeJsonBody(
          context.req,
          SaveThreadFileRequestSchema,
          () => new ThreadFilesInvalid(),
        ),
      );
      const threadId = decodeThreadId(context.req.param("threadId"));
      const path = decodePath(context.req.param("path"));
      const worktree = decodeWorktree(query.get("worktree") ?? undefined);
      const selected = selectWorkspaceRuntime(context.env, {
        local: localResident,
        deployed: configuredResident,
      });
      const data = await selected.save(
        context.env,
        threadId,
        path,
        body.expectedVersion,
        body.content,
        worktree,
      );
      return context.json(
        Schema.encodeUnknownSync(SaveThreadFileResponseSchema)({
          status: "success",
          data,
        }),
      );
    } catch (cause) {
      return errorResponse(context, cause);
    }
  });

  routes.post("/:threadId/files", async (context) => {
    try {
      const query = rejectUnknownQuery(context, new Set(["worktree"]));
      const body = await Effect.runPromise(
        decodeJsonBody(
          context.req,
          WriteThreadFilesRequestSchema,
          () => new ThreadFilesInvalid(),
        ),
      );
      const threadId = decodeThreadId(context.req.param("threadId"));
      const worktree = decodeWorktree(query.get("worktree") ?? undefined);
      const selected = selectWorkspaceRuntime(context.env, {
        local: localResident,
        deployed: configuredResident,
      });
      const data = await selected.write(context.env, threadId, body, worktree);
      return context.json(
        Schema.encodeUnknownSync(WriteThreadFilesResponseSchema)({
          status: "success",
          data,
        }),
      );
    } catch (cause) {
      return errorResponse(context, cause);
    }
  });

  // Upload: the request body is the new file's bytes.
  routes.put("/:threadId/files/:path{.+}", async (context) => {
    try {
      const query = rejectUnknownQuery(context, new Set(["worktree"]));
      const threadId = decodeThreadId(context.req.param("threadId"));
      const path = decodePath(context.req.param("path"));
      const worktree = decodeWorktree(query.get("worktree") ?? undefined);
      const declared = Number(context.req.header("content-length") ?? "NaN");
      if (
        !Number.isSafeInteger(declared) ||
        declared < 0 ||
        declared > THREAD_FILES_MAX_UPLOAD_BYTES
      )
        throw new ThreadFilesInvalid();
      const bytes = await readBoundedBody(context.req.raw, declared);
      if (bytes === undefined || bytes.byteLength !== declared)
        throw new ThreadFilesInvalid();
      const selected = selectWorkspaceRuntime(context.env, {
        local: localResident,
        deployed: configuredResident,
      });
      const data = await selected.upload(
        context.env,
        threadId,
        path,
        bytes,
        worktree,
      );
      return context.json(
        Schema.encodeUnknownSync(WriteThreadFilesResponseSchema)({
          status: "success",
          data,
        }),
        201,
      );
    } catch (cause) {
      return errorResponse(context, cause);
    }
  });

  return routes;
};

export const threadFilesRoutes = makeThreadFilesRoutes();
