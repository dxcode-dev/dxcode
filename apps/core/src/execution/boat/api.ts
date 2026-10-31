/**
 * The part of Boat's REST API (https://docs.boat.dev/api/v1.md, OpenAPI at
 * https://docs.boat.dev/openapi/boat-v1.yaml) dx uses, over `fetch` so it
 * runs in a Worker. Every answer is an `{ ok, type, ... }` envelope; an
 * error carries a stable `code`.
 */

const API = "https://boat.dev/api/v1";
/** One control-plane round trip. */
const CALL_TIMEOUT_MS = 60_000;
/** Boat holds a command for a starting sandbox this long before it runs. */
const START_WAIT_MS = 60_000;
/** A synchronous command runs at most this long (Boat's cap). */
export const MAX_COMMAND_SECONDS = 600;
/** The file API reads and writes up to 5 MiB; larger files use URLs. */
const FILE_API_LIMIT = 5 * 1024 * 1024;
/** Calls Boat marks as not run, retried this many times. */
const RETRIES = 5;
const RETRY_MS = 2_000;

export type BoatSandboxState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error"
  | "cancelled";

export interface BoatSandbox {
  readonly id: string;
  readonly state: BoatSandboxState;
  /** Set once Boat deleted a stopped sandbox's disk, 14 days after the stop. */
  readonly dataExpiredAt?: string | null;
  readonly error?: string | null;
}

export interface BoatCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface BoatSavedSnapshot {
  readonly name: string;
  readonly status: "saving" | "ready" | "failed";
  readonly error?: string;
  readonly createdAt?: string;
}

export interface BoatAccount {
  readonly id: string;
  /** Boat deletes a stopped sandbox's disk instead of keeping it. */
  readonly zeroDataRetention: boolean;
}

export interface BoatLimits {
  /** `trial` before the account's first payment. */
  readonly plan: string | undefined;
  /** The sandbox types the account can create now. */
  readonly machineTypes: ReadonlyArray<string>;
  /** The types it cannot, each with Boat's reason when it gives one. */
  readonly refusedTypes: ReadonlyMap<string, string | undefined>;
}

/** A Boat error response: its HTTP status and stable `code`. */
export class BoatApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Boat's `error.details.retryable`, when it says. */
    readonly retryable?: boolean,
  ) {
    super(message);
  }
}

export interface CreateBoatSandbox {
  readonly type: string;
  /** A saved snapshot name; absent for a stock Ubuntu sandbox. */
  readonly from?: string;
  readonly name: string;
  readonly ttlSeconds: number;
  /** Makes a retried create return the sandbox the first one made. */
  readonly idempotencyKey?: string;
}

export interface BoatApi {
  /** The account the key belongs to. Rejects with 401 or 403 for a bad key. */
  readonly account: () => Promise<BoatAccount>;
  readonly limits: () => Promise<BoatLimits>;
  readonly createSandbox: (input: CreateBoatSandbox) => Promise<BoatSandbox>;
  /** Undefined when the account has no such sandbox. */
  readonly getSandbox: (id: string) => Promise<BoatSandbox | undefined>;
  /** Sets the auto-stop deadline to `ttlSeconds` from now. */
  readonly setTtl: (id: string, ttlSeconds: number) => Promise<void>;
  /** Stops the sandbox, keeping its disk. */
  readonly stopSandbox: (id: string) => Promise<void>;
  readonly resumeSandbox: (id: string, ttlSeconds: number) => Promise<void>;
  /** Deletes the sandbox and its snapshots; one already gone is not an error. */
  readonly deleteSandbox: (id: string) => Promise<void>;
  /** Runs a command synchronously, as the sandbox's `user`. */
  readonly command: (
    id: string,
    command: string,
    timeoutSeconds: number,
  ) => Promise<BoatCommandResult>;
  /** Reads a file under /home/user or /tmp. */
  readonly readFile: (id: string, path: string) => Promise<Uint8Array>;
  /** Writes a file under /home/user or /tmp, creating its folders. */
  readonly writeFile: (
    id: string,
    path: string,
    content: Uint8Array,
  ) => Promise<void>;
  readonly saveSnapshot: (sandboxId: string, name: string) => Promise<void>;
  /** Undefined when the account has no saved snapshot by that name. */
  readonly savedSnapshot: (
    name: string,
  ) => Promise<BoatSavedSnapshot | undefined>;
  readonly savedSnapshots: () => Promise<ReadonlyArray<BoatSavedSnapshot>>;
  /** Deletes a saved snapshot; one already gone is not an error. */
  readonly deleteSavedSnapshot: (name: string) => Promise<void>;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

interface ErrorBody {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly details?: { readonly retryable?: unknown };
  };
}

