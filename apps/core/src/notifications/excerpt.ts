import { plainPreview } from "./plain-preview.js";

/**
 * A notification's excerpt as the Mentions inbox stores it: the message as
 * plain text, with picked mentions kept as `@[Name](user:ID)` tokens (and
 * `@[dx](agent)`, `@[here](here)`), which the inbox shows as chips. Links
 * keep their label; Markdown syntax goes. The cut to the limit happens on
 * that plain text, so it never splits a link, and a token it would split is
 * left out whole.
 */

const MENTION_TOKEN = /@\[[^\]\n]+\]\((?:user:[A-Za-z0-9_-]+|agent|here)\)/g;

/** Markdown as plain prose, mention tokens kept whole. */
export const plainExcerptText = (markdown: string) => {
  // Each token waits behind a private-use placeholder while the Markdown
  // is flattened, so link syntax never touches it.
  const tokens: string[] = [];
  const shielded = markdown.replace(MENTION_TOKEN, (token) => {
    tokens.push(token);
    return `\uE000${tokens.length - 1}\uE001`;
  });
  return plainPreview(shielded).replace(
    /\uE000(\d+)\uE001/g,
    (_, index: string) => tokens[Number(index)] ?? "",
  );
};

/** Plain text cut to `limit` characters, never inside a mention token. */
export const cutExcerpt = (text: string, limit: number) => {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  let cut = limit - 1;
  for (const match of trimmed.matchAll(MENTION_TOKEN)) {
    const start = match.index ?? 0;
    if (start < cut && start + match[0].length > cut) {
      cut = start;
      break;
    }
  }
  return `${trimmed.slice(0, cut).trimEnd()}…`;
};

/** Mention tokens as `@Name`, for channels that cannot show chips. */
export const tokensAsNames = (text: string) =>
  text.replace(/@\[([^\]\n]+)\]\((?:user:[A-Za-z0-9_-]+|agent|here)\)/g, "@$1");
