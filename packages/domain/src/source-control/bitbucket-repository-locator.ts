import { Schema } from "effect";

export interface CanonicalBitbucketRepositoryLocator {
  readonly fullName: string;
  readonly webUrl: string;
  readonly cloneUrl: string;
}

const locatorPattern =
  /^https:\/\/bitbucket\.org\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/;

export const canonicalBitbucketRepositoryLocator = (
  value: string,
): CanonicalBitbucketRepositoryLocator | undefined => {
  if (
    value.includes("%") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  )
    return undefined;
  const match = locatorPattern.exec(value);
  const workspace = match?.[1];
  const repository = match?.[2];
  if (
    workspace === undefined ||
    repository === undefined ||
    repository === "." ||
    repository === ".."
  )
    return undefined;
  const fullName = `${workspace}/${repository}`.toLowerCase();
  return {
    fullName,
    webUrl: `https://bitbucket.org/${fullName}`,
    cloneUrl: `https://bitbucket.org/${fullName}.git`,
  };
};

export const BitbucketRepositoryUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) => canonicalBitbucketRepositoryLocator(value) !== undefined,
    { description: "a canonical credential-free Bitbucket repository URL" },
  ),
);
