import {
  blockedHostname,
  isPublicIpAddress,
  type PublicDnsResolver,
  parseIpv4,
  readBounded,
  resolvePublicDns,
} from "../../../http/egress.js";
import { IMAGE_MAX_SOURCE_BYTES, sniffMedia } from "./image.js";

/**
 * Reads media from a URL for `view_media`. Every hop of a fetch, redirects
 * included, must be http(s) to a public address. The Thread's GitHub
 * credential goes only to github.com and api.github.com.
 *
 * GitHub serves an attachment in a private repository
 * (`github.com/user-attachments/assets/<id>`) only to a signed-in browser.
 * The API renders the issue or pull request that shows it with a short-lived
 * signed `private-user-images.githubusercontent.com` URL, which needs no
 * credential, so dx reads the attachment through the page it appears on.
 */

export class RemoteMediaRefused extends Error {
  override readonly name = "RemoteMediaRefused";
}

export interface RemoteMediaOptions {
  /** The token the Thread's `gh` would use, read only for GitHub URLs. */
  readonly githubToken: () => Promise<string | undefined>;
  /** The issue or pull request URL that shows a GitHub attachment. */
  readonly foundOn?: string;
  readonly fetch?: typeof fetch;
  readonly resolveDns?: PublicDnsResolver;
  readonly signal?: AbortSignal;
}

