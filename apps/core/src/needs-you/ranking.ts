import type {
  NeedsYouItem,
  NeedsYouRankedItem,
  NeedsYouRanking,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { notificationLogger } from "../logging.js";

/**
 * Needs-you Prioritize (#1447): one Workers AI call to Cloudflare's Clef, a
 * decision model that answers typed questions about a state. It is not a
 * Thread and uses no Orb or Claude plan. The state holds only the person's
 * own asks. For each ask, Clef scores how urgently to unblock it and picks
 * why from reasons dx defines, so every word the page shows is dx's: the
 * answer is untrusted, and only in-range scores and known choices for the
 * questions dx asked count.
 */

/** Clef models on Workers AI; the first is the default. */
export const RANKING_MODELS = [
  {
    model: "@cf/cloudflare/clef-flash",
    selector: "clef-flash",
    name: "Clef Flash",
  },
  { model: "@cf/cloudflare/clef", selector: "clef", name: "Clef" },
] as const;

export type RankingModelId = (typeof RANKING_MODELS)[number]["model"];

export const DEFAULT_RANKING_MODEL: RankingModelId = RANKING_MODELS[0].model;

/** Clef answers at most 64 questions a call; each ask takes two. */
const ASKS_PER_CALL = 32;
const ASK_LIMIT = 300;
const CALL_TIMEOUT_MS = 60_000;

/** Lowest first, as Clef's score rubric reads them. */
const URGENCY = [
  "Can wait: nothing depends on it",
  "This week",
  "Today: it holds up the Thread's own work",
  "Unblock first: a p0, an outage, a broken shipped feature, or it blocks releases, CI, previews, tooling, or other asks",
];

/** Why an ask matters, in dx's words. */
export const RANKING_REASONS = {
  outage: "A p0, an outage, or a broken shipped feature.",
  unblocks: "Unblocks other work: releases, CI, previews, or tooling.",
  merge: "An approval of work that is ready to merge.",
  decision: "A design or product decision only you can make.",
  retry: "A failed turn to look at and retry.",
  routine: "Routine; it can wait.",
} as const;

type Reason = keyof typeof RANKING_REASONS;

export interface RankingModel {
  readonly model: string;
  readonly name: string;
  readonly connectionName: string;
}

/**
 * The Clef models the deployment can rank with: none without its Workers
 * AI binding, or when a self-hosted deployment turned Workers AI off.
 */
export const rankingModels = (
  bindings: Bindings,
): ReadonlyArray<RankingModel> =>
  bindings.AI === undefined || bindings.DX_MODEL_WORKERS_AI_ENABLED === "false"
    ? []
    : RANKING_MODELS.map(({ model, name }) => ({
        model,
        name,
        connectionName: "Cloudflare Workers AI",
      }));

/** The saved model if it can still rank, else the default, else none. */
export const defaultRankingModel = (
  models: ReadonlyArray<RankingModel>,
  saved?: string,
) =>
  (
    models.find(({ model }) => model === saved) ??
    models.find(({ model }) => model === DEFAULT_RANKING_MODEL) ??
    models[0]
  )?.model;

const hoursWaited = (requestedAt: string, now: number) => {
  const hours = (now - Date.parse(requestedAt)) / 3_600_000;
  return Number.isFinite(hours) ? Math.max(0, Math.round(hours)) : 0;
};

/** The person's own inbox, each ask under a short alias. */
export const rankingState = (
  items: ReadonlyArray<NeedsYouItem>,
  now = Date.now(),
) => ({
  inbox:
    "A software team owner's inbox: AI agent Threads waiting on the owner for an answer or an approval, or Threads whose last turn failed. Asks that share a linked issue or pull request are related.",
  asks: items.map((item, index) => ({
    ask: `a${index + 1}`,
    thread: item.threadTitle,
    ...(item.projectName === "" ? {} : { project: item.projectName }),
    kind: item.kind,
    ...(item.summary === undefined
      ? {}
      : { request: item.summary.slice(0, ASK_LIMIT) }),
    waitedHours: hoursWaited(item.requestedAt, now),
    links: (item.links ?? []).map(
      (link) =>
        `${link.repository}#${link.number} ${link.kind === "pull" ? "pull request" : "issue"} ${link.state}${link.title === undefined ? "" : `: ${link.title}`}`,
    ),
  })),
});

/** Two questions per ask in one batch: its urgency and its reason. */
export const rankingQuestions = (
  aliases: ReadonlyArray<string>,
): Record<string, unknown> =>
  Object.fromEntries(
    aliases.flatMap((alias) => [
      [
        `${alias}.urgency`,
        {
          type: "score",
          instructions: {
            question:
              "How urgently should the owner unblock this ask, compared with the rest of the inbox?",
            ask: alias,
          },
          criteria: URGENCY,
        },
      ],
      [
        `${alias}.why`,
        {
          type: "choice",
          instructions: {
            question: "What best describes why this ask matters?",
            ask: alias,
          },
          criteria: RANKING_REASONS,
        },
      ],
    ]),
  );

export type RankingCall =
  | { readonly ok: true; readonly answers: Record<string, unknown> }
  | { readonly ok: false };

/** Runs one Clef call; never rejects. Tests replace it. */
export type RankingCaller = (input: {
  readonly bindings: Bindings;
  readonly model: RankingModelId;
  readonly state: unknown;
  readonly questions: Record<string, unknown>;
}) => Promise<RankingCall>;

export const workersAiRanking: RankingCaller = async ({
  bindings,
  model,
  state,
  questions,
}) => {
  const selector = RANKING_MODELS.find(
    (entry) => entry.model === model,
  )?.selector;
  if (bindings.AI === undefined || selector === undefined) return { ok: false };
  try {
    const run = bindings.AI.run as (
      model: string,
      input: unknown,
      options?: unknown,
    ) => Promise<unknown>;
    const response = await Promise.race([
      run.call(bindings.AI, model, { model: selector, state, questions }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Clef did not answer in time.")),
          CALL_TIMEOUT_MS,
        ),
      ),
    ]);
    const answers =
      typeof response === "object" && response !== null
        ? (response as { answers?: unknown }).answers
        : undefined;
    return typeof answers === "object" && answers !== null
      ? { ok: true, answers: answers as Record<string, unknown> }
      : { ok: false };
  } catch (cause) {
    notificationLogger.warn("Needs-you ranking call failed.", {
      event: "needs_you_ranking_call_failed",
      model,
      cause,
    });
    return { ok: false };
  }
};

