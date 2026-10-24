/** A heading, quote, or list item's leading syntax. */
const BLOCK_MARKER = /^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?)/;
const FENCE = /^\s*(?:```|~~~)/;
/** The rule under a table's header row. */
const TABLE_RULE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|?)+\s*$/;

const inlineText = (line: string) =>
  line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)(.*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();

/**
 * Markdown as one paragraph of prose, the way a lock screen shows it. Only
 * the words stay: code blocks, views, and images go, as does Markdown
 * syntax, and lines join with spaces so the device's few lines carry words
 * rather than layout. A heading or list item ends as a sentence, so
 * "## Done" does not run into the next line.
 */
export const plainPreview = (markdown: string) => {
  let fenced = false;
  return markdown
    .split("\n")
    .flatMap((line) => {
      if (FENCE.test(line)) fenced = !fenced;
      else if (!fenced && !TABLE_RULE.test(line)) {
        const marker = BLOCK_MARKER.exec(line)?.[0];
        const text = inlineText(line.slice(marker?.length ?? 0));
        if (text !== "")
          return [
            marker === undefined || /[.!?:;…]$/.test(text) ? text : `${text}.`,
          ];
      }
      return [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
};
