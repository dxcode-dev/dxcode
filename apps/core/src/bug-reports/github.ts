import { Redacted } from "effect";
import type { Bindings } from "../http/types.js";
import { observeExternal } from "../observability/boundaries.js";
import { createGitHubAppJwt } from "../source-control/github/app-auth.js";
import { loadGitHubAppConfigurationSync } from "../source-control/github/configuration.js";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "dx-bug-reports";
/** What a deployment labels new issues with unless it names its own. */
export const DEFAULT_BUG_REPORT_LABELS = ["intake"] as const;

export class BugReportFilingError extends Error {
  override readonly name = "BugReportFilingError";
  constructor(
    readonly step: string,
    readonly status?: number,
  ) {
    super(
      `GitHub ${step} failed${status === undefined ? "" : ` (${status})`}.`,
    );
  }
}

export interface BugReportRepository {
  readonly owner: string;
  readonly name: string;
}

const REPOSITORY =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

const LABEL = /^[^,\s][^,]{0,49}$/;

/**
 * `DX_BUG_REPORT_LABELS`, comma-separated: the labels a new issue gets.
 * Absent means `intake`, which starts an owner Thread on the dx board; a
 * stage that only proves filing names a label that starts nothing.
 */
export const bugReportLabels = (value: string | undefined) => {
  if (value === undefined || value.trim() === "")
    return [...DEFAULT_BUG_REPORT_LABELS];
  const labels = value
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");
  return labels.length > 0 && labels.every((label) => LABEL.test(label))
    ? labels
    : undefined;
};

/**
 * The repository a deployment files reports in, `DX_BUG_REPORT_REPOSITORY`
 * as `owner/name`, its labels, and the GitHub App that files them. Without
 * a repository and an App, or with labels it cannot read, Core keeps
 * reports and files them nowhere.
 */
export const bugReportFiling = (bindings: Bindings) => {
  const match = REPOSITORY.exec(
    bindings.DX_BUG_REPORT_REPOSITORY?.trim() ?? "",
  );
  if (match === null) return undefined;
  const labels = bugReportLabels(bindings.DX_BUG_REPORT_LABELS);
  if (labels === undefined) return undefined;
  const app = loadGitHubAppConfigurationSync(bindings);
  if (app === undefined) return undefined;
  return {
    repository: { owner: match[1] as string, name: match[2] as string },
    labels,
    appId: app.appId,
    privateKeyPem: app.privateKeyPem,
  };
};
export type BugReportFiling = NonNullable<ReturnType<typeof bugReportFiling>>;

export interface OpenIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

/**
 * The few GitHub calls filing needs, as the App's installation on the
 * report repository, with a token limited to that repository's issues.
 */
export const connectBugReportRepository = async (
  filing: BugReportFiling,
  fetcher: typeof fetch = fetch,
) => {
  const { owner, name } = filing.repository;
  const repo = `${API_ORIGIN}/repos/${owner}/${name}`;
  const call = async (
    step: string,
    url: string,
    token: string,
    init: { method?: string; body?: unknown } = {},
    allow: ReadonlyArray<number> = [],
  ) => {
    const response = await observeExternal("github", step, url, () =>
      fetcher(url, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": USER_AGENT,
          "x-github-api-version": API_VERSION,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      }),
    );
    if (!response.ok && !allow.includes(response.status))
      throw new BugReportFilingError(step, response.status);
    return response;
  };
  const json = async <T>(response: Response) => {
    try {
      return (await response.json()) as T;
    } catch {
      throw new BugReportFilingError("response");
    }
  };

  const appJwt = await createGitHubAppJwt({
    appId: filing.appId,
    privateKeyPem: Redacted.value(filing.privateKeyPem),
  });
  const installation = await json<{ id?: unknown }>(
    await call("installation", `${repo}/installation`, appJwt),
  );
  if (typeof installation.id !== "number")
    throw new BugReportFilingError("installation");
  const minted = await json<{ token?: unknown }>(
    await call(
      "token",
      `${API_ORIGIN}/app/installations/${installation.id}/access_tokens`,
      appJwt,
      {
        method: "POST",
        body: {
          repositories: [name],
          permissions: { issues: "write" },
        },
      },
    ),
  );
  if (typeof minted.token !== "string") throw new BugReportFilingError("token");
  const token = minted.token;

  return {
    /** Open issues, newest first, without pull requests. */
    openIssues: async (limit: number): Promise<ReadonlyArray<OpenIssue>> => {
      const items = await json<ReadonlyArray<Record<string, unknown>>>(
        await call(
          "issues",
          `${repo}/issues?state=open&sort=created&direction=desc&per_page=${Math.min(limit, 100)}`,
          token,
        ),
      );
      return items.flatMap((item) =>
        item.pull_request === undefined &&
        typeof item.number === "number" &&
        typeof item.title === "string" &&
        typeof item.html_url === "string"
          ? [
              {
                number: item.number,
                title: item.title,
                body: typeof item.body === "string" ? item.body : "",
                url: item.html_url,
              },
            ]
          : [],
      );
    },
    createIssue: async (input: {
      readonly title: string;
      readonly body: string;
    }) => {
      const issue = await json<{ number?: unknown; html_url?: unknown }>(
        await call("create-issue", `${repo}/issues`, token, {
          method: "POST",
          body: { ...input, labels: filing.labels },
        }),
      );
      if (
        typeof issue.number !== "number" ||
        typeof issue.html_url !== "string"
      )
        throw new BugReportFilingError("create-issue");
      return { number: issue.number, url: issue.html_url };
    },
    comment: async (issue: OpenIssue, body: string) => {
      const comment = await json<{ html_url?: unknown }>(
        await call(
          "comment",
          `${repo}/issues/${issue.number}/comments`,
          token,
          { method: "POST", body: { body } },
        ),
      );
      return {
        number: issue.number,
        url:
          typeof comment.html_url === "string" ? comment.html_url : issue.url,
      };
    },
  };
};
export type BugReportRepositoryClient = Awaited<
  ReturnType<typeof connectBugReportRepository>
>;
