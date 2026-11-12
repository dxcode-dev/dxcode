import { PluginProposalDataSchema } from "@dx/api";
import {
  PersistenceUnavailable,
  PluginBundleRepository,
  PluginBundleSource,
  PluginId,
  PluginIntegrityConflict,
  type PluginTarget,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { SettingsAudit } from "../../audit.js";
import { MAX_PENDING_PROPOSALS } from "../../skills/proposals.js";
import {
  PluginBundleRejected,
  PluginBundleSourceUnavailable,
} from "./errors.js";
import { PluginBundleService } from "./service.js";

/**
 * Plugin installs and updates the agent proposes and a person decides
 * (plugin plan M5, agent plugin management).
 *
 * `manage_skills` files a proposal in `agent_proposal` with kind 'plugin':
 * the GitHub source pinned to the commit dx read, the bundle's integrity,
 * and what the review shows. Nothing is installed. A person who could
 * install the plugin themselves (the owner for a personal plugin, a
 * workspace admin for a workspace one) approves it on the Plugins page,
 * which installs or updates exactly that commit through
 * `PluginBundleService`, wider permissions included, since the reviewer saw
 * them listed.
 */

export class PluginProposalNotFound extends Schema.TaggedError<PluginProposalNotFound>()(
  "PluginProposalNotFound",
  {},
) {}

export class PluginProposalDecided extends Schema.TaggedError<PluginProposalDecided>()(
  "PluginProposalDecided",
  {},
) {}

/** The installed plugin changed since the agent proposed its update. */
export class PluginProposalStale extends Schema.TaggedError<PluginProposalStale>()(
  "PluginProposalStale",
  {},
) {}

/** Why the agent cannot propose this; the message is for the agent. */
export class PluginProposalRefused extends Schema.TaggedError<PluginProposalRefused>()(
  "PluginProposalRefused",
  { reason: Schema.String },
) {}

export interface PluginProposalRow {
  readonly id: string;
  readonly scope: "personal" | "workspace";
  readonly target_id: string;
  readonly thread_id: string;
  readonly proposed_by_user_id: string;
  readonly name: string;
  readonly change: "new" | "update";
  readonly subject_id: string | null;
  readonly note: string;
  readonly payload_json: string;
  readonly integrity: string;
  readonly status: "pending" | "approved" | "rejected" | "superseded";
  readonly ask_artifact_id: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly thread_title?: string | null;
}

const query = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => PersistenceUnavailable.new({ operation }, cause),
  });

const refuse = (reason: string) => new PluginProposalRefused({ reason });

/** What the agent asks for: a plugin at a GitHub URL, or an installed one's latest. */
export type PluginProposalRequest =
  | { readonly type: "url"; readonly url: string }
  | { readonly type: "installed"; readonly name: string };

/**
 * Reads the plugin, checks it would install, and files a pending proposal,
 * replacing this Thread's earlier pending one for the same plugin.
 */
