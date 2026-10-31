import type { GitHubDeliveryEvent } from "@dx/api";
import { Effect, Redacted, Result } from "effect";
import type { Bindings } from "../http/types.js";
import { resolveExecutionEnvironment } from "../settings/environment-variables/execution.js";
import { readGitHubUserAccessToken } from "../source-control/github/control-plane.js";

/**
 * GitHub event subscriptions are driven by the dx GitHub App's webhooks:
 * a verified delivery names a repository and a commit, PR, or issue, and
 * `fromWebhook` turns it into events. To read a commit's whole check rollup
 * when one of its checks settles, dx uses the token the Thread's own `gh`
 * would: the owner's GITHUB_TOKEN for the Thread, else their dx GitHub
 * connection, so a subscription never sees more than its owner can.
 */

export const FILTER_KINDS = [
  "ci",
  "pr-comments",
  "issue-comments",
  "issue-opened",
  "pr-opened",
] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];

export interface SubscriptionFilter {
  readonly commitSha?: string;
  readonly branch?: string;
  readonly ciEvent?: "workflow_run" | "check_run" | "status";
  readonly workflowFile?: string;
  readonly workflow?: string;
  readonly checkName?: string;
  readonly statusContext?: string;
  readonly prNumber?: number;
  readonly issueNumber?: number;
  readonly label?: string;
}

/**
 * One thing that happened, as delivered (see `@dx/api`'s github-delivery),
 * with a key: a subscription delivers each key once.
 */
export interface GitHubEvent extends GitHubDeliveryEvent {
  readonly key: string;
  /** For new-thread delivery: the issue or PR this is about. */
  readonly subject?: { readonly number: number; readonly title: string };
  /** A CI result's commit and checks, kept for the Thread header. */
  readonly detail?: CiDetail;
}

export interface CiDetail {
  readonly sha: string;
  readonly branch?: string;
  readonly result: "passed" | "failed" | "finished";
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly result: string;
  }>;
}

/** What the Thread header shows of a pull request. */
export interface PullSubject {
  readonly title: string;
  readonly summary: string;
  readonly state: "open" | "merged" | "closed";
  readonly changedAt?: string;
}

/**
 * A pull request as GitHub's REST API and its webhooks both describe it,
 * reduced to what the header lists. The description's opening is collapsed
 * to one line.
 */
export const pullSubject = (value: unknown): PullSubject | undefined => {
  const pull = (typeof value === "object" && value !== null ? value : {}) as {
    title?: unknown;
    body?: unknown;
    state?: unknown;
    merged?: unknown;
    merged_at?: unknown;
    closed_at?: unknown;
    created_at?: unknown;
  };
  if (typeof pull.title !== "string") return undefined;
  const text = (key: unknown) => (typeof key === "string" ? key : undefined);
  const merged = pull.merged === true || text(pull.merged_at) !== undefined;
  const state = merged ? "merged" : pull.state === "closed" ? "closed" : "open";
  const changedAt =
    state === "merged"
      ? text(pull.merged_at)
      : state === "closed"
        ? text(pull.closed_at)
        : text(pull.created_at);
  return {
    title: pull.title.slice(0, 300),
    summary: (text(pull.body) ?? "")
      .replaceAll(/\s+/g, " ")
      .trim()
      .slice(0, 200),
    state,
    ...(changedAt === undefined ? {} : { changedAt }),
  };
};

/** Reads one pull request once, for a subscription made after it opened. */
export const readPullSubject = async (
  token: string,
  repository: string,
  number: number,
) =>
  pullSubject(
    await get<unknown>(token, `/repos/${repository}/pulls/${number}`),
  );

/**
 * Reads an issue or a pull request by number: GitHub numbers both in one
 * sequence, and its issues API answers for both.
 */
export const readItemSubject = async (
  token: string,
  repository: string,
  number: number,
) => {
  const item = await get<{ pull_request?: unknown }>(
    token,
    `/repos/${repository}/issues/${number}`,
  );
  return item.pull_request === undefined
    ? { kind: "issue" as const, subject: pullSubject(item) }
    : {
        kind: "pull" as const,
        subject: await readPullSubject(token, repository, number),
      };
};

