import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { Redacted } from "effect";
import type { ExecutionEnvironmentSnapshot } from "./execution.js";

// Process environments cannot contain NUL, so this delimiter cannot contain or
// join surrounding output into any admitted secret value.
export const ENVIRONMENT_SECRET_REDACTION = "\0";

const admittedValues = (snapshot: ExecutionEnvironmentSnapshot) => {
  const env: Record<string, string> = {};
  const secrets = new Set<string>();
  for (const value of snapshot.values) {
    const plaintext = Redacted.value(value.value);
    env[value.name] = plaintext;
    if (value.kind === "secret") secrets.add(plaintext);
  }
  return {
    env,
    secrets: [...secrets].sort((left, right) => right.length - left.length),
  };
};

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

const redactBytes = (value: Uint8Array, secrets: ReadonlyArray<string>) => {
  const encoder = new TextEncoder();
  const replacement = encoder.encode(ENVIRONMENT_SECRET_REDACTION);
  const candidates = secrets.map((secret) => encoder.encode(secret));
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

const decorateSandbox = (
  sandbox: Sandbox,
  resolve: () => Promise<ExecutionEnvironmentSnapshot>,
): Sandbox => {
  const snapshotWorkspaceContext = sandbox.snapshotWorkspaceContext;
  return {
    cwd: sandbox.cwd,
    resolvePath: (path) => sandbox.resolvePath(path),
    ...(snapshotWorkspaceContext === undefined
      ? {}
      : {
          snapshotWorkspaceContext: async (root: string) => {
            const admitted = admittedValues(await resolve());
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
      const admitted = admittedValues(await resolve());
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
      const admitted = admittedValues(await resolve());
      const contents = await withRedactedFailure(admitted.secrets, () =>
        sandbox.readFile(path),
      );
      return redactText(contents, admitted.secrets);
    },
    readFileBuffer: async (path) => {
      const admitted = admittedValues(await resolve());
      const contents = await withRedactedFailure(admitted.secrets, () =>
        sandbox.readFileBuffer(path),
      );
      return redactBytes(contents, admitted.secrets);
    },
    readdir: async (path) => {
      const admitted = admittedValues(await resolve());
      const entries = await withRedactedFailure(admitted.secrets, () =>
        sandbox.readdir(path),
      );
      return entries.map((entry) => redactText(entry, admitted.secrets));
    },
    writeFile: async (path, content) => {
      const admitted = admittedValues(await resolve());
      return withRedactedFailure(admitted.secrets, () =>
        sandbox.writeFile(path, content),
      );
    },
    stat: async (path) => {
      const admitted = admittedValues(await resolve());
      return withRedactedFailure(admitted.secrets, () => sandbox.stat(path));
    },
    exists: async (path) => {
      const admitted = admittedValues(await resolve());
      return withRedactedFailure(admitted.secrets, () => sandbox.exists(path));
    },
    mkdir: async (path, options) => {
      const admitted = admittedValues(await resolve());
      return withRedactedFailure(admitted.secrets, () =>
        sandbox.mkdir(path, options),
      );
    },
    rm: async (path, options) => {
      const admitted = admittedValues(await resolve());
      return withRedactedFailure(admitted.secrets, () =>
        sandbox.rm(path, options),
      );
    },
  };
};

export const withExecutionEnvironment = (
  factory: SandboxFactory,
  resolve: (id: string) => Promise<ExecutionEnvironmentSnapshot>,
): SandboxFactory => ({
  createSandbox: async ({ id }) =>
    decorateSandbox(await factory.createSandbox({ id }), () => resolve(id)),
  ...(factory.tools === undefined ? {} : { tools: factory.tools }),
});
