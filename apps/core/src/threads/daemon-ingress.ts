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
    const match = DAEMON_INGRESS_PATH.exec(new URL(request.url).pathname);
    return forwardDaemonUpgrade(request, env.THREAD_EXECUTION, match?.[1]);
  },
};
