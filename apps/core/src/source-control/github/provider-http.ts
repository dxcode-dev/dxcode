import { Redacted, Schema } from "effect";
import type { GitHubAppConfiguration } from "./configuration.js";

const API_ORIGIN = "https://api.github.com";
const WEB_ORIGIN = "https://github.com";
const TOKEN_URL = `${WEB_ORIGIN}/login/oauth/access_token`;
const API_VERSION = "2022-11-28";
const USER_AGENT = "dx-github-app";
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_PAGES = 1_000;
const MAX_VALUE = 8_192;

export type GitHubProviderErrorCategory =
  | "unauthorized"
  | "forbidden"
  | "saml-required"
  | "not-found"
  | "rate-limited"
  | "invalid-response"
  | "unavailable";

export class GitHubProviderError extends Schema.TaggedError<GitHubProviderError>()(
  "GitHubProviderError",
  {
    category: Schema.Literals([
      "unauthorized",
      "forbidden",
      "saml-required",
      "not-found",
      "rate-limited",
      "invalid-response",
      "unavailable",
    ]),
    retryAt: Schema.optional(Schema.instanceOf(Date)),
    endpoint: Schema.optional(Schema.Literals(["oauth-token", "rest-api"])),
    failureReason: Schema.optional(
      Schema.Literals(["http-response", "fetch-exception"]),
    ),
    failureCause: Schema.optional(
      Schema.Literals(["abort-error", "type-error", "other-error"]),
    ),
    failureCauseDetail: Schema.optional(
      Schema.Literals([
        "redirect",
        "redirect-same-origin",
        "redirect-cross-origin",
        "redirect-invalid",
        "signal",
        "receiver",
        "headers",
        "other",
      ]),
    ),
  },
) {}

export interface GitHubTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly refreshExpiresAt?: Date;
  readonly scopes: ReadonlyArray<string>;
}

export interface GitHubUser {
  readonly id: string;
  readonly login: string;
}

export interface GitHubInstallation {
  readonly id: string;
  readonly account: {
    readonly id: string;
    readonly login: string;
    readonly type: "User" | "Organization";
  };
  readonly repositorySelection: "all" | "selected";
  readonly permissions: Readonly<Record<string, "read" | "write">>;
  readonly suspendedAt?: Date;
}

export interface GitHubRepository {
  readonly id: string;
  readonly fullName: string;
  readonly webUrl: string;
  readonly cloneUrl: string;
  readonly visibility: "public" | "private" | "internal";
  readonly archived: boolean;
  readonly defaultBranch: string;
}

export interface GitHubResolvedSource {
  readonly repository: GitHubRepository;
  readonly commitSha: string;
}

type Clock = () => Date;

const runtimeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

const bounded = (value: unknown, maximum = MAX_VALUE): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;

const stableId = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,30})$/.test(value))
    return value;
  return undefined;
};

const retryAt = (headers: Headers, now: Date): Date | undefined => {
  const retry = headers.get("retry-after");
  if (retry !== null) {
    if (/^[0-9]+$/.test(retry))
      return new Date(now.getTime() + Number(retry) * 1_000);
    const parsed = Date.parse(retry);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null && /^[0-9]+$/.test(reset))
    return new Date(Number(reset) * 1_000);
  return undefined;
};

