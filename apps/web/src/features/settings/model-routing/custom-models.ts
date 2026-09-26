/**
 * Client-side syntax checks with line-numbered errors. The server validates
 * model identifiers against the full catalog; the provider picker exposes
 * only deployment-enabled providers and is not a complete model catalog.
 */

export interface ParsedCustomModelLine {
  readonly canonical: string;
  readonly upstream?: string;
}

export interface CustomModelLineError {
  readonly line: number;
  readonly message: string;
}

const CANONICAL_PATTERN = /^[^\s/]+\/[^\s]+$/;

export const parseCustomModelsText = (
  input: string,
): {
  readonly models: ReadonlyArray<ParsedCustomModelLine>;
  readonly errors: ReadonlyArray<CustomModelLineError>;
} => {
  const models: ParsedCustomModelLine[] = [];
  const errors: CustomModelLineError[] = [];
  const seen = new Map<string, number>();
  input.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (text === "" || text.startsWith("#")) return;
    if (text.split("->").length > 2) {
      errors.push({
        line,
        message: "Expected at most one `->` separator.",
      });
      return;
    }
    const [left, right] = text.split("->").map((part) => part.trim());
    if (left === undefined || !CANONICAL_PATTERN.test(left)) {
      errors.push({
        line,
        message: "Expected a canonical model id like `openai/gpt-6-astra`.",
      });
      return;
    }
    if (right !== undefined && right !== "" && right.length > 256) {
      errors.push({ line, message: "Upstream name is too long." });
      return;
    }
    const first = seen.get(left);
    if (first !== undefined) {
      errors.push({ line, message: `Duplicate of line ${first}.` });
      return;
    }
    seen.set(left, line);
    models.push({
      canonical: left,
      ...(right === undefined || right === "" ? {} : { upstream: right }),
    });
  });
  return { models, errors };
};
