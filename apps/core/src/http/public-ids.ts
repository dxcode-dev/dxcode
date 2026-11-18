/**
 * Thread and Project IDs have a public form, `t-<uuid>` and `p-<uuid>`,
 * beside the stored `thr_<uuid>` and `prj_<uuid>` (wiki/agent-mail.md). The
 * ID schemas decode both, but a handler that reads a path parameter as text
 * (Flue's agent router names its Durable Object from it) would see the
 * public form. So every `/v1` and `/api` request's path segments are put in
 * the stored form here, once, before any route runs.
 */

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PUBLIC_ID = new RegExp(`^(t|p)-(${UUID})$`, "i");

/**
 * Where an ID sits in a path: the segment right after a collection that
 * holds Threads or Projects. Only these are rewritten, so a workspace file
 * or folder that happens to be named `t-<uuid>` keeps its name.
 */
const ID_POSITIONS: ReadonlyArray<ReadonlyArray<string>> = [
  ["v1", "threads"],
  ["v1", "agents", "dx"],
  ["v1", "projects"],
  ["v1", "shared-threads"],
  ["v1", "spaces"],
];

/** The path with public IDs in the stored form; the same path when none. */
export const storedIdPath = (pathname: string) => {
  const segments = pathname.split("/");
  for (const prefix of ID_POSITIONS) {
    const index = prefix.length + 1;
    if (!prefix.every((part, offset) => segments[offset + 1] === part))
      continue;
    const match = PUBLIC_ID.exec(segments[index] ?? "");
    if (match?.[1] === undefined || match[2] === undefined) continue;
    segments[index] =
      `${match[1].toLowerCase() === "t" ? "thr" : "prj"}_${match[2].toLowerCase()}`;
  }
  return segments.join("/");
};

/** Wraps the app's fetch so its routes only ever see stored IDs. */
// biome-ignore lint/suspicious/noExplicitAny: any fetch-shaped handler
type FetchLike = (request: Request, ...rest: any[]) => unknown;

export const withStoredIds = <F extends FetchLike>(fetch: F): F =>
  ((request: Request, ...rest: unknown[]) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/"))
      return fetch(request, ...(rest as []));
    const pathname = storedIdPath(url.pathname);
    if (pathname === url.pathname) return fetch(request, ...(rest as []));
    url.pathname = pathname;
    return fetch(new Request(url, request), ...(rest as []));
  }) as F;
