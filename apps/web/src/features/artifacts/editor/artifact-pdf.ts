/**
 * The artifact as a PDF, made in the browser: where the browser cannot
 * print, as in an iPhone's Home Screen app, whose print does nothing.
 * The document maps onto pdfmake's blocks in the export's light look:
 * headings, text with its marks and links, lists and checklists, tables
 * with their alignment, quotes, code, dividers, chips, and images.
 * Loaded only when it is used.
 */
import type { Mark, Node } from "prosemirror-model";
import { parseChip } from "../markdown/chips.js";
import { chipLabel } from "./chip-views.js";

type Content = Record<string, unknown> | string;

/** An image's source, read as a JPEG data URL (with `#<width>`), if it can be. */
export type ImageSources = ReadonlyMap<string, string>;

const CHIP_COLORS: Record<string, readonly [string, string]> = {
  blue: ["#dbeafe", "#1e40af"],
  green: ["#dcfce7", "#166534"],
  yellow: ["#fef3c7", "#92400e"],
  red: ["#fee2e2", "#991b1b"],
  purple: ["#f3e8ff", "#6b21a8"],
};

const PAGE_WIDTH = 515;

const inline = (node: Node): Content[] => {
  const out: Content[] = [];
  node.forEach((child) => {
    if (child.isText) {
      const marks = (name: string) =>
        child.marks.find((mark: Mark) => mark.type.name === name);
      const link = marks("link");
      const text: Record<string, unknown> = { text: child.text ?? "" };
      if (marks("strong")) text.bold = true;
      if (marks("em")) text.italics = true;
      const decorations: string[] = [];
      if (marks("strike")) decorations.push("lineThrough");
      if (marks("code")) {
        text.background = "#eff1f3";
        text.fontSize = 9.5;
      }
      if (link !== undefined) {
        text.link = String(link.attrs.href);
        text.color = "#0969da";
        decorations.push("underline");
      }
      if (decorations.length > 0)
        text.decoration =
          decorations.length === 1 ? decorations[0] : decorations;
      out.push(text);
    } else if (child.type.name === "hard_break") out.push("\n");
    else if (child.type.name === "chip") {
      const chip = parseChip(String(child.attrs.source));
      if (chip === undefined) {
        out.push(String(child.attrs.source));
        return;
      }
      const color =
        chip.kind === "dropdown"
          ? chip.options.find((option) => option.selected)?.color
          : undefined;
      const [background, text] = CHIP_COLORS[color ?? ""] ?? [
        "#eef1f4",
        "#1f2328",
      ];
      out.push({
        text: `\u00a0${chipLabel(chip)}\u00a0`,
        background,
        color: text,
        fontSize: 9.5,
      });
    } else out.push(child.textContent);
  });
  return out;
};

/** A textblock's images, as their own blocks after its text. */
const images = (node: Node, sources: ImageSources): Content[] => {
  const out: Content[] = [];
  node.descendants((child) => {
    if (child.type.name !== "image") return true;
    const data = sources.get(String(child.attrs.src));
    out.push(
      data === undefined
        ? { text: `[${String(child.attrs.alt) || "image"}]`, color: "#59636e" }
        : {
            image: data.split("#")[0],
            // Its own size, at most the page's width; never enlarged.
            fit: [
              Math.min(
                PAGE_WIDTH,
                (Number(data.split("#")[1]) || PAGE_WIDTH) * 0.75,
              ),
              420,
            ],
            margin: [0, 4, 0, 8],
          },
    );
    return false;
  });
  return out;
};

const paragraph = (node: Node, sources: ImageSources): Content[] => [
  ...(node.textContent !== "" || node.childCount === 0
    ? [{ text: inline(node), margin: [0, 0, 0, 6] }]
    : []),
  ...images(node, sources),
];

/** A checklist item's box: filled with a tick when done. */
const box = (checked: boolean) => ({
  width: 14,
  canvas: [
    {
      type: "rect",
      x: 0,
      y: 2,
      w: 9,
      h: 9,
      r: 1.5,
      lineColor: "#8c959f",
      ...(checked ? { color: "#57606a" } : {}),
    },
    ...(checked
      ? [
          {
            type: "polyline",
            lineWidth: 1.4,
            lineColor: "#ffffff",
            points: [
              { x: 2, y: 6.5 },
              { x: 4, y: 8.5 },
              { x: 7.5, y: 4 },
            ],
          },
        ]
      : []),
  ],
});

const blocks = (parent: Node, sources: ImageSources): Content[] => {
  const out: Content[] = [];
  parent.forEach((node) => {
    out.push(...block(node, sources));
  });
  return out;
};

const listItem = (item: Node, sources: ImageSources): Content => {
  const inner = blocks(item, sources);
  if (item.attrs.checked === null || item.attrs.checked === undefined)
    return { stack: inner };
  const checked = item.attrs.checked === true;
  return {
    columns: [
      box(checked),
      {
        width: "*",
        stack: checked
          ? inner.map((part) =>
              typeof part === "object" && "text" in part
                ? { ...part, decoration: "lineThrough", color: "#59636e" }
                : part,
            )
          : inner,
      },
    ],
    columnGap: 2,
  };
};

