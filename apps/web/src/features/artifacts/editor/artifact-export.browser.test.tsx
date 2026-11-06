/**
 * Export an artifact as the reference editor does (#1801 audit, 2026-11-06):
 * Download Markdown, Download HTML, and Print or Save as PDF, for anyone who
 * can read it.
 *
 * Ways it can fail, each covered below:
 *  1. The menu lacks one of the three, or a reader who cannot edit has none.
 *  2. The HTML misses the title or the content (a table, a checklist's
 *     ticks, a dropdown's label), or carries the editor's own parts
 *     (contenteditable, comment highlights, buttons).
 *  3. A title with markup is written into the HTML as markup.
 *  5. The HTML's images point at the app, so the file shows none once
 *     opened on its own (the owner, on a phone, 2026-11-06).
 *  6. In an iPhone Home Screen app, where print does nothing and a download
 *     strands the file, Print or Save as PDF and the downloads do nothing
 *     (the owner, 2026-11-06): they must reach the share sheet as files,
 *     the print as a real PDF; and a share the phone refuses for want of a
 *     fresh tap must be finishable with one.
 *  4. Print shows the app, or the document unformatted (the owner's report,
 *     2026-11-06): no styles, dark page, one page cut at the window, no
 *     table borders, no chip colors; or what it adds stays afterwards.
 */
