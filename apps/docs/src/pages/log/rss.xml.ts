import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getLogEntries, logPath } from "../../lib/log";

export const GET = async (context: APIContext) =>
  rss({
    title: "dx Log",
    description:
      "What changed in dx, and why: product news and short notes from the team.",
    // The channel links to the hub; item links are root-relative paths.
    site: new URL(logPath(), context.site ?? "https://dxcode.dev").href,
    items: (await getLogEntries()).map((entry) => ({
      title: entry.data.title,
      pubDate: entry.data.date,
      description: entry.data.summary,
      link: logPath(entry),
      categories: [entry.data.kind],
    })),
    customData: "<language>en-us</language>",
  });
