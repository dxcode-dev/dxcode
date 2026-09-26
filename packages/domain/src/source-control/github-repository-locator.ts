import { Schema } from "effect";

export interface CanonicalGitHubRepositoryLocator {
  readonly fullName: string;
  readonly webUrl: string;
  readonly cloneUrl: string;
}

const locatorPattern =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/;

export const canonicalGitHubRepositoryLocator = (
  value: string,
): CanonicalGitHubRepositoryLocator | undefined => {
  if (
    value.includes("%") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  )
    return undefined;
  const match = locatorPattern.exec(value);
  const owner = match?.[1];
  const repository = match?.[2];
  if (
    owner === undefined ||
    repository === undefined ||
    repository === "." ||
    repository === ".."
  )
    return undefined;
  const fullName = `${owner}/${repository}`.toLowerCase();
  return {
    fullName,
    webUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
  };
};

export const GitHubRepositoryUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) => canonicalGitHubRepositoryLocator(value) !== undefined,
    { description: "a canonical credential-free GitHub repository URL" },
  ),
);
