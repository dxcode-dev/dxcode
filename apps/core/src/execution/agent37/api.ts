/**
 * The part of Agent37's Sandbox API (https://www.agent37.com/docs/llms.txt)
 * dx uses, over `fetch` so it runs in a Worker. One `sk_live_` key reaches
 * both planes: the control plane at api.agent37.com takes it as a bearer
 * token, and exec on sandbox.agent37.app, answered by the instance's own
 * machine, takes it as `X-Agent37-Key`.
 */

const API = "https://api.agent37.com/v1";
const SANDBOX = "https://sandbox.agent37.app/v1";
/** One control-plane round trip; a create waits for `running`. */
const CALL_TIMEOUT_MS = 60_000;
const CREATE_TIMEOUT_MS = 300_000;
/** A template registration copies the image once, minutes for a large one. */
const REGISTER_TIMEOUT_MS = 600_000;
/**
 * A command runs at most this long. Agent37 answers exec after 900 s with
 * `504 try_again` and kills the command; dx's own limit ends it first.
 */
export const MAX_COMMAND_SECONDS = 840;
/**
 * Agent37 runs a command of up to its 1 MB request cap, but a program dx
 * starts refuses any one argument of 128 KiB or more ("Argument list too
 * long"): a longer script runs from a file instead (`throughFile`).
 */
const ARGUMENT_BYTES = 120 * 1024;
/** Exec calls Agent37 says are safe to send again (`name` dedupes them). */
const EXEC_RETRIES = 4;
const EXEC_RETRY_MS = 2_000;

export type Agent37InstanceStatus =
  | "provisioning"
  | "running"
  | "stopping"
  | "stopped"
  | "starting"
  | "restarting"
  | "updating"
  | "sleeping"
  | "waking"
  | "failed"
  | "deleting"
  | "deleted"
  | (string & {});

export interface Agent37Instance {
  readonly id: string;
  readonly status: Agent37InstanceStatus;
  readonly template?: string;
  readonly mountPath?: string;
  readonly pastDue?: boolean;
  /** dx's own labels, given at create. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface Agent37Template {
  readonly name: string;
  readonly imageDigest?: string | null;
  readonly description?: string | null;
  /** Epoch seconds. */
  readonly created?: number;
}

export interface Agent37CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
}

/** An Agent37 error answer: its HTTP status, code, and message. */
export class Agent37ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Agent37's error code, such as `insufficient_balance`. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "Agent37ApiError";
  }
}

