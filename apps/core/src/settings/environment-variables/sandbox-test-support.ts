// Shared by the sandbox masking tests, which are split across files so the
// slow shell-read sweeps run on separate workers.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configReferenceFor,
  EnvironmentVariableId,
  EnvironmentVariableName,
} from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { Redacted, Schema } from "effect";
import { createShellTools } from "../../plugins/execution/shell/tools.js";
import type {
  ExecutionEnvironmentRevision,
  ExecutionEnvironmentSnapshot,
} from "./execution.js";
import { withExecutionEnvironment } from "./sandbox.js";

/** What dx shows in place of the secret this variable holds. */
export const marker = (name: string) => `[REDACTED:${name}]`;

export const temporaryDirectories: Array<string> = [];

export const value = (
  rawName: string,
  kind: "secret" | "variable",
  plaintext: string,
) => {
  const name = Schema.decodeUnknownSync(EnvironmentVariableName)(rawName);
  const id = Schema.decodeUnknownSync(EnvironmentVariableId)(
    `env_${rawName.toLowerCase()}`,
  );
  return {
    reference: configReferenceFor(id),
    name,
    kind,
    value: Redacted.make(plaintext),
    source: "personal" as const,
  };
};

export const snapshot = (
  values: ExecutionEnvironmentSnapshot["values"],
  personalRevision = 0,
): ExecutionEnvironmentSnapshot => ({
  revision: {
    personal: { targetId: "user", revision: personalRevision },
    project: { targetId: "project", revision: 0 },
    workspace: { targetId: null, revision: 0 },
  },
  values,
});

export const localSandbox = async (
  resolve: (id: string) => Promise<ExecutionEnvironmentSnapshot>,
  revision?: (id: string) => Promise<ExecutionEnvironmentRevision>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "dx-environment-test-"));
  temporaryDirectories.push(directory);
  const factory = withExecutionEnvironment(
    local({ cwd: directory }),
    resolve,
    revision,
  );
  return {
    directory,
    factory,
    sandbox: await factory.createSandbox({ id: "thread" }),
  };
};

/**
 * A sandbox whose saved values never change, with a revision source as
 * production's (activation.ts): the masker is built once, not on every read.
 * Building it for the long secrets below cost about half of each read.
 */
export const steadySandbox = (saved: () => ExecutionEnvironmentSnapshot) =>
  localSandbox(
    async () => saved(),
    async () => saved().revision,
  );

/** Whether any 6 characters of `secret` decode out of a base64 run. */
export const base64Reveals = (output: string, secret: string) => {
  const runs = output
    .split(/\[REDACTED:[A-Z_]+\]/)
    .flatMap((part) => part.match(/[A-Za-z0-9+/_-]{4,}/g) ?? []);
  for (const run of runs)
    for (let offset = 0; offset < 4; offset += 1) {
      const body = run.slice(offset);
      const usable = body.slice(0, body.length - (body.length % 4));
      const decoded = Buffer.from(
        usable.replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString("latin1");
      for (let start = 0; start + 6 <= secret.length; start += 1)
        if (decoded.includes(secret.slice(start, start + 6))) return true;
    }
  return false;
};

export type Read = { readonly output: string; readonly running: boolean };

export const outputOf = (text: string) =>
  /<output>([\s\S]*)<\/output>/.exec(text)?.[1] ?? "";

/**
 * Runs one command through shell_command and shell_command_status that
 * prints `parts` one at a time, each after the test lets it, so every read
 * ends exactly where a part does. Returns each read's output. `beforeRead`
 * runs before each read after the first, to change what is saved.
 */
export const streamed = async (
  sandbox: Sandbox,
  parts: ReadonlyArray<Uint8Array | string>,
  beforeRead?: (index: number) => void,
): Promise<Read[]> => {
  const directory = await mkdtemp(join(tmpdir(), "dx-hold-test-"));
  temporaryDirectories.push(directory);
  await Promise.all(
    parts.map((part, index) =>
      writeFile(join(directory, `part${index}`), part),
    ),
  );
  const tools = createShellTools(
    {
      ...sandbox,
      exec: (command, options) =>
        sandbox.exec(command, {
          ...options,
          env: { HOME: directory, ...options?.env },
        }),
    },
    { defaultWorkdir: directory },
  );
  const call = async (index: number, params: Record<string, unknown>) => {
    const result = await tools[index]?.execute("test", params);
    const text = (result?.content ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    const details = result?.details as { pid: number; running: boolean };
    return { text, details };
  };
  const command = parts
    .map(
      (_, index) =>
        `${index === 0 ? "" : `while [ ! -f go${index} ]; do sleep 0.01; done; `}cat part${index}`,
    )
    .join("; ");
  const reads: Read[] = [];
  const started = await call(0, { command, timeout_ms: 300 });
  reads.push({
    output: outputOf(started.text),
    running: started.details.running,
  });
  for (let index = 1; index < parts.length; index += 1) {
    beforeRead?.(index);
    await writeFile(join(directory, `go${index}`), "");
    const last = index === parts.length - 1;
    const read = await call(1, {
      pid: started.details.pid,
      timeout_ms: last ? 10_000 : 300,
    });
    reads.push({
      output: outputOf(read.text),
      running: read.details.running,
    });
  }
  // A read after the command ended and was flushed shows nothing again.
  const after = await call(1, { pid: started.details.pid, timeout_ms: 0 });
  reads.push({
    output: outputOf(after.text),
    running: after.details.running,
  });
  return reads;
};

/** Each way to cut `whole` in two, with the first part ending at byte `cut`. */
export const everyCut = (whole: string) => {
  const bytes = Buffer.from(whole);
  return Array.from({ length: bytes.length + 1 }, (_, cut) => [
    bytes.subarray(0, cut),
    bytes.subarray(cut),
  ]);
};

/** Runs `count` jobs, a few at a time. */
export const inBatches = async <A>(
  count: number,
  job: (index: number) => Promise<A>,
) => {
  const results: A[] = [];
  for (let start = 0; start < count; start += 8)
    results.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(8, count - start) }, (_, offset) =>
          job(start + offset),
        ),
      )),
    );
  return results;
};
