import { formatGitHubDelivery } from "@dx/api";
import type { Bindings } from "../http/types.js";
import { automationLogger } from "../logging.js";
import {
  ciEvent,
  type FilterKind,
  fromWebhook,
  type GitHubEvent,
  type GitHubHappening,
  githubToken,
  pullSubject,
  readCi,
} from "./github.js";
import {
  automaticCiOn,
  createSubscription,
  DEFAULT_LIFETIME_MS,
  filterOf,
  finishSubscription,
  listeningSubscriptions,
  markEvent,
  noteDeliveryFailure,
  recordNewEvents,
  type SubscriptionRow,
  savePullSubject,
} from "./subscriptions.js";
import { message, threadState } from "./sweep.js";
import {
  deliverMessage,
  selectionFor,
  startThread,
  type WakeTarget,
} from "./wake.js";

/**
 * GitHub events reach subscriptions here, from the dx GitHub App's verified
 * webhook (`source-control/github/webhooks.ts`). A webhook names the
 * repository and the commit, PR, or issue; each active subscription it
 * matches delivers once per event key, waking its Thread the way a schedule
 * does. A failed delivery is recorded on the subscription and not retried.
 */

const KINDS: Record<GitHubHappening["kind"], ReadonlyArray<FilterKind>> = {
  ci: ["ci"],
  conversation: ["pr-comments", "issue-comments"],
  opened: ["issue-opened", "pr-opened"],
};

const matches = (row: SubscriptionRow, happening: GitHubHappening) => {
  const filter = filterOf(row);
  switch (happening.kind) {
    case "ci":
      return filter.commitSha === happening.sha;
    case "conversation":
      return happening.pull
        ? row.filter_kind === "pr-comments" &&
            filter.prNumber === happening.number
        : row.filter_kind === "issue-comments" &&
            filter.issueNumber === happening.number;
    case "opened":
      return (
        row.filter_kind === (happening.pull ? "pr-opened" : "issue-opened") &&
        (filter.label === undefined || happening.labels.includes(filter.label))
      );
  }
};

/** The event this subscription delivers, or none yet. */
const eventFor = async (
  bindings: Bindings,
  db: D1Database,
  row: SubscriptionRow,
  happening: GitHubHappening,
): Promise<GitHubEvent | undefined> => {
  if (happening.kind !== "ci") return happening.event;
  // One check settling says little: read the whole rollup as the owner.
  const token = await githubToken(
    bindings,
    db,
    row.thread_id,
    row.owner_user_id,
  );
  if (token === undefined)
    throw new Error(
      "No GitHub credentials to read CI: connect GitHub in Settings → Integrations.",
    );
  const filter = filterOf(row);
  const state = await readCi(token, row.repository, filter);
  return state?.done === true
    ? ciEvent(row.repository, filter, state)
    : undefined;
};

const deliverTo = async (
  bindings: Bindings,
  db: D1Database,
  row: SubscriptionRow,
  happening: GitHubHappening,
  now: Date,
  waitUntil?: (promise: Promise<unknown>) => void,
) => {
  const thread = await threadState(db, row.thread_id);
  if (thread === null || thread.lifecycle_state !== "active") {
    await finishSubscription(
      db,
      row.id,
      "failed",
      "Its Thread was archived.",
      now,
    );
    return;
  }
  const event = await eventFor(bindings, db, row, happening);
  if (event === undefined) return;
  const [fresh] = await recordNewEvents(db, row.id, [event], now);
  if (fresh === undefined) return;
  const finished =
    happening.kind === "ci"
      ? `CI on ${event.commit?.sha.slice(0, 7)} finished.`
      : happening.kind === "conversation" &&
          (happening.ends === "merged" || happening.ends === "closed")
        ? `${happening.pull ? "PR" : "Issue"} #${happening.number} was ${happening.ends}.`
        : undefined;
  const target: WakeTarget = {
    bindings,
    ownerUserId: row.owner_user_id,
    automation: "github",
    ...(waitUntil === undefined ? {} : { waitUntil }),
  };
  const send = sendFor(db, row, target, thread.project_id);
  try {
    await send(fresh, finished);
  } catch (error) {
    // Forgotten, so redelivering the webhook from GitHub delivers it.
    await db
      .prepare(
        "DELETE FROM github_subscription_event WHERE subscription_id = ? AND event_key = ?",
      )
      .bind(row.id, fresh.key.slice(0, 200))
      .run();
    throw error;
  }
  if (finished !== undefined)
    await finishSubscription(db, row.id, "finished", finished, now);
  automationLogger.info("GitHub subscription delivered an event.", {
    event: "github_subscription_delivered",
    subscriptionId: row.id,
    kind: fresh.kind,
  });
};

