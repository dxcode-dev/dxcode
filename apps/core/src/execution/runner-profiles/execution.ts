import { RunnerProfileId, ThreadId, UserId } from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../../settings/audit.js";
import { SettingsService } from "../../settings/service.js";
import { WorkspaceRepositoryD1 } from "../../settings/workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../../settings/workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../../settings/workspace-policy/service.js";
import { loadRunnerProfileCatalog, selectRunnerProfile } from "./catalog.js";

const ExecutionRunnerRow = Schema.Struct({
  thread_runner_profile_id: Schema.NullOr(RunnerProfileId),
  project_runner_profile_id: RunnerProfileId,
  owner_user_id: UserId,
});

export class ExecutionRunnerProfileUnavailable extends Schema.TaggedError<ExecutionRunnerProfileUnavailable>()(
  "ExecutionRunnerProfileUnavailable",
  {},
) {}

export const resolveExecutionRunnerProfile = Effect.fn(
  "resolveExecutionRunnerProfile",
)(function* (bindings: Bindings, rawThreadId: string) {
  const threadId = yield* Schema.decodeUnknownEffect(ThreadId)(
    rawThreadId,
  ).pipe(Effect.mapError(() => new ExecutionRunnerProfileUnavailable()));
  const db = yield* decodeD1Binding(bindings.DB).pipe(
    Effect.mapError(() => new ExecutionRunnerProfileUnavailable()),
  );
  const catalog = yield* loadRunnerProfileCatalog(bindings).pipe(
    Effect.mapError(() => new ExecutionRunnerProfileUnavailable()),
  );
  const row = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `SELECT threads.runner_profile_id AS thread_runner_profile_id,
                  projects.runner_profile_id AS project_runner_profile_id,
                  threads.owner_user_id
           FROM threads
           INNER JOIN projects ON projects.id = threads.project_id
             AND projects.owner_user_id = threads.owner_user_id
           WHERE threads.id = ?
           LIMIT 1`,
        )
        .bind(threadId)
        .first(),
    catch: () => new ExecutionRunnerProfileUnavailable(),
  }).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.fail(new ExecutionRunnerProfileUnavailable())
        : Schema.decodeUnknownEffect(ExecutionRunnerRow)(value).pipe(
            Effect.mapError(() => new ExecutionRunnerProfileUnavailable()),
          ),
    ),
  );
  const profile = yield* selectRunnerProfile(
    catalog,
    row.thread_runner_profile_id ?? row.project_runner_profile_id,
  ).pipe(Effect.mapError(() => new ExecutionRunnerProfileUnavailable()));
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  yield* Effect.gen(function* () {
    const policy = yield* WorkspacePolicyService;
    yield* policy.evaluateForUser(row.owner_user_id, {
      kind: "execution.admit",
      runnerProfileId: profile.id,
      runnerAdapter: profile.adapter,
    });
  }).pipe(
    Effect.provide(
      WorkspacePolicyService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            workspace,
            settings,
            WorkspacePolicyRepositoryD1(db),
            SettingsAudit.layer,
          ),
        ),
      ),
    ),
  );
  return profile;
});
