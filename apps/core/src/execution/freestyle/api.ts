/**
 * The part of Freestyle's REST API (https://www.freestyle.sh/openapi.json,
 * `/v5`) dx uses, over `fetch` so it runs in a Worker. A request that
 * outlives a few seconds (a VM boot, a snapshot, a long command) is detached
 * by the API with `x-freestyle-background-after-secs`; the client then polls
 * `/v5/background-requests/{id}` for the same response it would have had.
 */

const API = "https://api.freestyle.sh";
const BACKGROUND_AFTER_SECS = "5";
const BACKGROUND_POLL_MS = 2_000;
/** A detached request gets this long before the client gives up on it. */
const BACKGROUND_DEADLINE_MS = 20 * 60_000;
/** One round trip; a detached request answers 202 well within it. */
const CALL_TIMEOUT_MS = 60_000;

export type FreestyleVmState =
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "stopped";

export interface FreestyleVm {
  readonly id: string;
  readonly state: FreestyleVmState;
  readonly slug?: string | null;
  readonly totalRunSeconds?: number | null;
  readonly maxRunTotalSeconds?: number | null;
}

export interface FreestyleExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Null when the command's timeout killed it. */
  readonly statusCode: number | null;
}

export interface FreestyleFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

/** A Freestyle error response: its HTTP status and stable `code`. */
export class FreestyleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CreateFreestyleVm {
  readonly snapshotId: string;
  readonly slug?: string;
  readonly displayName?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly maxRunTotalSeconds?: number;
}

export interface FreestyleApi {
  /** The account the key belongs to. Rejects with 401 or 403 for a bad key. */
  readonly accountId: () => Promise<string>;
  readonly createVm: (input: CreateFreestyleVm) => Promise<FreestyleVm>;
  /** Undefined when the account has no such VM. */
  readonly getVm: (vm: string) => Promise<FreestyleVm | undefined>;
  readonly startVm: (vm: string) => Promise<FreestyleVm>;
  readonly pauseVm: (vm: string) => Promise<void>;
  readonly updateVm: (
    vm: string,
    patch: { readonly maxRunTotalSeconds?: number },
  ) => Promise<void>;
  /** Deletes the VM; a VM already gone is not an error. */
  readonly deleteVm: (vm: string) => Promise<void>;
  readonly exec: (
    vm: string,
    input: {
      readonly command: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly linuxUser?: string;
      readonly timeoutMs?: number;
      /** Bytes for the command's stdin, up to 1 MiB. */
      readonly stdin?: Uint8Array;
    },
  ) => Promise<FreestyleExecResult>;
  readonly readFile: (vm: string, path: string) => Promise<Uint8Array>;
  readonly writeFile: (
    vm: string,
    path: string,
    content: Uint8Array,
  ) => Promise<void>;
  readonly stat: (vm: string, path: string) => Promise<FreestyleFileStat>;
  readonly readdir: (vm: string, path: string) => Promise<Array<string>>;
  readonly exists: (vm: string, path: string) => Promise<boolean>;
  readonly mkdir: (vm: string, path: string) => Promise<void>;
  readonly remove: (vm: string, path: string) => Promise<void>;
  /** Captures the VM's memory and disk; returns the snapshot ID. */
  readonly snapshot: (vm: string, displayName: string) => Promise<string>;
  /** Snapshots whose name contains `search`, by display name. */
  readonly snapshots: (search: string) => Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly createdAt: string;
    }>
  >;
  /** Deletes a snapshot; one already gone is not an error. */
  readonly deleteSnapshot: (snapshot: string) => Promise<void>;
}

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const failure = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  return new FreestyleApiError(
    response.status,
    typeof body.code === "string" ? body.code : "UNKNOWN_ERROR",
    typeof body.message === "string"
      ? body.message.slice(0, 300)
      : `Freestyle answered ${response.status}.`,
  );
};

