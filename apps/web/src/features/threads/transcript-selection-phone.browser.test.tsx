/**
 * The menu at text selected in a Thread's message on a phone, whose own
 * selection menu (iOS: Copy, Look Up, Share; Android: Copy, Share, Select
 * All) floats over the selection, or under its handles when the selection
 * is near the top of the screen.
 *
 * Ways it can fail, each covered below:
 *  1. It repeats Copy, which the phone's menu has, and grows wide.
 *  2. It sits where the phone's menu opens, over the selection, so the two
 *     overlap: for a selection low on the screen it used to flip there.
 *  3. Near the top of the screen, where the phone's menu opens under the
 *     handles, it sits in the same spot.
 *  4. Its buttons are too small to tap.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { cdp } from "vitest/browser";
import {
  menuLabels,
  mountTranscript,
  overlaps,
  selectionMenu,
  selectText,
  unmountTranscript,
} from "../../testing/selection-menu-fixture.js";

beforeEach(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
});

afterEach(async () => {
  await unmountTranscript();
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
});

/** The phone's menu, with its gap to the text. */
const NATIVE_MENU_ROOM = 56;
/** The selection handles under the text. */
const TOUCH_HANDLE_ROOM = 32;

/** Where the phone's own menu opens for a selection: over it, or under it. */
const nativeMenu = (range: DOMRect) =>
  range.top >= NATIVE_MENU_ROOM
    ? { ...range, top: range.top - NATIVE_MENU_ROOM, bottom: range.top }
    : {
        ...range,
        top: range.bottom,
        bottom: range.bottom + TOUCH_HANDLE_ROOM + NATIVE_MENU_ROOM,
      };

/** The selection, its handles, and the phone's menu. */
const nativeArea = (range: DOMRect) => {
  const menu = nativeMenu(range);
  return {
    left: 0,
    right: window.innerWidth,
    top: Math.min(menu.top, range.top),
    bottom: Math.max(menu.bottom, range.bottom + TOUCH_HANDLE_ROOM),
  };
};

const expectClear = (range: DOMRect) => {
  const menu = selectionMenu()?.getBoundingClientRect();
  if (menu === undefined) throw new Error("Expected the menu.");
  expect(overlaps(menu, nativeArea(range))).toBe(false);
  expect(menu.left).toBeGreaterThanOrEqual(0);
  expect(menu.right).toBeLessThanOrEqual(window.innerWidth);
  return menu;
};

it("leaves Copy to the phone's menu and keeps big enough buttons", async () => {
  await mountTranscript({
    width: 390,
    height: 844,
    transcript: 700,
    onReply: () => undefined,
  });
  await selectText("beta ships on Friday");
  expect(menuLabels()).toEqual(["Reply"]);
  const button = selectionMenu()
    ?.querySelector("button")
    ?.getBoundingClientRect();
  expect(button?.height).toBeGreaterThanOrEqual(44);
});

it("sits under the handles, clear of the phone's menu over the text", async () => {
  await mountTranscript({
    width: 390,
    height: 844,
    transcript: 700,
    onReply: () => undefined,
  });
  const range = await selectText("beta ships on Friday");
  const menu = expectClear(range);
  expect(menu.top).toBeGreaterThanOrEqual(range.bottom);
});

it("goes over the phone's menu, not onto it, for a selection low in the transcript", async () => {
  await mountTranscript({
    width: 390,
    height: 844,
    transcript: 640,
    onReply: () => undefined,
  });
  const range = await selectText("the draft is in the Thread");
  const menu = expectClear(range);
  expect(menu.bottom).toBeLessThanOrEqual(range.top);
});

it("goes under the phone's menu when that one opens under the handles", async () => {
  await mountTranscript({
    width: 390,
    height: 844,
    transcript: 700,
    onReply: () => undefined,
  });
  const range = await selectText("Can we ship");
  expect(range.top).toBeLessThan(NATIVE_MENU_ROOM);
  const menu = expectClear(range);
  expect(menu.top).toBeGreaterThanOrEqual(range.bottom);
});
