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
const trailingBlock = new RegExp(
  `\\n*<${BLOCK}>\\n?((?:<${ITEM}\\b[^>]*/>\\n?)*)</${BLOCK}>\\s*$`,
);
const anyBlockTag = new RegExp(`</?${BLOCK}\\b[^>]*>\\n?`, "gi");
const anyItemTag = new RegExp(`<${ITEM}\\b[^>]*/?>\\n?`, "gi");
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

/**
 * Removes every attachment tag from text a person wrote, repeating until none
 * is left so a tag split around another tag cannot reassemble.
 */
export const stripMessageAttachmentTags = (text: string) => {
  let current = text;
  for (;;) {
    const next = current.replace(anyBlockTag, "").replace(anyItemTag, "");
    if (next === current) return current;
    current = next;
  }
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
  const match = trailingBlock.exec(text);
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
  return { attachments, text: text.slice(0, match.index).trimEnd() };
};