const URGENCY_TOP = URGENCY.length - 1;

/** A score in Clef's range, or undefined. */
const urgencyOf = (answer: unknown) => {
  const score = (answer as { type?: unknown; score?: unknown } | null)?.score;
  return (answer as { type?: unknown } | null)?.type === "score" &&
    typeof score === "number" &&
    Number.isFinite(score) &&
    score >= 0 &&
    score <= URGENCY_TOP
    ? score
    : undefined;
};

/** One of dx's reasons, or undefined. */
const reasonOf = (answer: unknown): Reason | undefined => {
  const choice = (answer as { choice?: unknown } | null)?.choice;
  return (answer as { type?: unknown } | null)?.type === "choice" &&
    typeof choice === "string" &&
    Object.hasOwn(RANKING_REASONS, choice)
    ? (choice as Reason)
    : undefined;
};

const KIND_ORDER = { approval: 0, failed: 1, question: 2 } as const;

/**
 * Ranks the person's asks from Clef's answers, in as many calls as the
 * inbox needs. Undefined when no call answered usably.
 */
export const rankNeedsYou = async (
  call: RankingCaller,
  bindings: Bindings,
  model: RankingModelId,
  items: ReadonlyArray<NeedsYouItem>,
  now = Date.now(),
): Promise<ReadonlyArray<NeedsYouRankedItem> | undefined> => {
  const state = rankingState(items, now);
  const aliases = items.map((_, index) => `a${index + 1}`);
  const batches: string[][] = [];
  for (let start = 0; start < aliases.length; start += ASKS_PER_CALL)
    batches.push(aliases.slice(start, start + ASKS_PER_CALL));
  const results = await Promise.all(
    batches.map((batch) =>
      call({ bindings, model, state, questions: rankingQuestions(batch) }),
    ),
  );
  const answers = new Map<string, unknown>();
  results.forEach((result, index) => {
    if (!result.ok) return;
    for (const alias of batches[index] ?? [])
      for (const suffix of ["urgency", "why"])
        if (Object.hasOwn(result.answers, `${alias}.${suffix}`))
          answers.set(
            `${alias}.${suffix}`,
            result.answers[`${alias}.${suffix}`],
          );
  });
  const scored = items.map((item, index) => ({
    item,
    index,
    urgency: urgencyOf(answers.get(`a${index + 1}.urgency`)),
    reason: reasonOf(answers.get(`a${index + 1}.why`)),
  }));
  if (scored.every(({ urgency }) => urgency === undefined)) return undefined;
  // Asks sharing a linked issue or pull request form a group, named by it.
  const sharing = new Map<string, number>();
  for (const { links } of items)
    for (const ref of new Set(
      (links ?? []).map(({ repository, number }) => `${repository}#${number}`),
    ))
      sharing.set(ref, (sharing.get(ref) ?? 0) + 1);
  const groupOf = (item: NeedsYouItem) =>
    (item.links ?? [])
      .map(({ repository, number }) => `${repository}#${number}`)
      .find((ref) => (sharing.get(ref) ?? 0) > 1);
  return scored
    .sort(
      (a, b) =>
        (b.urgency ?? -1) - (a.urgency ?? -1) ||
        KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
        Date.parse(a.item.requestedAt) - Date.parse(b.item.requestedAt) ||
        a.index - b.index,
    )
    .map(({ item, urgency, reason }) => {
      const group = groupOf(item);
      return {
        threadId: item.threadId,
        threadTitle: item.threadTitle,
        projectName: item.projectName,
        kind: item.kind,
        ...(urgency === undefined || reason === undefined
          ? {}
          : { why: RANKING_REASONS[reason] }),
        ...(group === undefined ? {} : { group }),
        links: item.links ?? [],
      };
    });
};

