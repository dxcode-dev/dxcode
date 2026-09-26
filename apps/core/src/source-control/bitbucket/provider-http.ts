import { canonicalBitbucketRepositoryLocator } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { SourceMutationRejected } from "../operations.js";

const API_ORIGIN = "https://api.bitbucket.org";
const WEB_ORIGIN = "https://bitbucket.org";
const TOKEN_URL = `${WEB_ORIGIN}/site/oauth2/access_token`;
const MAX_TEXT = 2 * 1024 * 1024;
export const BITBUCKET_PULL_REQUEST_BODY_MAX_LENGTH = 8_192;
const MAX_VALUE = BITBUCKET_PULL_REQUEST_BODY_MAX_LENGTH;
const MAX_PAGES = 1_000;
const MAX_ITEMS = 100_000;
const MAX_DISCOVERY_REQUESTS = 1_000;
const MAX_EXPIRES_IN_SECONDS = 31 * 24 * 60 * 60;

export type BitbucketProviderErrorCategory =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "invalid-response"
  | "unavailable"
  | "invalid-grant";

export class BitbucketProviderError extends Schema.TaggedError<BitbucketProviderError>()(
  "BitbucketProviderError",
  {
    category: Schema.Literals([
      "unauthorized",
      "forbidden",
      "not-found",
      "rate-limited",
      "invalid-response",
      "unavailable",
      "invalid-grant",
    ]),
    retryAt: Schema.optional(Schema.instanceOf(Date)),
  },
) {}

export interface BitbucketConfiguration {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly callbackUrl: string;
}

export interface BitbucketTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly scopes: ReadonlyArray<string>;
}

export interface BitbucketRepository {
  readonly id: string;
  readonly workspaceId: string;
  readonly fullName: string;
  readonly webUrl: string;
  readonly cloneUrl: string;
  readonly defaultBranch: string;
  readonly visibility: "public" | "private";
  readonly archived: boolean;
}

export interface BitbucketPullRequest {
  readonly number: number;
  readonly state: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly head: string;
  readonly base: string;
}

export const isBitbucketPullRequestBodyWithinLimit = (value: string) => {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > BITBUCKET_PULL_REQUEST_BODY_MAX_LENGTH) return false;
  }
  return true;
};

const runtimeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);
const invalid = (): never => {
  throw new BitbucketProviderError({ category: "invalid-response" });
};
const rejected = (): never => {
  throw new SourceMutationRejected();
};
const string = (value: unknown, maximum = MAX_VALUE, empty = false) =>
  typeof value === "string" &&
  value.length <= maximum &&
  (empty || value.length > 0)
    ? value
    : undefined;
