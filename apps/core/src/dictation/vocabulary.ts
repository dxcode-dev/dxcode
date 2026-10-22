import {
  type DictationVocabularyData,
  DictationVocabularyErrorResponseSchema,
  DictationVocabularyResponseSchema,
  type SettingsFieldError,
  UpdateDictationVocabularyRequestSchema,
} from "@dx/api";
import {
  DictationVocabulary,
  dictationVocabularyProblem,
  mergeDictationVocabularies,
  parseDictationVocabulary,
  SettingsScopeForbidden,
  WorkspaceSlug,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Effect, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { settingsAuditLogger } from "../logging.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { workspacePolicyLayer } from "../plugins/resolution.js";
import { SettingsService } from "../settings/service.js";

type Scope = DictationVocabularyData["scope"];

interface Target {
  readonly scope: Scope;
  readonly targetId: string;
  readonly canUpdate: boolean;
}

type ErrorData = (typeof DictationVocabularyErrorResponseSchema.Type)["data"];
type WithoutRequestId<Data> = Data extends unknown
  ? Omit<Data, "requestId">
  : never;
type FailureData = WithoutRequestId<ErrorData>;

class VocabularyFailure extends Error {
  constructor(
    readonly status: 400 | 403 | 503,
    readonly data: FailureData,
  ) {
    super(data.code);
  }
}

const forbidden = () =>
  new VocabularyFailure(403, {
    code: "DICTATION_VOCABULARY_FORBIDDEN",
    message: "Only workspace admins can change the workspace vocabulary.",
  });

const unavailable = () =>
  new VocabularyFailure(503, {
    code: "DICTATION_VOCABULARY_UNAVAILABLE",
    message: "Dictation vocabulary is temporarily unavailable.",
  });

const invalid = (message: string) =>
  new VocabularyFailure(400, {
    code: "INVALID_DICTATION_VOCABULARY",
    message,
    fieldErrors: [{ field: "terms", message }] satisfies SettingsFieldError[],
  });

const decodeTerms = (stored: string | null | undefined): string[] => {
  if (stored == null) return [];
  const decoded = Schema.decodeUnknownOption(
    Schema.fromJsonString(DictationVocabulary),
  )(stored);
  return Option.isSome(decoded) ? [...decoded.value] : [];
};

/**
 * The vocabulary one transcription uses: the person's terms, then their
 * workspace's (users belong to at most one), merged by
 * `mergeDictationVocabularies`. Never rejects: a failed read dictates
 * without one.
 */
export const loadDictationVocabulary = async (
  db: D1Database,
  userId: string,
): Promise<string[]> => {
  const rows = await Promise.resolve()
    .then(() =>
      db
        .prepare(
          `SELECT scope, terms FROM dictation_vocabulary
           WHERE (scope = 'personal' AND target_id = ?1)
              OR (scope = 'workspace' AND target_id IN (SELECT organizationId FROM member WHERE userId = ?1))`,
        )
        .bind(userId)
        .all<{ scope: Scope; terms: string }>(),
    )
    .then(({ results }) => results)
    .catch(() => []);
  const terms = (scope: Scope) =>
    decodeTerms(rows.find((row) => row.scope === scope)?.terms);
  return mergeDictationVocabularies(terms("personal"), terms("workspace"));
};

const read = async (db: D1Database, target: Target) => {
  const row = await db
    .prepare(
      "SELECT terms, updated_at FROM dictation_vocabulary WHERE scope = ? AND target_id = ?",
    )
    .bind(target.scope, target.targetId)
    .first<{ terms: string; updated_at: string }>();
  return {
    scope: target.scope,
    terms: decodeTerms(row?.terms),
    canUpdate: target.canUpdate,
    updatedAt: row?.updated_at ?? null,
  } satisfies DictationVocabularyData;
};

const validTerms = (typed: ReadonlyArray<string>) => {
  const terms = parseDictationVocabulary(typed.join("\n"));
  const problem = dictationVocabularyProblem(terms);
  if (problem !== undefined) throw invalid(problem);
  return terms;
};

const database = async (c: Context<AppEnv>) => {
  const result = await Effect.runPromise(
    Effect.result(decodeD1Binding(c.env.DB)),
  );
  if (Result.isFailure(result)) throw unavailable();
  return result.success;
};

const personalTarget = async (c: Context<AppEnv>): Promise<Target> => ({
  scope: "personal",
  targetId: c.get("principal").userId,
  canUpdate: true,
});

const workspaceTarget = async (
  c: Context<AppEnv>,
  db: D1Database,
): Promise<Target> => {
  const slug = Schema.decodeUnknownOption(WorkspaceSlug)(
    c.req.param("workspaceSlug"),
  );
  if (Option.isNone(slug)) throw forbidden();
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        return yield* settings.workspace(c.get("principal"), slug.value);
      }).pipe(Effect.provide(workspacePolicyLayer(db))),
    ),
  );
  if (Result.isFailure(result))
    throw result.failure instanceof SettingsScopeForbidden
      ? forbidden()
      : unavailable();
  const { workspace, role } = result.success.workspace;
  return {
    scope: "workspace",
    targetId: workspace.id,
    canUpdate:
      workspace.lifecycleState === "active" &&
      workspaceRoleHasPermission(role, "workspace:update"),
  };
};

