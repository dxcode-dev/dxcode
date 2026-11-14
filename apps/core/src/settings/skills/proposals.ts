import { SkillProposalDataSchema } from "@dx/api";
import {
  MAX_SKILLS_PER_SCOPE,
  PersistenceUnavailable,
  type SkillImportBundle,
  SkillIntegrityConflict,
  SkillRepository,
  type SkillTarget,
  type SkillWithVersion,
  type UserId,
  WorkspaceRepository,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { SettingsAudit } from "../audit.js";
import { previewSkillImport, SkillImportRejected } from "./import.js";
import { SkillService } from "./service.js";

/**
 * Skill changes the agent proposes and a person decides (plugin plan M5).
 *
 * The agent's `manage_skills` tool files a proposal: the exact import bundle
 * it wants saved, checked by the same import rules a person's upload meets.
 * Nothing else changes. A person who could save that skill themselves (the
 * owner for a personal skill, a workspace admin for a workspace skill)
 * approves or rejects it on the Skills settings page; approval saves it
 * through `SkillService` as an enabled new skill or a new active version,
 * so new Threads load it like any skill the person saved.
 *
 * `agent_proposal.kind` is 'skill' here; agent plugin management adds its
 * own kind and payload to the same table and review flow.
 */

/** Pending proposals one scope holds at once, so an agent cannot flood it. */
export const MAX_PENDING_PROPOSALS = 20;

export class SkillProposalNotFound extends Schema.TaggedError<SkillProposalNotFound>()(
  "SkillProposalNotFound",
  {},
) {}

export class SkillProposalDecided extends Schema.TaggedError<SkillProposalDecided>()(
  "SkillProposalDecided",
  {},
) {}

/** Why the agent cannot propose this; the message is for the agent. */
export class SkillProposalRefused extends Schema.TaggedError<SkillProposalRefused>()(
  "SkillProposalRefused",
  { reason: Schema.String },
) {}

export type ProposalStatus = "pending" | "approved" | "rejected" | "superseded";

export interface SkillProposalRow {
  readonly id: string;
  readonly scope: "personal" | "workspace";
  readonly target_id: string;
  readonly thread_id: string;
  readonly proposed_by_user_id: string;
  readonly name: string;
  readonly change: "new" | "update";
  readonly subject_id: string | null;
  readonly current_version: number | null;
  readonly note: string;
  readonly payload_json: string;
  readonly integrity: string;
  readonly status: ProposalStatus;
  readonly ask_artifact_id: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly result_version: number | null;
  readonly thread_title?: string | null;
}

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const query = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: unavailable(operation) });

/** Where the agent may propose skills for a person: where they could save one. */
export interface ProposalScopes {
  readonly personal: { readonly target: SkillTarget };
  readonly workspace?: {
    readonly target: SkillTarget;
    readonly slug: string;
    readonly name: string;
    readonly canPropose: boolean;
  };
}

export const proposalScopes = Effect.fn("proposalScopes")(function* (
  userId: UserId,
) {
  const workspaces = yield* WorkspaceRepository;
  const membership = Option.getOrUndefined(
    yield* workspaces.findByUser(userId),
  );
  return {
    personal: { target: { scope: "personal", id: userId } },
    ...(membership === undefined
      ? {}
      : {
          workspace: {
            target: { scope: "workspace", id: membership.workspace.id },
            slug: membership.workspace.shortName,
            name: membership.workspace.displayName,
            canPropose: membership.role !== "member",
          },
        }),
  } satisfies ProposalScopes;
});

