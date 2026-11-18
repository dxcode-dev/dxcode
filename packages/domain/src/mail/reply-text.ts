/**
 * Splits an email's plain text into what its author typed and what they
 * quoted or forwarded. Only the typed text is the author's request; the rest
 * reaches the agent wrapped as untrusted data (wiki/agent-mail.md).
 */

export interface SplitMailText {
  /** What the author typed above any quote or forward. */
  readonly typed: string;
  /** A forwarded message's text, if the author forwarded one. */
  readonly forwarded: string | undefined;
  /** Earlier messages the author quoted, if any. */
  readonly quoted: string | undefined;
}

const FORWARD_MARKERS = [
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^Begin forwarded message:\s*$/i,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
];

/**
 * Outlook's plain-text reply and forward: a line of underscores, or
 * straight away a header block (`From:` then `Sent:`/`Date:`/`To:`/
 * `Subject:` within the next lines).
 */
const OUTLOOK_SEPARATOR = /^_{10,}\s*$/;
/** `From: Name <a@b>` or `From: a@b`: a header line naming an address. */
const FROM_ADDRESS = /^\*?From\*?\s*:.*(@|<[^>]+>)/i;
/**
 * A quoted message's header block: a `From:` line with an address, then a
 * `Sent:`/`Date:` line and a `To:`/`Subject:` line within the next four.
 * Ordinary text that happens to start lines with "From:" or "Date:" has no
 * address on its From line, or not all three.
 */
const outlookHeaderBlock = (lines: ReadonlyArray<string>, index: number) => {
  if (!FROM_ADDRESS.test((lines[index] ?? "").trim())) return false;
  const next = lines.slice(index + 1, index + 5).map((line) => line.trim());
  return (
    next.some((line) => /^\*?(Sent|Date)\*?\s*:/i.test(line)) &&
    next.some((line) => /^\*?(To|Subject)\*?\s*:/i.test(line))
  );
};

/** `On <date>, <name> wrote:`, which mail clients may wrap over two lines. */
const ATTRIBUTION = /^On\b.{0,300}\bwrote:\s*$/i;

const trimBlock = (lines: ReadonlyArray<string>) =>
  lines
    .join("\n")
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "");

export const splitMailText = (text: string): SplitMailText => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    // Outlook marks neither replies nor forwards apart: what follows its
    // separator or header block is someone else's text, quoted.
    if (
      OUTLOOK_SEPARATOR.test(trimmed) &&
      lines
        .slice(index + 1, index + 3)
        .some((_, offset) => outlookHeaderBlock(lines, index + 1 + offset))
    )
      return {
        typed: trimBlock(lines.slice(0, index)),
        forwarded: undefined,
        quoted: trimBlock(lines.slice(index)) || undefined,
      };
    if (outlookHeaderBlock(lines, index))
      return {
        typed: trimBlock(lines.slice(0, index)),
        forwarded: undefined,
        quoted: trimBlock(lines.slice(index)) || undefined,
      };
    if (FORWARD_MARKERS.some((marker) => marker.test(trimmed)))
      return {
        typed: trimBlock(lines.slice(0, index)),
        forwarded: trimBlock(lines.slice(index)) || undefined,
        quoted: undefined,
      };
    const twoLines = `${trimmed} ${(lines[index + 1] ?? "").trim()}`;
    if (
      ATTRIBUTION.test(trimmed) ||
      (/^On\b/i.test(trimmed) && ATTRIBUTION.test(twoLines)) ||
      (trimmed.startsWith(">") &&
        lines.slice(index).every((rest) => /^\s*(>|$)/.test(rest)))
    )
      return {
        typed: trimBlock(lines.slice(0, index)),
        forwarded: undefined,
        quoted: trimBlock(lines.slice(index)) || undefined,
      };
  }
  return { typed: trimBlock(lines), forwarded: undefined, quoted: undefined };
};

/** Makes text safe inside an `<email_content>` block: no closing tag. */
export const escapeEmailContent = (text: string) =>
  text.replace(/<\/?\s*email_content\b[^>]*>/gi, (tag) =>
    tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );

/** Plain text from an HTML body, for a message that has no text part. */
export const mailHtmlToText = (html: string) =>
  html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
