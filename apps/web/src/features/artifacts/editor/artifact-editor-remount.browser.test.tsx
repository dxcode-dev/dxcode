/**
 * Moving the Artifacts tab to another pane, splitting, opening the phone
 * sheet, or switching tabs unmounts the editor and mounts a new one (#1651:
 * a `/` typed before a pane move came back as text, and a table in a
 * checklist item came back as pipes). The new editor must carry on where the
 * old one stopped, without reloading from Markdown.
 *
 * Ways it can fail, each covered below:
 *  1. The new editor reparses the saved Markdown: unsaved edits, the caret,
 *     and undo history are lost, and anything that does not round-trip
 *     changes shape.
 *  2. An open `/` or `@` menu closes, or its query stays behind as text.
 *  3. A save made while a menu is open (on unmount, or by autosave) stores
 *     the `/query` or `@query` as text.
 *  4. A revision saved elsewhere while no editor was mounted is missed.
 *  5. Two editors of the same artifact at once (a moved pane mounts its new
 *     editor before the old one unmounts) show different documents, or a
 *     session outlives its QueryClient (a sign-out, or a test).
 */
import type { ThreadArtifact, ThreadMemberData } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { threadKeys } from "../../threads/thread-queries.js";
import { artifactKeys } from "../artifacts-queries.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000d1" as ThreadId;
const userId = "usr_viewer" as UserId;
const artifactId = `art_${"d".repeat(32)}`;

const MEMBERS = [
  {
    userId: "usr_viewer",
    name: "Viewer Self",
    handle: "viewer",
    email: "v@dx.test",
  },
  {
    userId: "usr_ada",
    name: "Ada Lovelace",
    handle: "ada",
    email: "a@dx.test",
  },
] as unknown as ThreadMemberData[];

const artifact = (revision: number): ThreadArtifact => ({
  id: artifactId,
  threadId,
  kind: "document",
  folder: "",
  title: "Release plan",
  revision,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

// A table inside the ticked checklist item, as in the owner's report.
const MARKDOWN = [
  "# Release plan",
  "",
  "- [ ] Write notes",
  "- [x] Approve",
  "",
  "  | Who | When |",
  "  | --- | --- |",
  "  | dx | Today |",
  "",
].join("\n");

let roots: Root[] = [];
afterEach(async () => {
  for (const root of roots) await React.act(() => root.unmount());
  roots = [];
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Saves the editor sends, as the Markdown each one carries. */
const saves: string[] = [];

const setup = () => {
  saves.length = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT" && typeof init.body === "string") {
      const body = JSON.parse(init.body) as { markdown?: string };
      if (typeof body.markdown === "string") saves.push(body.markdown);
    }
    void input;
    return new Promise<Response>(() => {});
  });
  const client = createQueryClient();
  client.setQueryData(threadKeys.members(userId, threadId), MEMBERS);
  return client;
};

/** One editor, as a pane or the phone sheet mounts it. */
const mount = async (
  client: ReturnType<typeof createQueryClient>,
  revision = 1,
  markdown = MARKDOWN,
) => {
  const container = document.body.appendChild(document.createElement("div"));
  container.style.height = "700px";
  container.style.display = "flex";
  const root = createRoot(container);
  roots.push(root);
  await React.act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Viewer Self", email: "v@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact: artifact(revision), markdown }}
            readOnly={false}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  const prose = container.querySelector<HTMLElement>(".artifact-prose");
  if (prose === null) throw new Error("Expected the editor.");
  return {
    prose,
    unmount: async () => {
      await React.act(() => root.unmount());
      roots = roots.filter((other) => other !== root);
      container.remove();
    },
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const type = async (text: string) => {
  await userEvent.keyboard(text);
  await settle();
};
const menuLabels = () =>
  [
    ...document.querySelectorAll(
      ".artifact-suggest [role=option] .artifact-suggest-label",
    ),
  ].map((label) => label.textContent);
/** The caret, as the text before it in its block. */
const caret = () => {
  const selection = getSelection();
  const node = selection?.anchorNode;
  const block = (node instanceof Element ? node : node?.parentElement)?.closest(
    ".artifact-prose > *, li, td, th",
  );
  if (selection === null || node == null || block == null) return undefined;
  const range = document.createRange();
  range.setStart(block, 0);
  range.setEnd(node, selection.anchorOffset);
  return range.toString();
};

/** Types into the table inside the checklist item. */
const tableInChecklistItem = async (prose: HTMLElement) => {
  const cell = prose.querySelector<HTMLElement>("li table td");
  if (cell === null) throw new Error("No table in the item.");
  await userEvent.click(cell);
  await type("{End} and Ada");
};

describe("a remounted editor carries on", () => {
  it("keeps unsaved edits, the caret, and an open / menu, and saves no /query", async () => {
    const client = setup();
    const first = await mount(client);
    await tableInChecklistItem(first.prose);
    await type(" /he");
    expect(menuLabels()).toContain("Heading 1");
    const before = { text: first.prose.textContent, caret: caret() };
    await first.unmount();
    // Saved on the way out, without the open menu's query.
    expect(saves.at(-1)).toBeDefined();
    expect(saves.at(-1)).not.toContain("/he");
    const second = await mount(client);
    await settle();
    expect(second.prose.textContent).toBe(before.text);
    expect(second.prose.querySelector("li table")).not.toBeNull();
    expect(menuLabels()).toContain("Heading 1");
    second.prose.focus();
    await settle();
    expect(caret()).toBe(before.caret);
    // The menu still works in the new editor.
    await type("{Escape}");
    expect(menuLabels()).toEqual([]);
    // Undo reaches edits made before the move.
    await type("{Control>}z{/Control}");
    expect(second.prose.textContent).not.toBe(before.text);
  });

  it("keeps an open @ picker and saves no @query", async () => {
    const client = setup();
    const first = await mount(client);
    await userEvent.click(first.prose.querySelector("li p") ?? first.prose);
    await type("{End} @ad");
    expect(menuLabels()).toEqual(["Ada Lovelace"]);
    await first.unmount();
    expect(saves.at(-1) ?? "").not.toContain("@ad");
    const second = await mount(client);
    await settle();
    expect(menuLabels()).toEqual(["Ada Lovelace"]);
    second.prose.focus();
    await type("{Enter}");
    expect(
      second.prose.querySelector(".artifact-chip")?.getAttribute("data-source"),
    ).toBe("@[Ada Lovelace](user:usr_ada)");
  });

  it("takes in a revision saved elsewhere while it was unmounted", async () => {
    const client = setup();
    const first = await mount(client);
    await first.unmount();
    client.setQueryData(artifactKeys.detail(threadId, artifactId), {
      artifact: artifact(2),
      markdown: "# Release plan\n\nShipped.\n",
    });
    const second = await mount(client, 1);
    await settle();
    expect(second.prose.textContent).toContain("Shipped.");
  });

  it("shows two editors at once the same document, and a new QueryClient starts afresh", async () => {
    const client = setup();
    const one = await mount(client);
    const two = await mount(client);
    expect(one.prose.isConnected && two.prose.isConnected).toBe(true);
    await userEvent.click(two.prose.querySelector("li p") ?? two.prose);
    await type("{End} two");
    expect(two.prose.textContent).toContain("Write notes two");
    expect(one.prose.textContent).toContain("Write notes two");
    await one.unmount();
    // The other editor carries on alone.
    await type(" more");
    expect(two.prose.textContent).toContain("Write notes two more");
    await two.unmount();
    const other = await mount(setup());
    expect(other.prose.textContent).not.toContain("two");
  });
});
