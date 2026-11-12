/**
 * Artifact comments, polished (owner direction, 2026-11-05): each entry shows
 * its author's avatar, mentions read as chips, and the composer writes
 * `@dx` as people read it while posting the mention dx wakes on.
 *
 * Ways it can fail, each covered below:
 *  1. An entry has no avatar, a person's picture is ignored, or dx shows a
 *     person's initials instead of its mark.
 *  2. A comment shows mention syntax (`@[Name](user:…)`, `@[dx](agent)`)
 *     instead of names, or loses its links; or a chip shows the name typed
 *     in the mention, so `@[Olive](user:<Maya>)` passes for Olive while it
 *     notifies Maya, or styles a mention of someone outside the Thread.
 *  3. Ask @dx writes the raw mention into the box, gives no sign that dx
 *     will reply, cannot be undone, or posts without the mention; or a
 *     typed `@dx` is not posted as one.
 */
import type { ThreadArtifact, ThreadArtifactComment } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { threadMembersQueryOptions } from "../../threads/sharing/thread-chat-queries.js";
import { artifactCommentsOptions } from "../artifact-comments-queries.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000f4" as ThreadId;
const userId = "usr_olive" as UserId;
const MAYA_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

const artifact = (): ThreadArtifact => ({
  id: `art_${"c".repeat(32)}`,
  threadId,
  kind: "document",
  folder: "",
  title: "Comments",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

let root: Root | undefined;
let posted: Array<Record<string, unknown>> = [];
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  posted = [];
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const mount = async (
  markdown: string,
  comments: ReadonlyArray<ThreadArtifactComment> = [],
) => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "POST" && url.endsWith("/comments"))
      posted.push(JSON.parse(String(init.body)));
    return new Promise<Response>(() => {});
  });
  const container = document.body.appendChild(document.createElement("div"));
  container.style.height = "700px";
  container.style.width = "800px";
  container.style.display = "flex";
  const client = createQueryClient();
  client.setQueryData(
    artifactCommentsOptions(threadId, artifact().id).queryKey,
    comments,
  );
  client.setQueryData(threadMembersQueryOptions(userId, threadId).queryKey, [
    {
      userId: "usr_maya",
      name: "Maya Member",
      handle: "maya",
      email: "maya@example.com",
      image: MAYA_IMAGE,
    },
  ] as never);
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Test", email: "t@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact: artifact(), markdown }}
            readOnly={false}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  const prose = container.querySelector<HTMLElement>(".artifact-prose");
  if (prose === null) throw new Error("Expected the editor.");
  return { container, prose };
};

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const MARKDOWN = "Ship it today.\n";
const QUOTE = "Ship it";

const entry = (
  id: string,
  author: ThreadArtifactComment["author"],
  body: string,
  parentId: string | null = null,
): ThreadArtifactComment => ({
  id: `cmt_${id.repeat(32)}`,
  artifactId: artifact().id,
  parentId,
  quote: parentId === null ? QUOTE : "",
  target: null,
  anchor:
    parentId === null ? { revision: 1, start: 0, end: QUOTE.length } : null,
  author,
  body,
  createdAt: 1,
  resolvedAt: null,
});

const ROOT = `cmt_${"1".repeat(32)}`;

/** Opens the seeded comment's card. */
const openComments = async (prose: HTMLElement) => {
  await settle(200);
  const highlight = prose.querySelector<HTMLElement>(
    ".artifact-comment-anchor",
  );
  if (highlight === null) throw new Error("No comment highlight.");
  await userEvent.click(highlight);
  await settle(200);
  const panel = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Comment"]',
  );
  if (panel === null) throw new Error("No comment card.");
  return panel;
};