/** All VMs reach the public Internet, so dxd can dial Core. */
const OUTBOUND = {
  rules: [{ action: "allow", source: {}, destination: { public: true } }],
} as const;

export const freestyleApi = (
  apiKey: string,
  send: typeof fetch = (...args) => fetch(...args),
): FreestyleApi => {
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${apiKey}`,
    "x-freestyle-background-after-secs": BACKGROUND_AFTER_SECS,
    ...extra,
  });
  /** One call; a detached call is followed to its stored response. */
  const call = async (
    method: string,
    path: string,
    init: {
      readonly query?: Readonly<Record<string, string>>;
      readonly json?: unknown;
      readonly bytes?: Uint8Array;
    } = {},
  ): Promise<Response> => {
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(init.query ?? {}))
      url.searchParams.set(key, value);
    const response = await send(url, {
      method,
      headers: headers(
        init.json !== undefined
          ? { "content-type": "application/json" }
          : init.bytes !== undefined
            ? { "content-type": "application/octet-stream" }
            : {},
      ),
      ...(init.json !== undefined
        ? { body: JSON.stringify(init.json) }
        : init.bytes !== undefined
          ? { body: init.bytes as Uint8Array<ArrayBuffer> }
          : {}),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (response.status !== 202) return response;
    const accepted = (await response.json().catch(() => ({}))) as {
      readonly requestId?: string;
      readonly resultUrl?: string;
    };
    const requestId =
      response.headers.get("x-freestyle-background-request-id") ??
      accepted.requestId;
    const result =
      accepted.resultUrl ??
      (requestId === undefined
        ? undefined
        : `/v5/background-requests/${encodeURIComponent(requestId)}`);
    if (result === undefined)
      throw new FreestyleApiError(
        202,
        "BACKGROUND_PROTOCOL_ERROR",
        "Freestyle detached a request without an ID.",
      );
    const deadline = Date.now() + BACKGROUND_DEADLINE_MS;
    while (Date.now() < deadline) {
      await delay(BACKGROUND_POLL_MS);
      const polled = await send(new URL(result, API), {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      }).catch(() => undefined);
      if (polled === undefined || polled.status === 202) continue;
      // A transient failure of the polling hop itself, not the stored result.
      if (
        [408, 429, 502, 503, 504].includes(polled.status) &&
        !polled.headers.has("x-freestyle-background-request-id")
      )
        continue;
      return polled;
    }
    throw new FreestyleApiError(
      504,
      "BACKGROUND_TIMEOUT",
      "Freestyle did not finish the request in time.",
    );
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
  const vmPath = (vm: string, rest = "") =>
    `/v5/vms/${encodeURIComponent(vm)}${rest}`;
  return {
    async accountId() {
      const listed = await json<{
        readonly identities?: ReadonlyArray<{ readonly id: string }>;
      }>("GET", "/v5/identities", {
        query: { limit: "1", includeManaged: "true" },
      });
      const id =
        listed.identities?.[0]?.id ??
        (
          await json<{ readonly id: string }>("POST", "/v5/identities", {
            json: {},
          })
        ).id;
      const identity = await json<{ readonly accountId?: string }>(
        "GET",
        `/v5/identities/${encodeURIComponent(id)}`,
      );
      if (typeof identity.accountId !== "string" || identity.accountId === "")
        throw new FreestyleApiError(
          500,
          "NO_ACCOUNT",
          "Freestyle did not name the key's account.",
        );
      return identity.accountId;
    },
    createVm: (input) =>
      json<FreestyleVm>("POST", "/v5/vms", {
        json: {
          snapshotId: input.snapshotId,
          firewall: OUTBOUND,
          // dxd holds a WebSocket open, so network idleness never comes;
          // Core pauses the VM through its run budget instead.
          idleTimeoutSeconds: -1,
          ...(input.slug === undefined ? {} : { slug: input.slug }),
          ...(input.displayName === undefined
            ? {}
            : { displayName: input.displayName }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          ...(input.maxRunTotalSeconds === undefined
            ? {}
            : { maxRunTotalSeconds: input.maxRunTotalSeconds }),
        },
      }),
    async getVm(vm) {
      const response = await call("GET", vmPath(vm));
      if (response.status === 404) return undefined;
      if (!response.ok) throw await failure(response);
      return (await response.json()) as FreestyleVm;
    },
    startVm: (vm) => json<FreestyleVm>("POST", vmPath(vm, "/start")),
    async pauseVm(vm) {
      await json("POST", vmPath(vm, "/pause"));
    },
    async updateVm(vm, patch) {
      await json("PATCH", vmPath(vm), { json: patch });
    },
    async deleteVm(vm) {
      const response = await call("DELETE", vmPath(vm));
      if (response.status === 404 || response.ok) return;
      throw await failure(response);
    },
    async exec(vm, input) {
      const result = await json<{
        readonly stdout?: string | null;
        readonly stderr?: string | null;
        readonly statusCode?: number | null;
      }>("POST", vmPath(vm, "/exec-await"), {
        json: {
          command: input.command,
          ...(input.env === undefined ? {} : { env: input.env }),
          ...(input.linuxUser === undefined
            ? {}
            : { linuxUser: input.linuxUser }),
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
          ...(input.stdin === undefined ? {} : { stdin: base64(input.stdin) }),
        },
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        statusCode: result.statusCode ?? null,
      };
    },
    async readFile(vm, path) {
      const response = await call("GET", vmPath(vm, "/fs/read"), {
        query: { path },
      });
      if (!response.ok) throw await failure(response);
      return new Uint8Array(await response.arrayBuffer());
    },
    async writeFile(vm, path, content) {
      await json("PUT", vmPath(vm, "/fs/write"), {
        query: { path },
        bytes: content,
      });
    },
    async stat(vm, path) {
      const stat = await json<{
        readonly isFile: boolean;
        readonly isDirectory: boolean;
        readonly isSymlink: boolean;
      }>("GET", vmPath(vm, "/fs/stat"), { query: { path } });
      return {
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymlink: stat.isSymlink,
      };
    },
    async readdir(vm, path) {
      const listed = await json<{
        readonly entries: ReadonlyArray<{ readonly name: string }>;
      }>("GET", vmPath(vm, "/fs/dir"), { query: { path } });
      return listed.entries.map(({ name }) => name);
    },
    async exists(vm, path) {
      return (
        await json<{ readonly exists: boolean }>(
          "GET",
          vmPath(vm, "/fs/exists"),
          { query: { path } },
        )
      ).exists;
    },
    async mkdir(vm, path) {
      await json("POST", vmPath(vm, "/fs/mkdir"), { json: { path } });
    },
    async remove(vm, path) {
      await json("DELETE", vmPath(vm, "/fs/remove"), { query: { path } });
    },
    async snapshot(vm, displayName) {
      return (
        await json<{ readonly snapshotId: string }>(
          "POST",
          vmPath(vm, "/snapshot"),
          { json: { displayName } },
        )
      ).snapshotId;
    },
    async snapshots(search) {
      const listed = await json<{
        readonly snapshots?: ReadonlyArray<{
          readonly id: string;
          readonly displayName?: string | null;
          readonly createdAt: string;
        }>;
      }>("GET", "/v5/snapshots", { query: { search, limit: "100" } });
      return (listed.snapshots ?? []).map(({ id, displayName, createdAt }) => ({
        id,
        name: displayName ?? "",
        createdAt,
      }));
    },
    async deleteSnapshot(snapshot) {
      const response = await call(
        "DELETE",
        `/v5/snapshots/${encodeURIComponent(snapshot)}`,
      );
      if (response.status === 404 || response.ok) return;
      throw await failure(response);
    },
  };
};
