import {
  type CreateThreadArtifactCommentRequest,
  type CreateThreadArtifactRequest,
  DeleteThreadArtifactResponseSchema,
  type SaveThreadArtifactRequest,
  type ThreadArtifact,
  ThreadArtifactCommentListResponseSchema,
  ThreadArtifactCommentResponseSchema,
  ThreadArtifactErrorResponseSchema,
  ThreadArtifactImageResponseSchema,
  ThreadArtifactListResponseSchema,
  ThreadArtifactResponseSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { noticeUnauthenticated } from "../../shared/auth/session-ended.js";
import { sameOriginFetch } from "../../shared/same-origin-fetch.js";

/** An artifact with its current Markdown. */
export interface ArtifactDocument {
  readonly artifact: ThreadArtifact;
  readonly markdown: string;
}

/** A refused artifact request; a conflict carries the newer revision. */
export class ArtifactApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly current?: ArtifactDocument,
  ) {
    super(message);
    this.name = "ArtifactApiError";
  }
}

export const isArtifactConflict = (
  error: unknown,
): error is ArtifactApiError & { readonly current: ArtifactDocument } =>
  error instanceof ArtifactApiError &&
  error.code === "ARTIFACT_CONFLICT" &&
  error.current !== undefined;

const artifactsUrl = (threadId: ThreadId, artifactId?: string) =>
  `/v1/threads/${encodeURIComponent(threadId)}/artifacts${
    artifactId === undefined ? "" : `/${encodeURIComponent(artifactId)}`
  }`;

const send = async <S extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  schema: S,
  init: RequestInit = {},
): Promise<S["Type"]> => {
  const response = await sameOriginFetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  noticeUnauthenticated(response);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = await Schema.decodeUnknownPromise(
      ThreadArtifactErrorResponseSchema,
    )(body).catch(() => undefined);
    throw new ArtifactApiError(
      response.status,
      error?.data.code ?? "ARTIFACTS_UNAVAILABLE",
      error?.data.message ?? "Artifacts are temporarily unavailable.",
      error?.data.current,
    );
  }
  return Schema.decodeUnknownPromise(schema)(body);
};

export const listArtifacts = async (threadId: ThreadId, signal?: AbortSignal) =>
  (
    await send(artifactsUrl(threadId), ThreadArtifactListResponseSchema, {
      ...(signal === undefined ? {} : { signal }),
    })
  ).data.artifacts;

export const getArtifact = async (
  threadId: ThreadId,
  artifactId: string,
  signal?: AbortSignal,
): Promise<ArtifactDocument> =>
  (
    await send(
      artifactsUrl(threadId, artifactId),
      ThreadArtifactResponseSchema,
      signal === undefined ? {} : { signal },
    )
  ).data;

export const createArtifact = async (
  threadId: ThreadId,
  input: CreateThreadArtifactRequest,
): Promise<ArtifactDocument> =>
  (
    await send(artifactsUrl(threadId), ThreadArtifactResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).data;

/**
 * Saves a new revision made from `baseRevision`. A newer revision refuses it
 * with an `ARTIFACT_CONFLICT` error carrying that revision.
 */
export const saveArtifact = async (
  threadId: ThreadId,
  artifactId: string,
  input: SaveThreadArtifactRequest,
): Promise<ArtifactDocument> =>
  (
    await send(
      artifactsUrl(threadId, artifactId),
      ThreadArtifactResponseSchema,
      { method: "PUT", body: JSON.stringify(input) },
    )
  ).data;

/** Every comment and reply on an artifact, oldest first, resolved ones too. */
export const listArtifactComments = async (
  threadId: ThreadId,
  artifactId: string,
  signal?: AbortSignal,
) =>
  (
    await send(
      `${artifactsUrl(threadId, artifactId)}/comments`,
      ThreadArtifactCommentListResponseSchema,
      signal === undefined ? {} : { signal },
    )
  ).data.comments;

/** A comment on a quote in the current revision, or a reply. */
export const createArtifactComment = async (
  threadId: ThreadId,
  artifactId: string,
  input: CreateThreadArtifactCommentRequest,
) =>
  (
    await send(
      `${artifactsUrl(threadId, artifactId)}/comments`,
      ThreadArtifactCommentResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    )
  ).data.comment;

/** Resolves a comment, hiding it and its replies. */
export const resolveArtifactComment = async (
  threadId: ThreadId,
  artifactId: string,
  commentId: string,
) =>
  (
    await send(
      `${artifactsUrl(threadId, artifactId)}/comments/${encodeURIComponent(commentId)}/resolve`,
      ThreadArtifactCommentResponseSchema,
      { method: "POST" },
    )
  ).data.comment;

/** Deletes an artifact with its revisions and comments. */
export const deleteArtifact = async (threadId: ThreadId, artifactId: string) =>
  (
    await send(
      artifactsUrl(threadId, artifactId),
      DeleteThreadArtifactResponseSchema,
      { method: "DELETE" },
    )
  ).data;

/** An image stored with the Thread, as an artifact embeds it. */
export interface ArtifactImage {
  readonly url: string;
  readonly name: string;
}

/**
 * A URL on this app's origin as its path, so an artifact's images keep
 * working on any of the app's addresses; another origin's URL as it is.
 */
const ownPath = (url: string) => {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin
      ? parsed.pathname + parsed.search
      : url;
  } catch {
    return url;
  }
};

/**
 * Uploads an image's bytes to the Thread
 * (`POST /v1/threads/:threadId/artifacts/images`), reporting the share sent
 * (0 to 1), which fetch cannot. Refusals throw `ArtifactApiError`.
 */
const uploadArtifactImage = (
  threadId: ThreadId,
  file: File,
  onProgress: (share: number) => void,
): Promise<ArtifactImage> =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(
      "POST",
      `${artifactsUrl(threadId)}/images?name=${encodeURIComponent(file.name || "image")}`,
    );
    request.setRequestHeader("accept", "application/json");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0)
        onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      // A session that ended elsewhere shows sign-in, as for every request.
      noticeUnauthenticated(
        new Response(request.responseText, { status: request.status }),
      );
      let body: unknown;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        body = undefined;
      }
      if (request.status >= 200 && request.status < 300) {
        Schema.decodeUnknownPromise(ThreadArtifactImageResponseSchema)(body)
          .then(({ data }) =>
            resolve({ url: ownPath(data.url), name: data.name }),
          )
          .catch(() =>
            reject(
              new ArtifactApiError(
                request.status,
                "ARTIFACTS_UNAVAILABLE",
                "The image could not be added.",
              ),
            ),
          );
        return;
      }
      void Schema.decodeUnknownPromise(ThreadArtifactErrorResponseSchema)(body)
        .catch(() => undefined)
        .then((error) =>
          reject(
            new ArtifactApiError(
              request.status,
              error?.data.code ??
                (request.status === 403
                  ? "THREAD_READ_ONLY"
                  : "ARTIFACTS_UNAVAILABLE"),
              error?.data.message ?? "The image could not be added.",
            ),
          ),
        );
    };
    request.onerror = () =>
      reject(new ArtifactApiError(0, "NETWORK", "The upload was interrupted."));
    request.send(file);
  });

export interface ArtifactsApi {
  readonly list: typeof listArtifacts;
  readonly get: typeof getArtifact;
  readonly create: typeof createArtifact;
  readonly save: typeof saveArtifact;
  readonly uploadImage: typeof uploadArtifactImage;
}

export const artifactsApi: ArtifactsApi = {
  list: listArtifacts,
  get: getArtifact,
  create: createArtifact,
  save: saveArtifact,
  uploadImage: uploadArtifactImage,
};
