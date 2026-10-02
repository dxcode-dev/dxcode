import { env } from "cloudflare:workers";
import {
  type SourceOperationRequestType,
  SourceWorkspaceRepository,
  ThreadId,
} from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { Effect, Layer, Schema } from "effect";
import {
  executeTrustedLocalCommand,
  executeTrustedSourceCommand,
} from "../execution/e2b/source-command-admission.js";
import type { Bindings } from "../http/types.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import {
  type SourceMutationIntent,
  SourceMutationRejected,
  SourceMutationRepositoryD1,
  SourceMutationService,
  SourceMutationServiceLive,
  type SourceReconciliation,
} from "./operations.js";
import { SourceWorkspaceRepositoryD1 } from "./source-workspace-repository-d1.js";

export class SourceProviderUnavailable extends Schema.TaggedError<SourceProviderUnavailable>()(
  "SourceProviderUnavailable",
  {},
) {}

export class SourceProviderRateLimited extends Schema.TaggedError<SourceProviderRateLimited>()(
  "SourceProviderRateLimited",
  {},
) {}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

type SourceCommandExecutor = (
  sandbox: Sandbox,
  command: string,
  request: SourceOperationRequestType,
  options: Parameters<Sandbox["exec"]>[1],
) => ReturnType<Sandbox["exec"]>;

export const isProviderRateLimited = (stderr: string) =>
  /(?:rate limit|secondary rate|abuse detection|abuse rate|too many requests|retry-after|x-ratelimit)/i.test(
    stderr,
  );

export const isDefiniteRemoteMutationRejection = (stderr: string) =>
  !isProviderRateLimited(stderr) &&
  /(?:protected branch|repository rule|non-fast-forward|remote rejected|permission to .+ denied|resource not accessible by integration|refusing to allow a github app|\b(?:403|422)\b)/i.test(
    stderr,
  );

const run = async (
  execute: SourceCommandExecutor,
  sandbox: Sandbox,
  command: string,
  request: SourceOperationRequestType,
  mutation = false,
  options?: Parameters<Sandbox["exec"]>[1],
) => {
  const result = await execute(sandbox, command, request, {
    ...options,
    cwd: sandbox.cwd,
    timeoutMs: 120_000,
  }).catch((cause) => {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "name" in cause &&
      cause.name === "AbortError"
    )
      throw cause;
    throw new SourceProviderUnavailable();
  });
  if (result.exitCode !== 0) {
    if (isProviderRateLimited(result.stderr))
      throw new SourceProviderRateLimited();
    if (mutation && isDefiniteRemoteMutationRejection(result.stderr))
      throw new SourceMutationRejected();
    throw new SourceProviderUnavailable();
  }
  if (result.stdout.length > 65_536)
    throw new Error(
      "Source provider response exceeded the bounded result size.",
    );
  return result.stdout.trim();
};

