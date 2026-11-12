import {
  PluginNotice,
  PluginPrompt,
  PluginQuickAction,
  type PluginQuickActionKind,
} from "@dx/api";
import { Option, Schema } from "effect";
import type { PromptKind, PromptSpec } from "./store.js";

/**
 * Checks what plugin code passes to `ctx.ui` and `createQuickAction`, and
 * shapes a person's answer into what the plugin's call returns. Anything
 * malformed fails the plugin's call with a message its author can act on.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodePrompt = Schema.decodeUnknownOption(PluginPrompt);

const PROMPT_FIELDS: Record<PromptKind, ReadonlyArray<string>> = {
  confirm: [
    "title",
    "message",
    "confirmLabel",
    "cancelLabel",
    "destructive",
    "fields",
  ],
  input: [
    "title",
    "message",
    "placeholder",
    "defaultValue",
    "multiline",
    "secret",
  ],
  select: ["title", "message", "options"],
};

const LIMITS: Record<PromptKind, string> = {
  confirm:
    "ui.confirm takes a title (at most 120 characters), and optionally a message (2,000), confirmLabel and cancelLabel (40 each), destructive, and up to 8 fields of { key, label, value, multiline? }.",
  input:
    "ui.input takes a title (at most 120 characters), and optionally a message (2,000), placeholder (200), defaultValue (4,000), multiline, and secret.",
  select:
    "ui.select takes a title (at most 120 characters), optionally a message (2,000), and 1 to 20 options of { value, label, description? }.",
};

export const promptSpecOf = (
  kind: PromptKind,
  options: unknown,
): PromptSpec => {
  const raw = isRecord(options) ? options : {};
  const picked: Record<string, unknown> = {};
  for (const key of PROMPT_FIELDS[kind])
    if (raw[key] !== undefined) picked[key] = raw[key];
  const decoded = decodePrompt({
    ...picked,
    id: "check",
    plugin: "check",
    kind,
    createdAt: "",
    expiresAt: "",
  });
  if (Option.isNone(decoded)) throw new Error(LIMITS[kind]);
  const {
    id: _id,
    plugin: _plugin,
    kind: _kind,
    createdAt: _c,
    expiresAt: _e,
    ...spec
  } = decoded.value;
  if (kind === "confirm" && "fields" in spec && spec.fields !== undefined) {
    const keys = spec.fields.map(({ key }) => key);
    if (new Set(keys).size !== keys.length)
      throw new Error("Each ui.confirm field needs its own key.");
  }
  if (kind === "select" && "options" in spec) {
    const values = spec.options.map(({ value }) => value);
    if (new Set(values).size !== values.length)
      throw new Error("Each ui.select option needs its own value.");
  }
  return spec as PromptSpec;
};

/**
 * What the plugin's `confirm`, `input`, or `select` resolves to. A confirm
 * resolves true or false, or with fields, the edited values or false; an
 * input resolves its text; a select one option's value. Anything else is
 * null, as if nobody answered.
 */
export const promptAnswerOf = (
  kind: PromptKind,
  spec: PromptSpec,
  answer: unknown,
): unknown => {
  if (kind === "confirm") {
    const fields = "fields" in spec ? spec.fields : undefined;
    if (answer === false) return false;
    if (fields === undefined || fields.length === 0)
      return answer === true ? true : null;
    if (answer === true || isRecord(answer)) {
      const values: Record<string, string> = {};
      for (const field of fields) {
        const edited = isRecord(answer) ? answer[field.key] : undefined;
        values[field.key] = typeof edited === "string" ? edited : field.value;
      }
      return values;
    }
    return null;
  }
  if (kind === "input") return typeof answer === "string" ? answer : null;
  if (typeof answer !== "string" || !("options" in spec)) return null;
  return spec.options.some(({ value }) => value === answer) ? answer : null;
};

const decodeNotice = Schema.decodeUnknownOption(PluginNotice);

export const noticeOf = (message: unknown, level: unknown) => {
  const decoded = decodeNotice({
    id: "check",
    plugin: "check",
    createdAt: "",
    message: typeof message === "string" ? message.trim() : message,
    level: level ?? "info",
  });
  if (Option.isNone(decoded))
    throw new Error(
      "ui.notify takes a message of 1 to 500 characters and a level of info, success, warning, or error.",
    );
  return { message: decoded.value.message, level: decoded.value.level };
};

const decodeQuickAction = Schema.decodeUnknownOption(PluginQuickAction);

const ACTION_ARG: Record<
  PluginQuickActionKind,
  "text" | "url" | "command" | "pane"
> = {
  "send-message": "text",
  copy: "text",
  "open-url": "url",
  "run-command": "command",
  "open-pane": "pane",
};

export const quickActionOf = (options: unknown) => {
  const raw = isRecord(options) ? options : {};
  const args = isRecord(raw.args) ? raw.args : {};
  const action = raw.action as PluginQuickActionKind;
  const argName = ACTION_ARG[action];
  const decoded = decodeQuickAction({
    id: "check",
    plugin: "check",
    label: raw.label,
    action,
    args:
      argName === undefined || args[argName] === undefined
        ? {}
        : { [argName]: args[argName] },
  });
  if (
    argName === undefined ||
    Option.isNone(decoded) ||
    decoded.value.args[argName] === undefined
  )
    throw new Error(
      "createQuickAction takes a label (at most 48 characters) and an action: send-message or copy with args.text, open-url with args.url (https), run-command with args.command (a command this plugin registered), or open-pane with args.pane (a pane this plugin registered).",
    );
  if (
    argName === "pane" &&
    !/^[a-z][a-z0-9-]{0,47}$/.test(decoded.value.args.pane ?? "")
  )
    throw new Error(
      "An open-pane quick action names a pane id: 1 to 48 lowercase letters, digits, and hyphens.",
    );
  if (argName === "url") {
    let url: URL | undefined;
    try {
      url = new URL(decoded.value.args.url ?? "");
    } catch {
      url = undefined;
    }
    if (url?.protocol !== "https:")
      throw new Error("An open-url quick action needs an https:// URL.");
  }
  return {
    label: decoded.value.label,
    action: decoded.value.action,
    args: decoded.value.args,
  };
};