const failure = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  const code = body.error?.code ?? body.code;
  const message = body.error?.message ?? body.message;
  const retryable = body.error?.details?.retryable;
  return new BoatApiError(
    response.status,
    typeof code === "string" ? code : "unknown",
    typeof message === "string"
      ? message.slice(0, 300)
      : `Boat answered ${response.status}.`,
    typeof retryable === "boolean" ? retryable : undefined,
  );
};

/**
 * Boat says these did not run (or ran idempotently): a sandbox still
 * starting after Boat's own minute, files still mounting after a resume, a
 * create whose first attempt is still in flight, a full machine pool.
 */
const notRun = (cause: unknown) =>
  cause instanceof BoatApiError &&
  ((cause.status === 409 &&
    (cause.code === "sandbox_starting" ||
      cause.code === "boat_starting" ||
      cause.code === "idempotency_in_progress")) ||
    (cause.status === 502 && cause.message === "sandbox_restoring") ||
    cause.status === 503);

/**
 * Boat refuses a file API read above 5 MiB with `400 sandbox_direct_failed`
 * and "File is too large for read_file" (seen 2026-10-31); the code is
 * generic, so the message decides.
 */
const isFileTooLarge = (cause: unknown) =>
  cause instanceof BoatApiError &&
  (cause.status === 413 ||
    /too_large|too_big/.test(cause.code) ||
    (cause.status === 400 && /too large/i.test(cause.message)));

