import type { Timestamp } from "@dx/domain";

const at = (timestamp: Timestamp) => timestamp.epochMilliseconds;

/** "6d 23h", "2h 5m", or "12m" until `until`. */
export const formatRemaining = (until: Timestamp, now = Date.now()) => {
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

/** `now`, `10m`, `3h`, `2d`, `5w`: how long ago, in one short unit. */
export const conciseAge = (iso: string, now = Date.now()) => {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
};
