import type { ThreadCiRunData, ThreadPullRequestData } from "@dx/api";
import { GitCommitHorizontal } from "lucide-react";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { ciIcon, ciWords, pullIcon } from "./github-status.js";
import "./automations.css";

const ago = (iso: string, now: number) =>
  formatRelativeTime({ epochMilliseconds: new Date(iso).getTime() }, now);

/** The pull requests the Thread follows: title, number, opening, state. */
export function PullRequestList({
  pulls,
}: {
  readonly pulls: ReadonlyArray<ThreadPullRequestData>;
}) {
  return (
    <ul className="automation-list" aria-label="Pull requests">
      {pulls.map((pull) => (
        <li key={`${pull.repository}#${pull.number}`}>
          <a
            className="automation-list-row"
            href={pull.url}
            target="_blank"
            rel="noreferrer"
          >
            {pullIcon(pull.state)}
            <span className="automation-list-copy">
              <span className="automation-list-title">
                <strong>{pull.title ?? pull.repository}</strong>
                <span className="automation-list-number">#{pull.number}</span>
              </span>
              <small>
                {pull.summary === undefined ? null : (
                  <span className="automation-list-summary">
                    {pull.summary}
                  </span>
                )}
                <span className="automation-list-meta">
                  {pull.changedAt === undefined ? (
                    pull.state
                  ) : (
                    <TimeText
                      text={(now) =>
                        `${pull.state === "open" ? "opened" : pull.state} ${ago(pull.changedAt as string, now)}`
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