/** The person's last ranking, or undefined. */
export const loadRanking = async (
  db: D1Database,
  userId: UserId,
): Promise<NeedsYouRanking | undefined> => {
  const row = await db
    .prepare(
      `SELECT model, ranking_json, ranked_at FROM needs_you_ranking
        WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<{ model: string; ranking_json: string; ranked_at: string }>();
  if (row === null) return undefined;
  try {
    const saved = JSON.parse(row.ranking_json) as {
      modelName: string;
      items: ReadonlyArray<NeedsYouRankedItem>;
    };
    return {
      rankedAt: row.ranked_at,
      model: row.model,
      modelName: saved.modelName,
      items: saved.items,
    };
  } catch {
    return undefined;
  }
};

/** Replaces the person's ranking with this one. */
export const saveRanking = (
  db: D1Database,
  userId: UserId,
  ranking: NeedsYouRanking,
) =>
  db
    .prepare(
      `INSERT INTO needs_you_ranking (user_id, model, ranking_json, ranked_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (user_id) DO UPDATE SET
         model = excluded.model, ranking_json = excluded.ranking_json,
         ranked_at = excluded.ranked_at`,
    )
    .bind(
      userId,
      ranking.model,
      JSON.stringify({ modelName: ranking.modelName, items: ranking.items }),
      ranking.rankedAt,
    )
    .run();
