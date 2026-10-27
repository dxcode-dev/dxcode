import type { GitHubSubscriptionData, ThreadScheduleData } from "@dx/api";
import { formatRelativeTime } from "../../../shared/utils.js";

const untilText = (iso: string, now: number) => {
  const minutes = Math.max(
    0,
    Math.round((new Date(iso).getTime() - now) / 60_000),
  );
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
};

/** "Next run in 1h 30m · Last run 4h ago", or what stopped it. */
export const runText = (schedule: ThreadScheduleData, now: number) =>
  [
    !schedule.enabled
      ? "Paused"
      : schedule.nextRunAt === undefined
        ? "No more runs"
        : `Next run ${untilText(schedule.nextRunAt, now)}`,
    schedule.lastRunAt === undefined
      ? undefined
      : `Last run ${formatRelativeTime(
          { epochMilliseconds: new Date(schedule.lastRunAt).getTime() },
          now,
        )}${schedule.lastRunStatus === "failed" ? " (failed)" : ""}`,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

export const subscriptionStatus = (subscription: GitHubSubscriptionData) =>
  subscription.stateDetail ??
  (subscription.state === "active"
    ? subscription.enabled
      ? "Listening for events."
      : "Disabled."
    : subscription.state === "finished"
      ? "Finished."
      : subscription.state === "expired"
        ? "Expired."
        : "Failed.");

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";
