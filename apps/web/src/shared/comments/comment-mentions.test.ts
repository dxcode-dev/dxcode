import { describe, expect, it } from "vitest";
import { asksAgent, draftOf, withMentions } from "./comment-mentions.js";

// Ways it could go wrong: a picked person whose name starts with "dx"
// posts as an @dx mention plus the rest of their name, waking the agent;
// @dx inside a longer word is taken for dx; a typed @dx no longer asks dx.

const picked = new Map([["dx second reviewer", "usr_second"]]);

describe("withMentions", () => {
  it("posts a picked person whose name starts with dx as that person", () => {
    const posted = withMentions("Ask @dx second reviewer to look", picked);
    expect(posted).toBe("Ask @[dx second reviewer](user:usr_second) to look");
    expect(asksAgent(posted)).toBe(false);
  });

  it("still posts a typed @dx as dx's mention beside a picked dx-named person", () => {
    expect(
      withMentions("@dx and @dx second reviewer, please check", picked),
    ).toBe(
      "@[dx](agent) and @[dx second reviewer](user:usr_second), please check",
    );
  });

  it("leaves @dx inside a longer word alone", () => {
    expect(withMentions("mail @dxcode or @dx-team", new Map())).toBe(
      "mail @dxcode or @dx-team",
    );
  });

  it("posts @here as everyone's mention", () => {
    expect(withMentions("@here heads up", new Map())).toBe(
      "@[here](here) heads up",
    );
  });
});

describe("draftOf", () => {
  it("turns a posted text back into the draft people read, with its picks", () => {
    const { draft, picked } = draftOf(
      "Ask @[dx second reviewer](user:usr_second) and @[dx](agent), @[here](here)",
    );
    expect(draft).toBe("Ask @dx second reviewer and @dx, @here");
    expect([...picked]).toEqual([["dx second reviewer", "usr_second"]]);
    // Posting the draft again gives back the same mentions.
    expect(withMentions(draft, picked)).toBe(
      "Ask @[dx second reviewer](user:usr_second) and @[dx](agent), @[here](here)",
    );
  });
});