import type { ThreadArtifact, ThreadArtifactComment } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import "../../../styles.css";
import "../artifacts-view.css";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { artifactCommentsOptions } from "../artifact-comments-queries.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000e1" as ThreadId;
const userId = "usr_export" as UserId;
const TITLE = 'Plan <script>alert("x")</script>';
const artifact: ThreadArtifact = {
  id: `art_${"e".repeat(32)}`,
  threadId,
  folder: "",
  title: TITLE,
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
};
const MARKDOWN = [
  "Ship it today.",
  "",
  "- [x] Done item",
  "- [ ] Open item",
  "",
  "1. First",
  "2. Second",
  "",
  "- Bullet",
  "",
  "| Step | State |",
  "| --- | --- |",
  "| Edit | {{dropdown:Todo\\|*Doing:blue}} |",
  "",
  "![Chart](/v1/test-images/chart.png)",
  "",
].join("\n");
/** A 1×1 PNG, as the artifact's image answers. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);
const comment: ThreadArtifactComment = {
  id: `cmt_${"5".repeat(32)}`,
  artifactId: artifact.id,
  parentId: null,
  quote: "Ship it",
  anchor: { revision: 1, start: 0, end: 7 },
  author: { kind: "agent" },
  body: "Sure?",
  createdAt: 1,
  resolvedAt: null,
};

let root: Root | undefined;
let downloads: Array<{ name: string; type: string; text: string }> = [];
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  downloads = [];
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = async (readOnly: boolean) => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
    String(input instanceof Request ? input.url : input).endsWith("chart.png")
      ? Promise.resolve(
          new Response(PNG, { headers: { "Content-Type": "image/png" } }),
        )
      : new Promise<Response>(() => {}),
  );
  const blobs = new Map<string, Blob>();
  // Real URLs (a PDF's maker loads its worker from one), remembered so a
  // download's bytes can be read back.
  const real = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = real(blob as Blob);
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.href);
    if (blob === undefined) return;
    void blob
      .text()
      .then((text) =>
        downloads.push({ name: this.download, type: blob.type, text }),
      );
  });
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height:700px;width:1000px;display:flex";
  const client = createQueryClient();
  client.setQueryData(artifactCommentsOptions(threadId, artifact.id).queryKey, [
    comment,
  ]);
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Ex", email: "e@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact, markdown: MARKDOWN }}
            readOnly={readOnly}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await settle(200);
};

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const choose = async (item: string) => {
  await userEvent.click(page.getByRole("button", { name: "Export" }));
  await settle(150);
  await userEvent.click(page.getByRole("menuitem", { name: item }));
  await settle(300);
};

describe("artifact export", () => {
  for (const readOnly of [false, true])
    it(`offers Markdown, HTML, and Print${readOnly ? " to a reader" : ""}`, async () => {
      await mount(readOnly);
      await userEvent.click(page.getByRole("button", { name: "Export" }));
      await settle(150);
      expect(
        [...document.querySelectorAll('[role="menuitem"]')].map(
          (item) => item.textContent,
        ),
      ).toEqual(["Download Markdown", "Download HTML", "Print or Save as PDF"]);
    });

  it("downloads the Markdown as saved", async () => {
    await mount(false);
    await choose("Download Markdown");
    expect(downloads).toEqual([
      {
        name: "Plan -script-alert(-x-)-script-.md",
        type: "text/markdown;charset=utf-8",
        text: MARKDOWN,
      },
    ]);
  });

  it("downloads the document as standalone HTML, without the editor's parts", async () => {
    await mount(false);
    await choose("Download HTML");
    expect(downloads).toHaveLength(1);
    const file = downloads[0];
    expect(file?.name).toBe("Plan -script-alert(-x-)-script-.html");
    expect(file?.type).toBe("text/html;charset=utf-8");
    const doc = new DOMParser().parseFromString(file?.text ?? "", "text/html");
    expect(doc.title).toBe(TITLE);
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("h1")?.textContent).toBe(TITLE);
    expect(doc.body.textContent).toContain("Ship it today.");
    expect(
      [...doc.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(
        (box) => box.checked,
      ),
    ).toEqual([true, false]);
    expect(doc.querySelector("table td:last-child")?.textContent).toBe("Doing");
    expect(doc.querySelector("[contenteditable]")).toBeNull();
    expect(doc.querySelector(".artifact-comment-anchor")).toBeNull();
    expect(doc.querySelector("button")).toBeNull();
  });

  it("prints the document, formatted, as the only thing on the page", async () => {
    // The owner, 2026-11-06: "Print/Save as PDF loosing the formatting".
    await mount(true);
    type Seen = Record<string, string | boolean | number>;
    const seen: Seen[] = [];
    vi.spyOn(window, "print").mockImplementation(() => {
      // What the print shows: read under print media, as the dialog lays out.
      const root = document.querySelector<HTMLElement>(".artifact-print-root");
      const style = (element: Element | null | undefined) =>
        element === null || element === undefined
          ? undefined
          : getComputedStyle(element);
      const app = style(document.body.firstElementChild);
      const th = style(root?.querySelector("th"));
      const h1 = style(root?.querySelector("h1"));
      const chip = style(root?.querySelector(".chip"));
      const done = style(root?.querySelector('li[data-checked="true"] p'));
      seen.push({
        app: app?.display ?? "",
        root: style(root)?.display ?? "",
        background: style(document.body)?.backgroundColor ?? "",
        color: style(root)?.color ?? "",
        overflow: style(document.body)?.overflow ?? "",
        height: style(document.documentElement)?.height ?? "",
        h1: Number.parseFloat(h1?.fontSize ?? "0"),
        border: th?.borderTopStyle ?? "",
        chipColor: chip?.backgroundColor ?? "",
        struck: done?.textDecorationLine ?? "",
        text: root?.textContent ?? "",
        boxes: root?.querySelectorAll('input[type="checkbox"]').length ?? 0,
        weight: h1?.fontWeight ?? "",
        numbers: style(root?.querySelector("ol"))?.listStyleType ?? "",
        bullets:
          style(root?.querySelector("ul:not(:has(li[data-checked]))"))
            ?.listStyleType ?? "",
        tick:
          style(root?.querySelector('input[type="checkbox"]'))?.appearance ??
          "",
        scheme: style(root)?.colorScheme ?? "",
      });
    });
    await cdp().send("Emulation.setEmulatedMedia", { media: "print" });
    try {
      await choose("Print or Save as PDF");
      await settle(300);
    } finally {
      await cdp().send("Emulation.setEmulatedMedia", { media: "" });
    }
    expect(seen).toHaveLength(1);
    const print = seen[0] as Seen;
    // Only the document prints: the app is hidden, the page is white with
    // dark text, and it runs past one page instead of being cut at the
    // window's height.
    expect(print.app).toBe("none");
    expect(print.root).toBe("block");
    expect(print.background).toBe("rgb(255, 255, 255)");
    expect(print.color).toBe("rgb(31, 35, 40)");
    expect(print.overflow).toBe("visible");
    expect(print.height).not.toBe("700px");
    // Formatted: a large title, table borders, a colored dropdown, ticks.
    expect(print.h1).toBeGreaterThanOrEqual(28);
    expect(print.border).toBe("solid");
    expect(print.chipColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(print.struck).toBe("line-through");
    expect(print.boxes).toBe(2);
    // Not the app's reset (seen in the preview's printed PDF): lists keep
    // their markers, headings their weight, checkboxes their look.
    expect(print.numbers).toBe("decimal");
    expect(print.bullets).toBe("disc");
    expect(print.weight).toBe("700");
    expect(print.tick).not.toBe("none");
    // Light controls, not the app's dark ones (an empty box printed black).
    expect(print.scheme).toBe("light");
    expect(print.text).toContain("Ship it today.");
    // Gone once the dialog closes.
    window.dispatchEvent(new Event("afterprint"));
    await settle();
    expect(document.querySelector(".artifact-print-root")).toBeNull();
  });

  it("puts the images inside the downloaded HTML", async () => {
    await mount(false);
    await choose("Download HTML");
    await settle(300);
    const doc = new DOMParser().parseFromString(
      downloads[0]?.text ?? "",
      "text/html",
    );
    expect(doc.querySelector("img")?.getAttribute("src")).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  describe("in an iPhone Home Screen app", () => {
    let shared: File[] = [];
    let refuse = 0;
    const added: string[] = [];
    afterEach(() => {
      for (const key of added.splice(0)) Reflect.deleteProperty(navigator, key);
    });
    const homeScreen = () => {
      shared = [];
      refuse = 0;
      const define = (key: string, value: unknown) => {
        Object.defineProperty(navigator, key, { value, configurable: true });
        added.push(key);
      };
      define("standalone", true);
      define("maxTouchPoints", 5);
      define("canShare", () => true);
      define("share", async ({ files }: { files: File[] }) => {
        if (refuse > 0) {
          refuse -= 1;
          throw new DOMException("No tap", "NotAllowedError");
        }
        shared.push(...files);
      });
    };

    it("shares the downloads as files instead of a download that strands them", async () => {
      await mount(false);
      homeScreen();
      await choose("Download Markdown");
      await choose("Download HTML");
      await settle(300);
      expect(downloads).toEqual([]);
      expect(shared.map((file) => [file.name, file.type])).toEqual([
        ["Plan -script-alert(-x-)-script-.md", "text/markdown;charset=utf-8"],
        ["Plan -script-alert(-x-)-script-.html", "text/html;charset=utf-8"],
      ]);
    });

    it("makes Print or Save as PDF a real PDF, with its text, in the share sheet", async () => {
      await mount(true);
      homeScreen();
      const printed = vi.spyOn(window, "print");
      // The app's content security policy refuses a worker made from a
      // blob, which the PDF maker reaches for to read a PNG.
      const workers = vi.spyOn(window, "Worker").mockImplementation(() => {
        throw new DOMException("Refused by worker-src", "SecurityError");
      });
      await choose("Print or Save as PDF");
      await expect.poll(() => shared.length, { timeout: 10_000 }).toBe(1);
      const pdf = shared[0] as File;
      expect(printed).not.toHaveBeenCalled();
      expect(workers).not.toHaveBeenCalled();
      expect(pdf.type).toBe("application/pdf");
      expect(pdf.name).toBe("Plan -script-alert(-x-)-script-.pdf");
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      // More than a blank page: the text, a table, and the image.
      expect(pdf.size).toBeGreaterThan(5_000);
    });

    it("finishes with one more tap when the phone wants a fresh one", async () => {
      await mount(false);
      homeScreen();
      refuse = 1;
      await choose("Download HTML");
      await settle(300);
      expect(shared).toEqual([]);
      await userEvent.click(page.getByRole("button", { name: /^Save / }));
      await settle(200);
      expect(shared.map((file) => file.name)).toEqual([
        "Plan -script-alert(-x-)-script-.html",
      ]);
    });
  });
});