const sendFor =
  (
    db: D1Database,
    row: SubscriptionRow,
    target: WakeTarget,
    projectId: string,
  ) =>
  async (fresh: GitHubEvent, finished: string | undefined) => {
    if (row.destination === "this-thread")
      await deliverMessage(
        target,
        row.thread_id,
        formatGitHubDelivery({
          subscription: {
            id: row.id,
            title: row.title,
            repository: row.repository,
          },
          events: [fresh],
          ...(finished === undefined ? {} : { finished }),
        }),
        `github:${row.id}:${fresh.key}`,
      );
    else {
      const started = await startThread(target, {
        parentThreadId: row.thread_id,
        projectId: row.project_id ?? projectId,
        title:
          `${row.title}: #${fresh.subject?.number ?? ""} ${fresh.subject?.title ?? ""}`.trim(),
        prompt: [
          row.instructions ??
            "Fetch the linked GitHub issue or pull request with gh and summarize it.",
          formatGitHubDelivery({
            subscription: {
              id: row.id,
              title: row.title,
              repository: row.repository,
            },
            events: [fresh],
          }),
        ].join("\n\n"),
        selection: await selectionFor(db, row.thread_id, row.agent_mode),
        key: `github:${row.id}:${fresh.key}`,
      });
      await markEvent(db, row.id, fresh.key, "started", started);
    }
  };

const deliverSafely = (
  bindings: Bindings,
  db: D1Database,
  row: SubscriptionRow,
  happening: GitHubHappening,
  now: Date,
  waitUntil?: (promise: Promise<unknown>) => void,
) =>
  deliverTo(bindings, db, row, happening, now, waitUntil).catch(
    async (cause) => {
      automationLogger.warn("GitHub subscription delivery failed.", {
        event: "github_subscription_delivery_failed",
        subscriptionId: row.id,
        cause,
      });
      await noteDeliveryFailure(db, row.id, message(cause), now).catch(
        () => undefined,
      );
    },
  );

/**
 * Reads a CI subscription's commit once when it starts watching: its checks
 * may have finished before it existed, and no webhook comes again for them.
 */
export const catchUpCi = async (
  bindings: Bindings,
  row: SubscriptionRow,
  waitUntil?: (promise: Promise<unknown>) => void,
) => {
  const sha = filterOf(row).commitSha;
  const db = bindings.DB;
  if (
    db === undefined ||
    row.filter_kind !== "ci" ||
    row.enabled !== 1 ||
    row.state !== "active" ||
    sha === undefined
  )
    return;
  // A webhook delivers it later if this read fails; nothing to note.
  await deliverTo(
    bindings,
    db,
    row,
    { kind: "ci", repository: row.repository, sha },
    new Date(),
    waitUntil,
  ).catch((cause) =>
    automationLogger.info("Reading a new CI subscription's checks failed.", {
      event: "github_subscription_catch_up_failed",
      subscriptionId: row.id,
      cause,
    }),
  );
};

/** How long after its last activity a Thread may still have opened a PR. */
const OPENER_WINDOW_MS = 10 * 60_000;

/**
 * The Thread that opened a PR: the one active Thread of the dx person whose
 * GitHub login authored it, in a Project bound to its repository, working
 * now or active within the window. A Thread's `gh` runs as its owner, so
 * nothing else names it. Ambiguous or none: no Thread.
 */
const openingThread = async (
  db: D1Database,
  repository: string,
  author: string,
  now: Date,
) => {
  const rows = (
    await db
      .prepare(
        `SELECT t.id, t.owner_user_id, t.project_id, t.activity_status
           FROM threads AS t
           JOIN project_repository AS r
             ON r.project_id = t.project_id AND r.provider = 'github'
            AND r.full_name = ?1 COLLATE NOCASE
           JOIN github_user_authorization AS g
             ON g.user_id = t.owner_user_id
            AND g.provider_account_login = ?2 COLLATE NOCASE AND g.status = 'active'
          WHERE t.lifecycle_state = 'active'
            AND (t.activity_status = 'working' OR t.last_activity_at >= ?3)
          LIMIT 10`,
      )
      .bind(
        repository,
        author,
        new Date(now.getTime() - OPENER_WINDOW_MS).toISOString(),
      )
      .all<{
        id: string;
        owner_user_id: string;
        project_id: string;
        activity_status: string;
      }>()
  ).results;
  const working = rows.filter((row) => row.activity_status === "working");
  const chosen =
    working.length === 1 ? working[0] : rows.length === 1 ? rows[0] : undefined;
  if (chosen === undefined && rows.length > 1)
    automationLogger.info(
      "A new PR matched several Threads; none follows it.",
      {
        event: "github_pull_request_unclaimed",
        candidates: rows.length,
      },
    );
  return chosen;
};

/**
 * A PR its Thread opened is followed without the agent asking: its
 * comments, reviews, and merge, and CI on its head, which each push to the
 * branch moves on.
 */
