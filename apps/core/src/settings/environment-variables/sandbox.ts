import { isHiddenEnvironmentValue } from "@dx/domain";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { Redacted } from "effect";
import {
  type ExecutionEnvironmentRevision,
  type ExecutionEnvironmentSnapshot,
  executionEnvironmentRevisionsEqual,
} from "./execution.js";

/**
 * What reads show in place of the secret a variable holds. It has no quote
 * or backslash, so it stays valid inside a JSON string.
 */
export const environmentSecretMarker = (name: string) => `[REDACTED:${name}]`;

/** One form of a hidden secret's value, and the marker shown in its place. */
export interface EnvironmentSecret {
  readonly name: string;
  readonly value: string;
  readonly marker: string;
}

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

/**
 * Every value reaches the process; reads redact only hidden secrets, since
 * hiding a short or common one would garble unrelated words. Where names
 * share a value, the first by name marks it.
 */
const admittedValues = (snapshot: ExecutionEnvironmentSnapshot) => {
  const env: Record<string, string> = {};
  const names = new Map<string, string>();
  const byName = [...snapshot.values].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const value of byName) {
    const plaintext = Redacted.value(value.value);
    env[value.name] = plaintext;
    if (isHiddenEnvironmentValue(value.kind, plaintext))
      for (const form of jsonForms(plaintext))
        if (!names.has(form)) names.set(form, value.name);
  }
  const secrets: ReadonlyArray<EnvironmentSecret> = [...names]
    .map(([value, name]) => ({
      name,
      value,
      marker: environmentSecretMarker(name),
    }))
    .sort((left, right) => right.value.length - left.value.length);
  const encoder = new TextEncoder();
  return {
    env,
    secrets,
    secretBytes: secrets.map((secret) => ({
      value: encoder.encode(secret.value),
      marker: encoder.encode(secret.marker),
    })),
  };
};

type Admitted = ReturnType<typeof admittedValues>;

/**
 * Redacts text that arrives in fragments, such as a streamed message, where
 * each fragment was read and redacted on its own and a secret can span two.
 * `held` is the tail an earlier call kept back, and `secrets` are longest
 * first, as `environmentSecretsOf` returns them. Returns the redacted text
 * that is final and the tail that could still begin a secret; with `final`,
 * nothing is held back.
 */
export const redactFragment = (
  held: string,
  fragment: string,
  secrets: ReadonlyArray<EnvironmentSecret>,
  final = false,
): { readonly released: string; readonly held: string } => {
  const value = held + fragment;
  if (secrets.length === 0) return { released: value, held: "" };
  const longest = Math.max(...secrets.map((secret) => secret.value.length));
  let released = "";
  for (let offset = 0; offset < value.length; ) {
    const rest = value.length - offset;
    if (
      !final &&
      rest < longest &&
      secrets.some(
        (secret) =>
          secret.value.length > rest &&
          secret.value.startsWith(value.slice(offset)),
      )
    )
      return { released, held: value.slice(offset) };
    const matched = secrets.find((secret) =>
      value.startsWith(secret.value, offset),
    );
    if (matched === undefined) {
      released += value.charAt(offset);
      offset += 1;
    } else {
      released += matched.marker;
      offset += matched.value.length;
    }
  }
  return { released, held: "" };
};

const redactText = (value: string, secrets: ReadonlyArray<EnvironmentSecret>) =>
  redactFragment("", value, secrets, true).released;

const environmentSecrets = Symbol("dx.environmentSecrets");

type WithEnvironmentSecrets = Sandbox & {
  readonly [environmentSecrets]?: () => Promise<
    ReadonlyArray<EnvironmentSecret>
  >;
};

/**
 * The values a decorated sandbox's reads redact, in every form they redact
 * them, longest first; none for a sandbox without an environment. Wrappers
 * that spread the sandbox keep it.
 */
export const environmentSecretsOf = async (
  sandbox: Sandbox,
): Promise<ReadonlyArray<EnvironmentSecret>> =>
  (await (sandbox as WithEnvironmentSecrets)[environmentSecrets]?.()) ?? [];

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
  for (const { name, marker } of await environmentSecretsOf(sandbox)) {
    if (!content.includes(marker)) continue;
    throw new Error(
      read
        ? `${path} holds the hidden secret ${name}, which dx shows as ${marker}. Do not write it into a file. Edit the file with a shell command that leaves that line alone, or ask the user to edit it.`
        : `${marker} stands for the hidden secret ${name}. Do not write it into a file. To use the secret, read $${name} from the environment.`,
    );
  }
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

const redactBytes = (
  value: Uint8Array,
  candidates: ReadonlyArray<{
    readonly value: Uint8Array;
    readonly marker: Uint8Array;
  }>,
) => {
  const output: Array<number> = [];
  for (let offset = 0; offset < value.length; ) {
    const matched = candidates.find((candidate) =>
      matchesAt(value, candidate.value, offset),
    );
    if (matched === undefined) {
      output.push(value[offset] as number);
      offset += 1;
    } else {
      output.push(...matched.marker);
      offset += matched.value.length;
    }
  }
  return Uint8Array.from(output);
};

const redactFailure = (
  cause: unknown,
  secrets: ReadonlyArray<EnvironmentSecret>,
) => {
  if (cause instanceof Error && cause.name === "AbortError") return cause;
  const error = new Error(
    redactText(cause instanceof Error ? cause.message : String(cause), secrets),
  );
  if (cause instanceof Error) error.name = cause.name;
  return error;
};

const withRedactedFailure = async <A>(
  secrets: ReadonlyArray<EnvironmentSecret>,
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
  const decorated: WithEnvironmentSecrets = {
    [environmentSecrets]: async () => (await environment("other")).secrets,
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
  return decorated;
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