export class GitHubUnavailable extends Error {
  override readonly name = "GitHubUnavailable";
}

const API = "https://api.github.com";

/** The token the Thread's `gh` would use, or undefined. */
export const githubToken = async (
  bindings: Bindings,
  db: D1Database,
  threadId: string,
  ownerUserId: string,
): Promise<string | undefined> => {
  const environment = await Effect.runPromise(
    Effect.result(resolveExecutionEnvironment(bindings, threadId)),
  );
  if (Result.isSuccess(environment)) {
    // GH_TOKEN is reserved for dx's gh wrapper; GITHUB_TOKEN is the owner's.
    const value = environment.success.values.find(
      ({ name }) => name === "GITHUB_TOKEN",
    );
    const token = value === undefined ? "" : Redacted.value(value.value).trim();
    if (token !== "") return token;
  }
  try {
    return await readGitHubUserAccessToken(bindings, db, ownerUserId);
  } catch {
    return undefined;
  }
};

const request = async <T>(
  token: string,
  path: string,
): Promise<{
  readonly body: T;
  readonly link: string | null;
}> => {
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "dx-automations",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (response.status === 404)
    throw new GitHubUnavailable(
      `GitHub answered 404 for ${path.split("?")[0]}: the repository or item does not exist or this token cannot see it.`,
    );
  if (!response.ok)
    throw new GitHubUnavailable(
      `GitHub answered ${response.status} for ${path.split("?")[0]}.`,
    );
  return {
    body: (await response.json()) as T,
    link: response.headers.get("link"),
  };
};

const get = async <T>(token: string, path: string) =>
  (await request<T>(token, path)).body;

export const isRepository = (value: string) =>
  /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(value) &&
  !value.endsWith("/.") &&
  !value.endsWith("/..");

/**
 * Whether the dx GitHub App is installed on the repository, which is where
 * its webhooks, and so every subscription event, come from.
 */
export const appHearsRepository = async (db: D1Database, repository: string) =>
  (await db
    .prepare(
      `SELECT 1 AS found FROM github_installation_repository AS r
         JOIN github_installation AS i ON i.installation_id = r.installation_id
        WHERE r.full_name = ? COLLATE NOCASE AND i.status = 'active' LIMIT 1`,
    )
    .bind(repository)
    .first<number>("found")) !== null;

/** Checks the token reaches the repository. */
export const checkRepository = (token: string, repository: string) =>
  get<{ full_name: string }>(token, `/repos/${repository}`);

/** The full SHA for a pushed commit or a prefix of at least 7 characters. */
export const resolveCommit = async (
  token: string,
  repository: string,
  sha: string,
) =>
  (await get<{ sha: string }>(token, `/repos/${repository}/commits/${sha}`))
    .sha;

const excerpt = (text: string | null | undefined, limit = 600) => {
  const trimmed = (text ?? "").trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
};

const short = (sha: string) => sha.slice(0, 7);

interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string | null;
}
interface CommitStatus {
  readonly context: string;
  readonly state: string;
  readonly target_url: string | null;
  readonly description: string | null;
}
interface WorkflowRun {
  readonly id: number;
  readonly name: string | null;
  readonly path: string;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly run_attempt?: number;
}

/** One CI result: done or not, its outcome, and its parts. */
export interface CiState {
  readonly done: boolean;
  readonly outcome: string;
  readonly parts: ReadonlyArray<{
    readonly name: string;
    readonly result: string;
    readonly url?: string;
  }>;
  readonly url?: string;
}

const failing = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "error",
  "stale",
]);

