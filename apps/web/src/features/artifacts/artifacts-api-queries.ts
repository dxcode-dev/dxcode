import {
  CreateStandaloneArtifactCommentEndpoint,
  CreateThreadArtifactCommentEndpoint,
  type CreateThreadArtifactCommentRequest,
  CreateThreadArtifactEndpoint,
  type CreateThreadArtifactRequest,
  DeleteStandaloneArtifactEndpoint,
  DeleteThreadArtifactEndpoint,
  type Endpoint,
  GetStandaloneArtifactEndpoint,
  GetThreadArtifactEndpoint,
  ListStandaloneArtifactCommentsEndpoint,
  ListStandaloneArtifactMembersEndpoint,
  ListThreadArtifactCommentsEndpoint,
  ListThreadArtifactsEndpoint,
  NotifyStandaloneArtifactAgentEndpoint,
  NotifyThreadArtifactAgentEndpoint,
  ResolveStandaloneArtifactCommentEndpoint,
  ResolveThreadArtifactCommentEndpoint,
  SaveStandaloneArtifactEndpoint,
  SaveThreadArtifactEndpoint,
  type SaveThreadArtifactRequest,
  type ThreadArtifact,
  UploadStandaloneArtifactImageEndpoint,
  UploadThreadArtifactImageEndpoint,
} from "@dx/api";
import {
  type CallOptions,
  type EndpointAnswerValue,
  type EndpointInput,
  endpointPath,
  refusalError,
} from "@dx/client";
import { Schema } from "effect";
import { ApiError, dxClient } from "../../shared/api/client.js";
import { noticeUnauthenticated } from "../../shared/auth/session-ended.js";
import { sameOriginFetch } from "../../shared/same-origin-fetch.js";
import { type ArtifactScope, scopeThread } from "./artifact-scope.js";

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

const UNAVAILABLE = {
  code: "ARTIFACTS_UNAVAILABLE",
  message: "Artifacts are temporarily unavailable.",
};

/**
 * The ArtifactApiError for a refused call: the route's code, message, and
 * newer revision, or `fallback` for an answer dx does not send on purpose.
 * Anything else (a network failure, an abort) stays as it is.
 */
const artifactError = (
  error: unknown,
  fallback: { readonly code: string; readonly message: string } = UNAVAILABLE,
): unknown => {
  if (!(error instanceof ApiError)) return error;
  if (!error.hasValidatedPayload || error.code === undefined)
    return new ArtifactApiError(error.status, fallback.code, fallback.message);
  return new ArtifactApiError(
    error.status,
    error.code,
    error.message,
    error.data?.current as ArtifactDocument | undefined,
  );
};

type Call = <E extends Endpoint>(
  endpoint: E,
  input: EndpointInput<E>,
  options?: CallOptions,
) => Promise<EndpointAnswerValue<E>>;

/**
 * Calls an artifact or library endpoint; a refusal throws ArtifactApiError.
 * A body Core would refuse as invalid is refused here the same way, since
 * `call` cannot send it.
 */
export const sendArtifactRequest = async <E extends Endpoint>(
  endpoint: E,
  input: EndpointInput<E>,
  options: CallOptions = {},
): Promise<EndpointAnswerValue<E>> => {
  try {
    return await (dxClient.call as Call)(endpoint, input, options);
  } catch (error) {
    throw artifactError(error);
  }
};

const signalOf = (signal: AbortSignal | undefined): CallOptions =>
  signal === undefined ? {} : { signal };

/**
 * An artifact's routes are under its Thread or, for a standalone artifact,
 * at `/v1/standalone-artifacts/:artifactId`, which has no list or create
 * (the library makes standalone artifacts).
 */
const standaloneId = (scope: ArtifactScope) => scope.slice("artifact:".length);

