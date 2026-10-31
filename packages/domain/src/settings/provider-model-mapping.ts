/**
 * A provider API-key connection's model mapping: which of its provider's
 * catalog models it serves. Each line is a `provider/model` pattern. A
 * leading `-` excludes, `*` may stand only at the start or end, and the last
 * matching line wins. `-> id` after an exact include sends a different model
 * id upstream. No lines means the provider's whole catalog. Settings and the
 * resolver both read lines through this module.
 */

export interface ModelMappingLine {
  /** The pattern, with a leading `-` for an exclusion. */
  readonly canonical: string;
  readonly upstream?: string;
}

export interface ModelMappingParse {
  readonly lines: ReadonlyArray<ModelMappingLine>;
  readonly errors: ReadonlyArray<{
    readonly line: number;
    readonly message: string;
  }>;
}

const PATTERN = /^[^\s/]+\/[^\s]+$/;

/** Why a mapping line is invalid, or undefined when it is valid. */
export const modelMappingLineError = (
  line: ModelMappingLine,
): string | undefined => {
  const exclude = line.canonical.startsWith("-");
  const pattern = exclude ? line.canonical.slice(1) : line.canonical;
  if (!PATTERN.test(pattern))
    return `Use provider/model, such as anthropic/claude-opus-5-5: ${line.canonical}`;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "*" && index !== 0 && index !== pattern.length - 1)
      return `Put * only at the start or end: ${line.canonical}`;
  }
  if (line.upstream !== undefined && (exclude || pattern.includes("*")))
    return `Only an exact model can be renamed with ->: ${line.canonical}`;
  if (line.upstream !== undefined && !/^\S{1,256}$/.test(line.upstream))
    return `The id after -> must be one word: ${line.canonical}`;
  return undefined;
};

/** Parse mapping text: one line each, `#` comments and blank lines ignored. */
export const parseModelMappingText = (text: string): ModelMappingParse => {
  const lines: ModelMappingLine[] = [];
  const errors: { line: number; message: string }[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((raw, index) => {
    const trimmed = raw.replace(/#.*$/, "").trim();
    if (trimmed === "") return;
    const arrow = trimmed.indexOf("->");
    const canonical = (arrow === -1 ? trimmed : trimmed.slice(0, arrow)).trim();
    const upstream = arrow === -1 ? undefined : trimmed.slice(arrow + 2).trim();
    const line =
      upstream === undefined ? { canonical } : { canonical, upstream };
    const message = modelMappingLineError(line);
    if (message !== undefined) {
      errors.push({ line: index + 1, message });
      return;
    }
    if (seen.has(canonical)) {
      errors.push({ line: index + 1, message: `Duplicate line ${canonical}.` });
      return;
    }
    seen.add(canonical);
    lines.push(line);
  });
  return { lines, errors };
};

export const modelMappingText = (
  lines: ReadonlyArray<ModelMappingLine>,
): string =>
  lines
    .map(({ canonical, upstream }) =>
      upstream === undefined ? canonical : `${canonical} -> ${upstream}`,
    )
    .join("\n");

const patternMatches = (pattern: string, canonical: string) => {
  const leading = pattern.startsWith("*");
  const trailing = pattern.length > 1 && pattern.endsWith("*");
  const core = pattern.slice(leading ? 1 : 0, trailing ? -1 : undefined);
  if (leading && trailing) return canonical.includes(core);
  if (leading) return canonical.endsWith(core);
  if (trailing) return canonical.startsWith(core);
  return canonical === pattern;
};

/**
 * Whether the mapping serves `canonical`, and the upstream id to send when a
 * line renames it. No lines serves everything.
 */
export const modelMappingServes = (
  lines: ReadonlyArray<ModelMappingLine>,
  canonical: string,
): { readonly served: boolean; readonly upstream?: string } => {
  if (lines.length === 0) return { served: true };
  let result: { served: boolean; upstream?: string } = { served: false };
  for (const line of lines) {
    const exclude = line.canonical.startsWith("-");
    const pattern = exclude ? line.canonical.slice(1) : line.canonical;
    if (!patternMatches(pattern, canonical)) continue;
    result = exclude
      ? { served: false }
      : line.upstream === undefined
        ? { served: true }
        : { served: true, upstream: line.upstream };
  }
  return result;
};
