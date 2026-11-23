/** Markdown for a fragment of rendered Markdown, such as a selection's. */
export const toMarkdown = (
  node: Node,
  list?: { ordered: boolean; index: number },
): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element) && !(node instanceof DocumentFragment))
    return "";
  const children = (within = list) =>
    [...node.childNodes].map((child) => toMarkdown(child, within)).join("");
  if (node instanceof DocumentFragment) return children();
  if (node.matches("button, [aria-hidden='true']")) return "";
  switch (node.tagName) {
    case "STRONG":
    case "B":
      return `**${children()}**`;
    case "EM":
    case "I":
      return `*${children()}*`;
    case "DEL":
    case "S":
      return `~~${children()}~~`;
    case "CODE":
      return node.closest("pre") === null
        ? `\`${node.textContent ?? ""}\``
        : (node.textContent ?? "");
    case "PRE":
      return `\n\`\`\`\n${(node.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n\n`;
    case "A": {
      const href = node.getAttribute("href");
      return href === null ? children() : `[${children()}](${href})`;
    }
    case "BR":
      return "\n";
    case "P":
      return `${children()}\n\n`;
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return `${"#".repeat(Number(node.tagName[1]))} ${children()}\n\n`;
    case "BLOCKQUOTE":
      return `${children()
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    case "UL":
    case "OL":
      return `${[...node.children]
        .map((item, index) =>
          toMarkdown(item, { ordered: node.tagName === "OL", index }),
        )
        .join("")}\n`;
    case "LI":
      return `${list?.ordered ? `${list.index + 1}.` : "-"} ${children(undefined).trim()}\n`;
    default:
      return children();
  }
};