export interface Agent37Api {
  readonly createInstance: (input: {
    readonly template: string;
    readonly resources: {
      readonly cpu: number;
      readonly memory: number;
      readonly disk: number;
    };
    readonly name: string;
    /** Where the instance's billed disk mounts. */
    readonly mountPath: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }) => Promise<Agent37Instance>;
  readonly getInstance: (id: string) => Promise<Agent37Instance | undefined>;
  /** Instances newest first, every page. */
  readonly instances: () => Promise<ReadonlyArray<Agent37Instance>>;
  readonly deleteInstance: (id: string) => Promise<void>;
  /** Checkpoints the instance with its memory; it bills disk only. */
  readonly sleep: (id: string) => Promise<void>;
  readonly start: (id: string) => Promise<void>;
  readonly exec: (
    id: string,
    command: string,
    options?: {
      readonly root?: boolean;
      readonly timeoutSeconds?: number;
    },
  ) => Promise<Agent37CommandResult>;
  readonly template: (name: string) => Promise<Agent37Template | undefined>;
  readonly registerTemplate: (input: {
    readonly name: string;
    readonly imageRef: string;
    readonly description: string;
  }) => Promise<Agent37Template>;
  /** The workspace's members, oldest first. */
  readonly members: () => Promise<
    ReadonlyArray<{ readonly id: string; readonly created: number }>
  >;
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  typeof value === "object" && value !== null ? (value as Json) : {};

const text = (value: unknown) => (typeof value === "string" ? value : "");

const instanceOf = (value: unknown): Agent37Instance => {
  const body = record(value);
  return {
    id: text(body.id),
    status: text(body.status),
    ...(typeof body.template === "string" ? { template: body.template } : {}),
    ...(typeof body.mount_path === "string"
      ? { mountPath: body.mount_path }
      : {}),
    ...(typeof body.past_due === "boolean" ? { pastDue: body.past_due } : {}),
    ...(typeof body.metadata === "object" && body.metadata !== null
      ? {
          metadata: Object.fromEntries(
            Object.entries(body.metadata).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
        }
      : {}),
  };
};

const templateOf = (value: unknown): Agent37Template => {
  const body = record(value);
  return {
    name: text(body.name),
    imageDigest:
      typeof body.image_digest === "string" ? body.image_digest : null,
    description: typeof body.description === "string" ? body.description : null,
    ...(typeof body.created === "number" ? { created: body.created } : {}),
  };
};

/**
 * Agent37's errors: `{ "error": { "code", "message" } }` on the control
 * plane, a flat `{ "error": "not_found" }` from sandbox.agent37.app when a
 * request is turned away before the instance.
 */
const failure = async (response: Response) => {
  const raw = await response.text().catch(() => "");
  let code: string | undefined;
  let message = raw.slice(0, 300) || response.statusText;
  try {
    const error = record(JSON.parse(raw)).error;
    if (typeof error === "string") {
      code = error;
      message = error;
    } else {
      const body = record(error);
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
    }
  } catch {}
  return new Agent37ApiError(response.status, message, code);
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const agent37Api = (
  apiKey: string,
  send: typeof fetch = fetch,
): Agent37Api => {
  const call = async (
    method: string,
    path: string,
    options: { readonly body?: unknown; readonly timeoutMs?: number } = {},
  ): Promise<unknown> => {
    const response = await send(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS),
    });
    if (!response.ok) throw await failure(response);
    return response.status === 204 ? {} : response.json();
  };
  const missing = (cause: unknown) => {
    if (cause instanceof Agent37ApiError && cause.status === 404)
      return undefined;
    throw cause;
  };
  return {
    async createInstance(input) {
      return instanceOf(
        await call("POST", "/instances", {
          body: {
            template: input.template,
            resources: input.resources,
            name: input.name,
            mount_path: input.mountPath,
            ...(input.metadata === undefined
              ? {}
              : { metadata: input.metadata }),
          },
          timeoutMs: CREATE_TIMEOUT_MS,
        }),
      );
    },
    getInstance: (id) =>
      call("GET", `/instances/${encodeURIComponent(id)}`).then(
        instanceOf,
        missing,
      ),
    async instances() {
      const listed = record(await call("GET", "/instances")).data;
      return Array.isArray(listed) ? listed.map(instanceOf) : [];
    },
    async deleteInstance(id) {
      await call("DELETE", `/instances/${encodeURIComponent(id)}`).catch(
        missing,
      );
    },
    async sleep(id) {
      await call("POST", `/instances/${encodeURIComponent(id)}/sleep`);
    },
    async start(id) {
      await call("POST", `/instances/${encodeURIComponent(id)}/start`);
    },
    async exec(id, command, options = {}) {
      const seconds = Math.min(
        MAX_COMMAND_SECONDS,
        Math.max(1, Math.ceil(options.timeoutSeconds ?? MAX_COMMAND_SECONDS)),
      );
      // `timeout` ends the command at dx's limit (exit 124), so it never
      // outlives the call that waits for it.
      const body = JSON.stringify({
        command: fitsArgument(command)
          ? `exec timeout -k 5 ${seconds} sh -c ${quote(command)}`
          : throughFile(command, `exec timeout -k 5 ${seconds} sh "$f"`),
        ...(options.root === true ? { user: "root" } : {}),
        // The same name makes a resent call return the first run's result.
        name: `dx-${crypto.randomUUID()}`,
      });
      for (let attempt = 0; ; attempt += 1) {
        const response = await send(
          `${SANDBOX}/instances/${encodeURIComponent(id)}/exec`,
          {
            method: "POST",
            headers: {
              "x-agent37-key": apiKey,
              "content-type": "application/json",
            },
            body,
            signal: AbortSignal.timeout((seconds + 60) * 1_000),
          },
        );
        if (response.ok) {
          const result = record(await response.json());
          return {
            stdout: text(result.stdout),
            stderr: text(result.stderr),
            exitCode:
              typeof result.exit_code === "number" ? result.exit_code : 1,
            truncated: result.truncated === true,
          };
        }
        const error = await failure(response);
        // A wake that failed or timed out, a busy instance, or an answer
        // that outwaited the call: each is safe to send again.
        const retryable =
          (error.status === 503 || error.status === 504) &&
          ["try_again", "wake_failed", "wake_timeout"].includes(
            error.code ?? "",
          );
        if (!retryable || attempt + 1 >= EXEC_RETRIES) throw error;
        await delay(EXEC_RETRY_MS * (attempt + 1));
      }
    },
    template: (name) =>
      call("GET", `/templates/${encodeURIComponent(name)}`).then(
        templateOf,
        missing,
      ),
    async registerTemplate(input) {
      return templateOf(
        await call("POST", "/templates", {
          body: {
            name: input.name,
            image_ref: input.imageRef,
            description: input.description,
          },
          timeoutMs: REGISTER_TIMEOUT_MS,
        }),
      );
    },
    async members() {
      const listed = record(await call("GET", "/members")).members;
      return (Array.isArray(listed) ? listed : [])
        .map((member) => {
          const body = record(member);
          return {
            id: text(body.id),
            created: typeof body.created === "number" ? body.created : 0,
          };
        })
        .filter(({ id }) => id !== "")
        .sort((a, b) => a.created - b.created);
    },
  };
};

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Whether `script` can be passed to a program as one argument. */
export const fitsArgument = (script: string) =>
  new TextEncoder().encode(script).length < ARGUMENT_BYTES;

/**
 * Shell that writes `script` to a private temporary file, through a heredoc
 * the shell reads itself, then runs `run`, which names the file `$f`. The
 * script deletes its file as it starts.
 */
export const throughFile = (script: string, run: string) => {
  const end = `DX_SCRIPT_${crypto.randomUUID().replaceAll("-", "")}`;
  return `f=$(mktemp /tmp/dx-exec-XXXXXXXX) || exit 125
cat >"$f" <<'${end}' || { rm -f -- "$f"; exit 125; }
rm -f -- "$0"
${script}
${end}
${run}`;
};
