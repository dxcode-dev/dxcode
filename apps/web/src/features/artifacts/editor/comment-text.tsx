/** An http(s) URL in a comment, up to whitespace or brackets. */
const URL_PATTERN = /https?:\/\/[^\s<>()[\]{}"']+/g;
/** Punctuation that ends a sentence, not the URL before it. */
const TRAILING = /[.,;:!?]+$/;

/**
 * A comment's text, with each http(s) URL in it a link that opens in a new
 * tab. The text stays exactly as written.
 */
export function CommentText({ text }: { readonly text: string }) {
  // Each part keyed by where it starts in the text.
  const parts: Array<{
    readonly at: number;
    readonly text: string;
    readonly url: boolean;
  }> = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING, "");
    const start = match.index;
    if (start > last)
      parts.push({ at: last, text: text.slice(last, start), url: false });
    parts.push({ at: start, text: url, url: true });
    last = start + url.length;
  }
  if (last < text.length)
    parts.push({ at: last, text: text.slice(last), url: false });
  return (
    <>
      {parts.map((part) =>
        part.url ? (
          <a
            key={part.at}
            href={part.text}
            target="_blank"
            rel="noopener noreferrer"
          >
            {part.text}
          </a>
        ) : (
          <span key={part.at}>{part.text}</span>
        ),
      )}
    </>
  );
}
