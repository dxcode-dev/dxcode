/**
 * The part of Lizard's sandbox API (https://lizard.build/docs/sandboxes,
 * and @lizard-build/sdk 1.0.10 for the file and snapshot calls the docs do
 * not list) dx uses, over `fetch` so it runs in a Worker. Every call names
 * the deployment's Lizard project.
 */

const API = "https://lizard.build";
/** One control-plane round trip. */
const CALL_TIMEOUT_MS = 60_000;
/** A command runs at most this long (Lizard's cap). */
export const MAX_COMMAND_MS = 600_000;
/** A snapshot of a whole sandbox can take minutes. */
const SNAPSHOT_TIMEOUT_MS = 300_000;

export type LizardSandboxStatus =
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "stopped"
  | "crashed"
  | (string & {});

export interface LizardSandbox {
  readonly id: string;
  readonly status: LizardSandboxStatus;
  readonly size?: string;
  readonly pauseError?: string | null;
  readonly crashReason?: string | null;
}

export interface LizardCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface LizardSnapshot {
  readonly id: string;
  /** `building` while Lizard takes it, then `ready` or `failed`. */
  readonly status: "creating" | "building" | "ready" | "failed" | (string & {});
  readonly error?: string | null;
  readonly name?: string;
  /** Epoch ms. */
  readonly createdAt?: number;
}

/** A Lizard error response: its HTTP status and message. */
export class LizardApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Lizard's error code, such as `SANDBOX_SIZE_NOT_ALLOWED`. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "LizardApiError";
  }
}

export interface LizardApi {
  readonly createSandbox: (input: {
    /** A Lizard size name; a snapshot restores at its own size instead. */
    readonly size: string;
    /** A catalog template, for preparation. */
    readonly template?: string;
    /** A dx Orb snapshot, for a Thread. */
    readonly snapshotId?: string;
    readonly metadata?: Readonly<Record<string, string>>;
    /**
     * When Lizard deletes it, for a build or test sandbox dx may lose. A
     * Thread's sandbox has none: dx pauses it when idle.
     */
    readonly deleteAfterMs?: number;
  }) => Promise<LizardSandbox>;
  readonly getSandbox: (id: string) => Promise<LizardSandbox | undefined>;
  readonly pause: (id: string) => Promise<void>;
  readonly resume: (id: string) => Promise<void>;
  readonly kill: (id: string) => Promise<void>;
  readonly exec: (
    id: string,
    cmd: string,
    options?: {
      readonly user?: string;
      readonly workdir?: string;
      readonly envs?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
    },
  ) => Promise<LizardCommandResult>;
  readonly readFile: (
    id: string,
    path: string,
    user?: string,
  ) => Promise<Uint8Array>;
  readonly writeFile: (
    id: string,
    path: string,
    content: Uint8Array,
    user?: string,
  ) => Promise<void>;
  readonly snapshot: (id: string, name: string) => Promise<LizardSnapshot>;
  readonly getSnapshot: (id: string) => Promise<LizardSnapshot | undefined>;
  /** Every snapshot of the project, any status. */
  readonly snapshots: () => Promise<ReadonlyArray<LizardSnapshot>>;
  readonly deleteSnapshot: (id: string) => Promise<void>;
  /** The vCPUs the project may run at once, from its plan's limits. */
  readonly limits: () => Promise<{
    readonly vcpu: number;
    readonly tier: string;
  }>;
}

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const failure = async (response: Response) => {
  const text = await response.text().catch(() => "");
  let message = text.slice(0, 300) || response.statusText;
  let code: string | undefined;
  try {
    const body = JSON.parse(text) as {
      readonly error?: string;
      readonly message?: string;
      readonly code?: string;
    };
    message = body.message ?? body.error ?? message;
    code = typeof body.code === "string" ? body.code : undefined;
  } catch {
    // Not JSON: keep the text.
  }
  return new LizardApiError(response.status, message, code);
};

const sandboxOf = (body: unknown): LizardSandbox => {
  const value = body as Record<string, unknown>;
  const id = value.id ?? value.sandboxId;
  if (typeof id !== "string") throw new LizardApiError(502, "no sandbox ID");
  return {
    id,
    status: String(value.status ?? "starting"),
    ...(typeof value.size === "string" ? { size: value.size } : {}),
    pauseError: (value.pauseError as string | null | undefined) ?? null,
    crashReason: (value.crashReason as string | null | undefined) ?? null,
  };
};

const snapshotOf = (body: unknown): LizardSnapshot => {
  const value = body as Record<string, unknown>;
  const id = value.id ?? value.snapshotId;
  if (typeof id !== "string") throw new LizardApiError(502, "no snapshot ID");
  return {
    id,
    status: String(value.status ?? "creating"),
    error: (value.error as string | null | undefined) ?? null,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.createdAt === "number"
      ? { createdAt: value.createdAt }
      : {}),
  };
};

