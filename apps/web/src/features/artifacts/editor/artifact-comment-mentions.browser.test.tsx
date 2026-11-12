/**
 * `@` in an artifact comment (#1808): the Thread's people, dx, and `@here`,
 * from the same list the artifact's body offers.
 *
 * Ways it can fail, each covered below:
 *  1. Typing `@` in the comment box opens nothing; or the list offers
 *     someone outside the Thread, or you yourself.
 *  2. dx or `@here` is missing, or typing does not narrow the list.
 *  3. The keyboard or a click picks the wrong row, or Escape leaves it open.
 *  4. A picked person shows as mention syntax in the box, or posts as plain
 *     text, so nobody is notified; `@here` does not post as the mention
 *     everyone is notified by.
 *  5. A picked name edited afterwards still posts as a mention of that
 *     person.
 *  6. A posted `@here` shows as syntax instead of a chip.
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

const threadId = "thr_00000000-0000-4000-8000-0000000000f8" as ThreadId;
const userId = "usr_olive" as UserId;

const artifact = (): ThreadArtifact => ({
  id: `art_${"e".repeat(32)}`,
  threadId,
  kind: "document",
  folder: "",
  title: "Mentions",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

const QUOTE = "Ship it";
const ROOT = `cmt_${"1".repeat(32)}`;
const entry = (body: string): ThreadArtifactComment => ({
  id: ROOT,
  artifactId: artifact().id,
  parentId: null,
  quote: QUOTE,
  target: null,
  anchor: { revision: 1, start: 0, end: QUOTE.length },
  author: { kind: "agent" },
  body,
  createdAt: 1,
  resolvedAt: null,
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

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

const mount = async (body = "Ready to ship?") => {
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
    [entry(body)],
  );
  client.setQueryData(threadMembersQueryOptions(userId, threadId).queryKey, [
    {
      userId: "usr_olive",
      name: "Olive Owner",
      handle: "olive",
      email: "olive@example.com",
    },
    {
      userId: "usr_maya",
      name: "Maya Member",
      handle: "maya",
      email: "maya@example.com",
    },
  ] as never);
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Olive Owner", email: "o@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact: artifact(), markdown: "Ship it today.\n" }}
            readOnly={false}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await settle(200);
  const highlight = container.querySelector<HTMLElement>(
    ".artifact-comment-anchor",
  );
  if (highlight === null) throw new Error("No comment highlight.");
  await userEvent.click(highlight);
  await settle(200);
  const panel = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Comment"]',
  );
  if (panel === null) throw new Error("No comment card.");
  const reply = panel.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Reply"]',
  );
  if (reply === null) throw new Error("No reply box.");
  return { panel, reply };
};

const list = () =>
  document.querySelector<HTMLElement>(
    '[role="listbox"][aria-label="Mention someone"]',
  );
const rows = () =>
  [...(list()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].map(
    (row) => row.querySelector(".artifact-suggest-label")?.textContent,
  );

const send = async (panel: HTMLElement) => {
  const button = panel.querySelector<HTMLButtonElement>(
    'button[aria-label="Reply"]',
  );
  if (button === null) throw new Error("No Reply button.");
  await userEvent.click(button);
  await settle();
};

describe("@ in an artifact comment", () => {
  it("offers dx, the Thread's other people, and @here, narrowing as you type", async () => {
    const { reply } = await mount();
    await userEvent.click(reply);
    await userEvent.keyboard("@");
    await settle();
    expect(list()).not.toBeNull();
    expect(rows()).toEqual(["dx", "Maya Member", "here"]);
    await userEvent.keyboard("ma");
    await settle();
    expect(rows()).toEqual(["Maya Member"]);
    await userEvent.keyboard("{Escape}");
    await settle();
    expect(list()).toBeNull();
    expect(reply.value).toBe("@ma");
  });

  it("picks a person with the keyboard, shows their name, and posts their mention", async () => {
    const { panel, reply } = await mount();
    await userEvent.click(reply);
    await userEvent.keyboard("Please @");
    await settle();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await settle();
    expect(list()).toBeNull();
    expect(reply.value).toBe("Please @Maya Member ");
    await userEvent.keyboard("check the date");
    await send(panel);
    expect(posted.at(-1)?.body).toBe(
      "Please @[Maya Member](user:usr_maya) check the date",
    );
  });

  it("posts @here, picked with a click, as the mention everyone with access is notified by", async () => {
    const { panel, reply } = await mount();
    await userEvent.click(reply);
    await userEvent.keyboard("@he");
    await settle();
    expect(rows()).toEqual(["here"]);
    const option = list()?.querySelector<HTMLElement>('[role="option"]');
    if (option === null || option === undefined) throw new Error("No row");
    await userEvent.click(option);
    await settle();
    expect(reply.value).toBe("@here ");
    await userEvent.keyboard("ship it?");
    await send(panel);
    expect(posted.at(-1)?.body).toBe("@[here](here) ship it?");
  });

  it("posts a picked name you edited afterwards as plain text", async () => {
    const { panel, reply } = await mount();
    await userEvent.click(reply);
    await userEvent.keyboard("@ma{Enter}");
    await settle();
    expect(reply.value).toBe("@Maya Member ");
    await userEvent.keyboard("{Backspace}{Backspace}{Backspace} ok");
    await send(panel);
    expect(posted.at(-1)?.body).toBe("@Maya Memb ok");
  });

  it("shows a posted @here as a chip", async () => {
    const { panel } = await mount("@[here](here) please look");
    const chips = [
      ...panel.querySelectorAll(
        ".artifact-comment-body .artifact-comment-mention",
      ),
    ].map((chip) => chip.textContent);
    expect(chips).toContain("@here");
    expect(panel.textContent).not.toContain("](here)");
  });
});
