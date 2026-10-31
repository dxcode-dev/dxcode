import { type CollectionEntry, getCollection } from "astro:content";

export type LogEntry = CollectionEntry<"log">;

/** Every dx Log entry, newest first; entries on the same day sort by title. */
export const getLogEntries = async (): Promise<LogEntry[]> =>
  (await getCollection("log")).sort(
    (a: LogEntry, b: LogEntry) =>
      b.data.date.getTime() - a.data.date.getTime() ||
      a.data.title.localeCompare(b.data.title),
  );

export const logPath = (entry?: LogEntry) =>
  `${import.meta.env.BASE_URL.replace(/\/$/, "")}/log/${entry ? `${entry.id}/` : ""}`;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export const formatLogDate = (date: Date) => dateFormat.format(date);
export const isoLogDate = (date: Date) => date.toISOString().slice(0, 10);
