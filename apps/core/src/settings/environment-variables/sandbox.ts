import { isHiddenEnvironmentValue } from "@dx/domain";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { Redacted } from "effect";
import {
  type ExecutionEnvironmentRevision,
  type ExecutionEnvironmentSnapshot,
  executionEnvironmentRevisionsEqual,
} from "./execution.js";
import { type SecretMasker, secretMasker } from "./masking.js";

/**
 * How long operations other than commands reuse the resolved environment
 * before checking its revision again. A command checks it every time, so an
 * edit reaches the next command at once and every other operation, such as
 * the reads Claude Code polls a run with, within this long.
 */
export const ENVIRONMENT_REVALIDATE_MS = 5_000;

/**
 * Every value reaches the process; reads mask only hidden secrets, since
 * hiding a short or common one would garble unrelated words. Where names
 * share a value, the first by name marks it.
 */
const admittedValues = (snapshot: ExecutionEnvironmentSnapshot) => {
  const env: Record<string, string> = {};
  const hidden: Array<{ name: string; value: string }> = [];
  const byName = [...snapshot.values].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const value of byName) {
    const plaintext = Redacted.value(value.value);
    env[value.name] = plaintext;
    if (isHiddenEnvironmentValue(value.kind, plaintext))
      hidden.push({ name: value.name, value: plaintext });
  }
  return { env, masker: secretMasker(hidden) };
};

type Admitted = ReturnType<typeof admittedValues>;

const environmentMasker = Symbol("dx.environmentMasker");

type WithEnvironmentMasker = Sandbox & {
  readonly [environmentMasker]?: () => Promise<SecretMasker>;
};

/** For a sandbox without an environment: only dx's own credentials. */
const credentialsOnly = secretMasker([]);

/**
 * What a decorated sandbox's reads mask; only dx's own credentials for a
 * sandbox without an environment. Wrappers that spread the sandbox keep it.
 */
export const environmentMaskerOf = async (
  sandbox: Sandbox,
): Promise<SecretMasker> =>
  (await (sandbox as WithEnvironmentMasker)[environmentMasker]?.()) ??
  credentialsOnly;

/**
 * Each Thread's latest decorated sandbox in this isolate, so tools that never
 * touch the Orb mask the same values.
 */
const threadMaskers = new Map<string, () => Promise<SecretMasker>>();

/**
 * The masker of the Thread's sandbox. A Flue session creates its sandbox
 * before any tool runs; without one in this isolate, only dx's own
 * credentials are masked.
 */
export const threadEnvironmentMasker = async (
  threadId: string,
): Promise<SecretMasker> =>
  (await threadMaskers.get(threadId)?.()) ?? credentialsOnly;

/**
 * Refuses a write of text that holds a hidden secret's marker: the file
 * held the secret where the agent read the marker, so writing the marker
 * back would replace the secret. `read` says the text came from the file
 * itself, as an edit's does.
 */
export const refuseSecretMarkerWrite = async (
  sandbox: Sandbox,
  path: string,
  content: string,
  read: boolean,
) => {
  if (!content.includes("[REDACTED:")) return;
  const { markers } = await environmentMaskerOf(sandbox);
  for (const { name, marker, credential } of markers) {
    if (!content.includes(marker)) continue;
    const what = credential ? "a credential" : `the hidden secret ${name}`;
    throw new Error(
      read
        ? `${path} holds ${what}, which dx shows as ${marker}. Do not write it into a file. Edit the file with a shell command that leaves that line alone, or ask the user to edit it.`
        : `${marker} stands for ${what}. Do not write it into a file.${credential ? "" : ` To use the secret, read $${name} from the environment.`}`,
    );
  }
};

const maskFailure = (cause: unknown, masker: SecretMasker) => {
  if (cause instanceof Error && cause.name === "AbortError") return cause;
  const error = new Error(
    masker.mask(cause instanceof Error ? cause.message : String(cause)),
  );
  if (cause instanceof Error) error.name = cause.name;
  return error;
};

