/**
 * The menu at text selected in a Thread's message, with a mouse.
 *
 * Ways it can fail, each covered below:
 *  1. It shows for no selection, or not for one in a message.
 *  2. Reply quotes something other than the selection.
 *  3. A right-click's own menu (Copy, Look Up) opens over it, so the two
 *     overlap; or it never comes back for the next selection.
 *  4. Near the bottom of the transcript it covers the composer floating
 *     over it.
 */
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  menuLabels,
  mountTranscript,
  selectionMenu,
  selectText,
  settleMenu,
  unmountTranscript,
} from "../../testing/selection-menu-fixture.js";

afterEach(unmountTranscript);

it("shows Reply and the copy actions under a selection, and Reply quotes it", async () => {
  const onReply = vi.fn();
  await mountTranscript({
    width: 1440,
    height: 900,
    transcript: 700,
    onReply,
  });
  expect(selectionMenu()).toBeNull();
  const range = await selectText("beta ships on Friday");
  expect(menuLabels()).toEqual([
    "Reply",
    "Copy as Markdown",
    "Copy with Styling",
  ]);
  const menu = selectionMenu()?.getBoundingClientRect();
  expect(menu?.top).toBeGreaterThanOrEqual(range.bottom);
  selectionMenu()?.querySelector<HTMLButtonElement>("button")?.click();
  expect(onReply).toHaveBeenCalledWith("> beta ships on Friday\n", false);
});

it("steps aside for a right-click's menu until the selection changes", async () => {
  await mountTranscript({ width: 1440, height: 900, transcript: 700 });
  await selectText("beta ships on Friday");
  expect(selectionMenu()).not.toBeNull();
  await React.act(() =>
    getSelection()
      ?.getRangeAt(0)
      .startContainer.parentElement?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
        }),
      ),
  );
  await settleMenu();
  expect(selectionMenu()).toBeNull();
  await selectText("release notes for the beta");
  expect(selectionMenu()).not.toBeNull();
});

it("stays off the composer floating over the transcript, for a selection just above it", async () => {
  await mountTranscript({ width: 1440, height: 900, transcript: 600 });
  const range = await selectText("the draft is in the Thread");
  const composer = document
    .querySelector(".agent-composer-dock")
    ?.getBoundingClientRect();
  const menu = selectionMenu()?.getBoundingClientRect();
  if (menu === undefined || composer === undefined)
    throw new Error("Expected the menu.");
  expect(range.bottom).toBeLessThanOrEqual(composer.top);
  expect(menu.bottom).toBeLessThanOrEqual(composer.top);
  expect(menu.bottom).toBeLessThanOrEqual(range.top);
});
