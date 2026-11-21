// A video playing in a message's gallery moves to the full-window viewer when
// it opens and back when it closes: one copy plays at a time, from the same
// moment, with the same sound settings. The viewer opens on the item shown.
// The clips are real VP8 files that count up their own seconds.

import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import clipA from "./fixtures/clip-a.webm?url";
import clipB from "./fixtures/clip-b.webm?url";
import {
  MarkdownImageSourceContext,
  type MarkdownImageSourceResolver,
} from "./markdown-file-link-context.js";
import { RichMarkdown } from "./rich-markdown.js";

const picture = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="teal"/></svg>',
)}`;

const resolve: MarkdownImageSourceResolver = (src) =>
  src === "first.webm"
    ? { url: clipA, kind: "video" }
    : src === "second.webm"
      ? { url: clipB, kind: "video" }
      : src === "still.png"
        ? { url: picture, kind: "image" }
        : undefined;

const gallery =
  "![First clip](first.webm)\n\n![Second clip](second.webm)\n\n![Still](still.png)";

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  document.body.replaceChildren();
});

const render = async (markdown: string) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => React.act(() => root.unmount()));
  await React.act(async () =>
    root.render(
      <MarkdownImageSourceContext.Provider value={resolve}>
        <RichMarkdown>{markdown}</RichMarkdown>
      </MarkdownImageSourceContext.Provider>,
    ),
  );
  return container;
};

const inlineVideo = (container: HTMLElement) => {
  const video = container.querySelector<HTMLVideoElement>(
    ".markdown-gallery video",
  );
  if (video === null) throw new Error("No video in the gallery");
  return video;
};

const viewer = () => document.querySelector<HTMLElement>(".dx-image-viewer");
const viewerVideo = () =>
  document.querySelector<HTMLVideoElement>(".dx-image-viewer video");
const playing = () =>
  [...document.querySelectorAll<HTMLMediaElement>("video, audio")].filter(
    (media) => !media.paused,
  );

const ready = (video: HTMLVideoElement) =>
  expect
    .poll(() => video.readyState, { timeout: 5000 })
    .toBeGreaterThanOrEqual(HTMLMediaElement.HAVE_METADATA);

const seek = async (video: HTMLVideoElement, time: number) => {
  await ready(video);
  video.currentTime = time;
  await expect.poll(() => video.seeking).toBe(false);
};

/**
 * Starts a video after a real click, which lets the page play sound. The
 * click lands on a button of the test's own: one on the player toggles playback itself a moment
 * later, after Chrome rules out a double click.
 */
const play = async (video: HTMLVideoElement) => {
  await ready(video);
  const start = document.createElement("button");
  start.textContent = "Start";
  document.body.prepend(start);
  await userEvent.click(start);
  start.remove();
  await React.act(() => video.play());
  await expect.poll(() => video.paused).toBe(false);
};

const openViewer = async () => {
  await userEvent.click(
    document.querySelector<HTMLElement>(
      ".markdown-gallery-expand",
    ) as HTMLElement,
  );
  await expect.poll(viewerVideo, { timeout: 5000 }).not.toBeNull();
  return viewerVideo() as HTMLVideoElement;
};

const closeViewer = async (how: "button" | "escape" | "outside") => {
  if (how === "button")
    await userEvent.click(
      document.querySelector<HTMLElement>(
        '.dx-image-viewer [aria-label="Close viewer"]',
      ) as HTMLElement,
    );
  else if (how === "escape") await userEvent.keyboard("{Escape}");
  else
    await userEvent.click(
      document.querySelector<HTMLElement>(
        ".dx-image-viewer-stage",
      ) as HTMLElement,
      { position: { x: 8, y: 8 } },
    );
  await expect.poll(viewer).toBeNull();
};

describe("a gallery video handed to the viewer", () => {
  it("pauses inline and plays in the viewer from the same moment", async () => {
    const container = await render(gallery);
    const inline = inlineVideo(container);
    await seek(inline, 3);
    await play(inline);
    const before = inline.currentTime;
    const shown = await openViewer();
    expect(inline.paused).toBe(true);
    await expect.poll(() => shown.paused, { timeout: 5000 }).toBe(false);
    await expect
      .poll(() => shown.currentTime, { timeout: 5000 })
      .toBeGreaterThan(before);
    expect(shown.currentTime).toBeLessThan(before + 2);
    expect(playing()).toEqual([shown]);
  });

  for (const how of ["button", "escape", "outside"] as const)
    it(`resumes inline from the viewer's moment after closing by ${how}`, async () => {
      const container = await render(gallery);
      const inline = inlineVideo(container);
      await seek(inline, 3);
      await play(inline);
      const shown = await openViewer();
      // The viewer takes over at the inline moment once its file's length is
      // known; a seek before then would be overwritten by that takeover.
      await expect
        .poll(() => shown.currentTime, { timeout: 5000 })
        .toBeGreaterThanOrEqual(3);
      await seek(shown, 6);
      await expect.poll(() => shown.paused).toBe(false);
      await closeViewer(how);
      await expect.poll(() => inline.paused, { timeout: 5000 }).toBe(false);
      expect(inline.currentTime).toBeGreaterThanOrEqual(6);
      expect(playing()).toEqual([inline]);
    });

  it("keeps a paused video paused at its moment both ways", async () => {
    const container = await render(gallery);
    const inline = inlineVideo(container);
    await seek(inline, 2.5);
    const shown = await openViewer();
    await ready(shown);
    await expect.poll(() => shown.currentTime).toBeCloseTo(2.5, 1);
    expect(shown.paused).toBe(true);
    await seek(shown, 5);
    await closeViewer("button");
    await expect.poll(() => inline.currentTime).toBeCloseTo(5, 1);
    expect(inline.paused).toBe(true);
    expect(playing()).toEqual([]);
  });

  it("carries mute and volume both ways", async () => {
    const container = await render(gallery);
    const inline = inlineVideo(container);
    inline.muted = true;
    inline.volume = 0.3;
    const shown = await openViewer();
    await expect.poll(() => shown.muted).toBe(true);
    expect(shown.volume).toBeCloseTo(0.3);
    shown.muted = false;
    shown.volume = 0.7;
    await closeViewer("button");
    expect(inline.muted).toBe(false);
    expect(inline.volume).toBeCloseTo(0.7);
  });

  it("pauses other media on the page while the viewer plays", async () => {
    const container = await render(
      `![Elsewhere](second.webm)\n\nThen a gallery:\n\n${gallery}`,
    );
    const elsewhere = container.querySelector<HTMLVideoElement>(
      "video.markdown-media",
    ) as HTMLVideoElement;
    const inline = inlineVideo(container);
    await play(elsewhere);
    await play(inline);
    const shown = await openViewer();
    await expect.poll(() => shown.paused, { timeout: 5000 }).toBe(false);
    expect(playing()).toEqual([shown]);
  });

  it("leaves the item alone when ←/→ seek a focused video", async () => {
    const container = await render(gallery);
    const shown = await (async () => {
      inlineVideo(container);
      return openViewer();
    })();
    shown.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(viewer()?.querySelector(".dx-image-viewer-count")?.textContent).toBe(
      "1 / 3",
    );
    expect(viewerVideo()).toBe(shown);
  });
});

describe("the viewer opens on the item shown", () => {
  it("opens the second item after stepping to it, and steps from there", async () => {
    const container = await render(gallery);
    await userEvent.click(
      container.querySelector<HTMLElement>(
        '.markdown-gallery [aria-label="Next"]',
      ) as HTMLElement,
    );
    const shown = await openViewer();
    const count = () =>
      viewer()?.querySelector(".dx-image-viewer-count")?.textContent;
    expect(count()).toBe("2 / 3");
    expect(shown.src).toContain("clip-b");
    await userEvent.click(
      viewer()?.querySelector('[aria-label="Next"]') as HTMLElement,
    );
    expect(count()).toBe("3 / 3");
    await userEvent.keyboard("{ArrowLeft}");
    expect(count()).toBe("2 / 3");
    await closeViewer("escape");
    expect(
      container.querySelector(".markdown-gallery-count")?.textContent,
    ).toBe("2 / 3");
  });
});