export const lizardApi = (
  apiKey: string,
  projectId: string,
  send: typeof fetch = (...args) => fetch(...args),
  /** Where new sandboxes run (Lizard's default is us-east-1). */
  region?: string,
): LizardApi => {
  const call = (
    method: string,
    path: string,
    init: {
      readonly query?: Readonly<Record<string, string>>;
      readonly json?: unknown;
      readonly timeoutMs?: number;
    } = {},
  ) => {
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
  const sandbox = (id: string) => `/api/sandboxes/${encodeURIComponent(id)}`;
  /** A call that answers 404 for a sandbox that is already gone. */
  const quiet = async (method: string, path: string, body?: unknown) => {
    const response = await call(method, path, {
      json: body ?? {},
    });
    if (response.ok || response.status === 404) return;
    throw await failure(response);
  };
  return {
    createSandbox: async (input) =>
      sandboxOf(
        await json("POST", "/api/sandboxes", {
          json: {
            projectId,
            size: input.size,
            ...(region === undefined ? {} : { region }),
            ...(input.template === undefined
              ? {}
              : { template: input.template }),
            ...(input.snapshotId === undefined
              ? {}
              : { snapshotId: input.snapshotId }),
            // A deadline kills a sandbox and deletes its disk; an idle
            // dx Orb is paused instead (provider.ts), so a Thread's has none.
            timeoutMs: input.deleteAfterMs ?? 0,
            ...(input.metadata === undefined
              ? {}
              : { metadata: input.metadata }),
          },
        }),
      ),
    async getSandbox(id) {
      const response = await call("GET", sandbox(id));
      if (response.status === 404) return undefined;
      if (!response.ok) throw await failure(response);
      return sandboxOf(await response.json());
    },
    // Every Lizard pause keeps files only and the resume boots fresh: memory
    // pauses are off since 2026-11-10 (SDK 1.0.19).
    pause: (id) => quiet("POST", `${sandbox(id)}/pause`),
    resume: (id) => quiet("POST", `${sandbox(id)}/resume`),
    async kill(id) {
      const response = await call("DELETE", sandbox(id));
      if (response.ok || response.status === 404) return;
      throw await failure(response);
    },
    async exec(id, cmd, options = {}) {
      const timeoutMs = Math.min(
        MAX_COMMAND_MS,
        Math.max(1_000, options.timeoutMs ?? 300_000),
      );
      const result = await json<{
        readonly stdout?: string;
        readonly stderr?: string;
        readonly exitCode?: number;
      }>("POST", `${sandbox(id)}/exec`, {
        json: {
          cmd,
          timeoutMs,
          ...(options.user === undefined ? {} : { user: options.user }),
          ...(options.workdir === undefined
            ? {}
            : { workdir: options.workdir }),
          ...(options.envs === undefined ? {} : { envs: options.envs }),
        },
        timeoutMs: timeoutMs + CALL_TIMEOUT_MS,
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 137,
      };
    },
    async readFile(id, path, user) {
      const response = await call("GET", `${sandbox(id)}/files`, {
        query: { path, ...(user === undefined ? {} : { user }) },
        timeoutMs: CALL_TIMEOUT_MS * 5,
      });
      if (!response.ok) throw await failure(response);
      return new Uint8Array(await response.arrayBuffer());
    },
    async writeFile(id, path, content, user) {
      const response = await call("POST", `${sandbox(id)}/files`, {
        json: {
          path,
          content: base64(content),
          encoding: "base64",
          ...(user === undefined ? {} : { user }),
        },
        timeoutMs: CALL_TIMEOUT_MS * 5,
      });
      if (!response.ok) throw await failure(response);
    },
    snapshot: async (id, name) =>
      snapshotOf(
        await json("POST", `${sandbox(id)}/snapshot`, {
          // Files only (memory snapshots are off); a Firecracker snapshot
          // ignores the pool size and restores from disk.
          json: { name, poolSize: 1 },
          timeoutMs: SNAPSHOT_TIMEOUT_MS,
        }),
      ),
    async getSnapshot(id) {
      const response = await call(
        "GET",
        `/api/sandbox-snapshots/${encodeURIComponent(id)}`,
      );
      if (response.status === 404) return undefined;
      if (!response.ok) throw await failure(response);
      return snapshotOf(await response.json());
    },
    snapshots: async () =>
      (
        await json<ReadonlyArray<unknown>>("GET", "/api/sandbox-snapshots", {
          query: { projectId },
        })
      ).map(snapshotOf),
    async deleteSnapshot(id) {
      const response = await call(
        "DELETE",
        `/api/sandbox-snapshots/${encodeURIComponent(id)}`,
      );
      if (response.ok || response.status === 404) return;
      throw await failure(response);
    },
    async limits() {
      const body = await json<{
        readonly tier?: string;
        readonly limits?: { readonly vcpu?: number };
      }>("GET", "/api/sandboxes/limits", { query: { projectId } });
      return { vcpu: body.limits?.vcpu ?? 0, tier: body.tier ?? "unknown" };
    },
  };
};
