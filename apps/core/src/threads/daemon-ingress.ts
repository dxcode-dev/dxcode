// dxd ingress: forward a daemon's WebSocket upgrade to its Thread execution
// object, which checks the key against the hash it keeps with the authority.
// Dependency-free on purpose: this module is also the whole of the dedicated
// ingress Worker, whose isolate starts in milliseconds where the full Core
// bundle takes about a second after a guest resumes.

const THREAD_ID =
  /^thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAEMON_KEY = /^Bearer dxd_[A-Za-z0-9._~-]{16,1016}$/;
const FORWARDED_HEADERS = [
  "authorization",
  "connection",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
] as const;

export const DAEMON_INGRESS_PATH = /^\/v1\/dxd\/([^/]+)$/;
export const DAEMON_ATTACHMENT_PATH =
  /^\/v1\/dxd\/([^/]+)\/attachments\/(att_[0-9a-f]{32})$/;

/**
 * `dxd files get` downloads a message attachment into the guest with the
 * daemon's own key. The Thread execution object checks the key as it does for
 * the socket and answers with a presigned R2 URL for any file the Thread's
 * owner could open; the guest then downloads straight from R2.
 */
export const forwardDaemonAttachment = async (
  request: Request,
  namespace: DurableObjectNamespace | undefined,
  threadId: string | undefined,
  attachmentId: string | undefined,
): Promise<Response> => {
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    threadId === undefined ||
    !THREAD_ID.test(threadId) ||
    attachmentId === undefined ||
    namespace === undefined
  )
    return new Response(null, { status: 404 });
  if (!DAEMON_KEY.test(request.headers.get("authorization") ?? ""))
    return new Response(null, { status: 401 });
  const headers = new Headers({
    authorization: request.headers.get("authorization") ?? "",
    "x-dx-daemon-ingress": "1",
    "x-dx-thread-id": threadId,
    "x-dx-attachment-id": attachmentId,
  });
  const range = request.headers.get("range");
  if (range !== null) headers.set("range", range);
  // Only local development streams the bytes through Core.
  if (new URL(request.url).searchParams.get("content") === "1")
    headers.set("x-dx-attachment-content", "1");
  return namespace.get(namespace.idFromName(threadId)).fetch(
    new Request("https://thread.internal/daemon/attachment", {
      method: request.method,
      headers,
    }),
  );
};

export const forwardDaemonUpgrade = async (
  request: Request,
  namespace: DurableObjectNamespace | undefined,
  threadId: string | undefined,
): Promise<Response> => {
  if (
    request.method !== "GET" ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    threadId === undefined ||
    !THREAD_ID.test(threadId) ||
    namespace === undefined
  )
    return new Response(null, { status: 404 });
  if (!DAEMON_KEY.test(request.headers.get("authorization") ?? ""))
    return new Response(null, { status: 401 });
  const headers = new Headers({
    upgrade: "websocket",
    "x-dx-daemon-ingress": "1",
    "x-dx-thread-id": threadId,
  });
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return namespace
    .get(namespace.idFromName(threadId))
    .fetch(new Request("https://thread.internal/daemon/socket", { headers }));
};

export default {
  fetch(
    request: Request,
    env: { readonly THREAD_EXECUTION?: DurableObjectNamespace },
  ) {
    const path = new URL(request.url).pathname;
    const attachment = DAEMON_ATTACHMENT_PATH.exec(path);
    if (attachment !== null)
      return forwardDaemonAttachment(
        request,
        env.THREAD_EXECUTION,
        attachment[1],
        attachment[2],
      );
    const match = DAEMON_INGRESS_PATH.exec(path);
    return forwardDaemonUpgrade(request, env.THREAD_EXECUTION, match?.[1]);
  },
};
