export type FilePreviewKind = "markdown" | "table";

/** Files that read better rendered than as source. */
export const filePreviewKind = (
  path: string,
  mediaType?: string,
): FilePreviewKind | undefined => {
  const extension = path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase();
  if (
    mediaType === "text/markdown" ||
    extension === "md" ||
    extension === "mdx" ||
    extension === "markdown"
  )
    return "markdown";
  if (extension === "csv" || extension === "tsv") return "table";
  return undefined;
};

/** One record and the source line it starts on, its stable identity. */
export interface DelimitedRow {
  readonly line: number;
  readonly cells: readonly string[];
}

/** RFC 4180 fields: quoted fields may hold delimiters, quotes, and newlines. */
export const parseDelimited = (
  text: string,
  delimiter: string,
): DelimitedRow[] => {
  const rows: DelimitedRow[] = [];
  let row: string[] = [];
  let line = 1;
  let rowLine = 1;
  let field = "";
  let quoted = false;
  let fieldStart = true;
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === "\n") line += 1;
      if (character !== '"') field += character;
      else if (source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (character === delimiter) {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push({ line: rowLine, cells: row });
      line += 1;
      rowLine = line;
      row = [];
      field = "";
      fieldStart = true;
    } else {
      field += character;
      fieldStart = false;
    }
  }
  if (!fieldStart || field !== "" || row.length > 0) {
    row.push(field);
    rows.push({ line: rowLine, cells: row });
  }
  return rows;
};

/** Comma, unless the header row is clearly split by semicolons. */
export const delimiterFor = (path: string, content: string) => {
  if (path.toLowerCase().endsWith(".tsv")) return "\t";
  const header = content.slice(0, content.search(/\r?\n|$/));
  const count = (character: string) => header.split(character).length - 1;
  return count(";") > count(",") ? ";" : ",";
};

/** Spreadsheet column names (A, B, … Z, AA), a column's stable identity. */
export const columnName = (index: number): string =>
  index < 26
    ? String.fromCharCode(65 + index)
    : `${columnName(Math.floor(index / 26) - 1)}${columnName(index % 26)}`;
