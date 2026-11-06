/**
 * An artifact's exports, as the reference editor offers them: its Markdown
 * as saved, a standalone HTML page, and the browser's print dialog (which
 * saves a PDF). The HTML is the document alone, written from its nodes, so
 * none of the editor's parts (highlights, grips, buttons) come with it.
 */
import { DOMSerializer, type Node } from "prosemirror-model";
import { artifactImageBlob } from "../artifacts-api.js";
import { artifactSchema } from "../markdown/artifact-markdown.js";
import { parseChip } from "../markdown/chips.js";
import { chipLabel } from "./chip-views.js";

const fileName = (title: string, extension: string) =>
  `${title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "artifact"}.${extension}`;

const download = (file: File) => {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

/**
 * An iPhone's or iPad's Home Screen app, where print does nothing and a
 * download strands the file in a viewer with no way back (WebKit bug
 * 290847): files go to the share sheet instead, whose Save to Files and
 * Print do the rest. A Safari tab, a desktop, and Android download.
 */
export const sharesFiles = () =>
  (navigator as Navigator & { readonly standalone?: boolean }).standalone ===
    true &&
  navigator.maxTouchPoints > 0 &&
  typeof navigator.share === "function";

/**
 * Saves `file`: downloads it, or in a Home Screen app hands it to the share
 * sheet. "again" when the phone wants a fresh tap to open the sheet (the
 * file took a moment to make).
 */
export const saveFile = async (file: File): Promise<"done" | "again"> => {
  if (!sharesFiles() || navigator.canShare?.({ files: [file] }) === false) {
    download(file);
    return "done";
  }
  try {
    await navigator.share({ files: [file], title: file.name });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError")
      return "again";
    // Closing the sheet is a choice, not a failure.
    if (!(error instanceof DOMException && error.name === "AbortError"))
      throw error;
  }
  return "done";
};

export const markdownFile = (title: string, markdown: string) =>
  new File([markdown], fileName(title, "md"), {
    type: "text/markdown;charset=utf-8",
  });

/**
 * Each image's bytes as a data URL, so a file on its own still shows it.
 * For a PDF, as a JPEG on white: the PDF maker reads a PNG in a worker made
 * from a blob, which the app's content security policy refuses.
 */
const imageData = async (
  sources: ReadonlyArray<string>,
  jpeg = false,
): Promise<Map<string, string>> => {
  const read = (blob: Blob) =>
    new Promise<string>((done, fail) => {
      const reader = new FileReader();
      reader.onload = () => done(String(reader.result));
      reader.onerror = () => fail(reader.error);
      reader.readAsDataURL(blob);
    });
  const asJpeg = async (blob: Blob) => {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("No canvas.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    // Its width rides on the URL's fragment, so the PDF does not enlarge it.
    return `${canvas.toDataURL("image/jpeg", 0.9)}#${bitmap.width}`;
  };
  const found = new Map<string, string>();
  await Promise.all(
    [...new Set(sources)].map(async (source) => {
      if (source.startsWith("data:") && !jpeg) return;
      try {
        const blob = await artifactImageBlob(source);
        if (blob === undefined) return;
        found.set(source, jpeg ? await asJpeg(blob) : await read(blob));
      } catch {
        // A missing image stays a link (HTML) or its alt text (PDF).
      }
    }),
  );
  return found;
};

const imageSources = (doc: Node) => {
  const sources: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "image") sources.push(String(node.attrs.src));
  });
  return sources;
};

/** The standalone HTML page, its images inside it. */
export const htmlFile = async (title: string, doc: Node) => {
  const data = await imageData(imageSources(doc));
  const page = new DOMParser().parseFromString(
    artifactHtml(title, doc),
    "text/html",
  );
  for (const image of page.querySelectorAll("img")) {
    const inline = data.get(image.getAttribute("src") ?? "");
    if (inline !== undefined) image.setAttribute("src", inline);
  }
  return new File(
    [`<!doctype html>\n${page.documentElement.outerHTML}\n`],
    fileName(title, "html"),
    { type: "text/html;charset=utf-8" },
  );
};