const withRedactedFailure = async <A>(
  masker: SecretMasker,
  operation: () => Promise<A>,
) => {
  try {
    return await operation();
  } catch (cause) {
    throw maskFailure(cause, masker);
  }
};

/** A tool's JSON result with every string in it masked. */
const maskValue = (value: unknown, masker: SecretMasker): unknown => {
  if (typeof value === "string") return masker.mask(value);
  if (value instanceof Uint8Array) return masker.maskBytes(value);
  if (Array.isArray(value)) return value.map((item) => maskValue(item, masker));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        masker.mask(key),
        maskValue(item, masker),
      ]),
    );
  return value;
};

/**
 * The tool's own error with its message and stack masked, so Flue still
 * recognizes its class; one that holds no secret is unchanged.
 */
const maskToolFailure = (cause: unknown, masker: SecretMasker) => {
  if (!(cause instanceof Error)) return new Error(masker.mask(String(cause)));
  const message = masker.mask(cause.message);
  if (message === cause.message) return cause;
  cause.message = message;
  if (cause.stack !== undefined) cause.stack = masker.mask(cause.stack);
  return cause;
};

/**
 * A tool whose result and failure are masked as the Thread's sandbox masks
 * its reads. For dx's tools that never touch the Orb, such as code_exec,
 * plugins, and the Thread tools, which can still return a secret.
 */
export const withMaskedToolResults = <
  T extends { readonly run: (context: never) => unknown },
>(
  tool: T,
  masker: () => Promise<SecretMasker>,
): T =>
  ({
    ...tool,
    run: async (context: never) => {
      let result: unknown;
      try {
        result = await tool.run(context);
      } catch (cause) {
        throw maskToolFailure(cause, await masker());
      }
      return maskValue(result, await masker());
    },
  }) as T;

/**
 * The environment for one decorated sandbox. Without a revision source every
 * operation resolves it again; with one, the resolved values are kept and
 * resolved again only when the revision changed.
 */
const environmentFor = (
  resolve: () => Promise<ExecutionEnvironmentSnapshot>,
  revision: (() => Promise<ExecutionEnvironmentRevision>) | undefined,
) => {
  let kept:
    | {
        readonly admitted: Admitted;
        readonly revision: ExecutionEnvironmentRevision;
        checkedAt: number;
      }
    | undefined;
  /** The check other operations share, so a burst of reads makes one. */
  let checking: Promise<Admitted> | undefined;
  const check = async (command: boolean): Promise<Admitted> => {
    const current = kept;
    if (current !== undefined) {
      const latest = await revision?.();
      if (
        latest !== undefined &&
        executionEnvironmentRevisionsEqual(latest, current.revision)
      ) {
        current.checkedAt = Date.now();
        return current.admitted;
      }
    }
    let snapshot = await resolve();
    // A first command also checks what it resolved, which may have been read
    // before the command was authorized (an activation's early read), and
    // reads again when anything changed since.
    if (command && current === undefined && revision !== undefined) {
      const latest = await revision();
      if (!executionEnvironmentRevisionsEqual(latest, snapshot.revision))
        snapshot = await resolve();
    }
    const admitted = admittedValues(snapshot);
    kept = { admitted, revision: snapshot.revision, checkedAt: Date.now() };
    return admitted;
  };
  return (operation: "command" | "other"): Promise<Admitted> => {
    if (revision === undefined) return resolve().then(admittedValues);
    if (operation === "command") return check(true);
    if (
      kept !== undefined &&
      Date.now() - kept.checkedAt < ENVIRONMENT_REVALIDATE_MS
    )
      return Promise.resolve(kept.admitted);
    checking ??= check(false).finally(() => {
      checking = undefined;
    });
    return checking;
  };
};

