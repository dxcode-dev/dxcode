import { env } from "cloudflare:workers";
import {
  type SourceOperationRequestType,
  SourceWorkspaceRepository,
  ThreadId,
} from "@dx/domain";
import { defineTool, type Sandbox } from "@flue/runtime";
import { Effect, Layer, Schema } from "effect";
import * as v from "valibot";
import {
  executeTrustedLocalCommand,
  executeTrustedSourceCommand,
} from "../execution/e2b/source-command-admission.js";
import type { Bindings } from "../http/types.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import {
  bitbucketControlPlaneFor,
  readBitbucketThreadAuthority,
} from "./bitbucket/control-plane.js";
import {
  type createBitbucketProvider,
  isBitbucketPullRequestBodyWithinLimit,
} from "./bitbucket/provider-http.js";
import {
  type SourceMutationIntent,
  SourceMutationRejected,
  SourceMutationRepositoryD1,
  SourceMutationService,
  SourceMutationServiceLive,
  type SourceReconciliation,
} from "./operations.js";
import { SourceWorkspaceRepositoryD1 } from "./source-workspace-repository-d1.js";

const IdempotencyKey = v.pipe(v.string(), v.minLength(8), v.maxLength(512));
const Branch = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(256),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
);
const Text = v.pipe(v.string(), v.minLength(1), v.maxLength(16_000));
const NumberId = v.pipe(v.number(), v.integer(), v.minValue(1));

export class SourceProviderUnavailable extends Schema.TaggedError<SourceProviderUnavailable>()(
  "SourceProviderUnavailable",
  {},
) {}

export class SourceProviderRateLimited extends Schema.TaggedError<SourceProviderRateLimited>()(
  "SourceProviderRateLimited",
  {},
) {}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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

const readJson = (value: string): JsonValue => {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw new Error("Source provider returned an invalid bounded response.");
  }
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