/** The document as a PDF made here, for where print does nothing. */
export const pdfFile = async (title: string, doc: Node) => {
  const [{ artifactPdf }, data] = await Promise.all([
    import("./artifact-pdf.js"),
    imageData(imageSources(doc), true),
  ]);
  return new File(
    [await artifactPdf(title, doc, data)],
    fileName(title, "pdf"),
    {
      type: "application/pdf",
    },
  );
};

/**
 * How an exported or printed artifact looks: the editor's light look, as
 * rules for the page's elements. `{root}` is the page's body for a file and
 * the print root for a print.
 */
const RULES: ReadonlyArray<readonly [string, string]> = [
  [
    "{root}",
    `max-width: 760px; margin: 0 auto; padding: 0 20px; color: #1f2328;
     background: #fff; color-scheme: light; font: 15px/1.6 system-ui, -apple-system, "Segoe UI",
     Roboto, sans-serif; -webkit-print-color-adjust: exact;
     print-color-adjust: exact;`,
  ],
  // The app's reset (list markers, heading weight, inputs) must not reach a
  // print made in its page.
  ["{root} h1, {root} h2, {root} h3", "font-weight: 700; color: #1f2328;"],
  ["{root} h1", "font-size: 2em; line-height: 1.2; margin: 0 0 .6em;"],
  ["{root} h2", "font-size: 1.5em; line-height: 1.3; margin: 1.4em 0 .5em;"],
  ["{root} h3", "font-size: 1.2em; margin: 1.2em 0 .4em;"],
  ["{root} p", "margin: 0 0 .8em;"],
  ["{root} a", "color: #0969da; text-decoration: underline;"],
  [
    "{root} table",
    "border-collapse: collapse; width: 100%; margin: 1em 0; break-inside: auto;",
  ],
  ["{root} tr", "break-inside: avoid;"],
  [
    "{root} th, {root} td",
    "border: 1px solid #d0d7de; padding: 6px 10px; vertical-align: top;",
  ],
  ["{root} th", "background: #f6f8fa; font-weight: 600; text-align: start;"],
  ["{root} th > p, {root} td > p", "margin: 0;"],
  [
    "{root} pre",
    `background: #f6f8fa; padding: 12px; border-radius: 6px;
     white-space: pre-wrap; break-inside: avoid;`,
  ],
  [
    "{root} code",
    "font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em;",
  ],
  [
    "{root} :not(pre) > code",
    "padding: .1em .35em; border-radius: 4px; background: #eff1f3;",
  ],
  [
    "{root} blockquote",
    "margin: 1em 0; padding-left: 1em; color: #59636e; border-left: 3px solid #d0d7de;",
  ],
  ["{root} hr", "border: 0; border-top: 1px solid #d0d7de; margin: 1.5em 0;"],
  ["{root} ul, {root} ol", "margin: 0 0 .8em; padding-left: 1.6em;"],
  ["{root} ul", "list-style: disc outside;"],
  ["{root} ol", "list-style: decimal outside;"],
  ["{root} li", "display: list-item;"],
  ["{root} li[data-checked]", "list-style: none; margin-left: -1.4em;"],
  [
    "{root} li[data-checked] > input",
    "margin: 0 .5em 0 0; vertical-align: -1px;",
  ],
  ["{root} li > p", "display: inline; margin: 0;"],
  [
    '{root} li[data-checked="true"] > p',
    "text-decoration: line-through; color: #59636e;",
  ],
  ["{root} img", "max-width: 100%;"],
  [
    "{root} .chip",
    `padding: 1px 8px; border-radius: 999px; background: #eef1f4;
     font-size: .9em; white-space: nowrap;`,
  ],
  ['{root} .chip[data-color="blue"]', "background: #dbeafe; color: #1e40af;"],
  ['{root} .chip[data-color="green"]', "background: #dcfce7; color: #166534;"],
  ['{root} .chip[data-color="yellow"]', "background: #fef3c7; color: #92400e;"],
  ['{root} .chip[data-color="red"]', "background: #fee2e2; color: #991b1b;"],
  ['{root} .chip[data-color="purple"]', "background: #f3e8ff; color: #6b21a8;"],
];