/** The skill files an agent sends, as the import bundle a person's upload is. */
export const proposalBundle = (input: {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly resources: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly mcpServerIds: ReadonlyArray<string>;
  readonly label: string;
}): SkillImportBundle =>
  ({
    source: { type: "browser-files", label: input.label },
    files: [
      {
        path: "skill.json",
        kind: "file",
        mediaType: "application/json",
        encoding: "utf-8",
        content: `${JSON.stringify(
          {
            schemaVersion: 1,
            name: input.name,
            description: input.description,
            mcpServerIds: input.mcpServerIds,
          },
          null,
          2,
        )}\n`,
      },
      {
        path: "instructions.md",
        kind: "file",
        mediaType: "text/markdown",
        encoding: "utf-8",
        content: input.instructions,
      },
      ...input.resources.map(({ path, content }) => ({
        path,
        kind: "file" as const,
        mediaType: "",
        encoding: "utf-8" as const,
        content,
      })),
    ],
  }) as unknown as SkillImportBundle;

const refuseImport = (error: SkillImportRejected) =>
  new SkillProposalRefused({ reason: `${error.field}: ${error.reason}` });

/**
 * Files a pending proposal for `target`, replacing this Thread's earlier
 * pending proposal for the same skill. Refuses what the import would, a
 * skill a plugin owns, and a full scope.
 */