const hash = async (value: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const shellPushIdempotencyKey = async (
  threadId: string,
  branch: string,
  expectedRemoteSha: string | undefined,
  intendedSha: string,
) =>
  `shell-push:${await hash(
    `${threadId}\0${branch}\0${expectedRemoteSha ?? "absent"}\0${intendedSha}`,
  )}`;

const sourceFor = async (bindings: Bindings, threadId: string) => {
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  const record = await Effect.runPromise(
    Effect.gen(function* () {
      const id = yield* Schema.decodeUnknownEffect(ThreadId)(threadId);
      return yield* (yield* SourceWorkspaceRepository).findByThreadId(id);
    }).pipe(Effect.provide(SourceWorkspaceRepositoryD1(db))),
  );
  if (record.snapshot === undefined || record.authority === undefined)
    throw new Error("This Thread has no connected source authority.");
  return {
    db,
    record,
    snapshot: record.snapshot,
    authority: record.authority,
  };
};

const mutate = async <A>(input: {
  readonly bindings: Bindings;
  readonly threadId: string;
  readonly idempotencyKey: string;
  readonly kind: SourceMutationIntent["kind"];
  readonly inputIdentity: string;
  readonly expectedRemoteSha?: string;
  readonly intendedSha?: string;
  readonly reconcile: () => Promise<SourceReconciliation>;
  readonly execute: () => Promise<{
    readonly value: A;
    readonly providerId?: string;
  }>;
}) => {
  const source = await sourceFor(input.bindings, input.threadId);
  const serviceLayer = SourceMutationServiceLive.pipe(
    Layer.provide(SourceMutationRepositoryD1(source.db)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SourceMutationService).execute({
        intent: {
          idempotencyKey: input.idempotencyKey,
          actorUserId: source.record.actorUserId,
          projectId: source.snapshot.projectId,
          threadId: input.threadId,
          provider: source.snapshot.provider,
          providerRepositoryId: source.authority.providerRepositoryId,
          kind: input.kind,
          ...(input.expectedRemoteSha === undefined
            ? {}
            : { expectedRemoteSha: input.expectedRemoteSha }),
          ...(input.intendedSha === undefined
            ? {}
            : { intendedSha: input.intendedSha }),
          inputIdentity: input.inputIdentity,
        },
        reconcile: () =>
          Effect.tryPromise({
            try: input.reconcile,
            catch: () => new SourceProviderUnavailable(),
          }),
        mutate: () =>
          Effect.tryPromise({
            try: input.execute,
            catch: (cause) =>
              cause instanceof SourceMutationRejected
                ? cause
                : cause instanceof SourceProviderRateLimited
                  ? cause
                  : new SourceProviderUnavailable(),
          }),
      });
    }).pipe(Effect.provide(serviceLayer)),
  );
};

const remoteSha = async (
  execute: SourceCommandExecutor,
  sandbox: Sandbox,
  branch: string,
  options?: Parameters<Sandbox["exec"]>[1],
) => {
  const output = await run(
    execute,
    sandbox,
    `git ls-remote --refs origin ${quote(`refs/heads/${branch}`)}`,
    { operation: "repository-read", invocationSource: "agent-command" },
    false,
    options,
  );
  if (output === "") return undefined;
  const sha = output.split(/\s+/)[0];
  return sha !== undefined && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
};

export interface SourceToolMutationInput<A> {
  readonly threadId: string;
  readonly idempotencyKey: string;
  readonly kind: SourceMutationIntent["kind"];
  readonly inputIdentity: string;
  readonly expectedRemoteSha?: string;
  readonly intendedSha?: string;
  readonly reconcile: () => Promise<SourceReconciliation>;
  readonly execute: () => Promise<{
    readonly value: A;
    readonly providerId?: string;
  }>;
}

export interface SourceControlToolDependencies {
  readonly bindings?: Bindings;
  readonly providerForThread?: (
    threadId: string,
  ) => Promise<"github" | "bitbucket">;
  readonly execute?: SourceCommandExecutor;
  readonly performMutation?: <A>(
    input: SourceToolMutationInput<A>,
  ) => Promise<A>;
}

export interface ExecuteSourcePushInput {
  readonly threadId: string;
  readonly sandbox: Sandbox;
  readonly branch: string;
  readonly idempotencyKey?: string;
  readonly expectedHead?: string;
  readonly expectedRemoteHead?: string | null;
  readonly signal?: AbortSignal;
}

export class SourcePushHeadChanged extends Schema.TaggedError<SourcePushHeadChanged>()(
  "SourcePushHeadChanged",
  {},
) {}

export class SourcePushRemoteHeadChanged extends Schema.TaggedError<SourcePushRemoteHeadChanged>()(
  "SourcePushRemoteHeadChanged",
  {},
) {}

const providerForThread = async (
  threadId: string,
  dependencies: SourceControlToolDependencies,
) => {
  if (dependencies.providerForThread)
    return dependencies.providerForThread(threadId);
  return (await sourceFor(dependencies.bindings ?? (env as Bindings), threadId))
    .snapshot.provider;
};