const css = (root: string) =>
  RULES.map(
    ([selector, rules]) =>
      `${selector.replaceAll("{root}", root)} { ${rules.replace(/\s+/g, " ")} }`,
  ).join("\n");

/** The document's own page: its title (unless it opens with one) and blocks. */
const exportPage = (title: string, doc: Node) => {
  const page = document.implementation.createHTMLDocument(title);
  const meta = page.createElement("meta");
  meta.setAttribute("charset", "utf-8");
  page.head.prepend(meta);
  page.body.append(
    DOMSerializer.fromSchema(artifactSchema).serializeFragment(doc.content, {
      document: page,
    }),
  );
  if (
    doc.firstChild?.type.name !== "heading" ||
    doc.firstChild.attrs.level !== 1
  ) {
    const heading = page.createElement("h1");
    heading.textContent = title;
    page.body.prepend(heading);
  }
  for (const item of page.querySelectorAll<HTMLElement>("li[data-checked]")) {
    const box = page.createElement("input");
    box.type = "checkbox";
    box.disabled = true;
    if (item.dataset.checked === "true") box.setAttribute("checked", "");
    item.prepend(box);
  }
  for (const element of page.querySelectorAll<HTMLElement>(
    "span.artifact-chip",
  )) {
    const chip = parseChip(element.dataset.source ?? "");
    const label = page.createElement("span");
    label.className = "chip";
    label.textContent =
      chip === undefined ? element.textContent : chipLabel(chip);
    const color =
      chip?.kind === "dropdown"
        ? chip.options.find((option) => option.selected)?.color
        : undefined;
    if (color !== undefined) label.dataset.color = color;
    element.replaceWith(label);
  }
  return page;
};

/** The document as one standalone HTML page, titled `title`. */
export const artifactHtml = (title: string, doc: Node) => {
  const page = exportPage(title, doc);
  const style = page.createElement("style");
  style.textContent = `${css("body")}\nbody { margin: 40px auto; }\n@media print { body { margin: 0 auto; } }`;
  page.head.append(style);
  return `<!doctype html>\n${page.documentElement.outerHTML}\n`;
};

/**
 * Prints the document in this page: for the print only, the app is hidden
 * and the document shows in its own light look, across as many pages as it
 * needs. A frame printed apart lost its look in some browsers (the owner's
 * report, 2026-11-06), and Safari on a phone prints the page around it.
 */
export const printArtifact = (title: string, doc: Node) => {
  document.querySelector(".artifact-print-root")?.remove();
  document.getElementById("artifact-print-style")?.remove();
  const root = document.createElement("div");
  root.className = "artifact-print-root";
  root.append(
    ...[...exportPage(title, doc).body.childNodes].map((node) =>
      document.importNode(node, true),
    ),
  );
  const style = document.createElement("style");
  style.id = "artifact-print-style";
  style.textContent = `@media screen { .artifact-print-root { display: none; } }
@media print {
  @page { margin: 16mm 14mm; }
  html.artifact-printing, html.artifact-printing body {
    height: auto !important; min-height: 0 !important;
    overflow: visible !important; background: #fff !important;
  }
  html.artifact-printing body > :not(.artifact-print-root) { display: none !important; }
  .artifact-print-root { display: block; }
  ${css(".artifact-print-root")}
}`;
  document.head.append(style);
  document.body.append(root);
  document.documentElement.classList.add("artifact-printing");
  const done = () => {
    root.remove();
    style.remove();
    document.documentElement.classList.remove("artifact-printing");
  };
  window.addEventListener("afterprint", done, { once: true });
  window.print();
};