const respond = (c: Context<AppEnv>, run: () => Promise<Target>) =>
  run()
    .then(async (target) =>
      c.json(
        Schema.encodeUnknownSync(DictationVocabularyResponseSchema)({
          status: "success",
          data: await read(await database(c), target),
        }),
        200,
      ),
    )
    .catch((error: unknown) => {
      const failure =
        error instanceof VocabularyFailure ? error : unavailable();
      return c.json(
        Schema.encodeUnknownSync(DictationVocabularyErrorResponseSchema)({
          status: "error",
          data: { ...failure.data, requestId: c.get("requestId") },
        } as never),
        failure.status,
      );
    });

const audit = (
  c: Context<AppEnv>,
  target: Target,
  outcome: "success" | "rejected",
  terms?: number,
) =>
  settingsAuditLogger.info("Settings mutation audited.", {
    event: "settings_mutation_audited",
    action: "dictation_vocabulary.update",
    scope: target.scope,
    outcome,
    requestId: c.get("requestId"),
    userId: c.get("principal").userId,
    ...(target.scope === "workspace" ? { workspaceId: target.targetId } : {}),
    ...(terms === undefined ? {} : { terms }),
  });

const mount = (
  router: Hono<AppEnv>,
  resolveTarget: (c: Context<AppEnv>, db: D1Database) => Promise<Target>,
) => {
  router.get("/", (c) =>
    respond(c, async () => resolveTarget(c, await database(c))),
  );
  router.put("/", (c) =>
    respond(c, async () => {
      const db = await database(c);
      const target = await resolveTarget(c, db);
      if (!target.canUpdate) {
        audit(c, target, "rejected");
        throw forbidden();
      }
      const body = Schema.decodeUnknownOption(
        UpdateDictationVocabularyRequestSchema,
      )(await c.req.json().catch(() => undefined));
      if (Option.isNone(body)) throw invalid("Enter the terms as text.");
      const terms = validTerms(body.value.terms);
      await db
        .prepare(
          `INSERT INTO dictation_vocabulary(scope, target_id, terms, updated_by, updated_at)
           VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(scope, target_id) DO UPDATE SET
             terms = excluded.terms,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .bind(
          target.scope,
          target.targetId,
          JSON.stringify(terms),
          c.get("principal").userId,
          new Date().toISOString(),
        )
        .run()
        .catch(() => {
          throw unavailable();
        });
      audit(c, target, "success", terms.length);
      return target;
    }),
  );
};

export const personalDictationVocabularyRoutes = new Hono<AppEnv>();
mount(personalDictationVocabularyRoutes, personalTarget);

export const workspaceDictationVocabularyRoutes = new Hono<AppEnv>();
mount(workspaceDictationVocabularyRoutes, workspaceTarget);