const decorateSandbox = (
  sandbox: Sandbox,
  resolve: () => Promise<ExecutionEnvironmentSnapshot>,
  revision?: () => Promise<ExecutionEnvironmentRevision>,
): Sandbox => {
  const environment = environmentFor(resolve, revision);
  const snapshotWorkspaceContext = sandbox.snapshotWorkspaceContext;
  const decorated: WithEnvironmentMasker = {
    [environmentMasker]: async () => (await environment("other")).masker,
    cwd: sandbox.cwd,
    resolvePath: (path) => sandbox.resolvePath(path),
    ...(snapshotWorkspaceContext === undefined
      ? {}
      : {
          snapshotWorkspaceContext: async (root: string) => {
            const admitted = await environment("other");
            const result = await withRedactedFailure(admitted.masker, () =>
              snapshotWorkspaceContext(root),
            );
            if ("kind" in result) return result;
            return {
              instructionFiles: Object.fromEntries(
                Object.entries(result.instructionFiles).map(
                  ([name, content]) => [name, admitted.masker.mask(content)],
                ),
              ),
              skillFiles: result.skillFiles.map((file) =>
                file.kind === "file"
                  ? {
                      ...file,
                      directoryName: admitted.masker.mask(file.directoryName),
                      content: admitted.masker.mask(file.content),
                    }
                  : {
                      ...file,
                      directoryName: admitted.masker.mask(file.directoryName),
                      errorMessage: admitted.masker.mask(file.errorMessage),
                    },
              ),
              ...(result.directoryListing === undefined
                ? {}
                : {
                    directoryListing: result.directoryListing.map((entry) =>
                      admitted.masker.mask(entry),
                    ),
                  }),
            };
          },
        }),
    exec: async (command, options) => {
      const admitted = await environment("command");
      const result = await withRedactedFailure(admitted.masker, () =>
        sandbox.exec(command, {
          ...options,
          env: { ...admitted.env, ...options?.env },
        }),
      );
      return {
        ...result,
        stdout: admitted.masker.mask(result.stdout),
        stderr: admitted.masker.mask(result.stderr),
      };
    },
    readFile: async (path) => {
      const admitted = await environment("other");
      const contents = await withRedactedFailure(admitted.masker, () =>
        sandbox.readFile(path),
      );
      return admitted.masker.mask(contents);
    },
    readFileBuffer: async (path) => {
      const admitted = await environment("other");
      const contents = await withRedactedFailure(admitted.masker, () =>
        sandbox.readFileBuffer(path),
      );
      return admitted.masker.maskBytes(contents);
    },
    readdir: async (path) => {
      const admitted = await environment("other");
      const entries = await withRedactedFailure(admitted.masker, () =>
        sandbox.readdir(path),
      );
      return entries.map((entry) => admitted.masker.mask(entry));
    },
    writeFile: async (path, content) => {
      const admitted = await environment("other");
      return withRedactedFailure(admitted.masker, () =>
        sandbox.writeFile(path, content),
      );
    },
    stat: async (path) => {
      const admitted = await environment("other");
      return withRedactedFailure(admitted.masker, () => sandbox.stat(path));
    },
    exists: async (path) => {
      const admitted = await environment("other");
      return withRedactedFailure(admitted.masker, () => sandbox.exists(path));
    },
    mkdir: async (path, options) => {
      const admitted = await environment("other");
      return withRedactedFailure(admitted.masker, () =>
        sandbox.mkdir(path, options),
      );
    },
    rm: async (path, options) => {
      const admitted = await environment("other");
      return withRedactedFailure(admitted.masker, () =>
        sandbox.rm(path, options),
      );
    },
  };
  return decorated;
};

export const withExecutionEnvironment = (
  factory: SandboxFactory,
  resolve: (id: string) => Promise<ExecutionEnvironmentSnapshot>,
  revision?: (id: string) => Promise<ExecutionEnvironmentRevision>,
): SandboxFactory => ({
  createSandbox: async ({ id }) => {
    const decorated = decorateSandbox(
      await factory.createSandbox({ id }),
      () => resolve(id),
      revision === undefined ? undefined : () => revision(id),
    );
    // Most recent last; an isolate keeps at most 256 Threads' maskers.
    threadMaskers.delete(id);
    threadMaskers.set(id, () => environmentMaskerOf(decorated));
    if (threadMaskers.size > 256)
      threadMaskers.delete(threadMaskers.keys().next().value ?? id);
    return decorated;
  },
  ...(factory.tools === undefined ? {} : { tools: factory.tools }),
});
