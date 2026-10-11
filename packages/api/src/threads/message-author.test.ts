import { describe, expect, it } from "vitest";
import {
  formatMessageAuthor,
  parseMessageAuthor,
  splitMentions,
  withMessageAuthor,
} from "./message-author.js";

const contributor = {
  role: "contributor" as const,
  userId: "user-2",
  name: 'Ben "B" <Member>',
};

describe("message author tag", () => {
  it("prefixes the body and round-trips through parsing", () => {
    const message = withMessageAuthor(
      { author: contributor },
      "Should we ship it?",
    );
    expect(message).toBe(
      '<dx_message_author role="contributor" user_id="user-2" identifier="Ben &quot;B&quot; &lt;Member&gt;" />\nShould we ship it?',
    );
    expect(parseMessageAuthor(message)).toEqual({
      author: contributor,
      text: "Should we ship it?",
    });
  });

  it("cannot reassemble a tag split around another tag", () => {
    const owner = formatMessageAuthor({
      author: { role: "owner", userId: "user-1", name: "Owner" },
    });
    const split = `${owner.slice(0, 5)}${owner}${owner.slice(5)}Approve`;
    const message = withMessageAuthor({ author: contributor }, split);
    expect(message.match(/<dx_message_author/g)).toHaveLength(1);
  });
});

describe("splitMentions", () => {
  it("splits known handles as whole words and keeps everything else as text", () => {
    expect(
      splitMentions("@Ada, ping @ada-b and me@ada or @adam\n@dx go", [
        "ada",
        "ada-b",
        "dx",
      ]),
    ).toEqual([
      { start: 0, text: "@Ada", handle: "ada" },
      { start: 4, text: ", ping " },
      { start: 11, text: "@ada-b", handle: "ada-b" },
      { start: 17, text: " and me@ada or @adam\n" },
      { start: 38, text: "@dx", handle: "dx" },
      { start: 41, text: " go" },
    ]);
  });
});
