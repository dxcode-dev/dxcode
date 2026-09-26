import {
  GITHUB_APP_REPOSITORY_PERMISSIONS,
  type GitIntegrationProvider,
  type ProviderRepositoryId,
} from "@dx/domain";
import { Redacted, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import {
  type GitHubAppConfiguration,
  loadGitHubAppConfigurationSync,
} from "../../source-control/github/configuration.js";
import { sourceControlProviderRegistry } from "../../source-control/provider-registry.js";

const GITHUB_PERMISSIONS = [
  "actions:write",
  "checks:read",
  "contents:write",
  "issues:write",
  "metadata:read",
  "organization_projects:write",
  "pull_requests:write",
  "statuses:read",
  "workflows:write",
] as const;
const GITLAB_SCOPES = ["read_api", "read_repository", "read_user"] as const;
const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1_000;

export class IntegrationProviderUnavailable extends Schema.TaggedError<IntegrationProviderUnavailable>()(
  "IntegrationProviderUnavailable",
  {},
) {}

export class IntegrationProviderRequestFailed extends Schema.TaggedError<IntegrationProviderRequestFailed>()(
  "IntegrationProviderRequestFailed",
  {},
) {}

export class IntegrationRepositoryForbidden extends Schema.TaggedError<IntegrationRepositoryForbidden>()(
  "IntegrationRepositoryForbidden",
  {},
) {}

export interface ProviderTokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly refreshExpiresAt?: string;
  readonly grantedScopes: ReadonlyArray<string>;
}

export interface ProviderIdentity {
  readonly id: string;
  readonly login: string;
}

export interface ProviderRepository {
  readonly id: ProviderRepositoryId;
  readonly fullName: string;
  readonly webUrl: string;
  readonly cloneUrl: string;
  readonly visibility: "public" | "private" | "internal";
}

export interface GitProviderClient {
  readonly provider: GitIntegrationProvider;
  readonly callbackUrl: string;
  readonly leastPrivilegeScopes: ReadonlyArray<string>;
  readonly authorizationUrl: (input: {
    readonly state: string;
    readonly codeChallenge: string;
  }) => string;
  readonly exchangeCode: (input: {
    readonly code: string;
    readonly codeVerifier: string;
  }) => Promise<ProviderTokenSet>;
  readonly refresh: (refreshToken: string) => Promise<ProviderTokenSet>;
  readonly revoke: (tokens: {
    readonly accessToken: string;
    readonly refreshToken?: string;
  }) => Promise<void>;
  readonly identity: (accessToken: string) => Promise<ProviderIdentity>;
  readonly repositories: (
    accessToken: string,
  ) => Promise<ReadonlyArray<ProviderRepository>>;
}

export interface IntegrationProviderRegistration {
  readonly provider: GitIntegrationProvider | "slack" | "mattermost" | "teams";
  readonly kind: "git" | "collaboration";
  readonly displayName: string;
  readonly configured: boolean;
  readonly available: boolean;
  readonly pkce: boolean;
  readonly leastPrivilegeScopes: ReadonlyArray<string>;
  readonly reason?: string;
  readonly client?: GitProviderClient;
}

const bytes = (length: number): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(length));

const base64Url = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const sha256 = async (value: string): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );

export const createOAuthProof = async (
  input: {
    readonly stateBytes?: Uint8Array<ArrayBuffer>;
    readonly verifierBytes?: Uint8Array<ArrayBuffer>;
  } = {},
) => {
  const state = base64Url(input.stateBytes ?? bytes(32));
  const codeVerifier = base64Url(input.verifierBytes ?? bytes(64));
  return {
    state,
    codeVerifier,
    codeChallenge: base64Url(await sha256(codeVerifier)),
  };
};

