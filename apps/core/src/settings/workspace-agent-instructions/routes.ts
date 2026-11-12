import {
  type SettingsFieldError,
  UpdateWorkspaceAgentInstructionsRequestSchema,
  type WorkspaceAgentInstructionsData,
  WorkspaceAgentInstructionsErrorResponseSchema,
  WorkspaceAgentInstructionsResponseSchema,
} from "@dx/api";
import {
  MAX_WORKSPACE_AGENT_INSTRUCTIONS_LENGTH,
  normalizePersonalAgentInstructions,
  SettingsScopeForbidden,
  WorkspaceSlug,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Effect, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedJson } from "../../http/bounded-body.js";
import type { AppEnv } from "../../http/types.js";
import { settingsAuditLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { workspacePolicyLayer } from "../../plugins/resolution.js";
import { SettingsService } from "../service.js";

interface Target {
  readonly workspaceId: string;
  readonly canUpdate: boolean;
}

type ErrorData =
  (typeof WorkspaceAgentInstructionsErrorResponseSchema.Type)["data"];
type WithoutRequestId<Data> = Data extends unknown
  ? Omit<Data, "requestId">
  : never;
type FailureData = WithoutRequestId<ErrorData>;

class InstructionsFailure extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    readonly data: FailureData,
  ) {
    super(data.code);
  }
}

const forbidden = () =>
  new InstructionsFailure(403, {
    code: "WORKSPACE_AGENT_INSTRUCTIONS_FORBIDDEN",
    message: "Only workspace admins can change the workspace instructions.",
  });

const unavailable = () =>
  new InstructionsFailure(503, {
    code: "WORKSPACE_AGENT_INSTRUCTIONS_UNAVAILABLE",
    message: "Workspace instructions are temporarily unavailable.",
  });

const invalid = (fieldErrors: SettingsFieldError[]) =>
  new InstructionsFailure(400, {
    code: "INVALID_WORKSPACE_AGENT_INSTRUCTIONS",
    message: "Workspace instructions validation failed.",
    fieldErrors,
  });

const conflict = (currentRevision: number) =>
  new InstructionsFailure(409, {
    code: "WORKSPACE_AGENT_INSTRUCTIONS_REVISION_CONFLICT",
    message:
      "Workspace instructions changed in another session. Reload before saving.",
    currentRevision,
  });

interface Row {
  readonly content: string;
  readonly revision: number;
  readonly updated_at: string;
}

const readRow = (db: D1Database, workspaceId: string) =>
  db
    .prepare(
      "SELECT content, revision, updated_at FROM workspace_agent_instructions WHERE workspace_id = ?",
    )
    .bind(workspaceId)
    .first<Row>();

const dataOf = (
  row: Row | null,
  target: Target,
): WorkspaceAgentInstructionsData => ({
  instructions: row?.content ?? "",
  revision: row?.revision ?? 0,
  canUpdate: target.canUpdate,
  updatedAt: row?.updated_at ?? null,
});

const database = async (c: Context<AppEnv>) => {
  const result = await Effect.runPromise(
    Effect.result(decodeD1Binding(c.env.DB)),
  );
  if (Result.isFailure(result)) throw unavailable();
  return result.success;
};

/** Every member reads the workspace's instructions; admins also change them. */
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
    workspaceId: workspace.id,
    canUpdate:
      workspace.lifecycleState === "active" &&
      workspaceRoleHasPermission(role, "workspace:update"),
  };
};

const audit = (
  c: Context<AppEnv>,
  target: Target,
  outcome: "success" | "rejected",
  characters?: number,
) =>
  settingsAuditLogger.info("Settings mutation audited.", {
    event: "settings_mutation_audited",
    action: "workspace_agent_instructions.update",
    scope: "workspace",
    outcome,
    requestId: c.get("requestId"),
    userId: c.get("principal").userId,
    workspaceId: target.workspaceId,
    ...(characters === undefined ? {} : { characters }),
  });

const respond = (
  c: Context<AppEnv>,
  run: () => Promise<WorkspaceAgentInstructionsData>,
) =>
  run()
    .then((data) =>
      c.json(
        Schema.encodeUnknownSync(WorkspaceAgentInstructionsResponseSchema)({
          status: "success",
          data,
        }),
        200,
      ),
    )
    .catch((error: unknown) => {
      const failure =
        error instanceof InstructionsFailure ? error : unavailable();
      return c.json(
        Schema.encodeUnknownSync(WorkspaceAgentInstructionsErrorResponseSchema)(
          {
            status: "error",
            data: { ...failure.data, requestId: c.get("requestId") },
          } as never,
        ),
        failure.status,
      );
    });

const validated = (body: unknown) => {
  const decoded = Schema.decodeUnknownOption(
    UpdateWorkspaceAgentInstructionsRequestSchema,
  )(body);
  if (Option.isNone(decoded))
    throw invalid([
      { field: "instructions", message: "Enter the instructions as text." },
    ]);
  const content = normalizePersonalAgentInstructions(
    decoded.value.instructions,
  );
  const { expectedRevision } = decoded.value;
  const fieldErrors: SettingsFieldError[] = [];
  if (content.length > MAX_WORKSPACE_AGENT_INSTRUCTIONS_LENGTH)
    fieldErrors.push({
      field: "instructions",
      message: `Enter no more than ${MAX_WORKSPACE_AGENT_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters.`,
    });
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    fieldErrors.push({
      field: "expectedRevision",
      message: "Use the current non-negative integer revision.",
    });
  if (fieldErrors.length > 0) throw invalid(fieldErrors);
  return { content, expectedRevision };
};

export const workspaceAgentInstructionsRoutes = new Hono<AppEnv>();

workspaceAgentInstructionsRoutes.get("/", (c) =>
  respond(c, async () => {
    const db = await database(c);
    const target = await workspaceTarget(c, db);
    const row = await readRow(db, target.workspaceId).catch(() => {
      throw unavailable();
    });
    return dataOf(row, target);
  }),
);

workspaceAgentInstructionsRoutes.put("/", (c) =>
  respond(c, async () => {
    const db = await database(c);
    const target = await workspaceTarget(c, db);
    if (!target.canUpdate) {
      audit(c, target, "rejected");
      throw forbidden();
    }
    let update: ReturnType<typeof validated>;
    try {
      update = validated(
        await readBoundedJson(c.req.raw).catch(() => undefined),
      );
    } catch (error) {
      audit(c, target, "rejected");
      throw error;
    }
    // One statement: the write lands only on the revision the admin saw.
    const written = await db
      .prepare(
        `INSERT INTO workspace_agent_instructions(workspace_id, content, revision, updated_by, updated_at)
         SELECT ?1, ?2, ?3 + 1, ?4, ?5
          WHERE ?3 = COALESCE((SELECT revision FROM workspace_agent_instructions WHERE workspace_id = ?1), 0)
         ON CONFLICT(workspace_id) DO UPDATE SET
           content = excluded.content,
           revision = excluded.revision,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at
         RETURNING content, revision, updated_at`,
      )
      .bind(
        target.workspaceId,
        update.content,
        update.expectedRevision,
        c.get("principal").userId,
        new Date().toISOString(),
      )
      .first<Row>()
      .catch(() => {
        throw unavailable();
      });
    if (written === null) {
      audit(c, target, "rejected");
      const current = await readRow(db, target.workspaceId).catch(() => {
        throw unavailable();
      });
      throw conflict(current?.revision ?? 0);
    }
    audit(c, target, "success", written.content.length);
    return dataOf(written, target);
  }),
);