const uuid = (value: unknown) => {
  const result = string(value, 38);
  return result !== undefined &&
    /^\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/i.test(
      result,
    )
    ? result.toLowerCase()
    : undefined;
};
const safeUrl = (value: unknown, origin: string) => {
  const raw = string(value, 4_096);
  if (raw === undefined) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" &&
      parsed.origin === origin &&
      !parsed.username &&
      !parsed.password
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};
const retryDate = (headers: Headers, now: Date) => {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  if (/^[0-9]+$/.test(value))
    return new Date(now.getTime() + Number(value) * 1_000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
};

export const createBitbucketProvider = (
  config: BitbucketConfiguration,
  fetcher: typeof fetch = runtimeFetch,
  clock: () => Date = () => new Date(),
) => {
  const secret = Redacted.value(config.clientSecret);
  const checked = (value: string) => string(value) ?? invalid();
  const pathPart = (value: string) => encodeURIComponent(checked(value));
  const checkedBody = (value: string) =>
    isBitbucketPullRequestBodyWithinLimit(value) ? value : rejected();
  const readText = async (response: Response) => {
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_TEXT)
    )
      invalid();
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > MAX_TEXT) {
        await reader.cancel();
        invalid();
      }
      text += decoder.decode(part.value, { stream: true });
    }
  };
  const request = async (url: string, init: RequestInit = {}) => {
    if (url.length > 4_096) invalid();
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new BitbucketProviderError({ category: "unavailable" });
    }
    if (response.ok) return response;
    if (response.status >= 300 && response.status < 400) invalid();
    if (url === TOKEN_URL && response.status === 400) {
      const text = await readText(response);
      try {
        const body: unknown = JSON.parse(text);
        if (
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          body.error === "invalid_grant"
        )
          throw new BitbucketProviderError({ category: "invalid-grant" });
      } catch (cause) {
        if (cause instanceof BitbucketProviderError) throw cause;
      }
      invalid();
    }
    if (response.status === 401)
      throw new BitbucketProviderError({ category: "unauthorized" });
    if (response.status === 403)
      throw new BitbucketProviderError({ category: "forbidden" });
    if (response.status === 404)
      throw new BitbucketProviderError({ category: "not-found" });
    if (response.status === 429)
      throw new BitbucketProviderError({
        category: "rate-limited",
        retryAt: retryDate(response.headers, clock()),
      });
    if (response.status >= 500)
      throw new BitbucketProviderError({ category: "unavailable" });
    throw new BitbucketProviderError({ category: "invalid-response" });
  };
  const json = async (url: string, init: RequestInit = {}) => {
    const response = await request(url, init);
    const text = await readText(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return invalid();
    }
  };
  const headers = (accessToken: string) => ({
    accept: "application/json",
    authorization: `Bearer ${checked(accessToken)}`,
  });
  const token = async (values: Record<string, string>) => {
    const authorization = `Basic ${btoa(`${checked(config.clientId)}:${secret}`)}`;
    const value = await json(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(values),
    });
    const item = value as Record<string, unknown>;
    const accessToken = string(item?.access_token);
    const refreshToken = string(item?.refresh_token);
    const expires = item?.expires_in;
    if (
      accessToken === undefined ||
      refreshToken === undefined ||
      typeof expires !== "number" ||
      !Number.isSafeInteger(expires) ||
      expires <= 0 ||
      expires > MAX_EXPIRES_IN_SECONDS
    )
      invalid();
    if (
      item.token_type !== undefined &&
      String(item.token_type).toLowerCase() !== "bearer"
    )
      invalid();
    const scope = item.scopes ?? item.scope;
    if (scope !== undefined && typeof scope !== "string") invalid();
    return {
      accessToken: accessToken as string,
      refreshToken: refreshToken as string,
      expiresAt: new Date(clock().getTime() + (expires as number) * 1_000),
      scopes:
        typeof scope === "string"
          ? [...new Set(scope.split(/[ ,]+/).filter(Boolean))].sort()
          : [],
    } satisfies BitbucketTokenSet;
  };
  const repository = (value: unknown): BitbucketRepository => {
    const item = value as Record<string, unknown>;
    const workspace = item?.workspace as Record<string, unknown>;
    const links = item?.links as Record<string, unknown>;
    const html = links?.html as Record<string, unknown>;
    const clones = links?.clone;
    const mainbranch = item?.mainbranch as Record<string, unknown>;
    const id = uuid(item?.uuid),
      workspaceId = uuid(workspace?.uuid);
    const fullName = string(item?.full_name, 512),
      defaultBranch = string(mainbranch?.name, 256);
    const locator =
      fullName === undefined
        ? undefined
        : canonicalBitbucketRepositoryLocator(
            `https://bitbucket.org/${fullName}`,
          );
    const clone = Array.isArray(clones)
      ? (clones.find(
          (entry) => (entry as Record<string, unknown>)?.name === "https",
        ) as Record<string, unknown> | undefined)
      : undefined;
    const validatedLink = (value: unknown, cloneLink: boolean) => {
      const raw = string(value, 4_096);
      if (raw === undefined) return false;
      try {
        const parsed = new URL(raw);
        if (
          parsed.password ||
          parsed.protocol !== "https:" ||
          parsed.origin !== WEB_ORIGIN
        )
          return false;
        // Bitbucket commonly returns an HTTPS clone URL with a username. It is
        // authentication context, not repository identity, so discard only it.
        parsed.username = "";
        const linked = canonicalBitbucketRepositoryLocator(
          parsed.toString().replace(/\/$/, ""),
        );
        return (
          linked !== undefined &&
          linked.fullName === locator?.fullName &&
          parsed.pathname
            .toLowerCase()
            .endsWith(cloneLink ? ".git" : (locator?.fullName ?? "\0"))
        );
      } catch {
        return false;
      }
    };
    if (
      id === undefined ||
      workspaceId === undefined ||
      fullName === undefined ||
      defaultBranch === undefined ||
      locator === undefined ||
      !validatedLink(html?.href, false) ||
      !validatedLink(clone?.href, true) ||
      typeof item?.is_private !== "boolean"
    )
      invalid();
    if (item.scm !== undefined && item.scm !== "git") invalid();
    if (item.is_archived !== undefined && typeof item.is_archived !== "boolean")
      invalid();
    const validLocator = locator ?? invalid();
    return {
      id: id as string,
      workspaceId: workspaceId as string,
      fullName: validLocator.fullName,
      webUrl: validLocator.webUrl,
      cloneUrl: validLocator.cloneUrl,
      defaultBranch: defaultBranch as string,
      visibility: item.is_private ? "private" : "public",
      archived: item.is_archived === true,
    };
  };
  const pullRequest = (value: unknown): BitbucketPullRequest => {
    const item = value as Record<string, unknown>;
    const links = item?.links as Record<string, unknown>,
      html = links?.html as Record<string, unknown>;
    const source = item?.source as Record<string, unknown>,
      destination = item?.destination as Record<string, unknown>;
    const sourceBranch = source?.branch as Record<string, unknown>,
      destinationBranch = destination?.branch as Record<string, unknown>;
    const number = item?.id,
      state = string(item?.state, 64),
      title = string(item?.title, 1024);
    const description = item?.description,
      body =
        typeof description === "string" &&
        isBitbucketPullRequestBodyWithinLimit(description)
          ? description
          : undefined,
      url = safeUrl(html?.href, WEB_ORIGIN);
    const head = string(sourceBranch?.name, 256),
      base = string(destinationBranch?.name, 256);
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      state === undefined ||
      title === undefined ||
      body === undefined ||
      url === undefined ||
      head === undefined ||
      base === undefined
    )
      invalid();
    return {
      number: number as number,
      state: state as string,
      title: title as string,
      body: body as string,
      url: url as string,
      head: head as string,
      base: base as string,
    };
  };
  const paged = async <T>(
    first: string,
    accessToken: string,
    decode: (value: unknown) => T,
    identity: (value: T) => string | number,
    allowedPath: (url: URL) => boolean = () => true,
    countRequest: () => void = () => {},
  ) => {
    const seenUrls = new Set<string>(),
      seenItems = new Set<string | number>(),
      output: T[] = [];
    let url: string | undefined = first;
    while (url !== undefined) {
      const parsedUrl = new URL(url);
      if (parsedUrl.origin !== API_ORIGIN || !allowedPath(parsedUrl)) invalid();
      if (seenUrls.size >= MAX_PAGES || seenUrls.has(url)) invalid();
      seenUrls.add(url);
      countRequest();
      const page = (await json(url, {
        headers: headers(accessToken),
      })) as Record<string, unknown>;
      const values = page?.values;
      if (!Array.isArray(values)) invalid();
      for (const raw of values as unknown[]) {
        const decoded = decode(raw),
          id = identity(decoded);
        if (!seenItems.has(id)) {
          seenItems.add(id);
          output.push(decoded);
        }
        if (output.length > MAX_ITEMS) invalid();
      }
      if (page.next === undefined || page.next === null) url = undefined;
      else url = safeUrl(page.next, API_ORIGIN) ?? invalid();
    }
    return output;
  };
  const repoPath = (workspaceId: string, repositoryId: string) =>
    `${API_ORIGIN}/2.0/repositories/${pathPart(workspaceId)}/${pathPart(repositoryId)}`;
  const getRepository = async (
    accessToken: string,
    workspaceId: string,
    repositoryId: string,
  ) => {
    const result = repository(
      await json(repoPath(workspaceId, repositoryId), {
        headers: headers(accessToken),
      }),
    );
    if (result.archived)
      throw new BitbucketProviderError({ category: "forbidden" });
    return result;
  };
  const prPath = (workspaceId: string, repositoryId: string) =>
    `${repoPath(workspaceId, repositoryId)}/pullrequests`;
  const writePr = async (
    url: string,
    accessToken: string,
    method: "POST" | "PUT",
    body: unknown,
  ) =>
    pullRequest(
      await json(url, {
        method,
        headers: {
          ...headers(accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );

  return {
    exchangeCode: (code: string) =>
      token({
        grant_type: "authorization_code",
        code: checked(code),
        redirect_uri: checked(config.callbackUrl),
      }),
    refreshToken: (refreshToken: string) =>
      token({
        grant_type: "refresh_token",
        refresh_token: checked(refreshToken),
      }),
    getUser: async (accessToken: string) => {
      const item = (await json(`${API_ORIGIN}/2.0/user`, {
        headers: headers(accessToken),
      })) as Record<string, unknown>;
      const id = uuid(item?.uuid),
        login = string(item?.nickname, 256);
      if (id === undefined || login === undefined) invalid();
      return { id, login };
    },
    listRepositories: async (accessToken: string) => {
      let requests = 0;
      const countRequest = () => {
        requests += 1;
        if (requests > MAX_DISCOVERY_REQUESTS) invalid();
      };
      const workspaces = await paged<string>(
        `${API_ORIGIN}/2.0/user/workspaces?pagelen=100`,
        accessToken,
        (raw) => {
          if (typeof raw !== "object" || raw === null) invalid();
          const workspace = (raw as Record<string, unknown>).workspace;
          if (typeof workspace !== "object" || workspace === null) invalid();
          const id = uuid((workspace as Record<string, unknown>).uuid);
          if (id === undefined) invalid();
          return id ?? invalid();
        },
        (id) => id,
        (url) => url.pathname === "/2.0/user/workspaces",
        countRequest,
      );
      const sparseRepositories = new Map<
        string,
        { workspaceId: string; repositoryId: string; fullName: string }
      >();
      for (const workspaceId of workspaces) {
        let permissions: Array<{
          workspaceId: string;
          repositoryId: string;
          fullName: string;
        }>;
        const permissionPath = `/2.0/user/workspaces/${encodeURIComponent(workspaceId)}/permissions/repositories`;
        try {
          permissions = await paged<{
            workspaceId: string;
            repositoryId: string;
            fullName: string;
          }>(
            `${API_ORIGIN}${permissionPath}?pagelen=100`,
            accessToken,
            (raw) => {
              if (typeof raw !== "object" || raw === null) invalid();
              const permission = raw as Record<string, unknown>;
              if (
                !(["read", "write", "admin"] as const).some(
                  (value) => value === permission.permission,
                )
              )
                invalid();
              const sparse = permission.repository;
              if (typeof sparse !== "object" || sparse === null) invalid();
              const item = sparse as Record<string, unknown>;
              const repositoryId = uuid(item.uuid);
              const fullName = string(item.full_name, 512);
              const locator =
                fullName === undefined
                  ? undefined
                  : canonicalBitbucketRepositoryLocator(
                      `https://bitbucket.org/${fullName}`,
                    );
              if (
                item.type !== "repository" ||
                repositoryId === undefined ||
                locator === undefined
              )
                invalid();
              const validLocator = locator ?? invalid();
              return {
                workspaceId,
                repositoryId: repositoryId ?? invalid(),
                fullName: validLocator.fullName,
              };
            },
            (item) => item.repositoryId,
            (url) => url.pathname === permissionPath,
            countRequest,
          );
        } catch (cause) {
          if (
            cause instanceof BitbucketProviderError &&
            (cause.category === "forbidden" || cause.category === "not-found")
          )
            continue;
          throw cause;
        }
        for (const item of permissions)
          sparseRepositories.set(item.repositoryId, item);
      }
      const output = await Effect.runPromise(
        Effect.forEach(
          sparseRepositories.values(),
          (sparse) =>
            Effect.tryPromise({
              try: async () => {
                try {
                  countRequest();
                  const raw = await json(
                    repoPath(sparse.workspaceId, sparse.repositoryId),
                    { headers: headers(accessToken) },
                  );
                  if (
                    typeof raw === "object" &&
                    raw !== null &&
                    (raw as Record<string, unknown>).mainbranch === null
                  ) {
                    // Bitbucket omits mainbranch for empty repositories. They cannot be
                    // selected because dx requires an exact default-branch snapshot.
                    return undefined;
                  }
                  const hydrated = repository(raw);
                  if (
                    hydrated.id !== sparse.repositoryId ||
                    hydrated.fullName !== sparse.fullName
                  )
                    invalid();
                  return hydrated.archived ? undefined : hydrated;
                } catch (cause) {
                  if (
                    cause instanceof BitbucketProviderError &&
                    (cause.category === "forbidden" ||
                      cause.category === "not-found")
                  )
                    return undefined;
                  throw cause;
                }
              },
              catch: (cause) => cause,
            }),
          { concurrency: 4 },
        ),
      );
      return output.filter((item) => item !== undefined);
    },
    getRepository,
    resolveRepositorySource: async (
      accessToken: string,
      workspaceId: string,
      repositoryId: string,
    ) => {
      const resolved = await getRepository(
        accessToken,
        workspaceId,
        repositoryId,
      );
      const value = (await json(
        `${repoPath(workspaceId, repositoryId)}/commits/${pathPart(resolved.defaultBranch)}?pagelen=1`,
        { headers: headers(accessToken) },
      )) as Record<string, unknown>;
      const first = Array.isArray(value?.values)
        ? (value.values[0] as Record<string, unknown> | undefined)
        : undefined;
      const commitSha = string(first?.hash, 40);
      if (commitSha === undefined || !/^[0-9a-f]{40}$/i.test(commitSha))
        invalid();
      return { repository: resolved, commitSha };
    },
    readPullRequest: async (
      accessToken: string,
      workspaceId: string,
      repositoryId: string,
      number: number,
    ) => {
      if (!Number.isSafeInteger(number) || number <= 0) invalid();
      return pullRequest(
        await json(`${prPath(workspaceId, repositoryId)}/${number}`, {
          headers: headers(accessToken),
        }),
      );
    },
    listPullRequests: (
      accessToken: string,
      workspaceId: string,
      repositoryId: string,
    ) =>
      paged(
        `${prPath(workspaceId, repositoryId)}?pagelen=50&state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED`,
        accessToken,
        pullRequest,
        (pr) => pr.number,
        (url) =>
          url.pathname === new URL(prPath(workspaceId, repositoryId)).pathname,
      ),
    createPullRequest: (
      accessToken: string,
      workspaceId: string,
      repositoryId: string,
      input: { head: string; base: string; title: string; body: string },
    ) =>
      writePr(prPath(workspaceId, repositoryId), accessToken, "POST", {
        title: checked(input.title),
        description: checkedBody(input.body),
        source: { branch: { name: checked(input.head) } },
        destination: { branch: { name: checked(input.base) } },
      }),
    updatePullRequest: (
      accessToken: string,
      workspaceId: string,
      repositoryId: string,
      number: number,
      input: { title?: string; body?: string },
    ) => {
      if (
        !Number.isSafeInteger(number) ||
        number <= 0 ||
        (input.title === undefined && input.body === undefined)
      )
        invalid();
      return writePr(
        `${prPath(workspaceId, repositoryId)}/${number}`,
        accessToken,
        "PUT",
        {
          ...(input.title === undefined ? {} : { title: checked(input.title) }),
          ...(input.body === undefined
            ? {}
            : { description: checkedBody(input.body) }),
        },
      );
    },
  };
};
