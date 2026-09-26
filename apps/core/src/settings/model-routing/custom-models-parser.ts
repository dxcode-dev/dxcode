import { ModelId } from "@dx/domain";
import { Option, Schema } from "effect";
import { catalogModelExists } from "./catalog.js";
import { copilotModelForCanonical } from "./copilot-mapping.js";

/** A parsed `custom` connection model line. */
export interface ParsedCustomModel {
  readonly canonical: ModelId;
  readonly upstream?: string;
}

export interface CustomModelLineError {
  /** 1-based line number in the textarea. */
  readonly line: number;
  readonly message: string;
}

const canonicalKnown = (canonical: string): boolean =>
  catalogModelExists(canonical) ||
  copilotModelForCanonical(canonical) !== undefined;

/**
 * Parses the Custom URL models textarea: one model per line, a canonical
 * `provider/model` id, optionally `canonical -> upstream-name` where the
 * right side is the exact string sent as `model` to the endpoint (decision
 * 9). Blank lines and `#` comments are ignored. Unknown canonical ids are
 * rejected with line numbers (decision 5a).
 */
export const parseCustomModels = (
  input: string,
): {
  readonly models: ReadonlyArray<ParsedCustomModel>;
  readonly errors: ReadonlyArray<CustomModelLineError>;
} => {
  const models: ParsedCustomModel[] = [];
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
    const canonical = Schema.decodeUnknownOption(ModelId)(left);
    if (Option.isNone(canonical)) {
      errors.push({
        line,
        message: "Expected a canonical model id like `openai/gpt-6-astra`.",
      });
      return;
    }
    if (!canonicalKnown(canonical.value)) {
      errors.push({
        line,
        message: `Unknown model \`${canonical.value}\` — pick a model from the catalog.`,
      });
      return;
    }
    if (right !== undefined && right !== "" && right.length > 256) {
      errors.push({ line, message: "Upstream name is too long." });
      return;
    }
    const first = seen.get(canonical.value);
    if (first !== undefined) {
      errors.push({
        line,
        message: `Duplicate of line ${first}.`,
      });
      return;
    }
    seen.set(canonical.value, line);
    models.push({
      canonical: canonical.value,
      ...(right === undefined || right === "" ? {} : { upstream: right }),
    });
  });
  return { models, errors };
};
