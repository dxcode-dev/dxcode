// A Thread transcript's messages over a composer, with the transcript's
// selection menu, for the menu's browser tests on a desktop and a phone.
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import {
  type TranscriptReply,
  TranscriptSelectionPopup,
} from "../features/threads/transcript-selection-popup.js";
import "../styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MESSAGES = [
  ["user-prompt", "Can we ship the beta on Friday after the review?"],
  ["assistant-prose", "Yes. The beta ships on Friday once the review passes."],
  ["user-prompt", "Then start the release notes for the beta today."],
  ["assistant-prose", "Started the release notes; the draft is in the Thread."],
] as const;

let root: Root | undefined;

export const unmountTranscript = async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
};

/**
 * A transcript filling the page with its messages spread over its top
 * `transcript` pixels, and the composer floating over the rest.
 */
export const mountTranscript = async ({
  width,
  height,
  transcript,
  onReply,
}: {
  readonly width: number;
  readonly height: number;
  readonly transcript: number;
  readonly onReply?: TranscriptReply;
}) => {
  await page.viewport(width, height);
  document.body.style.margin = "0";
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <>
        <div style={{ position: "relative", height }}>
          {/* As the Thread page: the composer floats over the transcript's
              bottom, which leaves room for it under the last message. */}
          <section
            className="pane-scroll agent-scroll transcript-viewport"
            style={{
              height,
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              padding: `16px 16px ${height - transcript + 16}px`,
              boxSizing: "border-box",
            }}
          >
            {MESSAGES.map(([kind, text], index) => (
              <article
                key={text}
                id={`row:msg${index}:text:0`}
                data-row-id={`row:msg${index}:text:0`}
                data-row-kind={kind}
                className={`transcript-row conversation-message ${
                  kind === "user-prompt" ? "user-message" : "agent-message"
                }`}
              >
                <div className="message-content">
                  <p>{text}</p>
                </div>
              </article>
            ))}
          </section>
          <form
            className="agent-composer-dock"
            aria-label="Composer"
            style={{ height: height - transcript, boxSizing: "border-box" }}
          />
        </div>
        <TranscriptSelectionPopup onReply={onReply} canDictate={false} />
      </>,
    ),
  );
  return container;
};

const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 60)));

/** Selects `text` where it first shows, as a drag or a long press would. */
export const selectText = async (text: string) => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const data = (node as Text).data;
    const start = data.indexOf(text);
    if (start < 0) continue;
    getSelection()?.setBaseAndExtent(node, start, node, start + text.length);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    await settle();
    return getSelection()?.getRangeAt(0).getBoundingClientRect() as DOMRect;
  }
  throw new Error(`No text "${text}" on the page.`);
};

export const selectionMenu = () =>
  document.querySelector<HTMLElement>(
    '[role="toolbar"][aria-label="Selection"]',
  );

export const menuLabels = () =>
  Array.from(selectionMenu()?.querySelectorAll("button") ?? [], (button) =>
    button.getAttribute("aria-label"),
  );

export const settleMenu = settle;

/** Whether two boxes share any area. */
export const overlaps = (
  a: { top: number; bottom: number; left: number; right: number },
  b: { top: number; bottom: number; left: number; right: number },
) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