export const hashOAuthState = async (state: string): Promise<string> =>
  [...(await sha256(state))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const oauthTransactionExpiresAt = (now: Date): string =>
  new Date(now.getTime() + OAUTH_TRANSACTION_TTL_MS).toISOString();

const isAllowedUrl = (value: string, environment: string | undefined) => {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (environment === "local" ||
        environment === "development" ||
        environment === "test") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
};

const exactOrigin = (
  value: string,
  environment: string | undefined,
): string | undefined => {
  if (!isAllowedUrl(value, environment)) return undefined;
  const url = new URL(value);
  return url.pathname === "/" ? url.origin : undefined;
};

const repositoryUrl = (value: unknown, origin: string): string | undefined => {
  const raw = requiredString(value);
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.origin === origin && !url.username && !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

const exactGitHubPermissions = (
  value: unknown,
  accountType: unknown,
): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const permissions = value as Record<string, unknown>;
  const expected = {
    ...GITHUB_APP_REPOSITORY_PERMISSIONS,
    ...(accountType === "Organization"
      ? { organization_projects: "write" }
      : {}),
  };
  return (
    Object.keys(permissions).sort().join(" ") ===
      Object.keys(expected).sort().join(" ") &&
    Object.entries(expected).every(
      ([name, level]) => permissions[name] === level,
    )
  );
};

const callbackFor = (
  bindings: Bindings,
  provider: GitIntegrationProvider,
): string | undefined => {
  const authUrl = bindings.DX_AUTH_URL;
  if (authUrl === undefined || !isAllowedUrl(authUrl, bindings.DX_ENV)) {
    return undefined;
  }
  const url = new URL(authUrl);
  url.pathname = `/v1/settings/personal/integrations/oauth/callback/${provider}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

const exactObject = (
  raw: string | undefined,
  keys: ReadonlyArray<string>,
): Record<string, unknown> | undefined => {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
};

const requiredString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length >= 1 && value.length <= 1_024
    ? value
    : undefined;

const tokenSet = (
  value: unknown,
  requiredScopes: ReadonlyArray<string>,
  requireResponseScope = false,
  now = new Date(),
): ProviderTokenSet => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IntegrationProviderRequestFailed();
  }
  const input = value as Record<string, unknown>;
  const accessToken = requiredString(input.access_token);
  const refreshToken =
    input.refresh_token === undefined
      ? undefined
      : requiredString(input.refresh_token);
  const responseScopes =
    typeof input.scope === "string" && input.scope.length > 0
      ? input.scope.split(/[ ,]+/).filter(Boolean).sort()
      : [...requiredScopes].sort();
  const expiry = (seconds: unknown): string | undefined =>
    typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0
      ? new Date(now.getTime() + seconds * 1_000).toISOString()
      : undefined;
  const expiresAt = expiry(input.expires_in);
  if (
    accessToken === undefined ||
    refreshToken === undefined ||
    expiresAt === undefined ||
    (requireResponseScope &&
      (typeof input.scope !== "string" || input.scope.length === 0)) ||
    responseScopes.join(" ") !== [...requiredScopes].sort().join(" ")
  ) {
    throw new IntegrationProviderRequestFailed();
  }
  return {
    accessToken,
    refreshToken,
    expiresAt,
    ...(expiry(input.refresh_token_expires_in) === undefined
      ? {}
      : { refreshExpiresAt: expiry(input.refresh_token_expires_in) }),
    grantedScopes: responseScopes,
  };
};

const requestJson = async (
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> => {
  try {
    const response = await fetcher(url, { ...init, redirect: "manual" });
    if (!response.ok) throw new IntegrationProviderRequestFailed();
    return await response.json();
  } catch (cause) {
    if (cause instanceof IntegrationProviderRequestFailed) throw cause;
    throw new IntegrationProviderRequestFailed();
  }
};

const bearer = (accessToken: string): HeadersInit => ({
  accept: "application/json",
  authorization: `Bearer ${accessToken}`,
});

const formRequest = (
  values: Record<string, string>,
  headers: HeadersInit = {},
): RequestInit => ({
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    ...headers,
  },
  body: new URLSearchParams(values),
});

const githubClient = (
  config: GitHubAppConfiguration,
  callbackUrl: string,
  fetcher: typeof fetch,
): GitProviderClient => {
  const { clientId } = config;
  const clientSecret = Redacted.value(config.clientSecret);
  const tokenUrl = "https://github.com/login/oauth/access_token";
  const exchange = async (values: Record<string, string>) =>
    tokenSet(
      await requestJson(
        fetcher,
        tokenUrl,
        formRequest({
          client_id: clientId,
          client_secret: clientSecret,
          ...values,
        }),
      ),
      GITHUB_PERMISSIONS,
    );
  return {
    provider: "github",
    callbackUrl,
    leastPrivilegeScopes: GITHUB_PERMISSIONS,
    authorizationUrl: ({ state, codeChallenge }) => {
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `https://github.com/login/oauth/authorize?${query}`;
    },
    exchangeCode: ({ code, codeVerifier }) =>
      exchange({
        code,
        redirect_uri: callbackUrl,
        code_verifier: codeVerifier,
      }),
    refresh: (refreshToken) =>
      exchange({ grant_type: "refresh_token", refresh_token: refreshToken }),
    revoke: async ({ accessToken }) => {
      const response = await fetcher(
        `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`,
        {
          method: "DELETE",
          redirect: "manual",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          body: JSON.stringify({ access_token: accessToken }),
        },
      );
      if (!response.ok) throw new IntegrationProviderRequestFailed();
    },
    identity: async (accessToken) => {
      const value = await requestJson(fetcher, "https://api.github.com/user", {
        headers: {
          ...bearer(accessToken),
          "x-github-api-version": "2022-11-28",
        },
      });
      const input = value as Record<string, unknown>;
      const id = input.id === undefined ? undefined : String(input.id);
      const login = requiredString(input.login);
      if (id === undefined || login === undefined)
        throw new IntegrationProviderRequestFailed();
      return { id, login };
    },
    repositories: async (accessToken) => {
      const headers = {
        ...bearer(accessToken),
        "x-github-api-version": "2022-11-28",
      };
      const installationValue = await requestJson(
        fetcher,
        "https://api.github.com/user/installations?per_page=100",
        { headers },
      );
      const installations = (installationValue as { installations?: unknown })
        .installations;
      if (!Array.isArray(installations))
        throw new IntegrationProviderRequestFailed();
      const values = await Promise.all(
        installations.slice(0, 100).map(async (installation) => {
          const item = installation as Record<string, unknown>;
          const id = item.id;
          const account = item.account;
          const accountType =
            typeof account === "object" &&
            account !== null &&
            !Array.isArray(account)
              ? (account as Record<string, unknown>).type
              : undefined;
          if (
            typeof id !== "number" ||
            (accountType !== "User" && accountType !== "Organization") ||
            !exactGitHubPermissions(item.permissions, accountType)
          )
            throw new IntegrationProviderRequestFailed();
          const value = await requestJson(
            fetcher,
            `https://api.github.com/user/installations/${id}/repositories?per_page=100`,
            { headers },
          );
          const repositories = (value as { repositories?: unknown })
            .repositories;
          if (!Array.isArray(repositories))
            throw new IntegrationProviderRequestFailed();
          return repositories;
        }),
      );
      return values.flat().map((repository) => {
        const item = repository as Record<string, unknown>;
        const id = String(item.id ?? "");
        const fullName = requiredString(item.full_name);
        const webUrl = repositoryUrl(item.html_url, "https://github.com");
        const cloneUrl = repositoryUrl(item.clone_url, "https://github.com");
        if (
          !id ||
          fullName === undefined ||
          webUrl === undefined ||
          cloneUrl === undefined
        ) {
          throw new IntegrationProviderRequestFailed();
        }
        return {
          id: id as ProviderRepositoryId,
          fullName,
          webUrl,
          cloneUrl,
          visibility: item.private === true ? "private" : "public",
        };
      });
    },
  };
};

