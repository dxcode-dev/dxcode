import YAML from "yaml";

/**
 * What every skill importer shares: reading a SKILL.md and naming the media
 * type of a skill's other files. A skill keeps any text file at any path of
 * its folder (scripts/, references/, assets/); binary files are left out.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Splits Markdown into its YAML front matter and body. */
export const frontMatter = (
  text: string,
): { readonly data: Record<string, unknown>; readonly body: string } => {
  const source = text.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (match === null) return { data: {}, body: source };
  let data: unknown;
  try {
    data = YAML.parse(match[1] ?? "", { maxAliasCount: 10 });
  } catch {
    data = undefined;
  }
  return {
    data: isRecord(data) ? data : {},
    body: source.slice(match[0].length),
  };
};

const textMediaTypes = new Map([
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".mdx", "text/markdown"],
  [".txt", "text/plain"],
  [".json", "application/json"],
  [".jsonl", "application/jsonl"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".toml", "application/toml"],
  [".py", "text/x-python"],
  [".sh", "text/x-shellscript"],
  [".bash", "text/x-shellscript"],
  [".zsh", "text/x-shellscript"],
  [".ps1", "text/plain"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".cjs", "text/javascript"],
  [".jsx", "text/javascript"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".mts", "text/typescript"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".css", "text/css"],
  [".xml", "application/xml"],
  [".xsd", "application/xml"],
  [".svg", "image/svg+xml"],
  [".sql", "application/sql"],
  [".rb", "text/plain"],
  [".go", "text/plain"],
  [".rs", "text/plain"],
  [".java", "text/plain"],
  [".kt", "text/plain"],
  [".swift", "text/plain"],
  [".php", "text/plain"],
  [".lua", "text/plain"],
  [".r", "text/plain"],
  [".ini", "text/plain"],
  [".cfg", "text/plain"],
  [".conf", "text/plain"],
  [".env", "text/plain"],
  [".graphql", "text/plain"],
  [".proto", "text/plain"],
  [".tex", "text/plain"],
  [".rst", "text/plain"],
]);

/** Extensions of files that are never text, so no importer reads them. */
const binaryExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tif",
  ".tiff",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".7z",
  ".rar",
  ".jar",
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".wav",
  ".ogg",
  ".webm",
  ".docx",
  ".xlsx",
  ".pptx",
  ".pyc",
  ".class",
  ".sqlite",
  ".db",
]);

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};

/**
 * The media type a skill file is stored with, or undefined for a file that
 * is binary by its extension. Any other file counts as text, so a file
 * without an extension (LICENSE, Makefile) or of an unlisted language is
 * kept; its content must still decode as UTF-8 text.
 */
export const skillFileMediaType = (path: string): string | undefined => {
  const extension = extensionOf(path);
  if (binaryExtensions.has(extension)) return undefined;
  return textMediaTypes.get(extension) ?? "text/plain";
};

/** Whether a browser-reported media type names binary content. */
export const binaryBrowserMediaType = (mediaType: string): boolean => {
  const type = mediaType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "image/svg+xml") return false;
  return (
    /^(image|audio|video|font)\//.test(type) ||
    [
      "application/pdf",
      "application/zip",
      "application/gzip",
      "application/x-tar",
      "application/x-7z-compressed",
      "application/vnd.rar",
      "application/wasm",
      "application/java-archive",
    ].includes(type)
  );
};