export const boatApi = (
  apiKey: string,
  send: typeof fetch = (...args) => fetch(...args),
): BoatApi => {
  const call = async (
    method: string,
    path: string,
    init: {
      readonly query?: Readonly<Record<string, string>>;
      readonly json?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<Response> => {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {}))
      url.searchParams.set(key, value);
    return send(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(init.json === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers,
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      signal: AbortSignal.timeout(init.timeoutMs ?? CALL_TIMEOUT_MS),
    });
  };
  const json = async <T>(
    method: string,
    path: string,
    init?: Parameters<typeof call>[2],
  ): Promise<T> => {
    const response = await call(method, path, init);
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  };
  /** Retries a call Boat says did not run. */
  const retried = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (cause) {
        if (attempt >= RETRIES || !notRun(cause)) throw cause;
        await delay(RETRY_MS);
      }
    }
  };
  const sandboxPath = (id: string, rest = "") =>
    `/sandboxes/${encodeURIComponent(id)}${rest}`;
  const fileUrl = async (
    id: string,
    path: string,
    kind: "upload" | "download",
  ) =>
    (
      await json<{ readonly url: string }>(
        "POST",
        sandboxPath(id, `/files/${kind}-url`),
        { json: { path } },
      )
    ).url;
  return {
    async account() {
      const { user } = await json<{
        readonly user?: {
          readonly id?: string;
          readonly zeroDataRetention?: boolean;
        };
      }>("GET", "/me");
      if (typeof user?.id !== "string" || user.id === "")
        throw new BoatApiError(
          500,
          "no_account",
          "Boat did not name the key's account.",
        );
      return {
        id: user.id,
        zeroDataRetention: user.zeroDataRetention === true,
      };
    },
    async limits() {
      const limits = await json<{
        readonly sandboxPlanKey?: string;
        readonly machineTypes?: ReadonlyArray<{
          readonly type: string;
          readonly available: boolean;
          readonly reason?: string | null;
        }>;
      }>("GET", "/limits");
      const types = limits.machineTypes ?? [];
      return {
        plan: limits.sandboxPlanKey,
        machineTypes: types.flatMap(({ type, available }) =>
          available ? [type] : [],
        ),
        refusedTypes: new Map(
          types.flatMap(({ type, available, reason }) =>
            available ? [] : [[type, reason ?? undefined] as const],
          ),
        ),
      };
    },
    createSandbox: (input) =>
      retried(async () => {
        const created = await json<{ readonly sandbox: BoatSandbox }>(
          "POST",
          "/sandboxes",
          {
            json: {
              type: input.type,
              name: input.name,
              ttlSeconds: input.ttlSeconds,
              // None of the account's secrets, logins, or Boat API key go
              // into an Orb, so none reach a saved snapshot either.
              noEnv: true,
              // Boat keeps no command output (which can carry credentials)
              // in its 90-day history.
              monitoring: false,
              ...(input.from === undefined ? {} : { from: input.from }),
            },
            ...(input.idempotencyKey === undefined
              ? {}
              : { headers: { "idempotency-key": input.idempotencyKey } }),
          },
        );
        return created.sandbox;
      }),
    async getSandbox(id) {
      const response = await call("GET", sandboxPath(id));
      if (response.status === 404) return undefined;
      if (!response.ok) throw await failure(response);
      return ((await response.json()) as { readonly sandbox: BoatSandbox })
        .sandbox;
    },
    async setTtl(id, ttlSeconds) {
      await json("PATCH", sandboxPath(id), { json: { ttlSeconds } });
    },
    async stopSandbox(id) {
      await json("POST", sandboxPath(id, "/stop"), { json: {} });
    },
    async resumeSandbox(id, ttlSeconds) {
      await retried(() =>
        json("POST", sandboxPath(id, "/resume"), { json: { ttlSeconds } }),
      );
    },
    async deleteSandbox(id) {
      const response = await call("DELETE", sandboxPath(id), {
        headers: { "x-ascii-confirm-delete": id },
      });
      if (response.status === 404 || response.ok) return;
      throw await failure(response);
    },
    command: (id, command, timeoutSeconds) =>
      retried(async () => {
        const result = await json<{
          readonly stdout?: string;
          readonly stderr?: string;
          readonly exitCode?: number | null;
          readonly timedOut?: boolean;
        }>("POST", sandboxPath(id, "/commands"), {
          json: { command, timeoutSeconds },
          timeoutMs: timeoutSeconds * 1_000 + START_WAIT_MS + CALL_TIMEOUT_MS,
        });
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? null,
          timedOut: result.timedOut === true,
        };
      }),
    async readFile(id, path) {
      try {
        const read = await retried(() =>
          json<{ readonly content: string }>("GET", sandboxPath(id, "/files"), {
            query: { path, encoding: "base64" },
          }),
        );
        return fromBase64(read.content);
      } catch (cause) {
        if (!isFileTooLarge(cause)) throw cause;
        const response = await send(await fileUrl(id, path, "download"), {
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS * 5),
        });
        if (!response.ok) throw await failure(response);
        return new Uint8Array(await response.arrayBuffer());
      }
    },
    async writeFile(id, path, content) {
      if (content.byteLength <= FILE_API_LIMIT) {
        await retried(() =>
          json("PUT", sandboxPath(id, "/files"), {
            json: { path, content: base64(content), encoding: "base64" },
          }),
        );
        return;
      }
      const response = await send(await fileUrl(id, path, "upload"), {
        method: "PUT",
        body: content as Uint8Array<ArrayBuffer>,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS * 5),
      });
      if (!response.ok) throw await failure(response);
    },
    async saveSnapshot(sandboxId, name) {
      await json("POST", "/saved-snapshots", { json: { sandboxId, name } });
    },
    async savedSnapshot(name) {
      const response = await call(
        "GET",
        `/saved-snapshots/${encodeURIComponent(name)}`,
      );
      if (response.status === 404) return undefined;
      if (!response.ok) throw await failure(response);
      return (
        (await response.json()) as { readonly snapshot: BoatSavedSnapshot }
      ).snapshot;
    },
    async savedSnapshots() {
      return (
        (
          await json<{ readonly snapshots?: ReadonlyArray<BoatSavedSnapshot> }>(
            "GET",
            "/saved-snapshots",
          )
        ).snapshots ?? []
      );
    },
    async deleteSavedSnapshot(name) {
      const response = await call(
        "DELETE",
        `/saved-snapshots/${encodeURIComponent(name)}`,
      );
      if (response.status === 404 || response.ok) return;
      throw await failure(response);
    },
  };
};