const block = (node: Node, sources: ImageSources): Content[] => {
  switch (node.type.name) {
    case "paragraph":
      return paragraph(node, sources);
    case "heading":
      return [
        {
          text: inline(node),
          style: `h${Math.min(Number(node.attrs.level), 3)}`,
        },
      ];
    case "blockquote":
      return [
        {
          table: {
            widths: ["*"],
            body: [[{ stack: blocks(node, sources), color: "#59636e" }]],
          },
          layout: {
            vLineWidth: (index: number) => (index === 0 ? 3 : 0),
            hLineWidth: () => 0,
            vLineColor: () => "#d0d7de",
            paddingLeft: () => 10,
          },
          margin: [0, 2, 0, 8],
        },
      ];
    case "code_block":
      return [
        {
          table: {
            widths: ["*"],
            body: [
              [
                {
                  text: node.textContent,
                  fontSize: 9,
                  preserveLeadingSpaces: true,
                },
              ],
            ],
          },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: () => 0,
            fillColor: () => "#f6f8fa",
            paddingLeft: () => 8,
            paddingRight: () => 8,
            paddingTop: () => 6,
            paddingBottom: () => 6,
          },
          margin: [0, 2, 0, 8],
        },
      ];
    case "horizontal_rule":
      return [
        {
          canvas: [
            {
              type: "line",
              x1: 0,
              y1: 0,
              x2: PAGE_WIDTH,
              y2: 0,
              lineColor: "#d0d7de",
            },
          ],
          margin: [0, 8, 0, 10],
        },
      ];
    case "bullet_list":
    case "ordered_list": {
      const items: Content[] = [];
      node.forEach((item) => {
        items.push(listItem(item, sources));
      });
      const checklist = node.firstChild?.attrs.checked != null;
      if (checklist) return [{ stack: items, margin: [0, 0, 0, 6] }];
      return [
        node.type.name === "ordered_list"
          ? { ol: items, start: node.attrs.order, margin: [0, 0, 0, 6] }
          : { ul: items, margin: [0, 0, 0, 6] },
      ];
    }
    case "table": {
      const body: Content[][] = [];
      node.forEach((row, _, rowIndex) => {
        const cells: Content[] = [];
        row.forEach((cell) => {
          const parts: Content[] = [];
          cell.forEach((child) => {
            parts.push(...inline(child));
          });
          cells.push({
            text: parts,
            bold: rowIndex === 0,
            alignment: cell.attrs.align ?? "left",
            ...(rowIndex === 0 ? { fillColor: "#f6f8fa" } : {}),
          });
        });
        body.push(cells);
      });
      const columns = body[0]?.length ?? 1;
      return [
        {
          table: {
            headerRows: 1,
            widths: Array.from({ length: columns }, () => "*"),
            body,
          },
          layout: {
            hLineColor: () => "#d0d7de",
            vLineColor: () => "#d0d7de",
            paddingLeft: () => 6,
            paddingRight: () => 6,
            paddingTop: () => 4,
            paddingBottom: () => 4,
          },
          margin: [0, 4, 0, 10],
        },
      ];
    }
    default:
      return node.textContent === ""
        ? []
        : [{ text: node.textContent, margin: [0, 0, 0, 6] }];
  }
};

/** The document as pdfmake's definition, titled `title`. */
export const pdfDefinition = (
  title: string,
  doc: Node,
  sources: ImageSources,
) => {
  const opensWithTitle =
    doc.firstChild?.type.name === "heading" && doc.firstChild.attrs.level === 1;
  return {
    info: { title },
    pageSize: "A4",
    pageMargins: [40, 48, 40, 48] as [number, number, number, number],
    content: [
      ...(opensWithTitle ? [] : [{ text: title, style: "h1" }]),
      ...blocks(doc, sources),
    ],
    defaultStyle: { fontSize: 11, lineHeight: 1.3, color: "#1f2328" },
    styles: {
      h1: { fontSize: 22, bold: true, margin: [0, 0, 0, 10] },
      h2: { fontSize: 16, bold: true, margin: [0, 12, 0, 6] },
      h3: { fontSize: 13, bold: true, margin: [0, 10, 0, 4] },
    },
  };
};

/** The PDF's bytes. */
export const artifactPdf = async (
  title: string,
  doc: Node,
  sources: ImageSources,
): Promise<Blob> => {
  const [{ default: pdfMake }, { default: fonts }] = await Promise.all([
    import("pdfmake/build/pdfmake.js"),
    import("pdfmake/build/vfs_fonts.js"),
  ]);
  pdfMake.addVirtualFileSystem(fonts);
  return pdfMake
    .createPdf(pdfDefinition(title, doc, sources) as never)
    .getBlob();
};
