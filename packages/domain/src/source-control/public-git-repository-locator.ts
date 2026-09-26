import { Schema } from "effect";

export interface CanonicalPublicGitRepositoryLocator {
  readonly fullName: string;
  readonly webUrl: string;
  readonly cloneUrl: string;
}

const safeSegment = /^[A-Za-z0-9._-]+$/;

export const canonicalPublicGitRepositoryLocator = (
  value: string,
): CanonicalPublicGitRepositoryLocator | undefined => {
  if (
    value.includes("%") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  )
    return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname.endsWith("/")
  )
    return undefined;
  const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  const segments = path.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        !safeSegment.test(segment) || segment === "." || segment === "..",
    )
  )
    return undefined;
  const fullName = segments.join("/");
  const webUrl = `https://${url.hostname.toLowerCase()}/${fullName}`;
  return { fullName, webUrl, cloneUrl: `${webUrl}.git` };
};

export const PublicGitRepositoryUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) => canonicalPublicGitRepositoryLocator(value) !== undefined,
    { description: "a canonical credential-free public Git repository URL" },
  ),
);
