import type {
  PersonalAgentInstructionsRepository,
  ProjectRepository,
  ThreadRepository,
  WorkspaceRepository,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer } from "effect";
import { env } from "cloudflare:test";
import { ProjectRepositoryD1 } from "../../src/projects/repository-d1.js";
import { PersonalAgentInstructionsRepositoryD1 } from "../../src/settings/agent-instructions/repository-d1.js";
import { WorkspaceRepositoryD1 } from "../../src/settings/workspace/repository-d1.js";
import { ThreadRepositoryD1 } from "../../src/threads/repository-d1.js";

const RepositoriesD1 = Layer.mergeAll(
  PersonalAgentInstructionsRepositoryD1,
  ProjectRepositoryD1,
  ThreadRepositoryD1,
  WorkspaceRepositoryD1(env.DB),
).pipe(Layer.provide(D1Client.layer({ db: env.DB })));

export const runRepositories = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | PersonalAgentInstructionsRepository
    | ProjectRepository
    | ThreadRepository
    | WorkspaceRepository
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(RepositoriesD1)));