const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** Pages of 100 read from each GitHub list before giving up. */
const MAX_PAGES = 10;
const CREDENTIAL_HOSTS = new Set(["github.com", "api.github.com"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const checkTarget = async (url: URL, resolveDns: PublicDnsResolver) => {
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new RemoteMediaRefused(
      `Only http and https URLs can be viewed, not ${url.protocol}`,
    );
  if (url.username !== "" || url.password !== "")
    throw new RemoteMediaRefused("The URL must not carry credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const privateTarget = () =>
    new RemoteMediaRefused(
      `${url.host} is a private network address; view_media reads only public URLs. To view an image from this workspace, give its path instead.`,
    );
  if (blockedHostname(host)) throw privateTarget();
  if (parseIpv4(host) !== undefined || host.includes(":")) {
    if (!isPublicIpAddress(host)) throw privateTarget();
    return;
  }
  let addresses: ReadonlyArray<string>;
  try {
    addresses = await resolveDns(host);
  } catch {
    throw new RemoteMediaRefused(`Could not resolve ${host}.`);
  }
  if (addresses.length === 0)
    throw new RemoteMediaRefused(`${host} has no address.`);
  if (!addresses.every(isPublicIpAddress)) throw privateTarget();
};

interface Session {
  readonly fetch: typeof fetch;
  readonly resolveDns: PublicDnsResolver;
  readonly signal: AbortSignal;
  readonly token: string | undefined;
}

/** Fetches with redirects followed by hand, each hop checked first. */
const follow = async (
  session: Session,
  start: URL,
  accept: string,
): Promise<{ readonly url: URL; readonly response: Response }> => {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await checkTarget(url, session.resolveDns);
    const headers: Record<string, string> = {
      accept,
      "user-agent": "dx-view-media",
    };
    if (session.token !== undefined && CREDENTIAL_HOSTS.has(url.hostname))
      headers.authorization = `Bearer ${session.token}`;
    if (url.hostname === "api.github.com")
      headers["x-github-api-version"] = "2022-11-28";
    const response = await session.fetch(url.toString(), {
      headers,
      redirect: "manual",
      signal: session.signal,
    });
    const location = response.headers.get("location");
    if (!REDIRECTS.has(response.status) || location === null)
      return { url, response };
    await response.body?.cancel().catch(() => undefined);
    url = new URL(location, url);
  }
  throw new RemoteMediaRefused(
    `${start.toString()} redirected more than ${MAX_REDIRECTS} times.`,
  );
};

const readImage = async (url: URL, response: Response) => {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new RemoteMediaRefused(
      `${url.host} answered HTTP ${response.status} for this file.`,
    );
  }
  const bytes = await readBounded(
    response,
    IMAGE_MAX_SOURCE_BYTES,
    () =>
      new RemoteMediaRefused(
        `The file at ${url.host} is larger than ${megabytes(IMAGE_MAX_SOURCE_BYTES)}.`,
      ),
  );
  if (sniffMedia(bytes) === undefined)
    throw new RemoteMediaRefused(
      `The response from ${url.host} is not an image or other media file (${response.headers.get("content-type") ?? "no content type"}).`,
    );
  return bytes;
};

/** The attachment ID of a github.com attachment URL, or undefined. */
const attachmentId = (url: URL) => {
  if (url.hostname !== "github.com") return undefined;
  const match =
    /^\/user-attachments\/assets\/([0-9a-f-]{36})\/?$/i.exec(url.pathname) ??
    /^\/[^/]+\/[^/]+\/assets\/\d+\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
  return match?.[1]?.toLowerCase();
};

const FOUND_ON =
  /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(issues|pull)\/(\d+)(?:[/?#].*)?$/;

/** The signed URL GitHub's API renders for the attachment on `foundOn`. */
const signedAttachmentUrl = async (
  session: Session,
  id: string,
  foundOn: string,
) => {
  const match = FOUND_ON.exec(foundOn);
  if (match === null)
    throw new RemoteMediaRefused(
      "found_on must be a GitHub issue or pull request URL, such as https://github.com/owner/repo/issues/123.",
    );
  const [, owner, repo, kind, number] = match;
  const repository = `/repos/${owner}/${repo}`;
  const api = async <T>(path: string) => {
    const { response } = await follow(
      session,
      new URL(`https://api.github.com${path}`),
      "application/vnd.github.full+json",
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteMediaRefused(
        response.status === 404
          ? `GitHub answered 404 for ${foundOn}: it does not exist, or the Thread's GitHub credential cannot see it.`
          : `GitHub answered HTTP ${response.status} reading ${foundOn}.`,
      );
    }
    return (await response.json()) as T;
  };
  const pattern = new RegExp(
    `https://private-user-images\\.githubusercontent\\.com/[^"'\\s<>]*${id}[^"'\\s<>]*`,
    "i",
  );
  const find = (html: unknown) => {
    if (typeof html !== "string") return undefined;
    return pattern.exec(html)?.[0].replaceAll("&amp;", "&");
  };
  const item = await api<{ body_html?: string; pull_request?: unknown }>(
    `${repository}/issues/${number}`,
  );
  const inItem = find(item.body_html);
  if (inItem !== undefined) return inItem;
  const lists = [`${repository}/issues/${number}/comments`];
  if (kind === "pull" || item.pull_request !== undefined)
    lists.push(
      `${repository}/pulls/${number}/comments`,
      `${repository}/pulls/${number}/reviews`,
    );
  for (const list of lists)
    for (let page = 1; page <= MAX_PAGES; page++) {
      const entries = await api<ReadonlyArray<{ body_html?: string }>>(
        `${list}?per_page=100&page=${page}`,
      );
      for (const entry of entries) {
        const signed = find(entry.body_html);
        if (signed !== undefined) return signed;
      }
      if (entries.length < 100) break;
    }
  throw new RemoteMediaRefused(
    `Attachment ${id} was not found in ${foundOn}, its comments, or its reviews. Check that found_on is the issue or pull request that shows it.`,
  );
};

/** The bytes at `raw`, checked to be an image or other media file. */
export const fetchRemoteMedia = async (
  raw: string,
  options: RemoteMediaOptions,
): Promise<Uint8Array> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteMediaRefused(`${raw} is not a URL.`);
  }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal =
    options.signal === undefined
      ? timeout
      : AbortSignal.any([options.signal, timeout]);
  const id = attachmentId(url);
  const session: Session = {
    // Workers' fetch throws "Illegal invocation" when called as a method.
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    resolveDns: options.resolveDns ?? resolvePublicDns,
    signal,
    token: id === undefined ? undefined : await options.githubToken(),
  };
  const accept = "image/*,application/pdf;q=0.9,*/*;q=0.1";
  const direct = await follow(session, url, accept);
  if (id === undefined || direct.response.ok)
    return readImage(direct.url, direct.response);
  // A private repository's attachment.
  await direct.response.body?.cancel().catch(() => undefined);
  if (options.foundOn === undefined)
    throw new RemoteMediaRefused(
      `GitHub answered HTTP ${direct.response.status} for this attachment. GitHub serves attachments in a private repository only through the issue or pull request that shows them: call view_media again with found_on set to that issue or pull request URL.`,
    );
  if (session.token === undefined)
    throw new RemoteMediaRefused(
      "No GitHub credentials: the owner has not connected GitHub in dx Settings → Integrations and set no GITHUB_TOKEN environment variable.",
    );
  const signed = new URL(
    await signedAttachmentUrl(session, id, options.foundOn),
  );
  const fetched = await follow(session, signed, accept);
  return readImage(fetched.url, fetched.response);
};
