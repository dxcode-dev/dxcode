/**
 * The Files editor on a phone with a keyboard (#1989): after Find, typing
 * must land where the person sees the caret, and Home must work.
 *
 * Ways it can fail, each covered below:
 *  1. Closing Find (Escape or its Close button) leaves focus on the page,
 *     so typing goes nowhere.
 *  2. A tap that focuses the editor puts back the Find match (or any earlier
 *     caret) over the tapped spot, so the edit lands on another line.
 *  3. On an iPhone, Find's button sends Ctrl+F, which the editor reads as
 *     "cursor right", so Find never opens.
 *  4. Home goes to column 0 instead of the first non-blank, or Shift+Home
 *     does not select.
 *  5. Any of these changes a line other than the one being edited: each test
 *     compares the whole file with what it expects.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { cdp, page } from "vitest/browser";
import "../../../styles.css";
import { mountEditor, withLines } from "./file-editor-harness.js";

// The reported phone. Pierre reads the platform once per page.
Object.defineProperty(navigator, "platform", { get: () => "iPhone" });

let editor: Awaited<ReturnType<typeof mountEditor>>;
/** This test's editor, once it mounted; a failed mount cleans up itself. */
let mounted: typeof editor | undefined;

beforeEach(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  await page.viewport(393, 852);
  editor = await mountEditor();
  mounted = editor;
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** A real touch tap at a point in this page. */
const tap = async (element: Element, dx?: number) => {
  const box = element.getBoundingClientRect();
  // The test page is an iframe in Vitest's UI; CDP wants the top page's
  // coordinates.
  const frame = window.frameElement?.getBoundingClientRect();
  const scale = frame === undefined ? 1 : frame.width / window.innerWidth;
  const point = {
    x: (frame?.left ?? 0) + (box.left + (dx ?? box.width / 2)) * scale,
    y: (frame?.top ?? 0) + (box.top + box.height / 2) * scale,
  };
  await cdp().send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point],
  });
  await cdp().send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await editor.settle();
};

it("opens Find on an iPhone, and Escape puts typing at the match", async () => {
  await editor.find("needle");
  await editor.type("{Escape}");
  expect(editor.focused()).toBe(editor.editable);
  await editor.type("X");
  expect(editor.text()).toBe(withLines({ 13: "    const X = 1;" }));
});

it("puts typing at the match after Find's Close button", async () => {
  await editor.find("needle");
  const close = editor.findClose();
  if (close === null) throw new Error("No Close button");
  await tap(close);
  expect(editor.findInput()).toBeNull();
  expect(editor.focused()).toBe(editor.editable);
  await editor.type("X");
  expect(editor.text()).toBe(withLines({ 13: "    const X = 1;" }));
});

it("types on the tapped line while Find is open, not at the match", async () => {
  await editor.find("needle");
  await tap(editor.line(25), 4);
  expect(editor.focused()).toBe(editor.editable);
  await editor.type("Y");
  expect(editor.text()).toBe(withLines({ 25: "Yline 25 text" }));
});

it("types on the tapped line after the editor lost focus", async () => {
  await tap(editor.line(5), 4);
  await editor.type("A");
  await tap(editor.outside);
  expect(editor.focused()).toBe(editor.outside);
  await tap(editor.line(20), 4);
  await editor.type("B");
  expect(editor.text()).toBe(
    withLines({ 5: "Aline 5 text", 20: "Bline 20 text" }),
  );
});

it("moves Home to the first non-blank, then column 0", async () => {
  await tap(editor.line(13), 100);
  await editor.type("{Home}A");
  expect(editor.text()).toBe(withLines({ 13: "    Aconst needle = 1;" }));
  await editor.type("{Home}{Home}B");
  expect(editor.text()).toBe(withLines({ 13: "B    Aconst needle = 1;" }));
});

it("selects to the first non-blank with Shift+Home, then column 0", async () => {
  await tap(editor.line(13), 100);
  // End moves the browser's caret, which the editor learns of on the next
  // selectionchange; a person never presses Shift+Home before that.
  await editor.type("{End}");
  await editor.type("{Shift>}{Home}{/Shift}C");
  expect(editor.text()).toBe(withLines({ 13: "    C" }));
  await editor.type("{End}");
  await editor.type("{Shift>}{Home}{Home}{/Shift}D");
  expect(editor.text()).toBe(withLines({ 13: "D" }));
});
