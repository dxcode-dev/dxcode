import type katexModule from "katex";

// Fenced code opener or closer: up to three spaces, then ``` or ~~~ (3+).
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Inline `$…$` follows Pandoc: the opener has a non-space to its right, the
 * closer a non-space to its left and no digit after it. Prices such as
 * "$5 and $10" or "$5-$10" stay text.
 */
const inlineDollarMath = (text: string, open: number): number | undefined => {
  const first = text[open + 1];
  if (first === undefined || first === "$" || /\s/.test(first))
    return undefined;
  for (let index = open + 2; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char !== "$") continue;
    if (/\s/.test(text[index - 1] ?? "") || /\d/.test(text[index + 1] ?? ""))
      return undefined;
    return index;
  }
  return undefined;
};

/** Rewrites math in prose outside code spans to `$$…$$` text math. */
const normalizeInline = (line: string): string => {
  let out = "";
  let index = 0;
  while (index < line.length) {
    const char = line[index] as string;
    if (char === "`") {
      const run = /^`+/.exec(line.slice(index))?.[0] ?? "`";
      const close = line.indexOf(run, index + run.length);
      const end = close === -1 ? index + run.length : close + run.length;
      out += line.slice(index, end);
      index = end;
      continue;
    }
    if (char === "\\") {
      const next = line[index + 1];
      const closer = next === "(" ? "\\)" : next === "[" ? "\\]" : undefined;
      const close = closer === undefined ? -1 : line.indexOf(closer, index + 2);
      if (close !== -1) {
        out += `$$${line.slice(index + 2, close)}$$`;
        index = close + 2;
      } else {
        out += line.slice(index, index + 2);
        index += 2;
      }
      continue;
    }
    if (char === "$") {
      if (line[index + 1] === "$") {
        const close = line.indexOf("$$", index + 2);
        const end = close === -1 ? index + 2 : close + 2;
        out += line.slice(index, end);
        index = end;
        continue;
      }
      const close = inlineDollarMath(line, index);
      if (close !== undefined) {
        out += `$$${line.slice(index + 1, close)}$$`;
        index = close + 1;
        continue;
      }
    }
    out += char;
    index++;
  }
  return out;
};

/**
 * Models write math as `\(…\)`, `\[…\]`, `$…$`, and `$$…$$`. remark-math
 * parses only dollars, and single-dollar parsing turns prices into math, so
 * this rewrites the other delimiters to `$$` outside code before parsing:
 * display math on its own lines becomes a math block, the rest text math.
 */
export const normalizeMathDelimiters = (markdown: string): string => {
  if (!/[$\\]/.test(markdown)) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: { readonly char: string; readonly length: number } | undefined;
  let mathBlock: "$$" | "\\]" | undefined;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (fence !== undefined) {
      if (
        match?.[1] !== undefined &&
        match[1].charAt(0) === fence.char &&
        match[1].length >= fence.length &&
        match[2]?.trim() === ""
      )
        fence = undefined;
      out.push(line);
      continue;
    }
    const indent = /^[ \t>]*/.exec(line)?.[0] ?? "";
    const body = line.slice(indent.length).trimEnd();
    if (mathBlock !== undefined) {
      if (body.endsWith(mathBlock)) {
        const content = body.slice(0, -mathBlock.length).trimEnd();
        if (content !== "") out.push(`${indent}${content}`);
        out.push(`${indent}$$`);
        mathBlock = undefined;
      } else out.push(line);
      continue;
    }
    const marker = match?.[1];
    if (
      marker !== undefined &&
      !(marker.startsWith("`") && match?.[2]?.includes("`"))
    ) {
      fence = { char: marker.charAt(0), length: marker.length };
      out.push(line);
      continue;
    }
    const display = body.startsWith("$$")
      ? "$$"
      : body.startsWith("\\[")
        ? "\\]"
        : undefined;
    if (display !== undefined) {
      const rest = body.slice(2).trim();
      if (rest.endsWith(display) && rest.length > display.length) {
        // `$$x$$` alone on a line is text math to remark-math; keep it display.
        out.push(
          `${indent}$$`,
          `${indent}${rest.slice(0, -display.length).trim()}`,
          `${indent}$$`,
        );
        continue;
      }
      if (rest === "" || !rest.includes(display)) {
        out.push(`${indent}$$`);
        if (rest !== "") out.push(`${indent}${rest}`);
        mathBlock = display;
        continue;
      }
    }
    out.push(normalizeInline(line));
  }
  return out.join("\n");
};

type Katex = typeof katexModule;

let katex: Promise<Katex | undefined> | undefined;

/**
 * KaTeX and its stylesheet load on the first formula. A failed load settles
 * as `undefined` for the page lifetime so formulas keep their source text.
 */
export const loadKatex = (): Promise<Katex | undefined> => {
  katex ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]).then(
    ([module]) => module.default,
    () => undefined,
  );
  return katex;
};