/** A Thread's artifacts; a standalone artifact has none beside it. */
export const listArtifacts = async (
  threadId: ArtifactScope,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ThreadArtifact>> => {
  const thread = scopeThread(threadId);
  if (thread === undefined) return [];
  return (
    await sendArtifactRequest(
      ListThreadArtifactsEndpoint,
      { params: { threadId: thread } },
      signalOf(signal),
    )
  ).data.artifacts;
};

export const getArtifact = async (
  threadId: ArtifactScope,
  artifactId: string,
  signal?: AbortSignal,
): Promise<ArtifactDocument> => {
  const thread = scopeThread(threadId);
  return (
    thread === undefined
      ? await sendArtifactRequest(
          GetStandaloneArtifactEndpoint,
          { params: { artifactId } },
          signalOf(signal),
        )
      : await sendArtifactRequest(
          GetThreadArtifactEndpoint,
          { params: { threadId: thread, artifactId } },
          signalOf(signal),
        )
  ).data;
};

/** A new artifact in a Thread; the library makes standalone ones. */
export const createArtifact = async (
  threadId: ArtifactScope,
  input: CreateThreadArtifactRequest,
): Promise<ArtifactDocument> => {
  const thread = scopeThread(threadId);
  if (thread === undefined)
    throw new ArtifactApiError(404, UNAVAILABLE.code, UNAVAILABLE.message);
  return (
    await sendArtifactRequest(CreateThreadArtifactEndpoint, {
      params: { threadId: thread },
      body: input,
    })
  ).data;
};

/**
 * Saves a new revision made from `baseRevision`. A newer revision refuses it
 * with an `ARTIFACT_CONFLICT` error carrying that revision.
 */
export const saveArtifact = async (
  threadId: ArtifactScope,
  artifactId: string,
  input: SaveThreadArtifactRequest,
): Promise<ArtifactDocument> => {
  const thread = scopeThread(threadId);
  return (
    thread === undefined
      ? await sendArtifactRequest(SaveStandaloneArtifactEndpoint, {
          params: { artifactId },
          body: input,
        })
      : await sendArtifactRequest(SaveThreadArtifactEndpoint, {
          params: { threadId: thread, artifactId },
          body: input,
        })
  ).data;
};

/** A data: URL's bytes; undefined when it is malformed. */
const dataUrlBlob = (source: string): Blob | undefined => {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(source);
  if (match === null) return undefined;
  const [, type = "", parameters = "", data = ""] = match;
  try {
    const bytes = parameters.split(";").includes("base64")
      ? Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(data));
    return new Blob([bytes], { type: type || "application/octet-stream" });
  } catch {
    return undefined;
  }
};

/**
 * An image the artifact shows, as bytes, for an export to carry inside it;
 * undefined when it cannot be read (gone, or on another site).
 */
export const artifactImageBlob = async (
  source: string,
): Promise<Blob | undefined> => {
  // Decoded here: dx's CSP refuses fetching data: URLs.
  if (source.startsWith("data:")) return dataUrlBlob(source);
  try {
    const url = new URL(source, window.location.href);
    if (url.protocol !== "data:" && url.origin !== window.location.origin)
      return undefined;
    const response = await sameOriginFetch(url.href);
    return response.ok ? await response.blob() : undefined;
  } catch {
    return undefined;
  }
};

/** Every comment and reply on an artifact, oldest first, resolved ones too. */
export const listArtifactComments = async (
  threadId: ArtifactScope,
  artifactId: string,
  signal?: AbortSignal,
) => {
  const thread = scopeThread(threadId);
  return (
    thread === undefined
      ? await sendArtifactRequest(
          ListStandaloneArtifactCommentsEndpoint,
          { params: { artifactId } },
          signalOf(signal),
        )
      : await sendArtifactRequest(
          ListThreadArtifactCommentsEndpoint,
          { params: { threadId: thread, artifactId } },
          signalOf(signal),
        )
  ).data.comments;
};

