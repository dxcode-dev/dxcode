import { Schema } from "effect";
import { canonicalPublicGitRepositoryLocator } from "./public-git-repository-locator.js";

/**
 * Another URL of a Project's repository, such as a mirror or an SSH remote.
 * `url` is the canonical form people see; `webUrl` is the HTTPS identity dx
 * matches repositories by.
 */
export interface CanonicalGitRemoteAlias {
  readonly url: string;
  readonly webUrl: string;
}

const safeSegment = /^[A-Za-z0-9._-]+$/;
const safeUser = /^[A-Za-z0-9._-]{1,64}$/;
const safeHost =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const repositoryPath = (value: string) => {
  const segments = value.replace(/\.git$/, "").split("/");
  return segments.length >= 2 &&
    segments.every(
      (segment) =>
        safeSegment.test(segment) && segment !== "." && segment !== "..",
    )
    ? segments.join("/")
    : undefined;
};

/** `git@host:owner/repo(.git)` or `ssh://git@host[:port]/owner/repo(.git)`. */
const sshAlias = (value: string): CanonicalGitRemoteAlias | undefined => {
  const scp = /^([^@/:]+)@([^/:]+):([^/].*)$/.exec(value);
  const url = /^ssh:\/\/([^@/:]+)@([^/:]+)(?::(\d{1,5}))?\/(.+)$/.exec(value);
  const [user, rawHost, port, rawPath] =
    scp !== null
      ? [scp[1], scp[2], undefined, scp[3]]
      : url !== null
        ? [url[1], url[2], url[3], url[4]]
        : [];
  if (user === undefined || rawHost === undefined || rawPath === undefined)
    return undefined;
  const host = rawHost.toLowerCase();
  const path = repositoryPath(rawPath);
  if (
    !safeUser.test(user) ||
    !safeHost.test(host) ||
    path === undefined ||
    (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
  )
    return undefined;
  return {
    url:
      scp !== null
        ? `${user}@${host}:${path}.git`
        : `ssh://${user}@${host}${port === undefined ? "" : `:${port}`}/${path}.git`,
    webUrl: `https://${host}/${path}`,
  };
};

/**
 * The canonical alias for an HTTPS or SSH Git URL without credentials, or
 * `undefined`.
 */
export const canonicalGitRemoteAlias = (
  value: string,
): CanonicalGitRemoteAlias | undefined => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return undefined;
  if (trimmed.startsWith("https://")) {
    const locator = canonicalPublicGitRepositoryLocator(trimmed);
    return locator === undefined
      ? undefined
      : { url: locator.webUrl, webUrl: locator.webUrl };
  }
  if (/[\s%\\?#]/.test(trimmed)) return undefined;
  return sshAlias(trimmed);
};

export const GitRemoteAliasInput = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => canonicalGitRemoteAlias(value) !== undefined, {
    description: "an HTTPS or SSH Git URL without credentials",
  }),
);