/** The commit's CI as the subscription's filter sees it, if it has any. */
export const readCi = async (
  token: string,
  repository: string,
  filter: SubscriptionFilter,
): Promise<CiState | undefined> => {
  const sha = filter.commitSha as string;
  // Without a workflow, workflow_run means the commit's whole rollup.
  if (filter.workflowFile !== undefined || filter.workflow !== undefined) {
    {
      const { workflow_runs } = await get<{ workflow_runs: WorkflowRun[] }>(
        token,
        `/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`,
      );
      const run = workflow_runs
        .filter((candidate) =>
          filter.workflowFile !== undefined
            ? candidate.path
                .split("@")[0]
                ?.endsWith(`/${filter.workflowFile}`) === true
            : candidate.name === filter.workflow,
        )
        .sort((left, right) => right.id - left.id)[0];
      if (run === undefined) return undefined;
      const done = run.status === "completed";
      return {
        done,
        outcome: done
          ? (run.conclusion ?? "neutral")
          : (run.status ?? "queued"),
        parts: [
          {
            name: run.name ?? filter.workflowFile ?? "workflow",
            result: run.conclusion ?? run.status ?? "queued",
            url: run.html_url,
          },
        ],
        url: run.html_url,
      };
    }
  }
  const [checks, combined] = await Promise.all([
    filter.ciEvent === "status"
      ? Promise.resolve({ check_runs: [] as CheckRun[] })
      : get<{ check_runs: CheckRun[] }>(
          token,
          `/repos/${repository}/commits/${sha}/check-runs?per_page=100`,
        ),
    filter.ciEvent === "check_run"
      ? Promise.resolve({ statuses: [] as CommitStatus[] })
      : get<{ statuses: CommitStatus[] }>(
          token,
          `/repos/${repository}/commits/${sha}/status`,
        ),
  ]);
  // GitHub keeps every attempt; the newest run of each name counts.
  const latest = new Map<string, CheckRun>();
  for (const run of checks.check_runs)
    if ((latest.get(run.name)?.id ?? -1) < run.id) latest.set(run.name, run);
  let parts = [
    ...[...latest.values()].map((run) => ({
      name: run.name,
      result:
        run.status === "completed" ? (run.conclusion ?? "neutral") : run.status,
      done: run.status === "completed",
      ...(run.html_url === null ? {} : { url: run.html_url }),
    })),
    ...combined.statuses.map((status) => ({
      name: status.context,
      result: status.state,
      done: status.state !== "pending",
      ...(status.target_url === null ? {} : { url: status.target_url }),
    })),
  ];
  if (filter.ciEvent === "check_run")
    parts = parts.filter(({ name }) => name === filter.checkName);
  if (filter.ciEvent === "status")
    parts = parts.filter(({ name }) => name === filter.statusContext);
  if (parts.length === 0) return undefined;
  const done = parts.every((part) => part.done);
  const outcome = !done
    ? "pending"
    : parts.some(({ result }) => failing.has(result))
      ? "failure"
      : "success";
  return {
    done,
    outcome,
    parts: parts
      .map(({ done: _done, ...part }) => part)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
};

/**
 * The event a settled CI result delivers. Its key is the result's digest,
 * so a rerun that changes the outcome is new and the same result is not.
 */
export const ciEvent = async (
  repository: string,
  filter: SubscriptionFilter,
  state: CiState,
): Promise<GitHubEvent> => {
  const sha = filter.commitSha as string;
  const what =
    filter.workflowFile ??
    filter.workflow ??
    filter.checkName ??
    filter.statusContext ??
    "CI";
  const passed = state.outcome === "success";
  return {
    key: `ci:${(await digest(state)).slice(0, 40)}`,
    kind: "ci",
    label: `${what} on ${short(sha)} ${passed ? "passed" : state.outcome === "failure" ? "failed" : `finished: ${state.outcome}`}`,
    url: state.url ?? `https://github.com/${repository}/commit/${sha}/checks`,
    commit: {
      sha,
      ...(filter.branch === undefined ? {} : { branch: filter.branch }),
    },
    checks: state.parts.slice(0, 50),
    detail: {
      sha,
      ...(filter.branch === undefined ? {} : { branch: filter.branch }),
      result: passed
        ? "passed"
        : state.outcome === "failure"
          ? "failed"
          : "finished",
      checks: state.parts
        .slice(0, 50)
        .map(({ name, result }) => ({ name: name.slice(0, 100), result })),
    },
  };
};

const digest = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** What one verified webhook says happened, for matching subscriptions. */
export type GitHubHappening =
  /** One of a commit's checks or statuses settled: re-read its CI. */
  | { readonly kind: "ci"; readonly repository: string; readonly sha: string }
  /** Something on an issue or PR; `ends` when it closes or reopens. */
  | {
      readonly kind: "conversation";
      readonly repository: string;
      readonly number: number;
      readonly pull: boolean;
      readonly event: GitHubEvent;
      readonly ends?: "merged" | "closed" | "reopened";
    }
  /** A new issue or PR, with its labels. */
  | {
      readonly kind: "opened";
      readonly repository: string;
      readonly pull: boolean;
      readonly labels: ReadonlyArray<string>;
      readonly event: GitHubEvent;
    };

type Payload = Record<string, unknown>;
const object = (value: unknown): Payload =>
  typeof value === "object" && value !== null ? (value as Payload) : {};
const string = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
const loginOf = (value: unknown) => string(object(value).login) ?? "someone";
const htmlUrl = (value: unknown) => {
  const url = string(object(value).html_url);
  return url?.startsWith("https://github.com/") ? url : undefined;
};

const settled = (status: unknown) => status === "completed";

/**
 * Decodes the events GitHub subscriptions follow. Anything else, including
 * actions nobody watches (a PR's labels changing, a check starting), is
 * undefined.
 */
export const fromWebhook = (
  event: string,
  action: string,
  payload: Payload,
): GitHubHappening | undefined => {
  const repository = string(object(payload.repository).full_name);
  if (repository === undefined || !isRepository(repository)) return undefined;
  const sha = (value: unknown) => {
    const text = string(value);
    return text !== undefined && /^[0-9a-f]{40}$/.test(text)
      ? ({ kind: "ci", repository, sha: text } as const)
      : undefined;
  };
  switch (event) {
    case "check_run":
      return action === "completed"
        ? sha(object(payload.check_run).head_sha)
        : undefined;
    case "check_suite":
      return action === "completed"
        ? sha(object(payload.check_suite).head_sha)
        : undefined;
    case "workflow_run": {
      const run = object(payload.workflow_run);
      return action === "completed" && settled(run.status)
        ? sha(run.head_sha)
        : undefined;
    }
    case "status":
      return payload.state === "pending" ? undefined : sha(payload.sha);
    case "issue_comment": {
      const issue = object(payload.issue);
      const comment = object(payload.comment);
      const issueNumber = number(issue.number);
      const id = number(comment.id);
      if (action !== "created" || issueNumber === undefined || id === undefined)
        return undefined;
      const pull = issue.pull_request !== undefined;
      return {
        kind: "conversation",
        repository,
        number: issueNumber,
        pull,
        event: {
          key: `comment:${id}`,
          kind: "comment",
          label: `${loginOf(comment.user)} commented on ${pull ? "PR" : "issue"} #${issueNumber}`,
          ...optionalUrl(htmlUrl(comment)),
          untrusted: excerpt(string(comment.body)),
        },
      };
    }
    case "pull_request_review_comment": {
      const pull = object(payload.pull_request);
      const comment = object(payload.comment);
      const pullNumber = number(pull.number);
      const id = number(comment.id);
      if (action !== "created" || pullNumber === undefined || id === undefined)
        return undefined;
      return {
        kind: "conversation",
        repository,
        number: pullNumber,
        pull: true,
        event: {
          key: `review-comment:${id}`,
          kind: "comment",
          label: `${loginOf(comment.user)} commented on ${string(comment.path) ?? "the diff"} in PR #${pullNumber}`,
          ...optionalUrl(htmlUrl(comment)),
          untrusted: excerpt(string(comment.body)),
        },
      };
    }
    case "pull_request_review": {
      const pull = object(payload.pull_request);
      const review = object(payload.review);
      const pullNumber = number(pull.number);
      const id = number(review.id);
      const state = string(review.state)?.toLowerCase() ?? "";
      const body = excerpt(string(review.body));
      // A bare comment review only wraps comments delivered on their own.
      if (
        action !== "submitted" ||
        pullNumber === undefined ||
        id === undefined ||
        (state === "commented" && body === "")
      )
        return undefined;
      return {
        kind: "conversation",
        repository,
        number: pullNumber,
        pull: true,
        event: {
          key: `review:${id}`,
          kind: "review",
          label: `${loginOf(review.user)} ${state === "approved" ? "approved" : state === "changes_requested" ? "requested changes on" : "reviewed"} PR #${pullNumber}`,
          ...optionalUrl(htmlUrl(review)),
          untrusted: body,
        },
      };
    }
    case "pull_request":
    case "issues": {
      const pull = event === "pull_request";
      const item = object(pull ? payload.pull_request : payload.issue);
      const itemNumber = number(item.number);
      if (itemNumber === undefined) return undefined;
      const noun = pull ? "PR" : "issue";
      const url =
        htmlUrl(item) ??
        `https://github.com/${repository}/${pull ? "pull" : "issues"}/${itemNumber}`;
      if (action === "opened")
        return {
          kind: "opened",
          repository,
          pull,
          labels: (Array.isArray(item.labels) ? item.labels : []).flatMap(
            (label) => string(object(label).name) ?? [],
          ),
          event: {
            key: `${pull ? "pr" : "issue"}:${itemNumber}`,
            kind: "opened",
            label: `${loginOf(item.user)} opened ${noun} #${itemNumber}`,
            url,
            untrusted:
              `${excerpt(string(item.title), 200)}\n\n${excerpt(string(item.body))}`.trim(),
            subject: { number: itemNumber, title: string(item.title) ?? "" },
          },
        };
      const merged = action === "closed" && item.merged === true;
      const lifecycle = merged
        ? ({ kind: "merged", words: "merged" } as const)
        : action === "closed"
          ? ({ kind: "closed", words: "closed" } as const)
          : action === "reopened"
            ? ({ kind: "reopened", words: "reopened" } as const)
            : pull && action === "enqueued"
              ? ({ kind: "queued", words: "entered the merge queue" } as const)
              : pull && action === "dequeued"
                ? ({ kind: "dequeued", words: "left the merge queue" } as const)
                : undefined;
      if (lifecycle === undefined) return undefined;
      const mergeSha = string(item.merge_commit_sha);
      return {
        kind: "conversation",
        repository,
        number: itemNumber,
        pull,
        event: {
          // One per transition: the item changed when it happened.
          key: `${lifecycle.kind}:${string(item.updated_at) ?? ""}`,
          kind: lifecycle.kind,
          label: `${noun} #${itemNumber} ${lifecycle.words}${merged && mergeSha !== undefined ? ` as ${short(mergeSha)}` : ""} (${loginOf(payload.sender)})`,
          url,
        },
        ...(lifecycle.kind === "merged" ||
        lifecycle.kind === "closed" ||
        lifecycle.kind === "reopened"
          ? { ends: lifecycle.kind }
          : {}),
      };
    }
    default:
      return undefined;
  }
};

const optionalUrl = (url: string | undefined) =>
  url === undefined ? {} : { url };

/** Where on github.com a subscription's subject lives. */
export const targetUrl = (
  repository: string,
  kind: FilterKind,
  filter: SubscriptionFilter,
) => {
  const base = `https://github.com/${repository}`;
  const labeled =
    filter.label === undefined
      ? ""
      : `?q=${encodeURIComponent(`is:open label:"${filter.label}"`)}`;
  switch (kind) {
    case "ci":
      return `${base}/commit/${filter.commitSha ?? ""}/checks`;
    case "pr-comments":
      return `${base}/pull/${filter.prNumber}`;
    case "issue-comments":
      return `${base}/issues/${filter.issueNumber}`;
    case "issue-opened":
      return `${base}/issues${labeled}`;
    case "pr-opened":
      return `${base}/pulls${labeled}`;
  }
};

/** What a subscription watches, in words. */
export const describeTarget = (
  kind: FilterKind,
  filter: SubscriptionFilter,
) => {
  switch (kind) {
    case "ci": {
      const what =
        filter.workflowFile ??
        filter.workflow ??
        filter.checkName ??
        filter.statusContext;
      return `${what === undefined ? "CI" : what} on ${short(filter.commitSha ?? "")}${
        filter.branch === undefined ? "" : ` (${filter.branch})`
      }`;
    }
    case "pr-comments":
      return `comments, reviews, and merges on PR #${filter.prNumber}`;
    case "issue-comments":
      return `comments on issue #${filter.issueNumber}`;
    case "issue-opened":
      return `new issues${filter.label === undefined ? "" : ` labeled ${filter.label}`}`;
    case "pr-opened":
      return `new PRs${filter.label === undefined ? "" : ` labeled ${filter.label}`}`;
  }
};
