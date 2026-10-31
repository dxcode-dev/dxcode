import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";

/**
 * Each docs page as Markdown at `/docs/<page>.md`, for the Copy Page
 * button and for anyone who wants the page as plain text.
 */
export const getStaticPaths = (async () => {
  // The splash landing page is MDX with components, not prose, and has no
  // Copy Page button, so it has no Markdown copy.
  // Annotated so the file typechecks before `astro sync` generates the
  // collection types, as `verify:changed` runs tsc first.
  const entries = (await getCollection("docs")).filter(
    (entry: CollectionEntry<"docs">) => entry.id !== "index",
  );
  return entries.map((entry: CollectionEntry<"docs">) => ({
    params: { slug: entry.id },
    props: { entry },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ entry: CollectionEntry<"docs"> }> = ({
  props,
}) => {
  const { title, description } = props.entry.data;
  const summary = description ? `\n\n${description}` : "";
  const body = (props.entry.body ?? "").trim();
  return new Response(`# ${title}${summary}\n\n${body}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
