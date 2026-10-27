import type { ThreadCiRunData, ThreadPullRequestData } from "@dx/api";
import {
  Check,
  CircleDashed,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  X,
} from "lucide-react";

export const pullIcon = (state: ThreadPullRequestData["state"]) =>
  state === "merged" ? (
    <GitMerge aria-hidden="true" data-pr="merged" />
  ) : state === "closed" ? (
    <GitPullRequestClosed aria-hidden="true" data-pr="closed" />
  ) : (
    <GitPullRequest aria-hidden="true" data-pr="open" />
  );

export const ciIcon = (result: ThreadCiRunData["result"]) =>
  result === "running" ? (
    <CircleDashed aria-hidden="true" data-ci="pending" />
  ) : result === "passed" ? (
    <Check aria-hidden="true" data-ci="passed" />
  ) : result === "failed" ? (
    <X aria-hidden="true" data-ci="failed" />
  ) : (
    <CircleDashed aria-hidden="true" data-ci="finished" />
  );

const FAILED = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "error",
  "stale",
]);

const SKIPPED = new Set(["skipped", "neutral"]);

/** "3 checks passed", "2 checks passed, 1 skipped", "1 of 2 checks failed", or "Checks running". */
export const ciWords = (run: ThreadCiRunData) => {
  if (run.result === "running") return "Checks running";
  const count = run.checks.length;
  const noun = count === 1 ? "check" : "checks";
  if (count === 0) return `Checks ${run.result}`;
  if (run.result !== "failed") {
    const skipped = run.checks.filter(({ result }) =>
      SKIPPED.has(result),
    ).length;
    const ran = count - skipped;
    return skipped === 0 || ran === 0
      ? `${count} ${noun} ${run.result}`
      : `${ran} ${ran === 1 ? "check" : "checks"} ${run.result}, ${skipped} skipped`;
  }
  const failed = run.checks.filter(({ result }) => FAILED.has(result)).length;
  return failed === 0 || failed === count
    ? `${count} ${noun} failed`
    : `${failed} of ${count} checks failed`;
};