const gitlabClient = (
  config: Record<string, unknown>,
  callbackUrl: string,
  bindings: Bindings,
  fetcher: typeof fetch,
): GitProviderClient | undefined => {
  const clientId = requiredString(config.clientId);
  const clientSecret = requiredString(config.clientSecret);
  const configuredCallback = requiredString(config.callbackUrl);
  const baseUrl = requiredString(config.baseUrl);
  const root =
    baseUrl === undefined ? undefined : exactOrigin(baseUrl, bindings.DX_ENV);
  if (
    clientId === undefined ||
    clientSecret === undefined ||
    configuredCallback !== callbackUrl ||
    root === undefined
  ) {
    return undefined;
  }
  const tokenUrl = `${root}/oauth/token`;
  const exchange = async (values: Record<string, string>) =>
    tokenSet(
      await requestJson(
        fetcher,
        tokenUrl,
        formRequest({
          client_id: clientId,
          client_secret: clientSecret,
          ...values,
        }),
      ),
      GITLAB_SCOPES,
      true,
    );
  return {
    provider: "gitlab",
    callbackUrl,
    leastPrivilegeScopes: GITLAB_SCOPES,
    authorizationUrl: ({ state, codeChallenge }) => {
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: "code",
        state,
        scope: GITLAB_SCOPES.join(" "),
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `${root}/oauth/authorize?${query}`;
    },
    exchangeCode: ({ code, codeVerifier }) =>
      exchange({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
        code_verifier: codeVerifier,
      }),
    refresh: (refreshToken) =>
      exchange({ grant_type: "refresh_token", refresh_token: refreshToken }),
    revoke: async ({ accessToken, refreshToken }) => {
      const response = await fetcher(`${root}/oauth/revoke`, {
        ...formRequest({
          client_id: clientId,
          client_secret: clientSecret,
          token: refreshToken ?? accessToken,
        }),
        redirect: "manual",
      });
      if (!response.ok) throw new IntegrationProviderRequestFailed();
    },
    identity: async (accessToken) => {
      const value = await requestJson(fetcher, `${root}/api/v4/user`, {
        headers: bearer(accessToken),
      });
      const input = value as Record<string, unknown>;
      const id = input.id === undefined ? undefined : String(input.id);
      const login = requiredString(input.username);
      if (id === undefined || login === undefined)
        throw new IntegrationProviderRequestFailed();
      return { id, login };
    },
    repositories: async (accessToken) => {
      const value = await requestJson(
        fetcher,
        `${root}/api/v4/projects?membership=true&simple=true&per_page=100&order_by=path&sort=asc`,
        { headers: bearer(accessToken) },
      );
      if (!Array.isArray(value)) throw new IntegrationProviderRequestFailed();
      return value.map((repository) => {
        const item = repository as Record<string, unknown>;
        const id = String(item.id ?? "");
        const fullName = requiredString(item.path_with_namespace);
        const webUrl = repositoryUrl(item.web_url, root);
        const cloneUrl = repositoryUrl(item.http_url_to_repo, root);
        const visibility = item.visibility;
        if (
          !id ||
          fullName === undefined ||
          webUrl === undefined ||
          cloneUrl === undefined ||
          (visibility !== "public" &&
            visibility !== "private" &&
            visibility !== "internal")
        ) {
          throw new IntegrationProviderRequestFailed();
        }
        return {
          id: id as ProviderRepositoryId,
          fullName,
          webUrl,
          cloneUrl,
          visibility,
        };
      });
    },
  };
};

