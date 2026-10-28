import { describe, expect, it } from "vitest";
import {
  formatMessageAttachments,
  type MessageAttachment,
  parseMessageAttachments,
  stripMessageAttachmentTags,
  withMessageAttachments,
} from "./message-attachments.js";

/**
 * Ways the attachment block parser and the tag stripper can fail:
 * - Work grows faster than the message: a long run of newlines, tags nested
 *   inside tag fragments, or many tag openings with no closing `>`. Core runs
 *   both on every user message and the web app on every rendered one.
 * - Removing a tag joins the text around it into a new tag.
 * - A tag survives in another letter case.
 * - Text that only resembles a tag, or mentions one without closing it, is
 *   changed.
 * - The trailing block is missed, or found where it is not trailing.
 */

const file: MessageAttachment = {
  id: "att_00000000000000000000000000000001",
  name: 'notes "v2" <draft>.md',
  mimeType: "text/markdown",
  size: 12,
  url: "https://dx.example/v1/attachments/att_00000000000000000000000000000001/notes.md",
};

// Linear on the inputs it checks, which are short.
const hasTag = (text: string) =>
  /<\/?dx_attachments\b[^>]*>|<dx_attachment\b[^>]*>/i.test(text);

const nested = (depth: number) => {
  let text = "<dx_attachment>";
  for (let i = 0; i < depth; i++) text = `<dx_${text}attachment>`;
  return text;
};

const MiB = 1024 * 1024;

const withinBudget = (run: () => void) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe("message attachment tags", () => {
  it("parses and strips megabyte-sized adversarial messages in linear time", () => {
    const inputs = [
      `${"\n".repeat(2 * MiB)}x`,
      `${"\n".repeat(2 * MiB)}<dx_attachments>`,
      "<dx_attachment ".repeat((2 * MiB) / 15),
      nested((2 * MiB) / 15),
      "<dx_attachments>".repeat((2 * MiB) / 16),
      `<dx_attachments>${'<dx_attachment id="a" />\n'.repeat(MiB / 26)} x`,
    ];
    for (const input of inputs) {
      const elapsed = withinBudget(() => {
        parseMessageAttachments(input);
        stripMessageAttachmentTags(input);
        withMessageAttachments(input, [file]);
      });
      expect(elapsed).toBeLessThan(2_000);
    }
  });

  it("leaves no tag behind, however tags are split around each other", () => {
    for (const input of [
      nested(40),
      '<dx_attach<dx_attachments>ment id="x" />',
      '<</dx_attachments>dx_attachment id="x" />',
      "</<dx_attachment/>dx_attachments>",
      '<dx_<DX_ATTACHMENT />attachments>\n<dx_attachment id="x"/>',
      "<dx_attachments<dx_attachment>>",
      "<<dx_attachment>dx_attachment>>",
      '<DX_ATTACHMENTS><Dx_Attachment id="x" /></dx_ATTACHMENTS>',
    ]) {
      const stripped = stripMessageAttachmentTags(input);
      expect(hasTag(stripped), JSON.stringify([input, stripped])).toBe(false);
      expect(parseMessageAttachments(stripped).attachments).toEqual([]);
    }
  });

  it("keeps text that only mentions or resembles a tag", () => {
    for (const text of [
      "The `<dx_attachments` block lists files",
      "<dx_attachmentsfoo> and <dx_attachmentx /> are not tags",
      "a <div> b </div>\n\nc > d",
      "",
      "\n\nfirst line\n",
    ])
      expect(stripMessageAttachmentTags(text)).toBe(text);
  });

  it("removes typed tags and the newline after each", () => {
    expect(
      stripMessageAttachmentTags('plain <dx_attachment id="x" />text'),
    ).toBe("plain text");
    expect(
      stripMessageAttachmentTags(
        'before\n<dx_attachments>\n<dx_attachment id="x" />\n</dx_attachments>\nafter',
      ),
    ).toBe("before\nafter");
  });

  it("reads back the block it writes, and only a trailing block", () => {
    const body = withMessageAttachments("Look at this\n\n\n", [file, file]);
    expect(parseMessageAttachments(body)).toEqual({
      text: "Look at this",
      attachments: [file, file],
    });
    expect(parseMessageAttachments(`${body}\n  \n`).attachments).toEqual([
      file,
      file,
    ]);
    expect(parseMessageAttachments(withMessageAttachments("", [file]))).toEqual(
      { text: "", attachments: [file] },
    );
    expect(parseMessageAttachments(`${body}\nmore`)).toEqual({
      text: `${body}\nmore`,
      attachments: [],
    });
    // Only the last block can be trailing.
    const twice = `${withMessageAttachments("a", [file])}\n${formatMessageAttachments([file, file])}`;
    expect(parseMessageAttachments(twice)).toEqual({
      text: withMessageAttachments("a", [file]),
      attachments: [file, file],
    });
  });
});
