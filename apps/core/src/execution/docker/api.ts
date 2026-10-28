/**
 * The part of the Docker Sandboxes API (https://docs.docker.com/reference/api/sandboxes/latest/,
 * `/v1`, experimental) dx uses, over `fetch` so it runs in a Worker.
 *
 * Two kinds of request with two kinds of credential:
 *
 * - Management requests (create, read, start, stop, delete, renew) go to
 *   `connect.docker.com/sandboxes` with an access token exchanged from the
 *   person's Docker ID and personal access token at Docker Hub. The
 *   documented exchange (`/v2/auth/token`) limits each IP address to 180
 *   calls, and Cloudflare's shared egress address is always over it, so a
 *   429 there signs in through `/v2/users/login`, which takes the same pair
 *   and issues the same token (`sub`, `sandbox:use`).
 * - Command and file requests go to the sandbox's own endpoint
 *   (`core.endpoint.uri`) with a short-lived credential issued for that
 *   sandbox (`endpoint-credentials`, at most five minutes).
 *
 * A mutation of an existing sandbox sends its current ETag in `If-Match`.
 */

const API = "https://connect.docker.com/sandboxes";
const TOKEN_URL = "https://hub.docker.com/v2/auth/token";
const LOGIN_URL = "https://hub.docker.com/v2/users/login";
/** One round trip; long waits poll the resource instead. */
const CALL_TIMEOUT_MS = 60_000;
/** A credential is renewed this long before it expires. */
const RENEW_BEFORE_MS = 30_000;
const ENDPOINT_PERMISSIONS = [
  "sandboxesExec",
  "sandboxesFilesRead",
  "sandboxesFilesWrite",
] as const;

export type DockerSandboxStatus =
  | "creating"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "deleting"
  | "degraded";

export interface DockerSandbox {
  /** The immutable sandbox ID, the last segment of `sandboxes/<uid>`. */
  readonly uid: string;
  readonly status: DockerSandboxStatus;
  /** The ETag a mutation sends as its precondition. */
  readonly etag: string;
  /** Why the sandbox failed, while `status` is `failed`. */
  readonly failure?: string;
}

/** A Docker Sandboxes error response: its HTTP status and stable `code`. */
export class DockerSandboxesApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CreateDockerSandbox {
  readonly imageRef: string;
  readonly cpus: number;
  readonly memoryMib: number;
  /** The deadline after each start, and what happens when it lapses. */
  readonly timeoutSeconds: number;
  readonly onTimeout: "stop" | "delete";
  /** An exact label to find the sandbox by, or a prefix Docker completes. */
  readonly displayName?: string;
  readonly displayNamePrefix?: string;
  readonly labels: Readonly<Record<string, string>>;
  /** A retried create with the same key returns the first sandbox. */
  readonly idempotencyKey: string;
}

export interface DockerExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface DockerFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

/** One sandbox's command and file service. */
export interface DockerSandboxEndpoint {
  readonly exec: (input: {
    readonly cmd: ReadonlyArray<string>;
    readonly user: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  }) => Promise<DockerExecResult>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, content: Uint8Array) => Promise<void>;
  /** Undefined when nothing is at `path`. */
  readonly stat: (path: string) => Promise<DockerFileStat | undefined>;
  /** Entry names in a directory. */
  readonly list: (path: string) => Promise<Array<string>>;
}

export interface DockerSandboxesApi {
  /**
   * The Docker account the credentials belong to. Rejects with 401 when
   * Docker refuses the Docker ID and token.
   */
  readonly account: () => Promise<string>;
  /** Rejects with 401 or 403 when the account cannot use Cloud Sandboxes. */
  readonly checkAccess: () => Promise<void>;
  readonly createSandbox: (
    input: CreateDockerSandbox,
  ) => Promise<DockerSandbox>;
  /** Undefined when the account has no such sandbox. */
  readonly getSandbox: (uid: string) => Promise<DockerSandbox | undefined>;
  /** The sandbox with this exact display name, if any. */
  readonly findSandbox: (
    displayName: string,
  ) => Promise<DockerSandbox | undefined>;
  readonly startSandbox: (sandbox: DockerSandbox) => Promise<void>;
  readonly stopSandbox: (sandbox: DockerSandbox) => Promise<void>;
  /** Deletes the sandbox; one already gone is not an error. */
  readonly deleteSandbox: (uid: string) => Promise<void>;
  /** Moves the sandbox's deadline to `seconds` from now. */
  readonly renewTimeout: (uid: string, seconds: number) => Promise<void>;
  readonly endpoint: (uid: string) => DockerSandboxEndpoint;
}

