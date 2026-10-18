import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { Redacted } from "effect";
import {
  type ExecutionEnvironmentRevision,
  type ExecutionEnvironmentSnapshot,
  executionEnvironmentRevisionsEqual,
} from "./execution.js";

// Process environments cannot contain NUL, so this delimiter cannot contain or
// join surrounding output into any admitted secret value.
export const ENVIRONMENT_SECRET_REDACTION = "\0";

/**
 * How long operations other than commands reuse the resolved environment
 * before checking its revision again. A command checks it every time, so an
 * edit reaches the next command at once and every other operation, such as
 * the reads Claude Code polls a run with, within this long.
 */
export const ENVIRONMENT_REVALIDATE_MS = 5_000;

/**
 * A secret as JSON text carries it, once and nested: Claude Code's
 * stream-json escapes a `"`, `\`, or control character in a tool result,
 * and a streamed tool input is JSON inside a JSON string.
 */
const jsonForms = (secret: string) => {
  const once = JSON.stringify(secret).slice(1, -1);
  return [secret, once, JSON.stringify(once).slice(1, -1)];
};

const admittedValues = (snapshot: ExecutionEnvironmentSnapshot) => {
  const env: Record<string, string> = {};
  const secrets = new Set<string>();
  for (const value of snapshot.values) {
    const plaintext = Redacted.value(value.value);
    env[value.name] = plaintext;
    if (value.kind === "secret")
      for (const form of jsonForms(plaintext)) secrets.add(form);
  }
  const sorted = [...secrets].sort((left, right) => right.length - left.length);
  const encoder = new TextEncoder();
  return {
    env,
    secrets: sorted,
    secretBytes: sorted.map((secret) => encoder.encode(secret)),
  };
};

type Admitted = ReturnType<typeof admittedValues>;

const redactText = (value: string, secrets: ReadonlyArray<string>) => {
  let redacted = "";
  for (let offset = 0; offset < value.length; ) {
    const matched = secrets.find((secret) => value.startsWith(secret, offset));
    if (matched === undefined) {
      redacted += value.charAt(offset);
      offset += 1;
    } else {
      redacted += ENVIRONMENT_SECRET_REDACTION;
      offset += matched.length;
    }
  }
  return redacted;
};

const matchesAt = (
  input: Uint8Array,
  candidate: Uint8Array,
  offset: number,
) => {
  if (offset + candidate.length > input.length) return false;
  for (let index = 0; index < candidate.length; index += 1) {
    if (input[offset + index] !== candidate[index]) return false;
  }
  return true;
};

const replacement = new TextEncoder().encode(ENVIRONMENT_SECRET_REDACTION);

const redactBytes = (
  value: Uint8Array,
  candidates: ReadonlyArray<Uint8Array>,
) => {
  const output: Array<number> = [];
  for (let offset = 0; offset < value.length; ) {
    const matched = candidates.find((candidate) =>
      matchesAt(value, candidate, offset),
    );
    if (matched === undefined) {
      output.push(value[offset] as number);
      offset += 1;
    } else {
      output.push(...replacement);
      offset += matched.length;
    }
  }
  return Uint8Array.from(output);
};

const redactFailure = (cause: unknown, secrets: ReadonlyArray<string>) => {
  if (cause instanceof Error && cause.name === "AbortError") return cause;
  const error = new Error(
    redactText(cause instanceof Error ? cause.message : String(cause), secrets),
  );
  if (cause instanceof Error) error.name = cause.name;
  return error;
};

