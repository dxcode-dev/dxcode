/**
 * Dictation in an artifact (#1758): the mic in the toolbar puts the
 * transcript at the cursor as a ProseMirror transaction, so it saves and
 * syncs like typed text, and the comment box has the composer's mic. Capture
 * and transcription are faked, as in use-dictation.browser.test.tsx.
 *
 * Ways it can fail, each covered below:
 *  1. The mic shows when the deployment serves no speech provider or the
 *     dictation switch is off, or to a reader who cannot edit.
 *  2. The transcript lands somewhere other than the cursor (the end of the
 *     document, a new block), replaces text, or is not a document change
 *     (so it neither saves nor undoes).
 *  3. The comment box has no mic, or its transcript is lost.
 */
import type { ThreadArtifact, ThreadArtifactComment } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

const fakes = vi.hoisted(() => {
  type Snapshot = {
    state: "idle" | "recording";
    waveform: ReadonlyArray<number>;
  };
  class Capture {
    snapshot: Snapshot = { state: "idle", waveform: [] };
    listeners = new Set<() => void>();
    finish = vi.fn(async () => {
      this.publish({ state: "idle", waveform: [] });
      return new Blob([new Uint8Array(45)]);
    });
    cancel = vi.fn(async () => this.publish({ state: "idle", waveform: [] }));
    start = vi.fn(async () =>
      this.publish({ state: "recording", waveform: [0, 0.5, 1] }),
    );
    subscribe = (listener: () => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    getSnapshot = () => this.snapshot;
    getServerSnapshot = () => ({ state: "idle" as const, waveform: [] });
    publish(snapshot: Snapshot) {
      this.snapshot = snapshot;
      for (const listener of this.listeners) listener();
    }
  }
  return {
    Capture,
    transcripts: [] as string[],
  };
});

vi.mock(
  "../../threads/dictation/dictation-capture.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../threads/dictation/dictation-capture.js")
    >()),
    DictationCapture: fakes.Capture,
  }),
);

vi.mock("../../threads/dictation/dictation-api.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../threads/dictation/dictation-api.js")
  >()),
  cancelDictationJob: vi.fn(),
  dictationMutationOptions: () => ({
    mutationFn: async () => fakes.transcripts.shift() ?? "",
    gcTime: 0,
  }),
}));

import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import {
  InsertDictation,
  TextareaDictation,
} from "../../threads/dictation/use-dictation.js";

/** The slot the Thread page passes down when dictation is available. */
const dictationSlot = { Insert: InsertDictation, Textarea: TextareaDictation };

import { artifactCommentsOptions } from "../artifact-comments-queries.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000f3" as ThreadId;
const userId = "usr_dictate" as UserId;

const artifact = (): ThreadArtifact => ({
  id: `art_${"d".repeat(32)}`,
  threadId,
  kind: "document",
  folder: "",
  title: "Dictate",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

let root: Root | undefined;
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  fakes.transcripts.length = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const mount = async (
  markdown: string,
  {
    comments = [],
    readOnly = false,
    dictationAvailable = true,
  }: {
    readonly comments?: ReadonlyArray<ThreadArtifactComment>;
    readonly readOnly?: boolean;
    readonly dictationAvailable?: boolean;
  } = {},
) => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  const container = document.body.appendChild(document.createElement("div"));
  container.style.height = "700px";
  container.style.width = "1200px";
  container.style.display = "flex";
  const client = createQueryClient();
  client.setQueryData(
    artifactCommentsOptions(threadId, artifact().id).queryKey,
    comments,
  );
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
          {/* As the Thread page offers it: only when dictation is available. */}
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact: artifact(), markdown }}
            readOnly={readOnly}
            switcher={null}
            dictation={dictationAvailable ? dictationSlot : undefined}
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

const MARKDOWN = ["Release notes draft.", "", "- [ ] Ship it", ""].join("\n");

/** Puts the caret right after `text` in the editor. */
const caretAfter = async (prose: HTMLElement, text: string) => {
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(text) ?? -1;
    if (at < 0) continue;
    prose.focus();
    const range = document.createRange();
    range.setStart(node, at + text.length);
    range.collapse(true);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    await settle();
    return;
  }
  throw new Error(`No text ${text}`);
};

/** Starts dictation with the mic `within`, then stops it to transcribe. */
const dictate = async (within: Element, transcript: string) => {
  fakes.transcripts.push(transcript);
  const start = within.querySelector<HTMLElement>(
    'button[aria-label="Start dictation"]',
  );
  if (start === null) throw new Error("No mic.");
  start.scrollIntoView({ block: "center" });
  await userEvent.click(start);
  await vi.waitUntil(() =>
    within.querySelector('button[aria-label="Stop dictation"]'),
  );
  // The button moves as the waveform appears beside it; click it where
  // it is now.
  await React.act(async () => {
    within
      .querySelector<HTMLElement>('button[aria-label="Stop dictation"]')
      ?.click();
  });
  await vi.waitUntil(() =>
    within.querySelector('button[aria-label="Start dictation"]'),
  );
  await settle(100);
};

const toolbar = () => {
  const bar = document.querySelector('[aria-label="Artifact tools"]');
  if (bar === null) throw new Error("No toolbar.");
  return bar;
};

describe("dictation in an artifact", () => {
  it("hides the mic when dictation is not served, and from a reader", async () => {
    await mount(MARKDOWN, { dictationAvailable: false });
    expect(
      toolbar().querySelector('button[aria-label="Start dictation"]'),
    ).toBeNull();
    await React.act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    await mount(MARKDOWN, { readOnly: true });
    expect(
      document.querySelector('button[aria-label="Start dictation"]'),
    ).toBeNull();
  });

  it("puts the transcript at the cursor in a checklist item and in a note, as an edit that undoes", async () => {
    const { prose } = await mount(MARKDOWN);
    await caretAfter(prose, "Ship it");
    await dictate(toolbar(), " and tell the team");
    await caretAfter(prose, "Release notes");
    // No leading space: the editor adds one before the word.
    await dictate(toolbar(), "for v2");
    expect(
      [...prose.children]
        .map((block) => (block.textContent ?? "").trim())
        .filter((text) => text !== ""),
    ).toEqual(["Release notes for v2 draft.", "Ship it and tell the team"]);
    expect(prose.querySelector("li input[type=checkbox]")).not.toBeNull();
    prose.focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    await settle();
    expect((prose.children[0]?.textContent ?? "").trim()).toBe(
      "Release notes draft.",
    );
  });

  it("dictates into the comment box", async () => {
    const quote = "Ship it";
    const { prose } = await mount(MARKDOWN, {
      comments: [
        {
          id: `cmt_${"5".repeat(32)}`,
          artifactId: artifact().id,
          parentId: null,
          quote,
          target: null,
          anchor: {
            revision: 1,
            start: MARKDOWN.indexOf(quote),
            end: MARKDOWN.indexOf(quote) + quote.length,
          },
          author: { kind: "agent" },
          body: "Is this ready?",
          createdAt: 1,
          resolvedAt: null,
        },
      ],
    });
    await settle(200);
    const highlighted = prose.querySelector<HTMLElement>(
      ".artifact-comment-anchor",
    );
    if (highlighted === null) throw new Error("No comment highlight.");
    await userEvent.click(highlighted);
    await settle(200);
    const box = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Reply"]',
    );
    if (box === null) throw new Error("No reply box.");
    box.focus();
    const form = box.closest("form");
    if (form === null) throw new Error("No reply form.");
    await dictate(form, "Yes, ship it today");
    expect(box.value).toBe("Yes, ship it today");
  });
});