const unavailable = (
  provider: IntegrationProviderRegistration["provider"],
  kind: IntegrationProviderRegistration["kind"],
  displayName: string,
  reason: string,
  configured = false,
): IntegrationProviderRegistration => ({
  provider,
  kind,
  displayName,
  configured,
  available: false,
  pkce: kind === "git",
  leastPrivilegeScopes: [],
  reason,
});

export const loadIntegrationProviderRegistry = (
  bindings: Bindings,
  fetcher: typeof fetch = fetch,
): ReadonlyArray<IntegrationProviderRegistration> => {
  const githubConfig = loadGitHubAppConfigurationSync(bindings);
  const githubCallback = callbackFor(bindings, "github");
  const github =
    githubConfig === undefined || githubCallback === undefined
      ? undefined
      : githubClient(githubConfig, githubCallback, fetcher);

  const gitlabCallback = callbackFor(bindings, "gitlab");
  const gitlabConfig = exactObject(bindings.DX_INTEGRATION_GITLAB_OAUTH, [
    "baseUrl",
    "callbackUrl",
    "clientId",
    "clientSecret",
  ]);
  const gitlab =
    gitlabCallback === undefined || gitlabConfig === undefined
      ? undefined
      : gitlabClient(gitlabConfig, gitlabCallback, bindings, fetcher);

  const forgejoConfigured = bindings.DX_INTEGRATION_FORGEJO_OAUTH !== undefined;
  const registrations: ReadonlyArray<IntegrationProviderRegistration> = [
    github === undefined
      ? unavailable(
          "github",
          "git",
          "GitHub",
          "Configure the strict version-1 GitHub App deployment secret with expiring user tokens, the reviewed permission and event manifests, and exact callback, setup, and webhook URLs.",
          bindings.DX_INTEGRATION_GITHUB_APP !== undefined,
        )
      : {
          provider: "github",
          kind: "git",
          displayName: "GitHub",
          configured: true,
          available: true,
          pkce: true,
          leastPrivilegeScopes: GITHUB_PERMISSIONS,
          client: github,
        },
    gitlab === undefined
      ? unavailable(
          "gitlab",
          "git",
          "GitLab",
          "Configure GitLab OAuth with read_user, read_api, and read_repository plus PKCE and the exact callback URL.",
          gitlabConfig !== undefined,
        )
      : {
          provider: "gitlab",
          kind: "git",
          displayName: "GitLab",
          configured: true,
          available: true,
          pkce: true,
          leastPrivilegeScopes: GITLAB_SCOPES,
          client: gitlab,
        },
    unavailable(
      "forgejo",
      "git",
      "Forgejo",
      "Forgejo OAuth tokens are currently unscoped and can act with the user's full rights. Connection remains unavailable until Forgejo supports read-only repository OAuth scopes.",
      forgejoConfigured,
    ),
    unavailable(
      "slack",
      "collaboration",
      "Slack",
      "Unavailable until a destination, event opt-in policy, encrypted credential, and delivery audit configuration are complete.",
    ),
    unavailable(
      "mattermost",
      "collaboration",
      "Mattermost",
      "Unavailable until a destination, event opt-in policy, encrypted credential, and delivery audit configuration are complete.",
    ),
    unavailable(
      "teams",
      "collaboration",
      "Microsoft Teams",
      "Unavailable until a destination, event opt-in policy, encrypted credential, and delivery audit configuration are complete.",
    ),
  ];
  return registrations.filter(
    (registration) =>
      registration.kind === "git" &&
      sourceControlProviderRegistry.isEnabled(
        registration.provider as GitIntegrationProvider,
      ),
  );
};

export const configuredGitProvider = (
  registry: ReadonlyArray<IntegrationProviderRegistration>,
  provider: GitIntegrationProvider,
): GitProviderClient => {
  const registration = registry.find((item) => item.provider === provider);
  if (
    registration === undefined ||
    !registration.available ||
    registration.client === undefined
  ) {
    throw new IntegrationProviderUnavailable();
  }
  return registration.client;
};
