import type { APIRoute, GetStaticPaths } from "astro";
import { getLogEntries, isoLogDate, type LogEntry } from "../../lib/log";

/**
 * Each dx Log entry as Markdown at `/docs/log/<slug>.md`, for the Copy Page
 * button, like the docs pages' copies.
 */
export const getStaticPaths = (async () =>
  (await getLogEntries()).map((entry) => ({
    params: { slug: entry.id },
    props: { entry },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ entry: LogEntry }> = ({ props }) => {
  const { title, date, summary } = props.entry.data;
  const body = (props.entry.body ?? "").trim();
  return new Response(
    `# ${title}\n\n${isoLogDate(date)}\n\n${summary}\n\n${body}\n`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
};