export const proposePlugin = Effect.fn("proposePlugin")(function* (
  db: D1Database,
  input: {
    readonly target: PluginTarget;
    readonly threadId: string;
    readonly userId: UserId;
    readonly request: PluginProposalRequest;
    readonly note: string;
  },
) {
  const service = yield* PluginBundleService;
  const installed = yield* (yield* PluginBundleRepository).list(input.target);
  // A rejection while reading the source is the agent's to fix.
  const reading = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof PluginBundleRejected ||
        error instanceof PluginBundleSourceUnavailable
          ? refuse(error.reason)
          : error,
      ),
    );
  const proposal = yield* Effect.gen(function* () {
    if (input.request.type === "url") {
      const preview = yield* reading(
        service.preview(input.target, {
          type: "github-url",
          url: input.request.url,
        }),
      );
      const current = installed.find(
        ({ name }) => name === preview.bundle.manifest.name,
      );
      if (current === undefined) {
        const [conflict] = preview.conflicts;
        if (conflict !== undefined) return yield* refuse(conflict);
        return {
          change: "new" as const,
          current,
          preview,
          update: undefined,
        };
      }
      if (preview.source.type !== "github")
        return yield* refuse("Unreachable.");
      return {
        change: "update" as const,
        current,
        preview,
        update: yield* reading(
          service.previewUpdate(input.target, current.id, {
            type: "github-commit",
            source: preview.source,
          }),
        ),
      };
    }
    const name = input.request.name;
    const current = installed.find((bundle) => bundle.name === name);
    if (current === undefined)
      return yield* refuse(
        `No ${input.target.scope} plugin is named ${name}. Call list to see the plugins, or propose one by its GitHub URL.`,
      );
    if (current.source.type === "zip")
      return yield* refuse(
        `${name} was installed from a ZIP, so dx can't read a new version itself. Ask the person to upload the new ZIP on the Plugins page.`,
      );
    const update = yield* reading(
      service.previewUpdate(input.target, current.id),
    );
    return { change: "update" as const, current, preview: update, update };
  });
  const { update, current } = proposal;
  if (update !== undefined) {
    if (update.upToDate)
      return yield* refuse(
        `${proposal.preview.bundle.manifest.name} is already up to date with its source.`,
      );
    const [conflict] = update.conflicts;
    if (conflict !== undefined) return yield* refuse(conflict);
  }
  const { bundle, source } = proposal.preview;
  if (source.type === "zip")
    return yield* refuse("dx proposes plugins from GitHub only.");
  const name = bundle.manifest.name as string;
  const pending = yield* query("agentProposal.countPendingPlugins", () =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_proposal
          WHERE kind = 'plugin' AND scope = ? AND target_id = ?
            AND status = 'pending' AND NOT (thread_id = ? AND name = ?)`,
      )
      .bind(input.target.scope, input.target.id, input.threadId, name)
      .first<{ n: number }>(),
  );
  if ((pending?.n ?? 0) >= MAX_PENDING_PROPOSALS)
    return yield* refuse(
      `${MAX_PENDING_PROPOSALS} plugin proposals already wait for review here. Ask the person to review them first.`,
    );
  const payload = {
    source,
    manifest: bundle.manifest,
    // The review's diff is against this version; approval refuses once the
    // install has moved on, so it never grants what the review didn't show.
    ...(current === undefined ? {} : { currentIntegrity: current.integrity }),
    ...(update === undefined
      ? {}
      : {
          permissions: update.permissions,
          skills: update.skills,
          mcpServers: update.mcpServers,
        }),
  };
  const id = `apr_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const superseded = yield* query(
    "agentProposal.listSupersededPlugins",
    async () =>
      (
        await db
          .prepare(
            `SELECT id, ask_artifact_id FROM agent_proposal
              WHERE kind = 'plugin' AND scope = ? AND target_id = ?
                AND thread_id = ? AND name = ? AND status = 'pending'`,
          )
          .bind(input.target.scope, input.target.id, input.threadId, name)
          .all<{ id: string; ask_artifact_id: string | null }>()
      ).results,
  );
  yield* query("agentProposal.insertPlugin", () =>
    db.batch([
      db
        .prepare(
          `UPDATE agent_proposal SET status = 'superseded', decided_at = ?
            WHERE kind = 'plugin' AND scope = ? AND target_id = ?
              AND thread_id = ? AND name = ? AND status = 'pending'`,
        )
        .bind(
          createdAt,
          input.target.scope,
          input.target.id,
          input.threadId,
          name,
        ),
      db
        .prepare(
          `INSERT INTO agent_proposal (
             id, kind, scope, target_id, thread_id, proposed_by_user_id, name,
             change, subject_id, note, payload_json, integrity, status,
             created_at
           ) VALUES (?, 'plugin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .bind(
          id,
          input.target.scope,
          input.target.id,
          input.threadId,
          input.userId,
          name,
          proposal.change,
          current?.id ?? null,
          input.note,
          JSON.stringify(payload),
          bundle.integrity,
          createdAt,
        ),
    ]),
  );
  return {
    id,
    name,
    displayName: bundle.manifest.displayName,
    change: proposal.change,
    version: bundle.manifest.version,
    widens: update?.permissions.widens ?? false,
    superseded,
  } as const;
});

/** A Thread's plugin proposals, newest first, for the agent to follow up. */
export const threadPluginProposals = (db: D1Database, threadId: string) =>
  query(
    "agentProposal.listPluginsForThread",
    async () =>
      (
        await db
          .prepare(
            `SELECT * FROM agent_proposal
              WHERE kind = 'plugin' AND thread_id = ?
              ORDER BY created_at DESC LIMIT 50`,
          )
          .bind(threadId)
          .all<PluginProposalRow>()
      ).results,
  );

/** Pending plugin proposals for one scope, oldest first. */
export const pendingPluginProposals = (db: D1Database, target: PluginTarget) =>
  query(
    "agentProposal.listPendingPlugins",
    async () =>
      (
        await db
          .prepare(
            `SELECT agent_proposal.*, threads.title AS thread_title
               FROM agent_proposal
               LEFT JOIN threads ON threads.id = agent_proposal.thread_id
              WHERE agent_proposal.kind = 'plugin'
                AND agent_proposal.scope = ? AND agent_proposal.target_id = ?
                AND agent_proposal.status = 'pending'
              ORDER BY agent_proposal.created_at ASC`,
          )
          .bind(target.scope, target.id)
          .all<PluginProposalRow>()
      ).results,
  );

/** What the review dialog shows: everything approval would install. */
export const pluginProposalData = (
  row: PluginProposalRow,
  viewerUserId: string,
) => {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  return Schema.decodeUnknownEffect(PluginProposalDataSchema)({
    ...payload,
    id: row.id,
    change: row.change,
    name: row.name,
    ...(row.subject_id === null ? {} : { pluginId: row.subject_id }),
    integrity: row.integrity,
    note: row.note,
    threadId: row.thread_id,
    // Another admin may not be able to open the proposer's Thread.
    ...(row.thread_title === null ||
    row.thread_title === undefined ||
    row.proposed_by_user_id !== viewerUserId
      ? {}
      : { threadTitle: row.thread_title }),
    createdAt: row.created_at,
  });
};

const findPending = Effect.fn("findPendingPluginProposal")(function* (
  db: D1Database,
  target: PluginTarget,
  proposalId: string,
) {
  const row = yield* query("agentProposal.findPlugin", () =>
    db
      .prepare(
        `SELECT * FROM agent_proposal
          WHERE id = ? AND kind = 'plugin' AND scope = ? AND target_id = ?`,
      )
      .bind(proposalId, target.scope, target.id)
      .first<PluginProposalRow>(),
  );
  if (row === null) return yield* new PluginProposalNotFound();
  if (row.status !== "pending") return yield* new PluginProposalDecided();
  return row;
});

const claim = Effect.fn("claimPluginProposal")(function* (
  db: D1Database,
  proposalId: string,
  status: "approved" | "rejected",
  userId: UserId,
) {
  const result = yield* query("agentProposal.claimPlugin", () =>
    db
      .prepare(
        `UPDATE agent_proposal
            SET status = ?, decided_at = ?, decided_by_user_id = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(status, new Date().toISOString(), userId, proposalId)
      .run(),
  );
  if (result.meta.changes !== 1) return yield* new PluginProposalDecided();
});

const release = (db: D1Database, proposalId: string) =>
  query("agentProposal.releasePlugin", () =>
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
 * Installs or updates the reviewed commit. The bundle dx reads again must
 * still have the integrity the reviewer saw.
 */
export const approvePluginProposal = Effect.fn("approvePluginProposal")(
  function* (
    db: D1Database,
    target: PluginTarget,
    proposalId: string,
    reviewedIntegrity: string,
    context: DecisionContext,
  ) {
    const row = yield* findPending(db, target, proposalId);
    if (row.integrity !== reviewedIntegrity)
      return yield* new PluginIntegrityConflict();
    const payload = JSON.parse(row.payload_json) as {
      source: unknown;
      currentIntegrity?: string;
    };
    const source = yield* Schema.decodeUnknownEffect(PluginBundleSource)(
      payload.source,
    );
    if (source.type === "zip") return yield* new PluginIntegrityConflict();
    // A shared copy reads its link again; the integrity check below catches
    // a shared install that moved on since the review.
    const input =
      source.type === "github"
        ? ({ type: "github-commit", source } as const)
        : ({ type: "share-latest", linkId: source.linkId } as const);
    const integrity = row.integrity as never;
    const service = yield* PluginBundleService;
    if (row.change === "update" && row.subject_id !== null) {
      const pluginId = yield* Schema.decodeUnknownEffect(PluginId)(
        row.subject_id,
      );
      const installed = yield* (yield* PluginBundleRepository).find(
        target,
        pluginId,
      );
      if (installed.integrity !== payload.currentIntegrity)
        return yield* new PluginProposalStale();
    }
    yield* claim(db, proposalId, "approved", context.userId);
    const saved = yield* (
      row.change === "new" || row.subject_id === null
        ? service.install(target, input, integrity, context)
        : Schema.decodeUnknownEffect(PluginId)(row.subject_id).pipe(
            Effect.flatMap((pluginId) =>
              service.update(
                target,
                pluginId,
                input,
                integrity,
                context,
                // The reviewer saw the permissions this update adds.
                true,
              ),
            ),
          )
    ).pipe(Effect.onError(() => release(db, proposalId).pipe(Effect.ignore)));
    yield* query("agentProposal.pluginResult", () =>
      db
        .prepare("UPDATE agent_proposal SET result_subject_id = ? WHERE id = ?")
        .bind(saved.id, proposalId)
        .run(),
    ).pipe(Effect.ignore);
    yield* (yield* SettingsAudit).record({
      action: "plugin_proposal.approve",
      scope: target.scope,
      outcome: "success",
      requestId: context.requestId,
      userId: context.userId,
      pluginId: saved.id,
      pluginVersion: saved.version,
      resourceId: proposalId,
    });
    return { row, plugin: saved };
  },
);

export const rejectPluginProposal = Effect.fn("rejectPluginProposal")(
  function* (
    db: D1Database,
    target: PluginTarget,
    proposalId: string,
    context: DecisionContext,
  ) {
    const row = yield* findPending(db, target, proposalId);
    yield* claim(db, proposalId, "rejected", context.userId);
    yield* (yield* SettingsAudit).record({
      action: "plugin_proposal.reject",
      scope: target.scope,
      outcome: "success",
      requestId: context.requestId,
      userId: context.userId,
      resourceId: proposalId,
    });
    return { row };
  },
);
