import type { Timestamp } from "@dx/domain";

const at = (timestamp: Timestamp) => timestamp.epochMilliseconds;

/** "6d 23h", "2h 5m", or "12m" until `until`. */
export const formatRemaining = (until: Timestamp, now: number) => {
  const minutes = Math.max(0, Math.floor((at(until) - now) / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
};

const untilFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Oct 15, 2:13 PM" in the viewer's locale. */
export const formatUntil = (until: Timestamp) =>
  untilFormat.format(new Date(at(until)));

/** "3 people in this thread, 1 here now": the trigger's and menu entry's name. */
export const participantsLabel = (count: number, liveCount: number) =>
  `${count} ${count === 1 ? "person" : "people"} in this thread${liveCount > 0 ? `, ${liveCount} here now` : ""}`;
