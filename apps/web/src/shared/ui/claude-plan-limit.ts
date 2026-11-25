import { type ClaudePlanLimit, claudePlanWindowName } from "@dx/domain";

export const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";

const resetTime = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const resetDayAndTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

/** The reset in the reader's time; a later day names the day too. */
const claudePlanReset = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return (
    date.toDateString() === new Date().toDateString()
      ? resetTime
      : resetDayAndTime
  ).format(date);
};

/**
 * What a Claude plan limit card says. Core runs the Thread or Space again
 * once the plan resets, with every message it got in the meantime.
 */
export const claudePlanLimitCopy = (
  limit: ClaudePlanLimit,
  subject: "Thread" | "Space" = "Thread",
) => ({
  title: `Waiting for plan reset at ${claudePlanReset(limit.resetsAt)}`,
  message: `You've hit your Claude ${
    limit.window === undefined
      ? "subscription limit"
      : claudePlanWindowName(limit.window)
  }. This ${subject} answers by itself once it resets; new ${
    subject === "Space" ? "posts" : "messages"
  } wait too.${
    limit.cause === "exhausted"
      ? ""
      : " dx kept Claude Code off paid extra usage."
  }`,
});
