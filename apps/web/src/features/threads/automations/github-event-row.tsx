import type { GitHubDeliveryEvent } from "@dx/api";
import {
  Check,
  ChevronDown,
  CircleDashed,
  GitCommitHorizontal,
  X,
} from "lucide-react";
import { GitHubOutlineIcon } from "../../../shared/ui/github-icon.js";

const FAILED = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "error",
  "stale",
]);

const checkIcon = (result: string) =>
  FAILED.has(result) ? (
    <X aria-hidden="true" data-result="failed" />
  ) : result === "success" ? (
    <Check aria-hidden="true" data-result="passed" />
  ) : (
    <CircleDashed aria-hidden="true" data-result="neutral" />
  );

const resultWord = (result: string) =>
  result === "success"
    ? "passed"
    : FAILED.has(result)
      ? "failed"
      : result.replaceAll("_", " ");

/** One delivered GitHub event: a linked line, or CI's commit and checks. */
export function GitHubEventRow({
  event,
  open,
  onToggle,
}: {
  readonly event: GitHubDeliveryEvent;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const ci = event.kind === "ci";
  const expandable = ci || (event.untrusted ?? "") !== "";
  const label = ci ? "Finished running CI" : event.label;
  return (
    <div className="github-event" data-kind={event.kind}>
      <div className="github-event-header">
        <GitHubOutlineIcon className="github-event-icon" />
        {event.url === undefined || ci ? (
          <span className="github-event-label">{label}</span>
        ) : (
          <a
            className="github-event-label github-event-link"
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {label}
          </a>
        )}
        {expandable ? (
          <button
            type="button"
            className="github-event-toggle"
            aria-expanded={open}
            aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
            onClick={onToggle}
          >
            <ChevronDown aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {open && ci ? (
        <div className="github-event-card">
          <a
            className="github-event-commit"
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <GitCommitHorizontal aria-hidden="true" />
            <span>
              <strong>Commit {event.commit?.sha.slice(0, 7)}</strong>
              <small>
                {event.commit?.sha.slice(0, 7)}
                {event.commit?.branch === undefined
                  ? ""
                  : ` ${event.commit.branch}`}
              </small>
            </span>
          </a>
          <ul className="github-event-checks">
            {(event.checks ?? []).map((check) => (
              <li key={`${check.name}:${check.url ?? ""}`}>
                {checkIcon(check.result)}
                {check.url === undefined ? (
                  <span>{check.name}</span>
                ) : (
                  <a href={check.url} target="_blank" rel="noopener noreferrer">
                    {check.name}
                  </a>
                )}
                <small>· {resultWord(check.result)}</small>
              </li>
            ))}
          </ul>
        </div>
      ) : open && event.untrusted !== undefined ? (
        <blockquote className="github-event-quote">
          {event.untrusted}
        </blockquote>
      ) : null}
    </div>
  );
}
