import {
  MAX_THREAD_STORAGE_FILE_BYTES,
  THREAD_STORAGE_TEMPORARY_TTL_MS,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import { Effect, Schema } from "effect";
import * as v from "valibot";
import { attachmentOrigin } from "../attachments/store.js";
import type {
  DxdStorageExportResult,
  DxdStorageImportOperation,
} from "../execution/dxd/protocol.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { loadThreadChangesIndex } from "../thread-changes/capture.js";
import { makeThreadChangesRepository } from "../thread-changes/repository-d1.js";
import type { ThreadToolsContext } from "../threads/agent-tools.js";
import {
  type CallingThread,
  readCallingThread,
} from "../threads/calling-thread.js";
import {
  DaemonUnavailable,
  StorageTransferOutdated,
  transferThreadStorage,
} from "../threads/daemon-client.js";
import {
  deleteThreadStorageFile,
  findThreadStorageFile,
  type ThreadStorageRow,
  threadStorageFileData,
} from "./store.js";

/** download_thread_changes skips a changed file larger than this. */
const CHANGES_MAX_FILE_BYTES = 16 * 1_024 * 1_024;
/** The most files one thread_file_url call shares. */
const URL_MAX_FILES = 20;
const PATH_MAX_CHARS = 4_096;
const THREAD_INPUT_MAX_CHARS = 512;

type Exported = Extract<
  DxdStorageExportResult,
  { readonly kind: "exported" }
>["files"][number];

/**
 * An exported file once Core has found its row: a stored file's ID comes
 * from the guest, so only a temporary file the source Thread stored counts.
 */
type Staged =
  | Exclude<Exported, { readonly kind: "stored" }>
  | (Extract<Exported, { readonly kind: "stored" }> & {
      readonly row: ThreadStorageRow;
    });

const description = (lines: ReadonlyArray<string>) => lines.join("\n\n");

/** The Thread an ID or a dx Thread URL names. */
const threadIdFrom = (value: string) => {
  const id =
    /thr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(
      value,
    )?.[0];
  if (id === undefined)
    throw new Error(
      `${value} is not a thread ID (thr_...) or a dx Thread URL.`,
    );
  return Schema.decodeUnknownSync(ThreadId)(id);
};

const baseName = (path: string) =>
  path.replace(/\/+$/, "").split("/").at(-1) || "file";

const joinPath = (directory: string, path: string) =>
  directory === "" || directory === "."
    ? path
    : `${directory.replace(/\/+$/, "")}/${path}`;

const skipMessage = (outcome: Staged) =>
  outcome.kind === "skipped"
    ? `${outcome.reason}${outcome.message === undefined ? "" : `: ${outcome.message}`}`
    : outcome.kind;

/**
 * The thread file tools: copy a file from another of the owner's Threads,
 * copy one to it, copy another Thread's changed files, and share a file as
 * a temporary link. Every file moves through Thread storage: the source
 * Thread's dxd uploads it straight to R2 as a temporary file, and the
 * destination's dxd downloads it straight from R2 (`storage.export` and
 * `storage.import`); this Worker only authorizes and relays JSON. A staged
 * transfer is deleted as soon as it lands; a shared link expires after
 * three hours. Every call acts as the calling Thread's owner and reaches
 * only Threads that owner owns, or, from a shared Thread, its family.
 */
export const createThreadStorageTools = (
  callingThreadId: string,
  getContext: () => ThreadToolsContext,
): ToolDefinition[] => {
  const callingThread = (context: ThreadToolsContext) =>
    readCallingThread(context.db, callingThreadId);

  /** One of the owner's Threads, reachable from the calling Thread. */
  const ownedThread = async (
    context: ThreadToolsContext,
    owner: CallingThread,
    threadId: ThreadId,
  ) => {
    const family = owner.sharedFamilyRoot;
    const row = await context.db
      .prepare(
        `SELECT id, lifecycle_state FROM threads
          WHERE id = ? AND owner_user_id = ? AND lifecycle_state != 'deleted'${
            family === undefined ? "" : " AND (id = ? OR parent_thread_id = ?)"
          }`,
      )
      .bind(
        threadId,
        owner.ownerUserId,
        ...(family === undefined ? [] : [family, family]),
      )
      .first<{ readonly id: string; readonly lifecycle_state: string }>();
    if (row === null)
      throw new Error(
        family === undefined
          ? `Thread ${threadId} was not found among this Thread owner's Threads.`
          : `Thread ${threadId} is not reachable from this shared Thread: it reaches only its parent and child Threads.`,
      );
    if (row.lifecycle_state !== "active")
      throw new Error(
        `Thread ${threadId} is archived, so its workspace is not resumed. Unarchive it to reach its files.`,
      );
    return threadId;
  };

  /** Another of the owner's Threads, never the calling one. */
  const otherThread = async (
    context: ThreadToolsContext,
    owner: CallingThread,
    value: string,
  ) => {
    const threadId = threadIdFrom(value);
    if (threadId === callingThreadId)
      throw new Error(
        "That is this Thread. Name another of the owner's Threads.",
      );
    return ownedThread(context, owner, threadId);
  };

  const workspaceFailure = (threadId: string, cause: unknown) =>
    cause instanceof StorageTransferOutdated
      ? new Error(
          `Thread ${threadId}'s workspace is still updating its daemon. Try again in a minute.`,
        )
      : cause instanceof DaemonUnavailable
        ? new Error(
            `Thread ${threadId}'s workspace is unavailable: it could not be resumed or did not answer.`,
          )
        : cause;

  const exportFiles = async (
    context: ThreadToolsContext,
    threadId: ThreadId,
    files: ReadonlyArray<{ readonly path: string }>,
    maxBytes: number,
  ): Promise<Staged[]> => {
    let exported: ReadonlyArray<Exported>;
    try {
      const result = await transferThreadStorage(context.bindings, threadId, {
        operation: "storage.export",
        files: files.map(({ path }) => ({ path })),
        maxBytes,
      });
      if (result.kind !== "exported" || result.files.length !== files.length)
        throw new Error(
          `Thread ${threadId}'s workspace could not store the files.`,
        );
      exported = result.files;
    } catch (cause) {
      throw workspaceFailure(threadId, cause);
    }
    const staged: Staged[] = [];
    for (const outcome of exported) {
      if (outcome.kind !== "stored") {
        staged.push(outcome);
        continue;
      }
      const row = await findThreadStorageFile(context.db, outcome.id);
      staged.push(
        row !== null &&
          row.thread_id === threadId &&
          row.state === "ready" &&
          row.expires_at !== null
          ? { ...outcome, row }
          : {
              kind: "skipped",
              reason: "failed",
              message: "the workspace named a file it did not store",
            },
      );
    }
    return staged;
  };

  const importFiles = async (
    context: ThreadToolsContext,
    threadId: ThreadId,
    operation: Omit<DxdStorageImportOperation, "operation">,
  ) => {
    try {
      const result = await transferThreadStorage(context.bindings, threadId, {
        operation: "storage.import",
        ...operation,
      });
      if (
        result.kind !== "imported" ||
        result.files.length !== operation.files.length
      )
        throw new Error(
          `Thread ${threadId}'s workspace could not write the files.`,
        );
      return result.files;
    } catch (cause) {
      throw workspaceFailure(threadId, cause);
    }
  };

  /** Staged files are deleted once they land, whatever the outcome. */
  const discard = async (
    context: ThreadToolsContext,
    outcomes: ReadonlyArray<Staged>,
  ) => {
    for (const outcome of outcomes)
      if (outcome.kind === "stored")
        await deleteThreadStorageFile(context.bindings, outcome.row).catch(
          () => undefined,
        );
  };

  /** Where an exported file comes from when a workspace writes it. */
  const importSource = (
    outcome: Extract<Staged, { readonly kind: "stored" | "empty" }>,
  ) =>
    outcome.kind === "stored"
      ? ({ kind: "stored", id: outcome.id, mode: outcome.mode } as const)
      : ({ kind: "empty", mode: outcome.mode } as const);

  const workspaceName = (threadId: string) =>
    threadId === callingThreadId ? "this workspace" : `Thread ${threadId}`;

  /** Copy one file from one Thread's workspace into another's. */
  const copyFile = async (
    context: ThreadToolsContext,
    from: ThreadId,
    path: string,
    to: ThreadId,
    destination: string,
    overwrite: boolean,
    createParents: boolean,
  ) => {
    const [exported] = await exportFiles(
      context,
      from,
      [{ path }],
      MAX_THREAD_STORAGE_FILE_BYTES,
    );
    if (exported === undefined || exported.kind === "skipped")
      throw new Error(
        `Could not read ${path} in ${workspaceName(from)}: ${
          exported === undefined ? "no answer" : skipMessage(exported)
        }.`,
      );
    try {
      const [written] = await importFiles(context, to, {
        files: [{ path: destination, source: importSource(exported) }],
        overwrite,
        createParents,
      });
      const where = workspaceName(to);
      if (written === undefined || written.kind === "skipped")
        throw new Error(
          written?.reason === "exists"
            ? `${destination} already exists in ${where}. Set overwrite to replace it.`
            : written?.reason === "no-parent"
              ? `The parent directory of ${destination} does not exist in ${where}.`
              : `Could not write ${destination} in ${where}${
                  written?.message === undefined ? "" : `: ${written.message}`
                }.`,
        );
      return written;
    } finally {
      await discard(context, [exported]);
    }
  };

  const withOwner = async <T>(
    use: (context: ThreadToolsContext, owner: CallingThread) => Promise<T>,
  ) => {
    const context = getContext();
    return use(context, await callingThread(context));
  };

  const threadInput = (text: string) =>
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(THREAD_INPUT_MAX_CHARS),
      v.description(text),
    );
  const pathInput = (text: string) =>
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(PATH_MAX_CHARS),
      v.description(text),
    );
  const overwriteInput = v.optional(
    v.pipe(
      v.boolean(),
      v.description("Overwrite an existing destination file. Default: false."),
    ),
  );

  return [
    defineTool({
      name: "download_thread_file",
      description: description([
        "Download one file from the workspace of another of this Thread owner's Threads into this workspace. The remote path is relative to that Thread's workspace root, for example .dx/data.db, or absolute. Files of up to 500 MB.",
        "A paused workspace is resumed automatically, which can take a minute; an archived Thread is not resumed, so download its files before archiving it. Use download_thread_changes instead to copy every file a Thread changed.",
      ]),
      input: v.object({
        thread: threadInput("Source thread ID (thr_...) or dx Thread URL."),
        path: pathInput(
          "File path relative to the source Thread's workspace root, or an absolute path.",
        ),
        destination: v.optional(
          pathInput(
            "Destination file path in this workspace, relative to its root or absolute. Defaults to the remote file's base name in the workspace root. Missing directories are created.",
          ),
        ),
        overwrite: overwriteInput,
      }),
      run: async ({ data }) =>
        withOwner(async (context, owner) => {
          const source = await otherThread(context, owner, data.thread);
          const written = await copyFile(
            context,
            source,
            data.path,
            Schema.decodeUnknownSync(ThreadId)(callingThreadId),
            data.destination ?? baseName(data.path),
            data.overwrite === true,
            true,
          );
          return {
            output: {
              thread: source,
              path: data.path,
              destination: written.path,
              size: written.size,
            },
          };
        }),
    }),
    defineTool({
      name: "upload_thread_file",
      description: description([
        "Upload one file of up to 500 MB from this workspace to another of this Thread owner's Threads. The destination is relative to the target Thread's workspace root, or absolute, and its parent directory must already exist. Existing files are preserved unless overwrite is true.",
        "A paused workspace is resumed automatically; an archived Thread is not. The file reaches the target's workspace, not its conversation: tell its agent about it with send_thread_message when it needs to know.",
      ]),
      input: v.object({
        thread: threadInput("Target thread ID (thr_...) or dx Thread URL."),
        path: pathInput(
          "Source file in this workspace, relative to its root or absolute.",
        ),
        destination: v.optional(
          pathInput(
            "Target path relative to the target Thread's workspace root, or absolute. Defaults to the source file's base name.",
          ),
        ),
        overwrite: overwriteInput,
      }),
      run: async ({ data }) =>
        withOwner(async (context, owner) => {
          const target = await otherThread(context, owner, data.thread);
          const written = await copyFile(
            context,
            Schema.decodeUnknownSync(ThreadId)(callingThreadId),
            data.path,
            target,
            data.destination ?? baseName(data.path),
            data.overwrite === true,
            false,
          );
          return {
            output: {
              thread: target,
              path: data.path,
              destination: written.path,
              size: written.size,
            },
          };
        }),
    }),
    defineTool({
      name: "download_thread_changes",
      description: description([
        "Download the changed files of another of this Thread owner's Threads, as its latest Changes capture lists them (what its Changes tab shows): every file changed relative to its merge base with the default branch. Writes each changed file's current contents from that Thread's workspace under the destination directory at its repository-relative path, and reports files the Thread deleted, which are not written. Use it to continue or recreate another Thread's uncommitted or unpushed work.",
        "The source workspace is resumed if it is paused; an archived Thread is not resumed. Files over 16 MiB, and files in the source's linked worktrees, are skipped and reported. A file that already exists at its destination is skipped unless overwrite is true. A Thread of the same repository already has every modified file at its base version, so pass overwrite: true to take the source's versions.",
      ]),
      input: v.object({
        thread: threadInput("Source thread ID (thr_...) or dx Thread URL."),
        destination: v.optional(
          pathInput(
            "Output directory, relative to this workspace's root or absolute. Defaults to the workspace root.",
          ),
        ),
        paths: v.optional(
          v.pipe(
            v.array(
              pathInput(
                "A repository-relative path, as the Changes tab shows it.",
              ),
            ),
            v.minLength(1),
            v.maxLength(200),
            v.description(
              "Optional repository-relative paths to include. Omit to include every changed file.",
            ),
          ),
        ),
        overwrite: overwriteInput,
      }),
      run: async ({ data }) =>
        withOwner(async (context, owner) => {
          const source = await otherThread(context, owner, data.thread);
          const db = await Effect.runPromise(
            decodeD1Binding(context.bindings.DB),
          );
          const state = await makeThreadChangesRepository(db).read(source);
          const storage = context.bindings.DX_STORAGE;
          if (state?.latestCaptureId === undefined || storage === undefined)
            throw new Error(
              `Thread ${source} has no Changes yet: nothing differs from its default branch, or its workspace has not reported them.`,
            );
          const capture = await loadThreadChangesIndex(
            storage,
            source,
            state.latestCaptureId,
          );
          const all = capture.ranges.find(({ range }) => range.kind === "all");
          if (all === undefined)
            throw new Error(`Thread ${source}'s Changes are unavailable.`);
          const wanted =
            data.paths === undefined ? undefined : new Set(data.paths);
          const listed = all.files.filter(
            (file) => wanted === undefined || wanted.has(file.path),
          );
          // dxd names the primary checkout "primary"; older captures omit it.
          const linked = (file: { readonly worktree?: string }) =>
            file.worktree !== undefined && file.worktree !== "primary";
          const deleted = listed
            .filter((file) => file.status === "deleted")
            .map((file) => file.path);
          const skipped: Array<{ path: string; reason: string }> = listed
            .filter((file) => file.status !== "deleted" && linked(file))
            .map((file) => ({
              path: file.path,
              reason: "in a linked worktree",
            }));
          const copied = listed.filter(
            (file) => file.status !== "deleted" && !linked(file),
          );
          for (const path of wanted ?? [])
            if (!listed.some((file) => file.path === path))
              skipped.push({ path, reason: "not among the changed files" });
          const written: Array<{ path: string; size: number }> = [];
          if (copied.length > 0) {
            const exported = await exportFiles(
              context,
              source,
              copied.map((file) => ({ path: file.path })),
              CHANGES_MAX_FILE_BYTES,
            );
            try {
              const sendable = copied.flatMap((file, index) => {
                const outcome = exported[index];
                if (outcome === undefined || outcome.kind === "skipped") {
                  skipped.push({
                    path: file.path,
                    reason:
                      outcome?.kind === "skipped" &&
                      outcome.reason === "too-large"
                        ? "over 16 MiB"
                        : outcome === undefined
                          ? "no answer"
                          : skipMessage(outcome),
                  });
                  return [];
                }
                return [
                  {
                    path: joinPath(data.destination ?? "", file.path),
                    from: file.path,
                    source: importSource(outcome),
                  },
                ];
              });
              if (sendable.length > 0) {
                const results = await importFiles(
                  context,
                  Schema.decodeUnknownSync(ThreadId)(callingThreadId),
                  {
                    files: sendable.map(({ path, source }) => ({
                      path,
                      source,
                    })),
                    overwrite: data.overwrite === true,
                    createParents: true,
                  },
                );
                results.forEach((result, index) => {
                  const from = sendable[index]?.from ?? "";
                  if (result.kind === "written")
                    written.push({ path: result.path, size: result.size });
                  else
                    skipped.push({
                      path: from,
                      reason:
                        result.reason === "exists"
                          ? "exists here; set overwrite to replace it"
                          : `${result.reason}${result.message === undefined ? "" : `: ${result.message}`}`,
                    });
                });
              }
            } finally {
              await discard(context, exported);
            }
          }
          return {
            output: {
              thread: source,
              capturedAt: capture.capturedAt,
              ...(capture.branch === undefined
                ? {}
                : { branch: capture.branch }),
              head: capture.head,
              written,
              deleted,
              skipped,
              ...(all.truncated ? { truncated: true } : {}),
            },
          };
        }),
    }),
    defineTool({
      name: "thread_file_url",
      description: description([
        "Store files from a Thread's workspace (this Thread's, or another of its owner's Threads') in temporary Thread storage and return their URLs. Any file type up to 500 MB.",
        "The URLs are temporary: they stop working 3 hours after this call, and the result's expiresAt says exactly when. Each url is on dx's origin, and the Thread's owner, or anyone the Thread is shared with, opens it while signed in to dx. Tell the user the link is temporary and when it expires.",
        "To copy a file into another Thread's workspace, use download_thread_file or upload_thread_file instead. To show media in a reply, use `dxd files put`, whose URLs last as long as the Thread.",
      ]),
      input: v.object({
        thread: v.optional(
          threadInput(
            "Thread ID (thr_...) or dx Thread URL whose workspace holds the files. Defaults to this Thread.",
          ),
        ),
        paths: v.pipe(
          v.array(
            pathInput(
              "A file path relative to that Thread's workspace root, or absolute.",
            ),
          ),
          v.minLength(1),
          v.maxLength(URL_MAX_FILES),
          v.description(`One or more file paths, at most ${URL_MAX_FILES}.`),
        ),
      }),
      run: async ({ data }) =>
        withOwner(async (context, owner) => {
          const threadId = await ownedThread(
            context,
            owner,
            data.thread === undefined
              ? Schema.decodeUnknownSync(ThreadId)(callingThreadId)
              : threadIdFrom(data.thread),
          );
          const exported = await exportFiles(
            context,
            threadId,
            data.paths.map((path) => ({ path })),
            MAX_THREAD_STORAGE_FILE_BYTES,
          );
          const origin = attachmentOrigin(
            context.bindings,
            "https://thread.internal/",
          );
          const files = [];
          for (const [index, outcome] of exported.entries()) {
            const path = data.paths[index] ?? "";
            const row = outcome.kind === "stored" ? outcome.row : null;
            if (row === null) {
              files.push({
                path,
                error:
                  outcome.kind === "empty"
                    ? "the file is empty"
                    : skipMessage(outcome),
              });
              continue;
            }
            const stored = threadStorageFileData(row, origin);
            const expiresAt = new Date(
              stored.expiresAt ??
                row.created_at + THREAD_STORAGE_TEMPORARY_TTL_MS,
            ).toISOString();
            files.push({
              path,
              url: stored.url,
              name: stored.name,
              size: stored.size,
              mimeType: stored.mimeType,
              expiresAt,
            });
          }
          const expiries = files.flatMap((file) =>
            "expiresAt" in file ? [file.expiresAt] : [],
          );
          return {
            output: {
              thread: threadId,
              ...(expiries.length === 0
                ? {}
                : { expiresAt: expiries.sort()[0] }),
              files,
            },
          };
        }),
    }),
  ];
};
