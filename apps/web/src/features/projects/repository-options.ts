import type { GitHubGrantData } from "@dx/api";
import {
  canonicalPublicGitRepositoryLocator,
  type ProviderRepositoryId,
} from "@dx/domain";
import type { BitbucketRepository } from "../settings/integrations/bitbucket-queries.js";

export type ProjectSource =
  | { readonly kind: "scratch" }
  | { readonly kind: "public-git-url"; readonly url: string }
  | {
      readonly kind: "repository";
      readonly provider: "github" | "bitbucket";
      readonly workspaceId?: string;
      readonly grantId: string;
      readonly providerRepositoryId: ProviderRepositoryId;
    };

/** A repository the user can pick: connected through a grant, or a URL. */
export interface RepositoryOption {
  readonly value: string;
  readonly label: string;
  readonly fullName: string;
  readonly webUrl: string;
  readonly visibility?: "public" | "private" | "internal";
  readonly connected?: {
    readonly provider: "github" | "bitbucket";
    readonly grantId: string;
    readonly workspaceId?: string;
    readonly repositoryId: string;
  };
}

const isBitbucketUuid = (value: string) =>
  /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?$/i.test(
    value,
  );

/** Repositories reachable through the user's own active connections. */
export const connectedRepositoryOptions = (
  grants: ReadonlyArray<GitHubGrantData>,
  bitbucketConnectionId: string | undefined,
  bitbucketRepositories: ReadonlyArray<BitbucketRepository>,
): ReadonlyArray<RepositoryOption> => [
  ...grants.flatMap((grant) =>
    grant.ownerScope === "personal" &&
    grant.status === "active" &&
    grant.installationStatus === "active"
      ? grant.repositories.map((repository) => ({
          value: `github:${grant.id}:${repository.id}`,
          label: repository.webUrl,
          fullName: repository.fullName,
          webUrl: repository.webUrl,
          visibility: repository.visibility,
          connected: {
            provider: "github" as const,
            grantId: grant.id,
            repositoryId: repository.id,
          },
        }))
      : [],
  ),
  ...(bitbucketConnectionId === undefined
    ? []
    : bitbucketRepositories.flatMap((repository) =>
        isBitbucketUuid(repository.id) &&
        isBitbucketUuid(repository.workspaceId)
          ? [
              {
                value: `bitbucket:${bitbucketConnectionId}:${repository.id}`,
                label: repository.webUrl,
                fullName: repository.fullName,
                webUrl: repository.webUrl,
                visibility: repository.visibility,
                connected: {
                  provider: "bitbucket" as const,
                  grantId: bitbucketConnectionId,
                  workspaceId: repository.workspaceId,
                  repositoryId: repository.id,
                },
              },
            ]
          : [],
      )),
];

/** A repository option for a pasted canonical URL, or `undefined`. */
export const urlOption = (value: string): RepositoryOption | undefined => {
  const locator = canonicalPublicGitRepositoryLocator(value.trim());
  return locator === undefined
    ? undefined
    : {
        value: `url:${locator.webUrl.toLowerCase()}`,
        label: locator.webUrl,
        fullName: locator.fullName,
        webUrl: locator.webUrl,
      };
};

export const sameRepository = (
  left: RepositoryOption,
  right: RepositoryOption,
) => left.webUrl.toLowerCase() === right.webUrl.toLowerCase();

/** Connected options plus a pasted URL that names none of them. */
export const optionsWithTypedUrl = (
  options: ReadonlyArray<RepositoryOption>,
  typed: string,
) => {
  const pasted = urlOption(typed);
  return pasted === undefined ||
    options.some((option) => sameRepository(option, pasted))
    ? options
    : [pasted, ...options];
};

/** A pasted URL matches its repository; other text matches by substring. */
export const matchesQuery = (option: RepositoryOption, query: string) => {
  const pasted = urlOption(query);
  if (pasted !== undefined) return sameRepository(option, pasted);
  const needle = query.trim().toLowerCase();
  return (
    option.webUrl.toLowerCase().includes(needle) ||
    option.fullName.toLowerCase().includes(needle)
  );
};

export const sourceFor = (repository: RepositoryOption): ProjectSource =>
  repository.connected === undefined
    ? { kind: "public-git-url", url: repository.webUrl }
    : {
        kind: "repository",
        provider: repository.connected.provider,
        grantId: repository.connected.grantId,
        ...(repository.connected.workspaceId === undefined
          ? {}
          : { workspaceId: repository.connected.workspaceId }),
        providerRepositoryId: repository.connected
          .repositoryId as ProviderRepositoryId,
      };