const responseError = (
  response: Response,
  now: Date,
  endpoint: "oauth-token" | "rest-api",
): GitHubProviderError => {
  if (response.status >= 300 && response.status < 400) {
    let failureCauseDetail:
      | "redirect-same-origin"
      | "redirect-cross-origin"
      | "redirect-invalid" = "redirect-invalid";
    const location = response.headers.get("location");
    if (location !== null) {
      try {
        failureCauseDetail =
          new URL(location, response.url).origin ===
          new URL(response.url).origin
            ? "redirect-same-origin"
            : "redirect-cross-origin";
      } catch {
        failureCauseDetail = "redirect-invalid";
      }
    }
    return new GitHubProviderError({
      category: "invalid-response",
      endpoint,
      failureReason: "http-response",
      failureCauseDetail,
    });
  }
  if (response.status === 401)
    return new GitHubProviderError({ category: "unauthorized" });
  if (response.status === 404)
    return new GitHubProviderError({ category: "not-found" });
  if (
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0")
  )
    return new GitHubProviderError({
      category: "rate-limited",
      retryAt: retryAt(response.headers, now),
    });
  if (response.status === 403)
    return new GitHubProviderError({
      category: response.headers.has("x-github-sso")
        ? "saml-required"
        : "forbidden",
    });
  if (response.status >= 500)
    return new GitHubProviderError({
      category: "unavailable",
      endpoint,
      failureReason: "http-response",
    });
  return new GitHubProviderError({ category: "invalid-response" });
};

