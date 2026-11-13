/**
 * The Files editor on a desktop (#1989): closing Find returns typing to the
 * match, a click after Find edits the clicked line, and Home is smart.
 * The phone cases, with the ways each can fail, are in
 * file-editor-phone.browser.test.tsx. Each test compares the whole file, so
 * a stray edit on any other line fails it.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import "../../../styles.css";
import { mountEditor, withLines } from "./file-editor-harness.js";

let editor: Awaited<ReturnType<typeof mountEditor>>;
/** This test's editor, once it mounted; a failed mount cleans up itself. */
let mounted: typeof editor | undefined;

beforeEach(async () => {
  editor = await mountEditor();
  mounted = editor;
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const click = async (element: HTMLElement, x: number) => {
  await userEvent.click(element, {
    position: { x, y: element.getBoundingClientRect().height / 2 },
  });
  await editor.settle();
};

it("puts typing at the match after Escape closes Find", async () => {
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
  await userEvent.click(close);
  await editor.settle();
  expect(editor.focused()).toBe(editor.editable);
  await editor.type("X");
  expect(editor.text()).toBe(withLines({ 13: "    const X = 1;" }));
});

it("types on the clicked line while Find is open", async () => {
  await editor.find("needle");
  await click(editor.line(25), 1);
  await editor.type("Y");
  expect(editor.text()).toBe(withLines({ 25: "Yline 25 text" }));
});

it("moves Home to the first non-blank, then column 0, and Shift+Home selects", async () => {
  await click(editor.line(13), 100);
  await editor.type("{Home}A");
  expect(editor.text()).toBe(withLines({ 13: "    Aconst needle = 1;" }));
  await editor.type("{End}{Shift>}{Home}{/Shift}C");
  expect(editor.text()).toBe(withLines({ 13: "    C" }));
  await editor.type("{Home}{Home}B");
  expect(editor.text()).toBe(withLines({ 13: "B    C" }));
});
