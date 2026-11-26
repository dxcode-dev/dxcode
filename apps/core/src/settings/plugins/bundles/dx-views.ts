import {
  MAX_PLUGIN_CALL_TARGETS,
  MAX_PLUGIN_EXPORTS,
  PluginExport,
  PluginName,
} from "@dx/domain";
import { Option, Schema } from "effect";
import { isRecord, skipUnknownFields } from "./bundle-reader.js";

/**
 * Reads the call fields of `extensions["dev.dxcode"]`: `exports` (the
 * functions other plugins may call) and `permissions.plugins` (the plugins
 * it may call). A malformed field is refused whole with a reason that names
 * it, so the caller turns dx's code layer off, as it does for any malformed
 * grant; a field dx does not read is noted and ignored.
 */

/** Notes a field dx does not read; it is ignored. */
type SkipField = (path: string, reason: string) => void;

const ignore: SkipField = () => undefined;

/** One field of an entry: its check, and what to write when it fails. */
interface FieldRule {
  readonly check: (value: unknown) => boolean;
  readonly expected: string;
  readonly required: boolean;
}

const EXPORT_RULES: Readonly<Record<string, FieldRule>> = {
  name: {
    check: Schema.is(PluginExport.fields.name),
    expected: "a letter, then letters, digits, and underscores, at most 48",
    required: true,
  },
  description: {
    check: (value) =>
      typeof value === "string" && value.length >= 1 && value.length <= 300,
    expected: "1 to 300 characters",
    required: true,
  },
  inputSchema: {
    check: isRecord,
    expected: "a JSON Schema object",
    required: false,
  },
};

/** Why an entry fails its rules, naming the field, or undefined when none does. */
const entryProblem = (
  item: unknown,
  rules: Readonly<Record<string, FieldRule>>,
  label: string,
): string | undefined => {
  if (!isRecord(item)) return `${label} must be an object.`;
  for (const [field, rule] of Object.entries(rules)) {
    const value = item[field];
    if (value === undefined) {
      if (rule.required)
        return `${label}.${field} is missing: ${rule.expected}.`;
      continue;
    }
    if (!rule.check(value))
      return `${label}.${field} is ${JSON.stringify(value)}; it must be ${rule.expected}.`;
  }
  return undefined;
};

export type ReadExportsResult =
  | {
      readonly ok: true;
      readonly value: ReadonlyArray<PluginExport> | undefined;
    }
  | { readonly ok: false; readonly reason: string };

export const readDxExports = (
  raw: unknown,
  skip: SkipField = ignore,
): ReadExportsResult => {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw))
    return { ok: false, reason: "exports must be a list." };
  if (raw.length > MAX_PLUGIN_EXPORTS)
    return {
      ok: false,
      reason: `A plugin exports at most ${MAX_PLUGIN_EXPORTS} functions.`,
    };
  const value: Array<PluginExport> = [];
  for (const [index, item] of raw.entries()) {
    const label = `exports[${index}]`;
    skipUnknownFields(skip, item, Object.keys(EXPORT_RULES), label);
    const problem = entryProblem(item, EXPORT_RULES, label);
    if (problem !== undefined) return { ok: false, reason: problem };
    const decoded = Schema.decodeUnknownOption(PluginExport)(item);
    if (Option.isNone(decoded))
      return { ok: false, reason: `${label} is malformed.` };
    if (value.some(({ name }) => name === decoded.value.name))
      return {
        ok: false,
        reason: `Two exports share the name ${decoded.value.name}.`,
      };
    value.push(decoded.value);
  }
  return { ok: true, value: value.length === 0 ? undefined : value };
};

export type ReadCallTargetsResult =
  | { readonly ok: true; readonly value: ReadonlyArray<PluginName> | undefined }
  | { readonly ok: false; readonly reason: string };

/** `permissions.plugins`: the plugins `ctx.plugins.call` may reach, by name. */
export const readDxCallTargets = (
  raw: unknown,
  self: string,
): ReadCallTargetsResult => {
  if (raw === undefined) return { ok: true, value: undefined };
  const decoded = Schema.decodeUnknownOption(
    Schema.Array(PluginName).check(Schema.isMaxLength(MAX_PLUGIN_CALL_TARGETS)),
  )(raw);
  if (Option.isNone(decoded))
    return {
      ok: false,
      reason: `permissions.plugins lists at most ${MAX_PLUGIN_CALL_TARGETS} plugin names.`,
    };
  if (decoded.value.includes(self as PluginName))
    return {
      ok: false,
      reason: "permissions.plugins may not name the plugin itself.",
    };
  const unique = [...new Set(decoded.value)];
  return { ok: true, value: unique.length === 0 ? undefined : unique };
};