const safeUrl = (value: unknown, origin: string): string | undefined => {
  const raw = bounded(value, 4_096);
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      url.origin === origin &&
      !url.username &&
      !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

const nextLink = (header: string | null): string | undefined => {
  if (header === null) return undefined;
  for (const part of header.split(/,(?=\s*<)/)) {
    const match = part
      .trim()
      .match(/^<([^>]{1,4096})>\s*;\s*rel="?next"?(?:\s*;.*)?$/);
    if (match?.[1]) return safeUrl(match[1], API_ORIGIN);
  }
  return undefined;
};

export const createGitHubProvider = (
  config: GitHubAppConfiguration,
  fetcher: typeof fetch = runtimeFetch,
  clock: Clock = () => new Date(),
) => {
  const secret = Redacted.value(config.clientSecret);
  const checkInput = (value: string) => {
    if (value.length < 1 || value.length > MAX_VALUE)
      throw new GitHubProviderError({ category: "invalid-response" });
    return value;
  };
  const request = async (url: string, init: RequestInit = {}) => {
    if (url.length > 4_096)
      throw new GitHubProviderError({ category: "invalid-response" });
    const endpoint = url === TOKEN_URL ? "oauth-token" : "rest-api";
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw responseError(response, clock(), endpoint);
      return response;
    } catch (cause) {
      if (cause instanceof GitHubProviderError) throw cause;
      const message = cause instanceof Error ? cause.message.toLowerCase() : "";
      throw new GitHubProviderError({
        category: "unavailable",
        endpoint,
        failureReason: "fetch-exception",
        failureCause:
          cause instanceof DOMException && cause.name === "AbortError"
            ? "abort-error"
            : cause instanceof TypeError
              ? "type-error"
              : "other-error",
        failureCauseDetail: message.includes("redirect")
          ? "redirect"
          : message.includes("signal") || message.includes("abort")
            ? "signal"
            : message.includes("invocation") ||
                message.includes("receiver") ||
                message.includes("this reference")
              ? "receiver"
              : message.includes("header")
                ? "headers"
                : "other",
      });
    }
  };
  const json = async (
    url: string,
    init: RequestInit = {},
  ): Promise<{ value: unknown; response: Response }> => {
    const response = await request(url, init);
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > MAX_TEXT)
      throw new GitHubProviderError({ category: "invalid-response" });
    const text = await response.text();
    if (text.length > MAX_TEXT)
      throw new GitHubProviderError({ category: "invalid-response" });
    try {
      return { value: JSON.parse(text) as unknown, response };
    } catch {
      throw new GitHubProviderError({ category: "invalid-response" });
    }
  };
  const apiHeaders = (token: string) => ({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${checkInput(token)}`,
    "user-agent": USER_AGENT,
    "x-github-api-version": API_VERSION,
  });
  const token = async (
    values: Record<string, string>,
  ): Promise<GitHubTokenSet> => {
    const { value } = await json(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: secret,
        ...values,
      }),
    });
    const record = value as Record<string, unknown>;
    const accessToken = bounded(record?.access_token);
    const refreshToken = bounded(record?.refresh_token);
    const expires = record?.expires_in;
    if (
      accessToken === undefined ||
      refreshToken === undefined ||
      typeof expires !== "number" ||
      !Number.isSafeInteger(expires) ||
      expires <= 0
    )
      throw new GitHubProviderError({ category: "invalid-response" });
    const refreshExpires = record.refresh_token_expires_in;
    if (
      refreshExpires !== undefined &&
      (typeof refreshExpires !== "number" ||
        !Number.isSafeInteger(refreshExpires) ||
        refreshExpires <= 0)
    )
      throw new GitHubProviderError({ category: "invalid-response" });
    const now = clock().getTime();
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(now + expires * 1_000),
      ...(typeof refreshExpires === "number"
        ? { refreshExpiresAt: new Date(now + refreshExpires * 1_000) }
        : {}),
      scopes:
        typeof record.scope === "string"
          ? record.scope.split(/[ ,]+/).filter(Boolean).sort()
          : [],
    };
  };
  const installation = (value: unknown): GitHubInstallation => {
    const item = value as Record<string, unknown>;
    const account = item?.account as Record<string, unknown>;
    const id = stableId(item?.id),
      accountId = stableId(account?.id),
      login = bounded(account?.login, 256);
    const type = account?.type,
      repositorySelection = item?.repository_selection;
    const rawPermissions = item?.permissions;
    if (
      typeof rawPermissions !== "object" ||
      rawPermissions === null ||
      Array.isArray(rawPermissions)
    )
      throw new GitHubProviderError({ category: "invalid-response" });
    const permissions: Record<string, "read" | "write"> = {};
    for (const [name, level] of Object.entries(rawPermissions)) {
      if (
        !/^[a-z_]{1,64}$/.test(name) ||
        (level !== "read" && level !== "write")
      )
        throw new GitHubProviderError({ category: "invalid-response" });
      permissions[name] = level;
    }
    const suspendedAt = item?.suspended_at;
    if (
      suspendedAt !== null &&
      suspendedAt !== undefined &&
      typeof suspendedAt !== "string"
    )
      throw new GitHubProviderError({ category: "invalid-response" });
    const parsedSuspendedAt =
      typeof suspendedAt === "string" ? new Date(suspendedAt) : undefined;
    if (
      parsedSuspendedAt !== undefined &&
      !Number.isFinite(parsedSuspendedAt.getTime())
    )
      throw new GitHubProviderError({ category: "invalid-response" });
    if (
      id === undefined ||
      accountId === undefined ||
      login === undefined ||
      (type !== "User" && type !== "Organization") ||
      (repositorySelection !== "all" && repositorySelection !== "selected")
    )
      throw new GitHubProviderError({ category: "invalid-response" });
    return {
      id,
      account: { id: accountId, login, type },
      repositorySelection,
      permissions,
      ...(parsedSuspendedAt === undefined
        ? {}
        : { suspendedAt: parsedSuspendedAt }),
    };
  };
  const repository = (value: unknown): GitHubRepository => {
    const item = value as Record<string, unknown>;
    const id = stableId(item?.id),
      fullName = bounded(item?.full_name, 512),
      webUrl = safeUrl(item?.html_url, WEB_ORIGIN),
      cloneUrl = safeUrl(item?.clone_url, WEB_ORIGIN),
      defaultBranch = bounded(item?.default_branch, 256);
    const visibility =
      item?.visibility ?? (item?.private === true ? "private" : "public");
    if (
      id === undefined ||
      fullName === undefined ||
      webUrl === undefined ||
      cloneUrl === undefined ||
      defaultBranch === undefined ||
      typeof item?.archived !== "boolean" ||
      (visibility !== "public" &&
        visibility !== "private" &&
        visibility !== "internal")
    )
      throw new GitHubProviderError({ category: "invalid-response" });
    return {
      id,
      fullName,
      webUrl,
      cloneUrl,
      defaultBranch,
      archived: item.archived,
      visibility,
    };
  };
  const paged = async <T>(
    first: string,
    headers: HeadersInit,
    key: string,
    decode: (value: unknown) => T,
  ): Promise<ReadonlyArray<T>> => {
    const seenUrls = new Set<string>(),
      seenIds = new Set<string>(),
      output: T[] = [];
    let url: string | undefined = first;
    while (url !== undefined) {
      if (seenUrls.size >= MAX_PAGES || seenUrls.has(url))
        throw new GitHubProviderError({ category: "invalid-response" });
      seenUrls.add(url);
      const { value, response } = await json(url, { headers });
      const values = (value as Record<string, unknown>)?.[key];
      if (!Array.isArray(values))
        throw new GitHubProviderError({ category: "invalid-response" });
      for (const raw of values) {
        const decoded = decode(raw);
        const id = (decoded as { id: string }).id;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          output.push(decoded);
        }
      }
      const link = response.headers.get("link");
      url = nextLink(link);
      if (link?.includes('rel="next"') && url === undefined)
        throw new GitHubProviderError({ category: "invalid-response" });
    }
    return output;
  };
  const getRepository = async (
    installationToken: string,
    repositoryId: string,
  ): Promise<GitHubRepository> => {
    const valid = stableId(repositoryId);
    if (valid === undefined)
      throw new GitHubProviderError({ category: "invalid-response" });
    const { value } = await json(`${API_ORIGIN}/repositories/${valid}`, {
      headers: apiHeaders(installationToken),
    });
    const resolved = repository(value);
    if (resolved.id !== valid || resolved.archived)
      throw new GitHubProviderError({ category: "forbidden" });
    return resolved;
  };
  return {
    authorizationUrl: (state: string, challenge: string) => {
      const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        state: checkInput(state),
        code_challenge: checkInput(challenge),
        code_challenge_method: "S256",
      });
      return `${WEB_ORIGIN}/login/oauth/authorize?${query}`;
    },
    exchangeCode: (code: string, verifier: string) =>
      token({
        code: checkInput(code),
        code_verifier: checkInput(verifier),
        redirect_uri: config.callbackUrl,
      }),
    refresh: (refreshToken: string) =>
      token({
        grant_type: "refresh_token",
        refresh_token: checkInput(refreshToken),
      }),
    revoke: async (accessToken: string) => {
      await request(
        `${API_ORIGIN}/applications/${encodeURIComponent(config.clientId)}/token`,
        {
          method: "DELETE",
          headers: {
            ...apiHeaders(accessToken),
            authorization: `Basic ${btoa(`${config.clientId}:${secret}`)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ access_token: checkInput(accessToken) }),
        },
      );
    },
    getUser: async (accessToken: string): Promise<GitHubUser> => {
      const { value } = await json(`${API_ORIGIN}/user`, {
        headers: apiHeaders(accessToken),
      });
      const item = value as Record<string, unknown>;
      const id = stableId(item?.id),
        login = bounded(item?.login, 256);
      if (id === undefined || login === undefined)
        throw new GitHubProviderError({ category: "invalid-response" });
      return { id, login };
    },
    listUserInstallations: (accessToken: string) =>
      paged(
        `${API_ORIGIN}/user/installations?per_page=100`,
        apiHeaders(accessToken),
        "installations",
        installation,
      ),
    getInstallation: async (appJwt: string, id: string) => {
      const valid = stableId(id);
      if (valid === undefined)
        throw new GitHubProviderError({ category: "invalid-response" });
      const { value } = await json(`${API_ORIGIN}/app/installations/${valid}`, {
        headers: apiHeaders(appJwt),
      });
      return installation(value);
    },
    deleteInstallation: async (appJwt: string, id: string) => {
      const valid = stableId(id);
      if (valid === undefined)
        throw new GitHubProviderError({ category: "invalid-response" });
      try {
        await request(`${API_ORIGIN}/app/installations/${valid}`, {
          method: "DELETE",
          headers: apiHeaders(appJwt),
        });
      } catch (cause) {
        // GitHub's delete endpoint is idempotent from dx's perspective.
        if (
          cause instanceof GitHubProviderError &&
          cause.category === "not-found"
        )
          return;
        throw cause;
      }
    },
    listUserInstallationRepositories: (accessToken: string, id: string) => {
      const valid = stableId(id);
      if (valid === undefined)
        throw new GitHubProviderError({ category: "invalid-response" });
      return paged(
        `${API_ORIGIN}/user/installations/${valid}/repositories?per_page=100`,
        apiHeaders(accessToken),
        "repositories",
        repository,
      );
    },
    createInstallationToken: async (
      appJwt: string,
      id: string,
      restriction?: {
        readonly repositoryId: string;
        readonly permissions: Readonly<Record<string, "read" | "write">>;
      },
    ) => {
      const valid = stableId(id);
      if (valid === undefined)
        throw new GitHubProviderError({ category: "invalid-response" });
      const restrictedRepositoryId =
        restriction === undefined
          ? undefined
          : stableId(restriction.repositoryId);
      if (
        restrictedRepositoryId !== undefined &&
        !Number.isSafeInteger(Number(restrictedRepositoryId))
      )
        throw new GitHubProviderError({ category: "invalid-response" });
      if (restriction !== undefined && restrictedRepositoryId === undefined)
        throw new GitHubProviderError({ category: "invalid-response" });
      const { value } = await json(
        `${API_ORIGIN}/app/installations/${valid}/access_tokens`,
        {
          method: "POST",
          headers: {
            ...apiHeaders(appJwt),
            "content-type": "application/json",
          },
          ...(restriction === undefined
            ? {}
            : {
                body: JSON.stringify({
                  repository_ids: [Number(restrictedRepositoryId)],
                  permissions: restriction.permissions,
                }),
              }),
        },
      );
      const item = value as Record<string, unknown>;
      const token = bounded(item?.token);
      const expiresAt =
        typeof item?.expires_at === "string"
          ? new Date(item.expires_at)
          : undefined;
      if (
        token === undefined ||
        expiresAt === undefined ||
        !Number.isFinite(expiresAt.getTime())
      )
        throw new GitHubProviderError({ category: "invalid-response" });
      return { token, expiresAt };
    },
    listInstallationRepositories: (installationToken: string) =>
      paged(
        `${API_ORIGIN}/installation/repositories?per_page=100`,
        apiHeaders(installationToken),
        "repositories",
        repository,
      ),
    revokeInstallationToken: async (installationToken: string) => {
      await request(`${API_ORIGIN}/installation/token`, {
        method: "DELETE",
        headers: apiHeaders(installationToken),
      });
    },
    getRepository,
    resolveRepositorySource: async (
      installationToken: string,
      repositoryId: string,
    ): Promise<GitHubResolvedSource> => {
      const valid = stableId(repositoryId);
      if (valid === undefined)
        throw new GitHubProviderError({ category: "invalid-response" });
      const resolvedRepository = await getRepository(installationToken, valid);
      const { value: commitValue } = await json(
        `${API_ORIGIN}/repositories/${valid}/commits/${encodeURIComponent(resolvedRepository.defaultBranch)}`,
        { headers: apiHeaders(installationToken) },
      );
      const commitSha = bounded(
        (commitValue as Record<string, unknown>)?.sha,
        40,
      );
      if (commitSha === undefined || !/^[a-f0-9]{40}$/.test(commitSha))
        throw new GitHubProviderError({ category: "invalid-response" });
      return { repository: resolvedRepository, commitSha };
    },
  };
};