const operationMarker = async (
  threadId: string,
  kind: SourceMutationIntent["kind"],
  action: string,
  idempotencyKey: string,
) => {
  const digest = await hash(
    `${threadId}\0${kind}\0${action}\0${idempotencyKey}`,
  );
  return { digest, hidden: `<!-- dx-op:${digest} -->` };
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

export const sourceControlTools = (
  threadId: string,
  dependencies: SourceControlToolDependencies = {},
) => {
  const execute = dependencies.execute ?? executeTrustedSourceCommand;
  const runner = (
    sandbox: Sandbox,
    command: string,
    request: SourceOperationRequestType,
    mutation = false,
  ) => run(execute, sandbox, command, request, mutation);
  const performMutation = <A>(input: SourceToolMutationInput<A>) =>
    dependencies.performMutation === undefined
      ? mutate({
          ...input,
          bindings: dependencies.bindings ?? (env as Bindings),
        })
      : dependencies.performMutation(input);
  const tools = [
    defineTool({
      name: "source_status",
      description:
        "Return bounded source working-tree status without repository content.",
      input: v.object({}),
      harness: true,
      async run({ harness }) {
        const output = await harness.sandbox.exec(
          "git status --porcelain=v2 --branch",
          { cwd: harness.sandbox.cwd, timeoutMs: 30_000 },
        );
        if (output.exitCode !== 0)
          throw new Error("Source status is unavailable.");
        const lines = output.stdout.split("\n");
        return {
          output: {
            branch:
              lines
                .find((line) => line.startsWith("# branch.head "))
                ?.slice(14) ?? "unknown",
            changed: lines.filter((line) => /^[12u?] /.test(line)).length,
            conflicted: lines.filter((line) => line.startsWith("u ")).length,
          },
        };
      },
    }),
    defineTool({
      name: "source_fetch",
      description: "Fetch the bound repository using a fresh read-only lease.",
      input: v.object({}),
      harness: true,
      async run({ harness }) {
        await runner(harness.sandbox, "git fetch --prune origin", {
          operation: "fetch",
          invocationSource: "agent-command",
        });
        return { output: { status: "fetched" } };
      },
    }),
    defineTool({
      name: "source_push",
      description:
        "Push one branch with durable idempotency and explicit force-with-lease protection.",
      input: v.object({ branch: Branch, idempotencyKey: IdempotencyKey }),
      harness: true,
      async run({ data, harness }) {
        const result = await executeSourcePush(
          {
            threadId,
            sandbox: harness.sandbox,
            branch: data.branch,
            idempotencyKey: data.idempotencyKey,
          },
          {
            ...dependencies,
            execute,
            performMutation,
            ...(dependencies.bindings === undefined
              ? {}
              : { bindings: dependencies.bindings }),
          },
        );
        return { output: result };
      },
    }),
    defineTool({
      name: "pull_request",
      description:
        "Read, create, or update a pull request in the bound repository using DX-held provider authority.",
      input: v.object({
        action: v.picklist(["read", "create", "update"]),
        number: v.optional(NumberId),
        head: v.optional(Branch),
        base: v.optional(Branch),
        title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
        body: v.optional(Text),
        idempotencyKey: v.optional(IdempotencyKey),
      }),
      harness: true,
      async run({ data, harness }) {
        if ((await providerForThread(threadId, dependencies)) === "bitbucket") {
          const bindings = dependencies.bindings ?? (env as Bindings);
          const withProvider = async <A>(
            callback: (
              token: string,
              provider: ReturnType<typeof createBitbucketProvider>,
              workspaceId: string,
              repositoryId: string,
            ) => Promise<A>,
          ) => {
            const source = await sourceFor(bindings, threadId);
            const control = await bitbucketControlPlaneFor(source.db, bindings);
            const authority = await readBitbucketThreadAuthority(
              source.db,
              threadId,
              source.record.actorUserId,
            );
            return control.withConnection(
              source.record.actorUserId,
              authority.grantId,
              async (token, connection, provider) => {
                if (
                  connection.authorization_epoch !==
                  authority.authorizationEpoch
                )
                  throw new SourceProviderUnavailable();
                const repo = await provider.getRepository(
                  token,
                  authority.providerWorkspaceId,
                  authority.providerRepositoryId,
                );
                if (
                  repo.id !== authority.providerRepositoryId ||
                  repo.fullName !== authority.repositoryName
                )
                  throw new SourceProviderUnavailable();
                return callback(
                  token,
                  provider,
                  authority.providerWorkspaceId,
                  authority.providerRepositoryId,
                );
              },
            );
          };
          if (data.action === "read") {
            if (data.number === undefined)
              throw new Error("A change-request number is required.");
            return {
              output: {
                ...(await withProvider((token, api, workspace, repository) =>
                  api.readPullRequest(
                    token,
                    workspace,
                    repository,
                    data.number as number,
                  ),
                )),
              },
            };
          }
          if (
            !data.idempotencyKey ||
            (data.action === "create" &&
              (!data.head || !data.base || !data.title || !data.body)) ||
            (data.action === "update" && data.number === undefined)
          )
            throw new Error(
              "Change-request fields and idempotency key are required.",
            );
          const marker = await operationMarker(
            threadId,
            "pull-request-write",
            data.action,
            data.idempotencyKey,
          );
          const body =
            data.body === undefined
              ? undefined
              : `${data.body}\n\n${marker.hidden}`;
          if (
            body !== undefined &&
            !isBitbucketPullRequestBodyWithinLimit(body)
          )
            throw new SourceMutationRejected();
          const output = await performMutation({
            threadId,
            idempotencyKey: data.idempotencyKey,
            kind: "pull-request-write",
            inputIdentity: JSON.stringify(data),
            reconcile: () =>
              withProvider(
                async (
                  token,
                  api,
                  workspace,
                  repository,
                ): Promise<SourceReconciliation> => {
                  if (data.action === "update") {
                    const pr = await api.readPullRequest(
                      token,
                      workspace,
                      repository,
                      data.number as number,
                    );
                    return (data.title === undefined ||
                      pr.title === data.title) &&
                      (body === undefined || pr.body === body)
                      ? { state: "applied", id: String(pr.number) }
                      : { state: "not-observed" };
                  }
                  const matches = (
                    await api.listPullRequests(token, workspace, repository)
                  ).filter(
                    (pr) =>
                      pr.body.includes(marker.hidden) &&
                      pr.head === data.head &&
                      pr.base === data.base,
                  );
                  return matches.length === 1
                    ? { state: "applied", id: String(matches[0]?.number) }
                    : matches.length > 1
                      ? { state: "conflict" }
                      : { state: "unknown" };
                },
              ),
            execute: () =>
              withProvider(async (token, api, workspace, repository) => {
                const pr =
                  data.action === "create"
                    ? await api.createPullRequest(
                        token,
                        workspace,
                        repository,
                        {
                          head: data.head as string,
                          base: data.base as string,
                          title: data.title as string,
                          body: body as string,
                        },
                      )
                    : await api.updatePullRequest(
                        token,
                        workspace,
                        repository,
                        data.number as number,
                        { title: data.title, body },
                      );
                return {
                  value: { status: "applied", reference: pr.url },
                  providerId: String(pr.number),
                };
              }),
          });
          return { output: output ?? { status: "already-succeeded" } };
        }
        if (data.action === "read") {
          if (data.number === undefined)
            throw new Error("A change-request number is required.");
          const value = await runner(
            harness.sandbox,
            `gh pr view ${data.number} --json number,state,title,url,headRefName,baseRefName`,
            {
              operation: "pull-request-read",
              invocationSource: "agent-command",
            },
          );
          return { output: readJson(value) };
        }
        if (data.idempotencyKey === undefined)
          throw new Error("An idempotency key is required.");
        if (
          data.action === "create" &&
          (data.head === undefined ||
            data.base === undefined ||
            data.title === undefined ||
            data.body === undefined)
        )
          throw new Error("Head, base, title, and body are required.");
        if (data.action === "update" && data.number === undefined)
          throw new Error("A change-request number is required.");
        const head = data.head as string;
        const base = data.base as string;
        const title = data.title as string;
        const body = data.body as string;
        const marker = await operationMarker(
          threadId,
          "pull-request-write",
          data.action,
          data.idempotencyKey,
        );
        const command =
          data.action === "create"
            ? `gh pr create --head ${quote(head)} --base ${quote(base)} --title ${quote(title)} --body ${quote(`${body}\n\n${marker.hidden}`)}`
            : `gh pr edit ${data.number}${data.title === undefined ? "" : ` --title ${quote(data.title)}`}${data.body === undefined ? "" : ` --body ${quote(`${data.body}\n\n${marker.hidden}`)}`}`;
        const output = await performMutation({
          threadId,
          idempotencyKey: data.idempotencyKey,
          kind: "pull-request-write",
          inputIdentity: JSON.stringify(data),
          reconcile: async () => {
            if (data.action === "update") {
              const current = readJson(
                await runner(
                  harness.sandbox,
                  `gh pr view ${data.number} --json number,title,body`,
                  {
                    operation: "pull-request-read",
                    invocationSource: "agent-command",
                  },
                ),
              ) as { number?: number; title?: string; body?: string };
              const titleMatches =
                data.title === undefined || current.title === data.title;
              const bodyMatches =
                data.body === undefined ||
                (current.body?.startsWith(data.body) === true &&
                  current.body.includes(marker.hidden));
              return current.number === data.number &&
                titleMatches &&
                bodyMatches
                ? { state: "applied", id: String(data.number) }
                : { state: "not-observed" };
            }
            const found = readJson(
              await runner(
                harness.sandbox,
                `gh pr list --head ${quote(head)} --base ${quote(base)} --search ${quote(marker.digest)} --json number --limit 2`,
                {
                  operation: "pull-request-read",
                  invocationSource: "agent-command",
                },
              ),
            ) as Array<{ number?: number }>;
            return found.length === 1 && found[0]?.number !== undefined
              ? { state: "applied", id: String(found[0].number) }
              : found.length > 1
                ? { state: "conflict" }
                : { state: "unknown" };
          },
          execute: async () => {
            const value = await runner(
              harness.sandbox,
              command,
              {
                operation: "pull-request-write",
                invocationSource: "agent-command",
              },
              true,
            );
            return {
              value: { status: "applied", reference: value.slice(0, 512) },
            };
          },
        });
        return { output: output ?? { status: "already-succeeded" } };
      },
    }),
    defineTool({
      name: "source_issue",
      description: "Read, create, update, or comment on a bounded issue.",
      input: v.object({
        action: v.picklist(["read", "create", "update", "comment"]),
        number: v.optional(NumberId),
        title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
        body: v.optional(Text),
        idempotencyKey: v.optional(IdempotencyKey),
      }),
      harness: true,
      async run({ data, harness }) {
        if (data.action === "read") {
          if (data.number === undefined)
            throw new Error("An issue number is required.");
          return {
            output: readJson(
              await runner(
                harness.sandbox,
                `gh issue view ${data.number} --json number,state,title,url`,
                { operation: "issue-read", invocationSource: "agent-command" },
              ),
            ),
          };
        }
        if (data.idempotencyKey === undefined || data.body === undefined)
          throw new Error("An idempotency key and body are required.");
        if (data.action === "create" && data.title === undefined)
          throw new Error("An issue title is required.");
        if (data.action !== "create" && data.number === undefined)
          throw new Error("An issue number is required.");
        const title = data.title as string;
        const body = data.body;
        const marker = await operationMarker(
          threadId,
          "issue-write",
          data.action,
          data.idempotencyKey,
        );
        const command =
          data.action === "create"
            ? `gh issue create --title ${quote(title)} --body ${quote(`${body}\n\n${marker.hidden}`)}`
            : data.action === "update"
              ? `gh issue edit ${data.number}${data.title === undefined ? "" : ` --title ${quote(data.title)}`} --body ${quote(`${body}\n\n${marker.hidden}`)}`
              : `gh issue comment ${data.number} --body ${quote(`${body}\n\n${marker.hidden}`)}`;
        const output = await performMutation({
          threadId,
          idempotencyKey: data.idempotencyKey,
          kind: "issue-write",
          inputIdentity: JSON.stringify(data),
          reconcile: async () => {
            if (data.action === "update") {
              const current = readJson(
                await runner(
                  harness.sandbox,
                  `gh issue view ${data.number} --json number,title,body`,
                  {
                    operation: "issue-read",
                    invocationSource: "agent-command",
                  },
                ),
              ) as { number?: number; title?: string; body?: string };
              const titleMatches =
                data.title === undefined || current.title === data.title;
              const bodyMatches =
                current.body?.startsWith(body) === true &&
                current.body.includes(marker.hidden);
              return current.number === data.number &&
                titleMatches &&
                bodyMatches
                ? { state: "applied", id: String(data.number) }
                : { state: "not-observed" };
            }
            if (data.action === "comment") {
              const current = readJson(
                await runner(
                  harness.sandbox,
                  `gh issue view ${data.number} --json number,comments`,
                  {
                    operation: "issue-read",
                    invocationSource: "agent-command",
                  },
                ),
              ) as { number?: number; comments?: Array<{ body?: string }> };
              const matches =
                current.number === data.number
                  ? (current.comments ?? []).filter((comment) =>
                      comment.body?.includes(marker.hidden),
                    ).length
                  : 0;
              return matches === 1
                ? { state: "applied", id: String(data.number) }
                : matches > 1
                  ? { state: "conflict" }
                  : { state: "unknown" };
            }
            const found = readJson(
              await runner(
                harness.sandbox,
                `gh issue list --search ${quote(marker.digest)} --json number --limit 2`,
                { operation: "issue-read", invocationSource: "agent-command" },
              ),
            ) as Array<{ number?: number }>;
            return found.length === 1 && found[0]?.number !== undefined
              ? { state: "applied", id: String(found[0].number) }
              : found.length > 1
                ? { state: "conflict" }
                : { state: "unknown" };
          },
          execute: async () => ({
            value: {
              status: "applied",
              reference: (
                await runner(
                  harness.sandbox,
                  command,
                  {
                    operation: "issue-write",
                    invocationSource: "agent-command",
                  },
                  true,
                )
              ).slice(0, 512),
            },
          }),
        });
        return { output: output ?? { status: "already-succeeded" } };
      },
    }),
    defineTool({
      name: "source_checks",
      description:
        "Read bounded check and commit-status state for a change request.",
      input: v.object({ number: NumberId }),
      harness: true,
      async run({ data, harness }) {
        return {
          output: readJson(
            await runner(
              harness.sandbox,
              `gh pr checks ${data.number} --json name,state,workflow,link,bucket`,
              {
                operation: "checks-status-read",
                invocationSource: "agent-command",
              },
            ),
          ),
        };
      },
    }),
    defineTool({
      name: "source_workflow",
      description:
        "Read Actions workflows/runs or durably rerun/cancel a known run. Dispatch returns reconciliation-required when GitHub provides no run identity.",
      input: v.object({
        action: v.picklist([
          "runs",
          "workflows",
          "rerun",
          "cancel",
          "dispatch",
        ]),
        runId: v.optional(NumberId),
        workflow: v.optional(
          v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
        ),
        branch: v.optional(Branch),
        idempotencyKey: v.optional(IdempotencyKey),
      }),
      harness: true,
      async run({ data, harness }) {
        if (data.action === "runs" || data.action === "workflows")
          return {
            output: readJson(
              await runner(
                harness.sandbox,
                data.action === "runs"
                  ? "gh run list --json databaseId,status,conclusion,workflowName,url --limit 50"
                  : "gh workflow list --json id,name,state --limit 50",
                {
                  operation: "actions-read",
                  invocationSource: "agent-command",
                },
              ),
            ),
          };
        if (data.idempotencyKey === undefined)
          throw new Error("An idempotency key is required.");
        if (
          data.action === "dispatch" &&
          (data.workflow === undefined || data.branch === undefined)
        )
          throw new Error("A workflow and branch are required.");
        if (data.action !== "dispatch" && data.runId === undefined)
          throw new Error("A workflow run ID is required.");
        const workflow = data.workflow as string;
        const branch = data.branch as string;
        const runId = data.runId as number;
        const command =
          data.action === "dispatch"
            ? `gh workflow run ${quote(workflow)} --ref ${quote(branch)}`
            : `gh run ${data.action} ${runId}`;
        const output = await performMutation({
          threadId,
          idempotencyKey: data.idempotencyKey,
          kind: "actions-write",
          inputIdentity: JSON.stringify(data),
          reconcile: async () => {
            if (data.action === "cancel") {
              const current = readJson(
                await runner(
                  harness.sandbox,
                  `gh run view ${runId} --json databaseId,status,conclusion`,
                  {
                    operation: "actions-read",
                    invocationSource: "agent-command",
                  },
                ),
              ) as { databaseId?: number; conclusion?: string };
              return current.databaseId === runId &&
                current.conclusion === "cancelled"
                ? { state: "applied", id: String(runId) }
                : { state: "unknown" };
            }
            return { state: "unknown" };
          },
          execute: async () => {
            await runner(
              harness.sandbox,
              command,
              {
                operation: "actions-write",
                invocationSource: "agent-command",
              },
              true,
            );
            if (data.action === "dispatch")
              throw new Error(
                "Workflow dispatch outcome requires reconciliation.",
              );
            return {
              value: { status: "applied", runId },
              providerId: String(runId),
            };
          },
        });
        return { output: output ?? { status: "already-succeeded" } };
      },
    }),
    defineTool({
      name: "source_project",
      description:
        "Report the bounded Projects v2 capability. Organization-wide credentials are never delegated to a Thread.",
      input: v.object({
        projectNodeId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
      }),
      async run() {
        return {
          output: {
            status: "action-required",
            reason: "organization-projects-exact-repository-lease-unavailable",
            action:
              "Configure a separately reviewed Core-only owner-scoped Projects v2 broker before enabling this operation.",
          },
        };
      },
    }),
  ];
  return tools.filter(({ name }) => name === "pull_request");
};