/** A comment on a quote in the current revision, or a reply. */
export const createArtifactComment = async (
  threadId: ArtifactScope,
  artifactId: string,
  input: CreateThreadArtifactCommentRequest,
) => {
  const thread = scopeThread(threadId);
  return (
    thread === undefined
      ? await sendArtifactRequest(CreateStandaloneArtifactCommentEndpoint, {
          params: { artifactId },
          body: input,
        })
      : await sendArtifactRequest(CreateThreadArtifactCommentEndpoint, {
          params: { threadId: thread, artifactId },
          body: input,
        })
  ).data.comment;
};

/** Resolves a comment, hiding it and its replies. */
export const resolveArtifactComment = async (
  threadId: ArtifactScope,
  artifactId: string,
  commentId: string,
) => {
  const thread = scopeThread(threadId);
  return (
    thread === undefined
      ? await sendArtifactRequest(ResolveStandaloneArtifactCommentEndpoint, {
          params: { artifactId, commentId },
        })
      : await sendArtifactRequest(ResolveThreadArtifactCommentEndpoint, {
          params: { threadId: thread, artifactId, commentId },
        })
  ).data.comment;
};

/** Who `@` lists on a standalone artifact: the members it is shared with. */
export const getStandaloneArtifactMembers = async (
  artifactId: string,
  signal?: AbortSignal,
) =>
  (
    await sendArtifactRequest(
      ListStandaloneArtifactMembersEndpoint,
      { params: { artifactId } },
      signalOf(signal),
    )
  ).data.members;

/** Deletes an artifact with its revisions and comments. */
export const deleteArtifact = async (
  threadId: ArtifactScope,
  artifactId: string,
) => {
  const thread = scopeThread(threadId);
  return (
    thread === undefined
      ? await sendArtifactRequest(DeleteStandaloneArtifactEndpoint, {
          params: { artifactId },
        })
      : await sendArtifactRequest(DeleteThreadArtifactEndpoint, {
          params: { threadId: thread, artifactId },
        })
  ).data;
};

/**
 * Notify agent (#1765): wakes the Thread's agent once with what people
 * changed since it last saved the artifact.
 */
export const notifyArtifactAgent = async (
  threadId: ArtifactScope,
  artifactId: string,
) => {
  const thread = scopeThread(threadId);
  return (
    thread === undefined
      ? await sendArtifactRequest(NotifyStandaloneArtifactAgentEndpoint, {
          params: { artifactId },
        })
      : await sendArtifactRequest(NotifyThreadArtifactAgentEndpoint, {
          params: { threadId: thread, artifactId },
        })
  ).data;
};

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

/** The upload endpoint and its URL for the scope, with the file's name. */
const imageUpload = (scope: ArtifactScope, name: string) => {
  const thread = scopeThread(scope);
  const query = { name };
  return thread === undefined
    ? {
        endpoint: UploadStandaloneArtifactImageEndpoint,
        url: endpointPath(UploadStandaloneArtifactImageEndpoint, {
          params: { artifactId: standaloneId(scope) },
          query,
        }),
      }
    : {
        endpoint: UploadThreadArtifactImageEndpoint,
        url: endpointPath(UploadThreadArtifactImageEndpoint, {
          params: { threadId: thread },
          query,
        }),
      };
};

/**
 * Uploads an image's bytes to the Thread, or to a standalone artifact,
 * reporting the share sent (0 to 1), which fetch cannot. Refusals throw
 * `ArtifactApiError`.
 */
const uploadArtifactImage = (
  threadId: ArtifactScope,
  file: File,
  onProgress: (share: number) => void,
): Promise<ArtifactImage> =>
  new Promise((resolve, reject) => {
    const { endpoint, url } = imageUpload(threadId, file.name || "image");
    const request = new XMLHttpRequest();
    request.open(endpoint.method, url);
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
        Schema.decodeUnknownPromise(endpoint.success)(body)
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
      void refusalError(endpoint, request.status, body).then((error) =>
        reject(
          artifactError(error, {
            code:
              request.status === 403
                ? "THREAD_READ_ONLY"
                : "ARTIFACTS_UNAVAILABLE",
            message: "The image could not be added.",
          }),
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