const STATUSES: ReadonlySet<string> = new Set<DockerSandboxStatus>([
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "deleting",
  "degraded",
]);

const failure = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  return new DockerSandboxesApiError(
    response.status,
    typeof body.code === "string" ? body.code : "unknown",
    typeof body.message === "string"
      ? body.message.slice(0, 300)
      : `Docker answered ${response.status}.`,
  );
};

const fromBase64 = (value: unknown) => {
  if (typeof value !== "string" || value === "") return "";
  const binary = atob(value);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
};

/** The JWT claims of a Docker Hub access token, unverified. */
const claims = (token: string): Record<string, unknown> => {
  const payload = token.split(".")[1];
  if (payload === undefined) return {};
  try {
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")),
          (character) => character.charCodeAt(0),
        ),
      ),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const sandboxOf = (body: unknown): DockerSandbox => {
  const resource = body as {
    readonly uid?: unknown;
    readonly name?: unknown;
    readonly core?: { readonly status?: unknown; readonly etag?: unknown };
    readonly failure?: { readonly message?: unknown; readonly code?: unknown };
  };
  const uid =
    typeof resource.uid === "string"
      ? resource.uid
      : typeof resource.name === "string"
        ? resource.name.replace(/^sandboxes\//, "")
        : undefined;
  const status = resource.core?.status;
  const etag = resource.core?.etag;
  if (
    uid === undefined ||
    typeof status !== "string" ||
    !STATUSES.has(status) ||
    typeof etag !== "string"
  )
    throw new DockerSandboxesApiError(
      502,
      "invalidResponse",
      "Docker returned a sandbox dx could not read.",
    );
  const reason =
    typeof resource.failure?.message === "string"
      ? resource.failure.message
      : typeof resource.failure?.code === "string"
        ? resource.failure.code
        : undefined;
  return {
    uid,
    status: status as DockerSandboxStatus,
    etag,
    ...(reason === undefined ? {} : { failure: reason.slice(0, 300) }),
  };
};

export const dockerSandboxesApi = (
  credentials: { readonly dockerId: string; readonly accessToken: string },
  send: typeof fetch = (...args) => fetch(...args),
): DockerSandboxesApi => {
  let token: { readonly value: string; readonly expires: number } | undefined;
  /** Exchanges the personal access token at Docker Hub. */
  const exchange = async () => {
    const post = (url: string, body: unknown) =>
      send(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    const exchanged = await post(TOKEN_URL, {
      identifier: credentials.dockerId,
      secret: credentials.accessToken,
    });
    const response =
      exchanged.status === 429
        ? await post(LOGIN_URL, {
            username: credentials.dockerId,
            password: credentials.accessToken,
          })
        : exchanged;
    if (response.status === 401 || response.status === 403)
      throw new DockerSandboxesApiError(
        401,
        "unauthenticated",
        "Docker rejected the access token.",
      );
    if (!response.ok) throw await failure(response);
    const issued = (await response.json()) as {
      access_token?: unknown;
      token?: unknown;
    };
    const access = response === exchanged ? issued.access_token : issued.token;
    if (typeof access !== "string" || access === "")
      throw new DockerSandboxesApiError(
        502,
        "invalidResponse",
        "Docker Hub returned no access token.",
      );
    const expiry = claims(access).exp;
    token = {
      value: access,
      expires:
        typeof expiry === "number" ? expiry * 1_000 : Date.now() + 300_000,
    };
    return token;
  };
  const accessToken = async () =>
    token !== undefined && token.expires - RENEW_BEFORE_MS > Date.now()
      ? token
      : exchange();

  /** One management request; a refused token is exchanged again once. */
  const call = async (
    method: string,
    path: string,
    init: {
      readonly query?: Readonly<Record<string, string>>;
      readonly json?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<Response> => {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {}))
      url.searchParams.set(key, value);
    for (let attempt = 0; ; attempt += 1) {
      const bearer = await accessToken();
      const response = await send(url, {
        method,
        headers: {
          authorization: `Bearer ${bearer.value}`,
          accept: "application/json",
          ...(init.json === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...init.headers,
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (response.status !== 401 || attempt > 0) return response;
      token = undefined;
    }
  };
  const json = async <T>(
    method: string,
    path: string,
    init?: Parameters<typeof call>[2],
  ): Promise<T> => {
    const response = await call(method, path, init);
    if (!response.ok) throw await failure(response);
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  };
  const sandboxPath = (uid: string, rest = "") =>
    `/v1/sandboxes/${encodeURIComponent(uid)}${rest}`;
  const getSandbox = async (uid: string) => {
    const response = await call("GET", sandboxPath(uid));
    if (response.status === 404) return undefined;
    if (!response.ok) throw await failure(response);
    return sandboxOf(await response.json());
  };
  const lifecycle = async (sandbox: DockerSandbox, action: string) => {
    await json("POST", sandboxPath(sandbox.uid, action), {
      json: {},
      headers: {
        "if-match": sandbox.etag,
        "idempotency-key": crypto.randomUUID(),
      },
    });
  };

  const endpoint = (uid: string): DockerSandboxEndpoint => {
    let current:
      | {
          readonly uri: string;
          readonly token: string;
          readonly expires: number;
        }
      | undefined;
    /** The sandbox's endpoint and a credential for it, renewed as needed. */
    const resolve = async (fresh: boolean) => {
      if (
        !fresh &&
        current !== undefined &&
        current.expires - RENEW_BEFORE_MS > Date.now()
      )
        return current;
      const sandbox = await json<{
        readonly core?: { readonly endpoint?: { readonly uri?: unknown } };
      }>("GET", sandboxPath(uid));
      const uri = sandbox.core?.endpoint?.uri;
      if (typeof uri !== "string" || !uri.startsWith("https://"))
        throw new DockerSandboxesApiError(
          409,
          "failedPrecondition",
          "The sandbox has no endpoint to reach yet.",
        );
      const credential = await json<{
        readonly token?: unknown;
        readonly expireTime?: unknown;
      }>("POST", sandboxPath(uid, "/endpoint-credentials"), {
        json: { permissions: ENDPOINT_PERMISSIONS, ttl: "300s" },
      });
      const expires =
        typeof credential.expireTime === "string"
          ? Date.parse(credential.expireTime)
          : Number.NaN;
      if (typeof credential.token !== "string" || !Number.isFinite(expires))
        throw new DockerSandboxesApiError(
          502,
          "invalidResponse",
          "Docker returned no sandbox credential.",
        );
      current = {
        uri: uri.replace(/\/+$/, ""),
        token: credential.token,
        expires,
      };
      return current;
    };
    /**
     * One sandbox request. A refused credential, or an endpoint that moved
     * when the sandbox restarted, is resolved again once.
     */
    const request = async (
      method: string,
      path: string,
      init: {
        readonly query?: Readonly<Record<string, string>>;
        readonly json?: unknown;
        readonly bytes?: Uint8Array;
        readonly timeoutMs?: number;
      } = {},
    ): Promise<Response> => {
      for (let attempt = 0; ; attempt += 1) {
        const target = await resolve(attempt > 0);
        const url = new URL(`${target.uri}${path}`);
        for (const [key, value] of Object.entries(init.query ?? {}))
          url.searchParams.set(key, value);
        const response = await send(url, {
          method,
          headers: {
            authorization: `Bearer ${target.token}`,
            ...(init.json !== undefined
              ? { "content-type": "application/json" }
              : init.bytes !== undefined
                ? { "content-type": "application/octet-stream" }
                : {}),
          },
          ...(init.json !== undefined
            ? { body: JSON.stringify(init.json) }
            : init.bytes !== undefined
              ? { body: init.bytes as Uint8Array<ArrayBuffer> }
              : {}),
          signal: AbortSignal.timeout(init.timeoutMs ?? CALL_TIMEOUT_MS),
        });
        if (response.status !== 401 || attempt > 0) return response;
      }
    };
    const checked = async (response: Response) => {
      if (!response.ok) throw await failure(response);
      return response;
    };
    return {
      async exec(input) {
        const response = await checked(
          await request("POST", "/v1/processes/exec", {
            json: {
              cmd: input.cmd,
              user: input.user,
              ...(input.env === undefined ? {} : { env: input.env }),
            },
            timeoutMs: input.timeoutMs,
          }),
        );
        const result = (await response.json()) as {
          readonly exitCode?: unknown;
          readonly stdout?: unknown;
          readonly stderr?: unknown;
        };
        return {
          stdout: fromBase64(result.stdout),
          stderr: fromBase64(result.stderr),
          // Proto JSON leaves a zero exit code out.
          exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
        };
      },
      async readFile(path) {
        const response = await checked(
          await request("GET", "/v1/files/content", { query: { path } }),
        );
        return new Uint8Array(await response.arrayBuffer());
      },
      async writeFile(path, content) {
        await checked(
          await request("PUT", "/v1/files/content", {
            query: { path, mode: "420" },
            bytes: content,
          }),
        );
      },
      async stat(path) {
        const response = await request("GET", "/v1/files/stat", {
          query: { path },
        });
        if (response.status === 404) return undefined;
        const { info } = (await (await checked(response)).json()) as {
          readonly info?: { readonly isDir?: unknown; readonly type?: unknown };
        };
        const directory = info?.isDir === true || info?.type === "directory";
        return {
          isFile: info?.type === "regular" || (!directory && !info?.type),
          isDirectory: directory,
          isSymlink: info?.type === "symlink",
        };
      },
      async list(path) {
        const names: Array<string> = [];
        let pageToken: string | undefined;
        do {
          const response = await checked(
            await request("GET", "/v1/files", {
              query: {
                path,
                pageSize: "1000",
                ...(pageToken === undefined ? {} : { pageToken }),
              },
            }),
          );
          const page = (await response.json()) as {
            readonly entries?: ReadonlyArray<{ readonly path?: unknown }>;
            readonly nextPageToken?: unknown;
          };
          for (const entry of page.entries ?? [])
            if (typeof entry.path === "string")
              names.push(
                entry.path.replace(/\/+$/, "").split("/").at(-1) ?? "",
              );
          pageToken =
            typeof page.nextPageToken === "string" && page.nextPageToken !== ""
              ? page.nextPageToken
              : undefined;
        } while (pageToken !== undefined);
        return names.filter((name) => name !== "");
      },
    };
  };

  return {
    async account() {
      const claimed = claims((await accessToken()).value);
      const hub = claimed["https://hub.docker.com"] as
        | { readonly uuid?: unknown }
        | undefined;
      // The account's UUID survives a Docker ID rename and a new token.
      const id =
        typeof claimed.sub === "string" && claimed.sub !== ""
          ? claimed.sub
          : typeof hub?.uuid === "string"
            ? hub.uuid
            : credentials.dockerId.toLowerCase();
      return id;
    },
    async checkAccess() {
      await json("GET", "/v1/sandboxes", { query: { pageSize: "1" } });
    },
    async createSandbox(input) {
      const response = await call("POST", "/v1/sandboxes", {
        headers: { "idempotency-key": input.idempotencyKey },
        json: {
          imageRef: input.imageRef,
          // The Orb image is built for x86 only.
          platform: { os: "linux", architecture: "amd64" },
          resources: { cpus: input.cpus, memoryMib: input.memoryMib },
          // Run the image's own entrypoint (tini and dx-orb-init) as its
          // own user.
          startupExecution: { rawImage: {} },
          features: {
            timeouts: {
              timeout: `${input.timeoutSeconds}s`,
              onTimeout: input.onTimeout,
              // Core wakes a stopped Orb itself, after it authorizes.
              autoResume: false,
            },
          },
          labels: input.labels,
          ...(input.displayName === undefined
            ? {}
            : { displayName: input.displayName }),
          ...(input.displayNamePrefix === undefined
            ? {}
            : { displayNamePrefix: input.displayNamePrefix }),
        },
      });
      if (!response.ok) throw await failure(response);
      return sandboxOf(await response.json());
    },
    getSandbox,
    async findSandbox(displayName) {
      const listed = await json<{
        readonly sandboxes?: ReadonlyArray<unknown>;
      }>("GET", "/v1/sandboxes", {
        query: { filter: `display_name=${displayName}`, pageSize: "2" },
      });
      const first = listed.sandboxes?.[0];
      return first === undefined ? undefined : sandboxOf(first);
    },
    startSandbox: (sandbox) => lifecycle(sandbox, "/start"),
    stopSandbox: (sandbox) => lifecycle(sandbox, "/stop"),
    async deleteSandbox(uid) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const sandbox = await getSandbox(uid);
        if (sandbox === undefined || sandbox.status === "deleting") return;
        const response = await call("DELETE", sandboxPath(uid), {
          query: { force: "true" },
          headers: {
            "if-match": sandbox.etag,
            "idempotency-key": crypto.randomUUID(),
          },
        });
        if (response.ok || response.status === 404) return;
        // The sandbox changed between the read and the delete.
        if (response.status === 412) continue;
        throw await failure(response);
      }
      throw new DockerSandboxesApiError(
        412,
        "failedPrecondition",
        "The sandbox kept changing while dx deleted it.",
      );
    },
    async renewTimeout(uid, seconds) {
      await json("POST", sandboxPath(uid, "/renew-timeout"), {
        json: { timeout: `${seconds}s` },
      });
    },
    endpoint,
  };
};