describe("artifact comments", () => {
  it("show each author's avatar: dx's mark, a member's picture, or initials", async () => {
    const { prose } = await mount(MARKDOWN, [
      entry("1", { kind: "agent" }, "Ready to ship?"),
      entry(
        "2",
        { kind: "user", userId: "usr_maya", name: "Maya Member" },
        "Yes.",
        ROOT,
      ),
      entry(
        "3",
        { kind: "user", userId: "usr_omar", name: "Omar Outside" },
        "Agreed.",
        ROOT,
      ),
    ]);
    const panel = await openComments(prose);
    const avatars = [
      ...panel.querySelectorAll<HTMLElement>(".artifact-comment-avatar"),
    ];
    expect(avatars).toHaveLength(3);
    expect(avatars[0]?.querySelector(".dx-brand-wordmark")).not.toBeNull();
    expect(avatars[1]?.querySelector("img")?.getAttribute("src")).toBe(
      MAYA_IMAGE,
    );
    expect(avatars[2]?.textContent).toBe("OO");
  });

  it("show mentions as names, keeping links", async () => {
    const { prose } = await mount(MARKDOWN, [
      entry(
        "1",
        { kind: "user", userId: "usr_maya", name: "Maya Member" },
        "@[Omar Outside](user:usr_omar) and @[dx](agent), see https://example.com/spec",
      ),
    ]);
    const panel = await openComments(prose);
    const body = panel.querySelector<HTMLElement>(".artifact-comment-body");
    expect(body?.textContent).toBe(
      "@Omar Outside and @dx, see https://example.com/spec",
    );
    // Omar is outside the Thread: his name stays plain text, not a chip.
    expect(
      [...(body?.querySelectorAll(".artifact-comment-mention") ?? [])].map(
        (chip) => chip.textContent,
      ),
    ).toEqual(["@dx"]);
    expect(body?.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/spec",
    );
  });

  it("name a mentioned member as they are, whatever name the mention was written with", async () => {
    const { prose } = await mount(MARKDOWN, [
      entry(
        "1",
        { kind: "user", userId: "usr_omar", name: "Omar Outside" },
        "@[Olive](user:usr_maya) and @[Someone](user:usr_olive), please look",
      ),
    ]);
    const panel = await openComments(prose);
    const body = panel.querySelector<HTMLElement>(".artifact-comment-body");
    expect(body?.textContent).toBe("@Maya Member and @Test, please look");
    expect(
      [...(body?.querySelectorAll(".artifact-comment-mention") ?? [])].map(
        (chip) => chip.textContent,
      ),
    ).toEqual(["@Maya Member", "@Test"]);
  });

  it("write @dx as people read it, say dx will reply, and post the mention", async () => {
    const { prose } = await mount(MARKDOWN, [
      entry("1", { kind: "agent" }, "Ready to ship?"),
    ]);
    const panel = await openComments(prose);
    const box = panel.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Reply"]',
    );
    const ask =
      panel.querySelector<HTMLElement>('button[aria-label="Ask @dx"]') ??
      undefined;
    if (box === null || ask === undefined) throw new Error("No reply box.");
    await userEvent.click(ask);
    await settle();
    expect(box.value).toBe("@dx ");
    expect(ask.getAttribute("aria-pressed")).toBe("true");
    expect(panel.querySelector(".artifact-comment-asking")?.textContent).toBe(
      "dx will reply",
    );
    // Asking again takes it back.
    await userEvent.click(ask);
    await settle();
    expect(box.value).toBe("");
    expect(panel.querySelector(".artifact-comment-asking")).toBeNull();
    await userEvent.click(ask);
    await userEvent.type(box, "please check the date");
    await userEvent.click(
      panel.querySelector<HTMLElement>(
        'button[aria-label="Reply"]',
      ) as HTMLElement,
    );
    await settle();
    expect(posted).toEqual([
      { parentId: ROOT, body: "@[dx](agent) please check the date" },
    ]);
  });

  it("post a typed @dx as the mention, but leave other words alone", async () => {
    const { prose } = await mount(MARKDOWN, [
      entry("1", { kind: "agent" }, "Ready to ship?"),
    ]);
    const panel = await openComments(prose);
    const box = panel.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Reply"]',
    );
    if (box === null) throw new Error("No reply box.");
    await userEvent.type(box, "Thanks @dx, mail team@dxcode.dev");
    await settle();
    expect(panel.querySelector(".artifact-comment-asking")?.textContent).toBe(
      "dx will reply",
    );
    await userEvent.click(
      panel.querySelector<HTMLElement>(
        'button[aria-label="Reply"]',
      ) as HTMLElement,
    );
    await settle();
    expect(posted).toEqual([
      {
        parentId: ROOT,
        body: "Thanks @[dx](agent), mail team@dxcode.dev",
      },
    ]);
  });
});
