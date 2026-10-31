import type {
  ThreadCiRunData,
  ThreadIssueData,
  ThreadPullRequestData,
} from "@dx/api";
import { GitCommitHorizontal } from "lucide-react";
import type * as React from "react";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { ciIcon, ciWords, issueIcon, pullIcon } from "./github-status.js";
import "./automations.css";

const ago = (iso: string, now: number) =>
  formatRelativeTime({ epochMilliseconds: new Date(iso).getTime() }, now);

/** The issues the Thread is linked to: title, number, opening, state. */
export function IssueList({
  issues,
}: {
  readonly issues: ReadonlyArray<ThreadIssueData>;
}) {
  return (
    <GitHubItemList
      label="Issues"
      items={issues.map((issue) => ({
        ...issue,
        icon: issueIcon(issue.state),
      }))}
    />
  );
}

/** The pull requests the Thread follows: title, number, opening, state. */
export function PullRequestList({
  pulls,
}: {
  readonly pulls: ReadonlyArray<ThreadPullRequestData>;
}) {
  return (
    <GitHubItemList
      label="Pull requests"
      items={pulls.map((pull) => ({ ...pull, icon: pullIcon(pull.state) }))}
    />
  );
}

/** Issues or pull requests, each linking to GitHub. */
function GitHubItemList({
  label,
  items,
}: {
  readonly label: string;
  readonly items: ReadonlyArray<
    (ThreadIssueData | ThreadPullRequestData) & {
      readonly icon: React.ReactNode;
    }
  >;
}) {
  return (
    <ul className="automation-list" aria-label={label}>
      {items.map((item) => (
        <li key={`${item.repository}#${item.number}`}>
          <a
            className="automation-list-row"
            href={item.url}
            target="_blank"
            rel="noreferrer"
          >
            {item.icon}
            <span className="automation-list-copy">
              <span className="automation-list-title">
                <strong>{item.title ?? item.repository}</strong>
                <span className="automation-list-number">#{item.number}</span>
              </span>
              <small>
                {item.summary === undefined ? null : (
                  <span className="automation-list-summary">
                    {item.summary}
                  </span>
                )}
                <span className="automation-list-meta">
                  {item.changedAt === undefined ? (
                    item.state
                  ) : (
                    <TimeText
                      text={(now) =>
                        `${item.state === "open" ? "opened" : item.state} ${ago(item.changedAt as string, now)}`
                      }
                    />
                  )}
                </span>
              </small>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** One row per commit dx reported CI for, newest first. */
export function CiRunList({
  runs,
}: {
  readonly runs: ReadonlyArray<ThreadCiRunData>;
}) {
  return (
    <ul className="automation-list" aria-label="CI">
      {runs.map((run) => (
        <li key={`${run.repository}@${run.sha}`}>
          <a
            className="automation-list-row"
            href={run.url}
            target="_blank"
            rel="noreferrer"
          >
            <GitCommitHorizontal aria-hidden="true" />
            <span className="automation-list-copy">
              <span className="automation-list-title">
                <code>{run.sha.slice(0, 7)}</code>
                {run.branch === undefined ? null : (
                  <span className="automation-list-branch">{run.branch}</span>
                )}
              </span>
              <small className="automation-list-ci" data-ci={run.result}>
                {ciIcon(run.result)}
                <span>
                  {ciWords(run)} <TimeText text={(now) => ago(run.at, now)} />
                </span>
                {run.checks.length === 0 ? null : (
                  <span className="automation-list-summary">
                    {run.checks.map(({ name }) => name).join(", ")}
                  </span>
                )}
              </small>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
