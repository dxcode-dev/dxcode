/**
 * A dropdown's options can be edited from its picker (#1865), as the
 * reference editor allows: add, rename, recolor, reorder, remove, and remove
 * the dropdown; every edit is the chip's Markdown, so it saves.
 *
 * Ways it can fail, each covered below:
 *  1. The picker only selects; there is no way to add, rename, recolor,
 *     reorder or remove an option, or to remove the dropdown.
 *  2. A label that would break the Markdown (`|`, `}`, a leading `*`) or one
 *     already there is written anyway, corrupting the chip.
 *  3. Removing the selected option leaves a chip that names it.
 *  4. Selecting an option stops working.
 *  5. A phone cannot reach the controls (44px targets).
 *  6. Clicking the chip selects it as a node, and the text selection's
 *     toolbar shows over the page for it (seen on the branch preview).
 */
import type { ThreadArtifact } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../../styles.css";
import "../artifacts-view.css";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000d5" as ThreadId;
const userId = "usr_dropdown" as UserId;
const artifact: ThreadArtifact = {
  id: `art_${"d".repeat(32)}`,
  threadId,
  kind: "document",
  folder: "",
  title: "Status",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
};
const MARKDOWN = "Status: {{dropdown:Todo|*Doing:blue|Done:green}}\n";

let root: Root | undefined;
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

const mount = async (width: number) => {
  await page.viewport(width, 800);
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = `height:760px;width:${width}px;display:flex`;
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={createQueryClient()}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Dee", email: "d@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact, markdown: MARKDOWN }}
            readOnly={false}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await settle(150);
};

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const chip = () =>
  document.querySelector<HTMLElement>('.artifact-chip[data-kind="dropdown"]');
const source = () => chip()?.dataset.source;
const picker = () =>
  document.querySelector<HTMLElement>('[aria-label="Edit chip"]');
const open = async () => {
  const element = chip();
  if (element === null) throw new Error("No dropdown.");
  await userEvent.click(element);
  await settle(150);
  if (picker() === null) throw new Error("No picker.");
};
const control = (label: string) => {
  const element = picker()?.querySelector<HTMLElement>(
    `[aria-label="${label}"]`,
  );
  if (element === null || element === undefined)
    throw new Error(`No ${label}.`);
  return element;
};
const option = (label: string) => {
  const element = [
    ...(picker()?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (element === undefined) throw new Error(`No option ${label}.`);
  return element;
};

for (const width of [1440, 390]) {
  describe(`dropdown options at ${width}`, () => {
    it("adds an option, refusing a duplicate or one that would break the Markdown", async () => {
      await mount(width);
      await open();
      const add = control("New option");
      await userEvent.click(add);
      await userEvent.keyboard("Blocked{Enter}");
      await settle();
      expect(source()).toBe("{{dropdown:Todo|*Doing:blue|Done:green|Blocked}}");
      for (const bad of ["Done", "A|B", "x}y", "*Star"]) {
        await userEvent.click(control("New option"));
        await userEvent.keyboard(`${bad}{Enter}`);
        await settle();
        expect(source()).toBe(
          "{{dropdown:Todo|*Doing:blue|Done:green|Blocked}}",
        );
      }
      expect(picker()?.querySelector('[role="alert"]')).not.toBeNull();
    });

    it("renames an option, keeping it selected", async () => {
      await mount(width);
      await open();
      await userEvent.click(control("Rename Doing"));
      await userEvent.keyboard("{Control>}a{/Control}In Progress{Enter}");
      await settle();
      expect(source()).toBe("{{dropdown:Todo|*In Progress:blue|Done:green}}");
      expect(chip()?.textContent).toBe("In Progress");
    });

    it("cycles an option's color, moves it, and removes it", async () => {
      await mount(width);
      await open();
      await userEvent.click(control("Change Color of Todo"));
      await settle();
      expect(source()).toBe("{{dropdown:Todo:blue|*Doing:blue|Done:green}}");
      await userEvent.click(control("Move Done Up"));
      await settle();
      expect(source()).toBe("{{dropdown:Todo:blue|Done:green|*Doing:blue}}");
      await userEvent.click(control("Remove Doing"));
      await settle();
      expect(source()).toBe("{{dropdown:Todo:blue|Done:green}}");
      // The selected option is gone: the chip asks for a choice.
      expect(chip()?.textContent).toBe("Select…");
    });

    it("still selects an option, and removes the whole dropdown", async () => {
      await mount(width);
      await open();
      expect(document.querySelector(".artifact-selection-toolbar")).toBeNull();
      await userEvent.click(option("Done"));
      await settle();
      expect(source()).toBe("{{dropdown:Todo|Doing:blue|*Done:green}}");
      await open();
      if (width === 390)
        expect(
          control("Remove Dropdown").getBoundingClientRect().height,
        ).toBeGreaterThanOrEqual(44);
      await userEvent.click(control("Remove Dropdown"));
      await settle();
      expect(chip()).toBeNull();
      expect(document.querySelector(".artifact-prose")?.textContent).toBe(
        "Status: ",
      );
    });
  });
}
