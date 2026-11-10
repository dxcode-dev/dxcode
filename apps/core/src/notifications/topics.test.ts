import { describe, expect, it } from "vitest";
import { NOTIFICATION_TOPICS } from "./topics.js";

// The inbox keeps picked mentions as `@[Name](user:ID)` tokens and shows them
// as chips; email and push have no chips, so they must read `@Name`, never
// the raw token.
describe("A mention's email and push text", () => {
  it("shows picked mentions as names", () => {
    const content = NOTIFICATION_TOPICS.mention.content({
      actorName: "Ada Owner",
      threadTitle: "Checkout v2",
      excerpt:
        "@[Ben Member](user:usr_ben) please review, cc @[dx](agent) and @[here](here)",
    });
    expect(content.body).toBe("@Ben Member please review, cc @dx and @here");
    expect(content.preview).toBe(
      "Ada Owner: @Ben Member please review, cc @dx and @here",
    );
  });
});
