import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMentionContext } from "./markdown-mention-context.js";
import { RichMarkdown } from "./rich-markdown.js";

describe("mentions in Markdown", () => {
  it("highlights known @handles in prose but not in code, links, or longer words", () => {
    const html = renderToStaticMarkup(
      <MarkdownMentionContext
        value={{
          handles: ["ada"],
          render: (handle, text) => <mark data-handle={handle}>{text}</mark>,
        }}
      >
        <RichMarkdown>
          {"Thanks @Ada, ask @adam. See `@ada` and [@ada](https://x.test)."}
        </RichMarkdown>
      </MarkdownMentionContext>,
    );
    expect(
      [...html.matchAll(/<mark data-handle="(\w+)">([^<]*)<\/mark>/g)].map(
        ([, handle, text]) => [handle, text],
      ),
    ).toEqual([["ada", "@Ada"]]);
    expect(html).toContain("<code>@ada</code>");
    expect(html).toContain(">@ada</a>");
  });
});