export const executeSourcePush = async (
  input: ExecuteSourcePushInput,
  dependencies: SourceControlToolDependencies = {},
) => {
  const execute = dependencies.execute ?? executeTrustedSourceCommand;
  const runner = (
    command: string,
    request: SourceOperationRequestType,
    mutation = false,
  ) =>
    run(execute, input.sandbox, command, request, mutation, {
      signal: input.signal,
    });
  const performMutation = <A>(mutationInput: SourceToolMutationInput<A>) =>
    dependencies.performMutation === undefined
      ? mutate({
          ...mutationInput,
          bindings: dependencies.bindings ?? (env as Bindings),
        })
      : dependencies.performMutation(mutationInput);
  const intendedSha = (
    await executeTrustedLocalCommand(input.sandbox, "git rev-parse HEAD", {
      cwd: input.sandbox.cwd,
      timeoutMs: 10_000,
      signal: input.signal,
    })
  ).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(intendedSha))
    throw new Error("The intended local commit is invalid.");
  if (input.expectedHead !== undefined && intendedSha !== input.expectedHead)
    throw new SourcePushHeadChanged();
  const expectedRemoteSha = await remoteSha(
    execute,
    input.sandbox,
    input.branch,
    { signal: input.signal },
  );
  if (
    input.expectedRemoteHead !== undefined &&
    (expectedRemoteSha ?? null) !== input.expectedRemoteHead
  )
    throw new SourcePushRemoteHeadChanged();
  const changed = await executeTrustedLocalCommand(
    input.sandbox,
    expectedRemoteSha === undefined
      ? `git ls-tree -r --name-only ${intendedSha} -- .github/workflows`
      : `git diff --name-only ${expectedRemoteSha}..${intendedSha} -- .github/workflows`,
    { cwd: input.sandbox.cwd, timeoutMs: 10_000, signal: input.signal },
  );
  if (changed.exitCode !== 0)
    throw new Error(
      "Workflow permission proof failed; fetch the remote branch before pushing.",
    );
  const kind =
    changed.stdout.trim() === "" ||
    (await providerForThread(input.threadId, dependencies)) === "bitbucket"
      ? "contents-push"
      : "workflow-write";
  const request = {
    operation: kind,
    targetBranch: input.branch,
    invocationSource: "agent-command",
  } as const;
  const idempotencyKey =
    input.idempotencyKey ??
    (await shellPushIdempotencyKey(
      input.threadId,
      input.branch,
      expectedRemoteSha,
      intendedSha,
    ));
  const result = await performMutation({
    threadId: input.threadId,
    idempotencyKey,
    kind,
    inputIdentity: `${input.branch}\0${expectedRemoteSha ?? "absent"}\0${intendedSha}`,
    ...(expectedRemoteSha === undefined ? {} : { expectedRemoteSha }),
    intendedSha,
    reconcile: async () => {
      const observed = await remoteSha(execute, input.sandbox, input.branch, {
        signal: input.signal,
      });
      if (observed === intendedSha)
        return { state: "applied", id: intendedSha };
      if (observed === expectedRemoteSha) return { state: "not-observed" };
      return observed === undefined
        ? { state: "unknown" }
        : { state: "conflict" };
    },
    execute: async () => {
      if (
        (await providerForThread(input.threadId, dependencies)) === "bitbucket"
      ) {
        const attributes = await executeTrustedLocalCommand(
          input.sandbox,
          `git grep -l 'filter=lfs' ${intendedSha} -- .gitattributes '**/.gitattributes'`,
          { cwd: input.sandbox.cwd, timeoutMs: 10_000, signal: input.signal },
        );
        if (attributes.exitCode !== 0 && attributes.exitCode !== 1)
          throw new Error("Unable to inspect LFS attributes before pushing.");
        // Repository hooks are disabled. Upload LFS objects explicitly before
        // publishing the commit, so a failed upload cannot leave broken pointers.
        if (attributes.exitCode === 0)
          await runner(`git lfs push origin ${intendedSha}`, request, true);
      }
      await runner(
        `git push --force-with-lease=${quote(`refs/heads/${input.branch}:${expectedRemoteSha ?? ""}`)} origin ${quote(`${intendedSha}:refs/heads/${input.branch}`)}`,
        request,
        true,
      );
      return {
        value: { status: "pushed" as const, sha: intendedSha },
        providerId: intendedSha,
      };
    },
  });
  return result ?? { status: "already-succeeded" as const };
};
