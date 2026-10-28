/**
 * The files a user message references. dx appends a `<dx_attachments>` block
 * to the message the agent receives, one `<dx_attachment …/>` per file with
 * its download URL, so the model knows what was attached and where to fetch
 * it. Clients read the same block to show the files as cards instead of text.
 *
 * Core rewrites the block on admission from its own records, so the block a
 * client sends only names attachment ids; its other fields are display hints.
 */
export interface MessageAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly url: string;
}

const BLOCK = "dx_attachments";
const ITEM = "dx_attachment";
const BLOCK_OPENING = `<${BLOCK}>`;
const trailingBlock = new RegExp(
  `^<${BLOCK}>\\n?((?:<${ITEM}\\b[^>]*/>\\n?)*)</${BLOCK}>\\s*$`,
);
/** How a tag starts; any of them, then a non-word character, opens a tag. */
const TAG_OPENINGS = [`<${ITEM}`, `<${BLOCK}`, `</${BLOCK}`];
const wordCharacter = /\w/;
const itemTag = new RegExp(`<${ITEM}\\b([^>]*)/>`, "g");
const attribute = /([a-z_]+)="([^"]*)"/g;

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const unescapeAttribute = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

export const formatMessageAttachments = (
  attachments: ReadonlyArray<MessageAttachment>,
) =>
  attachments.length === 0
    ? ""
    : `<${BLOCK}>\n${attachments
        .map(
          ({ id, name, mimeType, size, url }) =>
            `<${ITEM} id="${escapeAttribute(id)}" name="${escapeAttribute(name)}" type="${escapeAttribute(mimeType)}" size="${size}" url="${escapeAttribute(url)}" />`,
        )
        .join("\n")}\n</${BLOCK}>`;

/** Where `kept` ends with a tag opening, ignoring case, or -1. */
const openingAtEnd = (kept: ReadonlyArray<string>) => {
  for (const opening of TAG_OPENINGS) {
    const start = kept.length - opening.length;
    let matched = start >= 0;
    for (let i = 0; matched && i < opening.length; i++)
      matched = kept[start + i]?.toLowerCase() === opening[i];
    if (matched) return start;
  }
  return -1;
};

/**
 * Removes every attachment tag from text a person wrote, in one pass. A tag
 * ends at the first `>` after its opening, so when one closes, the text kept
 * so far is cut back to where it opened: the text around a removed tag joins
 * in `kept`, and a tag it forms is found at its own `>`.
 */
export const stripMessageAttachmentTags = (text: string) => {
  if (!/dx_attachment/i.test(text)) return text;
  const kept: string[] = [];
  // The first tag opening in `kept` after its last `>`, or -1.
  let tagStart = -1;
  for (let i = 0; i < text.length; i++) {
    const character = text[i] ?? "";
    if (tagStart === -1 && !wordCharacter.test(character))
      tagStart = openingAtEnd(kept);
    if (character !== ">" || tagStart === -1) {
      kept.push(character);
      continue;
    }
    kept.length = tagStart;
    tagStart = -1;
    if (text[i + 1] === "\n") i++;
  }
  return kept.join("");
};

/** The message text followed by its attachment block, when it has files. */
export const withMessageAttachments = (
  body: string,
  attachments: ReadonlyArray<MessageAttachment>,
) => {
  const text = stripMessageAttachmentTags(body).trimEnd();
  const block = formatMessageAttachments(attachments);
  if (block === "") return text;
  return text === "" ? block : `${text}\n\n${block}`;
};

/** Splits a trailing attachment block from a user message. */
export const parseMessageAttachments = (
  text: string,
): {
  readonly attachments: ReadonlyArray<MessageAttachment>;
  readonly text: string;
} => {
  // A block cannot hold its own opening tag, so only the last can trail.
  const start = text.lastIndexOf(BLOCK_OPENING);
  const match = start === -1 ? null : trailingBlock.exec(text.slice(start));
  if (match === null) return { attachments: [], text };
  const attachments = [...(match[1] ?? "").matchAll(itemTag)].flatMap(
    ([, attributes]): MessageAttachment[] => {
      const fields = new Map(
        [...(attributes ?? "").matchAll(attribute)].map(([, key, value]) => [
          key,
          unescapeAttribute(value ?? ""),
        ]),
      );
      const id = fields.get("id");
      if (!id) return [];
      const size = Number(fields.get("size"));
      return [
        {
          id,
          name: fields.get("name") || "file",
          mimeType: fields.get("type") || "application/octet-stream",
          size: Number.isFinite(size) && size >= 0 ? size : 0,
          url: fields.get("url") ?? "",
        },
      ];
    },
  );
  return { attachments, text: text.slice(0, start).trimEnd() };
};
