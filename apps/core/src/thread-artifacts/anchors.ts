/**
 * Where a comment's quoted text is in a revision's Markdown: the occurrence
 * nearest `near` (a UTF-16 offset, such as where the quote was in the
 * previous revision), or undefined when the text is gone.
 */
export const findQuote = (
  markdown: string,
  quote: string,
  near = 0,
): { readonly start: number; readonly end: number } | undefined => {
  if (quote.length === 0) return undefined;
  let best: number | undefined;
  for (
    let index = markdown.indexOf(quote);
    index !== -1;
    index = markdown.indexOf(quote, index + 1)
  ) {
    if (best === undefined || Math.abs(index - near) < Math.abs(best - near))
      best = index;
    // Occurrences only get farther once past `near`.
    if (index > near) break;
  }
  return best === undefined
    ? undefined
    : { start: best, end: best + quote.length };
};

/**
 * Where `offset` in `before` is in `after`, assuming one edited region: text
 * in the unchanged prefix stays, text in the unchanged suffix shifts by the
 * change in length, and text inside the edit keeps its offset as a hint.
 */
export const mapOffset = (
  before: string,
  after: string,
  offset: number,
  length: number,
) => {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  if (offset + length <= prefix) return offset;
  if (offset >= before.length - suffix)
    return offset + after.length - before.length;
  return offset;
};

/**
 * A comment's quote in the next revision: at its old place mapped through
 * the edit when the text is still there, else the occurrence nearest it.
 */
export const moveQuote = (
  before: string | undefined,
  after: string,
  quote: string,
  start: number | null,
) => {
  if (before !== undefined && start !== null) {
    const mapped = mapOffset(before, after, start, quote.length);
    if (after.startsWith(quote, mapped))
      return { start: mapped, end: mapped + quote.length };
    return findQuote(after, quote, mapped);
  }
  return findQuote(after, quote, start ?? 0);
};