const followPullRequest = async (
  bindings: Bindings,
  db: D1Database,
  action: string,
  payload: Record<string, unknown>,
  now: Date,
  waitUntil?: (promise: Promise<unknown>) => void,
) => {
  const pull = (payload.pull_request ?? {}) as {
    number?: number;
    user?: { login?: string };
    head?: { sha?: string; ref?: string };
  };
  const repository = (payload.repository as { full_name?: string } | undefined)
    ?.full_name;
  const sha = pull.head?.sha;
  const branch = pull.head?.ref;
  if (
    repository === undefined ||
    typeof pull.number !== "number" ||
    sha === undefined ||
    branch === undefined
  )
    return;
  const ciFrom = (
    row: SubscriptionRow | undefined,
    thread: {
      threadId: string;
      ownerUserId: string;
    },
  ) =>
    createSubscription(
      db,
      thread.ownerUserId,
      {
        title: row?.title ?? `PR #${pull.number} CI`,
        repository,
        kind: "ci",
        filter: {
          ...(row === undefined ? {} : filterOf(row)),
          commitSha: sha,
          branch,
        },
        destination: "this-thread",
        threadId: thread.threadId,
        projectId: null,
        agentMode: null,
        instructions: null,
        automatic: true,
        expiresAt:
          row?.expires_at ??
          new Date(now.getTime() + DEFAULT_LIFETIME_MS).toISOString(),
      },
      now,
    );
  if (action === "synchronize") {
    // Each automatic CI follow-up on this branch moves to the new head.
    for (const row of await automaticCiOn(db, repository, branch)) {
      const { row: moved } = await ciFrom(row, {
        threadId: row.thread_id,
        ownerUserId: row.owner_user_id,
      });
      await catchUpCi(bindings, moved, waitUntil);
    }
    return;
  }
  if (action !== "opened" && action !== "reopened") return;
  const author = pull.user?.login;
  if (author === undefined) return;
  const thread = await openingThread(db, repository, author, now);
  if (thread === undefined) return;
  const owner = { threadId: thread.id, ownerUserId: thread.owner_user_id };
  await createSubscription(
    db,
    owner.ownerUserId,
    {
      title: `PR #${pull.number} comments and reviews`,
      repository,
      kind: "pr-comments",
      filter: { prNumber: pull.number },
      destination: "this-thread",
      threadId: owner.threadId,
      projectId: null,
      agentMode: null,
      instructions: null,
      automatic: true,
      expiresAt: new Date(now.getTime() + DEFAULT_LIFETIME_MS).toISOString(),
    },
    now,
  );
  const { row: ci } = await ciFrom(undefined, owner);
  automationLogger.info("A Thread follows the PR it opened.", {
    event: "github_pull_request_followed",
    threadId: owner.threadId,
  });
  await catchUpCi(bindings, ci, waitUntil);
};

/** Keeps the header's title, description, and state of a followed PR. */
const savePullFromWebhook = async (
  db: D1Database,
  action: string,
  payload: Record<string, unknown>,
) => {
  if (!["opened", "edited", "closed", "reopened"].includes(action)) return;
  const pull = payload.pull_request as { number?: unknown } | undefined;
  const repository = (payload.repository as { full_name?: string } | undefined)
    ?.full_name;
  const subject = pullSubject(pull);
  if (
    repository === undefined ||
    typeof pull?.number !== "number" ||
    subject === undefined
  )
    return;
  await savePullSubject(db, repository, pull.number, subject).catch((cause) =>
    automationLogger.warn("Saving a PR's title failed.", {
      event: "github_pull_request_save_failed",
      cause,
    }),
  );
};

/**
 * Delivers one verified webhook to the subscriptions it matches. Never
 * throws: a failure is noted on its subscription and the rest go on.
 */
export const deliverGitHubWebhook = async (
  bindings: Bindings,
  event: string,
  action: string,
  payload: Record<string, unknown>,
  waitUntil?: (promise: Promise<unknown>) => void,
  now = new Date(),
) => {
  const db = bindings.DB;
  if (db === undefined) return 0;
  if (event === "pull_request") {
    await followPullRequest(
      bindings,
      db,
      action,
      payload,
      now,
      waitUntil,
    ).catch((cause) =>
      automationLogger.warn("Following a new PR failed.", {
        event: "github_pull_request_follow_failed",
        cause,
      }),
    );
    await savePullFromWebhook(db, action, payload);
  }
  const happening = fromWebhook(event, action, payload);
  if (happening === undefined) return 0;
  const rows = (
    await listeningSubscriptions(
      db,
      happening.repository,
      KINDS[happening.kind],
      now,
    )
  ).filter((row) => matches(row, happening));
  await Promise.all(
    rows.map((row) =>
      deliverSafely(bindings, db, row, happening, now, waitUntil),
    ),
  );
  return rows.length;
};
