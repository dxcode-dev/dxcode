import type { APIRoute } from "astro";
import { getLogEntries, isoLogDate, logPath } from "../lib/log";

/** The dx Log hub as Markdown at `/docs/log.md`, for the Copy Page button. */
export const GET: APIRoute = async ({ site }) => {
  const entries = await getLogEntries();
  const section = (heading: string, kind: "news" | "note") => {
    const items = entries
      .filter((entry) => entry.data.kind === kind)
      .map(
        (entry) =>
          `- ${isoLogDate(entry.data.date)}: [${entry.data.title}](${new URL(logPath(entry), site ?? "https://dxcode.dev").href}). ${entry.data.summary}`,
      );
    return items.length ? `## ${heading}\n\n${items.join("\n")}\n\n` : "";
  };
  return new Response(
    `# dx Log\n\nWhat changed in dx, and why: product news and short notes from the team.\n\n${section("News", "news")}${section("Notes", "note")}`.trimEnd() +
      "\n",
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
};