export const proposeSkill = Effect.fn("proposeSkill")(function* (
  db: D1Database,
  input: {
    readonly target: SkillTarget;
    readonly threadId: string;
    readonly userId: UserId;
    readonly bundle: SkillImportBundle;
    readonly note: string;
  },
) {
  const repository = yield* SkillRepository;
  const preview = yield* previewSkillImport(input.bundle).pipe(
    Effect.mapError((error) =>
      error instanceof SkillImportRejected ? refuseImport(error) : error,
    ),
  );
  const existing = yield* repository.list(input.target);
  const current = existing.find(
    ({ skill }) => skill.name === preview.manifest.name,
  );
  if (current?.skill.pluginId !== undefined)
    return yield* new SkillProposalRefused({
      reason: `A plugin installed the skill ${preview.manifest.name}, so only a new version of that plugin can change it. Choose another name.`,
    });
  if (current?.active.integrity === preview.integrity)
    return yield* new SkillProposalRefused({
      reason: `The active version of ${preview.manifest.name} already has exactly this content.`,
    });
  if (current === undefined && existing.length >= MAX_SKILLS_PER_SCOPE)
    return yield* new SkillProposalRefused({
      reason: `This scope already holds ${MAX_SKILLS_PER_SCOPE} skills, its limit. Propose an update to an existing skill instead.`,
    });
  const pending = yield* query("agentProposal.countPending", () =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_proposal
          WHERE kind = 'skill' AND scope = ? AND target_id = ?
            AND status = 'pending'
            AND NOT (thread_id = ? AND name = ?)`,
      )
      .bind(
        input.target.scope,
        input.target.id,
        input.threadId,
        preview.manifest.name,
      )
      .first<{ n: number }>(),
  );
  if ((pending?.n ?? 0) >= MAX_PENDING_PROPOSALS)
    return yield* new SkillProposalRefused({
      reason: `${MAX_PENDING_PROPOSALS} skill proposals already wait for review here. Ask the person to review them first.`,
    });
  const id = `apr_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const change = current === undefined ? "new" : "update";
  // This Thread's pending proposal for the same skill, whose ask the caller
  // ticks as replaced.
  const superseded = yield* query(
    "agentProposal.listSuperseded",
    async () =>
      (
        await db
          .prepare(
            `SELECT id, ask_artifact_id FROM agent_proposal
            WHERE kind = 'skill' AND scope = ? AND target_id = ?
              AND thread_id = ? AND name = ? AND status = 'pending'`,
          )
          .bind(
            input.target.scope,
            input.target.id,
            input.threadId,
            preview.manifest.name,
          )
          .all<{ id: string; ask_artifact_id: string | null }>()
      ).results,
  );
  yield* query("agentProposal.insert", () =>
    db.batch([
      db
        .prepare(
          `UPDATE agent_proposal SET status = 'superseded', decided_at = ?
            WHERE kind = 'skill' AND scope = ? AND target_id = ?
              AND thread_id = ? AND name = ? AND status = 'pending'`,
        )
        .bind(
          createdAt,
          input.target.scope,
          input.target.id,
          input.threadId,
          preview.manifest.name,
        ),
      db
        .prepare(
          `INSERT INTO agent_proposal (
             id, kind, scope, target_id, thread_id, proposed_by_user_id, name,
             change, subject_id, current_version, note, payload_json,
             integrity, status, created_at
           ) VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .bind(
          id,
          input.target.scope,
          input.target.id,
          input.threadId,
          input.userId,
          preview.manifest.name,
          change,
          current?.skill.id ?? null,
          current?.skill.activeVersion ?? null,
          input.note,
          JSON.stringify(input.bundle),
          preview.integrity,
          createdAt,
        ),
    ]),
  );
  return {
    id,
    name: preview.manifest.name,
    change,
    currentVersion: current?.skill.activeVersion,
    integrity: preview.integrity,
    superseded,
  } as const;
});

/** A Thread's skill proposals, newest first, for the agent to follow up. */
export const threadProposals = (db: D1Database, threadId: string) =>
  query(
    "agentProposal.listForThread",
    async () =>
      (
        await db
          .prepare(
            `SELECT * FROM agent_proposal
            WHERE kind = 'skill' AND thread_id = ?
            ORDER BY created_at DESC LIMIT 50`,
          )
          .bind(threadId)
          .all<SkillProposalRow>()
      ).results,
  );

/** Pending proposals for one scope, oldest first, with each Thread's title. */
export const pendingProposals = (db: D1Database, target: SkillTarget) =>
  query(
    "agentProposal.listPending",
    async () =>
      (
        await db
          .prepare(
            `SELECT agent_proposal.*, threads.title AS thread_title
             FROM agent_proposal
             LEFT JOIN threads ON threads.id = agent_proposal.thread_id
            WHERE agent_proposal.kind = 'skill'
              AND agent_proposal.scope = ? AND agent_proposal.target_id = ?
              AND agent_proposal.status = 'pending'
            ORDER BY agent_proposal.created_at ASC`,
          )
          .bind(target.scope, target.id)
          .all<SkillProposalRow>()
      ).results,
  );

/** What the review dialog shows: everything approval would save. */
export const proposalData = Effect.fn("proposalData")(function* (
  row: SkillProposalRow,
  viewerUserId: string,
) {
  const preview = yield* previewSkillImport(JSON.parse(row.payload_json));
  // Built in its encoded form, so the timestamp decodes like any response's.
  return yield* Schema.decodeUnknownEffect(SkillProposalDataSchema)({
    id: row.id,
    change: row.change,
    name: row.name,
    ...(row.current_version === null
      ? {}
      : { currentVersion: row.current_version }),
    manifest: preview.manifest,
    instructions: preview.instructions,
    resources: preview.resources.map((resource) => ({
      path: resource.path,
      mediaType: resource.mediaType,
      sizeBytes: resource.sizeBytes,
      integrity: resource.integrity,
      content: resource.content,
    })),
    integrity: preview.integrity,
    note: row.note,
    threadId: row.thread_id,
    // Another admin may not be able to open the proposer's Thread, so only
    // the proposer sees its title.
    ...(row.thread_title === null ||
    row.thread_title === undefined ||
    row.proposed_by_user_id !== viewerUserId
      ? {}
      : { threadTitle: row.thread_title }),
    createdAt: row.created_at,
  });
});

const findPending = Effect.fn("findPendingProposal")(function* (
  db: D1Database,
  target: SkillTarget,
  proposalId: string,
) {
  const row = yield* query("agentProposal.find", () =>
    db
      .prepare(
        `SELECT * FROM agent_proposal
          WHERE id = ? AND kind = 'skill' AND scope = ? AND target_id = ?`,
      )
      .bind(proposalId, target.scope, target.id)
      .first<SkillProposalRow>(),
  );
  if (row === null) return yield* new SkillProposalNotFound();
  if (row.status !== "pending") return yield* new SkillProposalDecided();
  return row;
});

/**
 * Claims a pending proposal for one decision. A second decision, or one
 * racing this, finds it no longer pending.
 */
const claim = Effect.fn("claimProposal")(function* (
  db: D1Database,
  proposalId: string,
  status: "approved" | "rejected",
  userId: UserId,
) {
  const result = yield* query("agentProposal.claim", () =>
    db
      .prepare(
        `UPDATE agent_proposal
            SET status = ?, decided_at = ?, decided_by_user_id = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(status, new Date().toISOString(), userId, proposalId)
      .run(),
  );
  if (result.meta.changes !== 1) return yield* new SkillProposalDecided();
});

const release = (db: D1Database, proposalId: string) =>
  query("agentProposal.release", () =>
    db
      .prepare(
        `UPDATE agent_proposal
            SET status = 'pending', decided_at = NULL, decided_by_user_id = NULL
          WHERE id = ?`,
      )
      .bind(proposalId)
      .run(),
  );

interface DecisionContext {
  readonly userId: UserId;
  readonly requestId: string;
}

/**
 * Saves a pending proposal the person reviewed: a new skill switched on, or
 * a new version of the same-named skill, made active unless that skill is
 * pinned. The content must still be what the reviewer saw.
 */
export const approveProposal = Effect.fn("approveProposal")(function* (
  db: D1Database,
  target: SkillTarget,
  proposalId: string,
  reviewedIntegrity: string,
  context: DecisionContext,
) {
  const row = yield* findPending(db, target, proposalId);
  if (row.integrity !== reviewedIntegrity)
    return yield* new SkillIntegrityConflict();
  const preview = yield* previewSkillImport(JSON.parse(row.payload_json));
  if (preview.integrity !== row.integrity)
    return yield* new SkillIntegrityConflict();
  const repository = yield* SkillRepository;
  const service = yield* SkillService;
  const current = (yield* repository.list(target)).find(
    ({ skill }) => skill.name === preview.manifest.name,
  );
  if (current?.skill.pluginId !== undefined)
    return yield* new SkillImportRejected({
      field: "name",
      reason: `A plugin owns the skill ${preview.manifest.name}; it cannot take this version.`,
    });
  yield* claim(db, proposalId, "approved", context.userId);
  const saved: SkillWithVersion = yield* (
    current === undefined
      ? service.createFromPreview(target, preview, context, { enabled: true })
      : service.publishFromPreview(
          target,
          current.skill.id,
          preview,
          !current.skill.pinned,
          context,
        )
  ).pipe(
    // Any failure, interruption included, hands the proposal back for
    // another decision.
    Effect.onError(() => release(db, proposalId).pipe(Effect.ignore)),
  );
  const savedVersion = Math.max(...saved.versions);
  // The skill is saved; recording which version is only for follow-up.
  yield* query("agentProposal.result", () =>
    db
      .prepare(
        "UPDATE agent_proposal SET result_subject_id = ?, result_version = ? WHERE id = ?",
      )
      .bind(saved.skill.id, savedVersion, proposalId)
      .run(),
  ).pipe(Effect.ignore);
  yield* (yield* SettingsAudit).record({
    action: "skill_proposal.approve",
    scope: target.scope,
    outcome: "success",
    requestId: context.requestId,
    userId: context.userId,
    skillId: saved.skill.id,
    skillVersion: savedVersion,
    resourceId: proposalId,
  });
  return {
    row,
    skillId: saved.skill.id,
    version: savedVersion,
    activated: saved.skill.activeVersion === savedVersion,
    enabled: saved.skill.enabled,
  };
});

export const rejectProposal = Effect.fn("rejectProposal")(function* (
  db: D1Database,
  target: SkillTarget,
  proposalId: string,
  context: DecisionContext,
) {
  const row = yield* findPending(db, target, proposalId);
  yield* claim(db, proposalId, "rejected", context.userId);
  yield* (yield* SettingsAudit).record({
    action: "skill_proposal.reject",
    scope: target.scope,
    outcome: "success",
    requestId: context.requestId,
    userId: context.userId,
    resourceId: proposalId,
  });
  return { row };
});
