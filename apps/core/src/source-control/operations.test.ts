import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  SourceMutationConflict,
  SourceMutationRejected,
  SourceMutationUnavailable,
  SourceMutationRepository,
  type SourceMutationRecord,
  SourceMutationService,
  SourceMutationServiceLive,
} from "./operations.js";

const base: SourceMutationRecord = {
  id: "scop_117",
  idempotencyKeyHash: "a".repeat(64),
  actorUserId: "user-117",
  projectId: "project-117",
  threadId: "thread-117",
  provider: "github",
  providerRepositoryId: "7117",
  kind: "contents-push",
  expectedRemoteSha: "a".repeat(40),
  intendedSha: "b".repeat(40),
  inputIdentityHash: "c".repeat(64),
  state: "pending",
  attempt: 0,
  version: 1,
};

const intent = {
  idempotencyKey: "operation-117",
  actorUserId: base.actorUserId,
  projectId: base.projectId,
  threadId: base.threadId,
  provider: base.provider,
  providerRepositoryId: base.providerRepositoryId,
  kind: base.kind,
  expectedRemoteSha: base.expectedRemoteSha,
  intendedSha: base.intendedSha,
  inputIdentity: "branch and commits",
} as const;

const service = (initial: SourceMutationRecord) => {
  let current = initial;
  const transitions: string[] = [];
  const repository = SourceMutationRepository.of({
    register: () => Effect.succeed(current),
    transition: (record, state, result) => {
      if (record.version !== current.version)
        return Effect.fail(
          new SourceMutationConflict({ reason: "state-conflict" }),
        );
      transitions.push(state);
      current = {
        ...current,
        state,
        version: current.version + 1,
        attempt: current.attempt + (state === "executing" ? 1 : 0),
        ...(result?.id === undefined
          ? {}
          : { providerResultOpaqueId: result.id }),
        ...(result?.category === undefined
          ? {}
          : { providerResultCategory: result.category }),
      };
      return Effect.succeed(current);
    },
  });
  const layer = SourceMutationServiceLive.pipe(
    Layer.provide(Layer.succeed(SourceMutationRepository, repository)),
  );
  return {
    transitions,
    execute: <A>(input: Parameters<typeof run<A>>[1]) => run(layer, input),
  };
};

const run = <A>(
  layer: Layer.Layer<SourceMutationService>,
  input: {
    readonly reconcile: () => Effect.Effect<
      | { readonly state: "applied"; readonly id?: string }
      | { readonly state: "not-observed" }
      | { readonly state: "conflict" }
      | { readonly state: "unknown" },
      unknown
    >;
    readonly mutate: () => Effect.Effect<
      { readonly value: A; readonly providerId?: string },
      unknown
    >;
  },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SourceMutationService).execute({
        intent,
        reconcile: input.reconcile,
        mutate: input.mutate,
      });
    }).pipe(Effect.provide(layer)),
  );

describe("SourceMutationService", () => {
  it("claims and settles one admitted mutation", async () => {
    const state = service(base);
    const mutate = vi.fn(() =>
      Effect.succeed({ value: "ok", providerId: base.intendedSha }),
    );
    await expect(
      state.execute({ reconcile: () => Effect.die("unused"), mutate }),
    ).resolves.toBe("ok");
    expect(state.transitions).toEqual(["executing", "succeeded"]);
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("reconciles an ambiguous success without repeating the mutation", async () => {
    const state = service({ ...base, state: "reconcile-required", version: 3 });
    const mutate = vi.fn(() => Effect.succeed({ value: "repeated" }));
    await expect(
      state.execute({
        reconcile: () =>
          Effect.succeed({ state: "applied", id: base.intendedSha }),
        mutate,
      }),
    ).resolves.toBeUndefined();
    expect(state.transitions).toEqual(["succeeded"]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not retry when reconciliation cannot prove absence", async () => {
    const state = service({ ...base, state: "reconcile-required", version: 3 });
    const mutate = vi.fn(() => Effect.succeed({ value: "repeated" }));
    await expect(
      state.execute({
        reconcile: () => Effect.succeed({ state: "unknown" }),
        mutate,
      }),
    ).rejects.toMatchObject({ reason: "state-conflict" });
    expect(state.transitions).toEqual([]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("permits one controlled retry only after absence is established", async () => {
    const state = service({
      ...base,
      state: "executing",
      version: 2,
      attempt: 1,
    });
    await expect(
      state.execute({
        reconcile: () => Effect.succeed({ state: "not-observed" }),
        mutate: () => Effect.succeed({ value: "retried" }),
      }),
    ).resolves.toBe("retried");
    expect(state.transitions).toEqual([
      "reconcile-required",
      "executing",
      "succeeded",
    ]);
  });

  it("does not repeat an operation after the controlled retry", async () => {
    const state = service({
      ...base,
      state: "reconcile-required",
      version: 4,
      attempt: 2,
    });
    const mutate = vi.fn(() => Effect.succeed({ value: "repeated" }));
    await expect(
      state.execute({
        reconcile: () => Effect.succeed({ state: "not-observed" }),
        mutate,
      }),
    ).rejects.toMatchObject({ reason: "state-conflict" });
    expect(state.transitions).toEqual([]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("persists reconcile-required after an ambiguous mutation failure", async () => {
    const state = service(base);
    await expect(
      state.execute({
        reconcile: () => Effect.die("unused"),
        mutate: () => Effect.fail(new SourceMutationUnavailable()),
      }),
    ).rejects.toBeInstanceOf(SourceMutationUnavailable);
    expect(state.transitions).toEqual(["executing", "reconcile-required"]);
  });

  it("persists a definite provider rejection without retrying", async () => {
    const state = service(base);
    await expect(
      state.execute({
        reconcile: () => Effect.die("unused"),
        mutate: () => Effect.fail(new SourceMutationRejected()),
      }),
    ).rejects.toBeInstanceOf(SourceMutationRejected);
    expect(state.transitions).toEqual(["executing", "failed"]);
  });
});