const withRedactedFailure = async <A>(
  secrets: ReadonlyArray<string>,
  operation: () => Promise<A>,
) => {
  try {
    return await operation();
  } catch (cause) {
    throw redactFailure(cause, secrets);
  }
};

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
  const check = async (): Promise<Admitted> => {
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
    const snapshot = await resolve();
    const admitted = admittedValues(snapshot);
    kept = { admitted, revision: snapshot.revision, checkedAt: Date.now() };
    return admitted;
  };
  return (operation: "command" | "other"): Promise<Admitted> => {
    if (revision === undefined) return resolve().then(admittedValues);
    if (operation === "command") return check();
    if (
      kept !== undefined &&
      Date.now() - kept.checkedAt < ENVIRONMENT_REVALIDATE_MS
    )
      return Promise.resolve(kept.admitted);
    checking ??= check().finally(() => {
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
  return {
    cwd: sandbox.cwd,
    resolvePath: (path) => sandbox.resolvePath(path),
    ...(snapshotWorkspaceContext === undefined
      ? {}
      : {
          snapshotWorkspaceContext: async (root: string) => {
            const admitted = await environment("other");
            const result = await withRedactedFailure(admitted.secrets, () =>
              snapshotWorkspaceContext(root),
            );
            if ("kind" in result) return result;
            return {
              instructionFiles: Object.fromEntries(
                Object.entries(result.instructionFiles).map(
                  ([name, content]) => [
                    name,
                    redactText(content, admitted.secrets),
                  ],
                ),
              ),
              skillFiles: result.skillFiles.map((file) =>
                file.kind === "file"
                  ? {
                      ...file,
                      directoryName: redactText(
                        file.directoryName,
                        admitted.secrets,
                      ),
                      content: redactText(file.content, admitted.secrets),
                    }
                  : {
                      ...file,
                      directoryName: redactText(
                        file.directoryName,
                        admitted.secrets,
                      ),
                      errorMessage: redactText(
                        file.errorMessage,
                        admitted.secrets,
                      ),
                    },
              ),
              ...(result.directoryListing === undefined
                ? {}
                : {
                    directoryListing: result.directoryListing.map((entry) =>
                      redactText(entry, admitted.secrets),
                    ),
                  }),
            };
          },
        }),
    exec: async (command, options) => {
      const admitted = await environment("command");
      const result = await withRedactedFailure(admitted.secrets, () =>
        sandbox.exec(command, {
          ...options,
          env: { ...admitted.env, ...options?.env },
        }),
      );
      return {
        ...result,
        stdout: redactText(result.stdout, admitted.secrets),
        stderr: redactText(result.stderr, admitted.secrets),
      };
    },
    readFile: async (path) => {
      const admitted = await environment("other");
      const contents = await withRedactedFailure(admitted.secrets, () =>
        sandbox.readFile(path),
      );
      return redactText(contents, admitted.secrets);
    },
    readFileBuffer: async (path) => {
      const admitted = await environment("other");
      const contents = await withRedactedFailure(admitted.secrets, () =>
        sandbox.readFileBuffer(path),
      );
      return redactBytes(contents, admitted.secretBytes);
    },
    readdir: async (path) => {
      const admitted = await environment("other");
      const entries = await withRedactedFailure(admitted.secrets, () =>
        sandbox.readdir(path),
      );
      return entries.map((entry) => redactText(entry, admitted.secrets));
    },
    writeFile: async (path, content) => {
      const admitted = await environment("other");
      return withRedactedFailure(admitted.secrets, () =>
        sandbox.writeFile(path, content),
      );
    },
    stat: async (path) => {
      const admitted = await environment("other");
      return withRedactedFailure(admitted.secrets, () => sandbox.stat(path));
    },
    exists: async (path) => {
      const admitted = await environment("other");
      return withRedactedFailure(admitted.secrets, () => sandbox.exists(path));
    },
    mkdir: async (path, options) => {
      const admitted = await environment("other");
      return withRedactedFailure(admitted.secrets, () =>
        sandbox.mkdir(path, options),
      );
    },
    rm: async (path, options) => {
      const admitted = await environment("other");
      return withRedactedFailure(admitted.secrets, () =>
        sandbox.rm(path, options),
      );
    },
  };
};

export const withExecutionEnvironment = (
  factory: SandboxFactory,
  resolve: (id: string) => Promise<ExecutionEnvironmentSnapshot>,
  revision?: (id: string) => Promise<ExecutionEnvironmentRevision>,
): SandboxFactory => ({
  createSandbox: async ({ id }) =>
    decorateSandbox(
      await factory.createSandbox({ id }),
      () => resolve(id),
      revision === undefined ? undefined : () => revision(id),
    ),
  ...(factory.tools === undefined ? {} : { tools: factory.tools }),
});
