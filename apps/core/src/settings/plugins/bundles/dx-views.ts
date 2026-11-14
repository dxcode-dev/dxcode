import {
  MAX_PLUGIN_CALL_TARGETS,
  MAX_PLUGIN_EXPORTS,
  MAX_PLUGIN_THREAD_TYPES,
  MAX_PLUGIN_VIEW_PAGES,
  MAX_PLUGIN_VIEW_TABS,
  PLUGIN_ARCHIVED_MODES,
  PLUGIN_LUCIDE_ICON_PATTERN,
  PluginExport,
  PluginName,
  PluginThreadType,
  PluginViewId,
  PluginViewPage,
  type PluginViews,
  PluginViewTab,
} from "@dx/domain";
import { Option, Schema } from "effect";
import { isRecord, skipUnknownFields } from "./bundle-reader.js";

/**
 * Reads the view and call fields of `extensions["dev.dxcode"]`: `views`
 * (tabs, pages, and Thread types its code draws with `dx.registerView`),
 * `exports` (the functions other plugins may call), and
 * `permissions.plugins` (the plugins it may call). A malformed field is
 * refused whole with a reason that names it, so the caller turns dx's code
 * layer off, as it does for any malformed grant; a field dx does not read
 * is noted and ignored. Tier gating happens at resolution, not here.
 */

export type ReadViewsResult =
  | { readonly ok: true; readonly value: PluginViews | undefined }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves a per-item icon (`lucide:<name>`, or an asset path) to what is
 * stored: `readItemIcon`, which skips, with a reason, an icon it cannot
 * use. Without one, only `lucide:` names are kept.
 */
export type ResolveItemIcon = (
  raw: unknown,
  label: string,
) => string | undefined;

/** Notes a field dx does not read; it is ignored. */
export type SkipField = (path: string, reason: string) => void;

const lucideOnly: ResolveItemIcon = (raw) =>
  typeof raw === "string" && PLUGIN_LUCIDE_ICON_PATTERN.test(raw)
    ? raw
    : undefined;

const ignore: SkipField = () => undefined;

const withIcon = (
  raw: Record<string, unknown>,
  resolveIcon: ResolveItemIcon,
  label: string,
) => {
  const { icon, ...rest } = raw;
  const kept = icon === undefined ? undefined : resolveIcon(icon, label);
  return kept === undefined ? rest : { ...rest, icon: kept };
};

/** One field of an entry: its check, and what to write when it fails. */
interface FieldRule {
  readonly check: (value: unknown) => boolean;
  readonly expected: string;
  readonly required: boolean;
}

const ID_RULE: FieldRule = {
  check: Schema.is(PluginViewId),
  expected:
    "1 to 48 lowercase letters, digits, and hyphens, starting with a letter",
  required: true,
};
const TITLE_RULE: FieldRule = {
  check: (value) =>
    typeof value === "string" && value.length >= 1 && value.length <= 40,
  expected: "1 to 40 characters",
  required: true,
};
// The icon is resolved before the entry is checked: one dx cannot use is
// skipped with its own reason, so it never fails the entry.
const ICON_RULE: FieldRule = {
  check: () => true,
  expected: "",
  required: false,
};

const TAB_RULES: Readonly<Record<string, FieldRule>> = {
  id: ID_RULE,
  title: TITLE_RULE,
  icon: ICON_RULE,
  archivedThreads: {
    check: (value) =>
      (PLUGIN_ARCHIVED_MODES as ReadonlyArray<unknown>).includes(value),
    expected: PLUGIN_ARCHIVED_MODES.join(", "),
    required: false,
  },
};
const PAGE_RULES: Readonly<Record<string, FieldRule>> = {
  id: ID_RULE,
  title: TITLE_RULE,
  icon: ICON_RULE,
  path: {
    check: (value) =>
      typeof value === "string" &&
      value.length <= 200 &&
      /^\/[A-Za-z0-9._~/-]*$/.test(value),
    expected:
      "a path of at most 200 characters that starts with / and holds letters, digits, and . _ ~ / -",
    required: false,
  },
};
const THREAD_TYPE_RULES: Readonly<Record<string, FieldRule>> = {
  id: ID_RULE,
  title: TITLE_RULE,
  icon: ICON_RULE,
  view: { ...ID_RULE, expected: "the id of one of views.tabs" },
  chat: {
    check: (value) => value === "side" || value === "hidden",
    expected: "side or hidden",
    required: false,
  },
};
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

const list = <S extends Schema.Top>(
  raw: unknown,
  schema: S,
  rules: Readonly<Record<string, FieldRule>>,
  max: number,
  what: string,
  resolveIcon: ResolveItemIcon,
  skip: SkipField,
): { ok: true; value: Array<S["Type"]> } | { ok: false; reason: string } => {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw))
    return { ok: false, reason: `${what} must be a list.` };
  if (raw.length > max)
    return { ok: false, reason: `A plugin declares at most ${max} ${what}.` };
  const value: Array<S["Type"]> = [];
  for (const [index, item] of raw.entries()) {
    const label = `${what}[${index}]`;
    skipUnknownFields(skip, item, Object.keys(rules), label);
    const problem = entryProblem(item, rules, label);
    if (problem !== undefined) return { ok: false, reason: problem };
    const known = Object.fromEntries(
      Object.entries(item as Record<string, unknown>).filter(([key]) =>
        Object.hasOwn(rules, key),
      ),
    );
    const decoded = Schema.decodeUnknownOption(schema as never)(
      withIcon(known, resolveIcon, `${label}.icon`),
    ) as Option.Option<S["Type"]>;
    if (Option.isNone(decoded))
      return { ok: false, reason: `${label} is malformed.` };
    const id = (decoded.value as { id: string }).id;
    if (value.some((seen) => (seen as { id: string }).id === id))
      return { ok: false, reason: `Two ${what} share the id ${id}.` };
    value.push(decoded.value);
  }
  return { ok: true, value };
};

export const readDxViews = (
  raw: unknown,
  resolveIcon: ResolveItemIcon = lucideOnly,
  skip: SkipField = ignore,
  /** The manifest's pane ids: panes and views share one id namespace. */
  paneIds: ReadonlyArray<string> = [],
): ReadViewsResult => {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) return { ok: false, reason: "views is not an object." };
  skipUnknownFields(skip, raw, ["tabs", "pages", "threadTypes"], "views");
  const tabs = list(
    raw.tabs,
    PluginViewTab,
    TAB_RULES,
    MAX_PLUGIN_VIEW_TABS,
    "views.tabs",
    resolveIcon,
    skip,
  );
  if (!tabs.ok) return tabs;
  const pages = list(
    Array.isArray(raw.pages)
      ? raw.pages.map((page: unknown) =>
          isRecord(page) && page.path === undefined
            ? { ...page, path: "/" }
            : page,
        )
      : raw.pages,
    PluginViewPage,
    PAGE_RULES,
    MAX_PLUGIN_VIEW_PAGES,
    "views.pages",
    resolveIcon,
    skip,
  );
  if (!pages.ok) return pages;
  const threadTypes = list(
    Array.isArray(raw.threadTypes)
      ? raw.threadTypes.map((type: unknown) =>
          isRecord(type) && type.chat === undefined
            ? { ...type, chat: "side" }
            : type,
        )
      : raw.threadTypes,
    PluginThreadType,
    THREAD_TYPE_RULES,
    MAX_PLUGIN_THREAD_TYPES,
    "views.threadTypes",
    resolveIcon,
    skip,
  );
  if (!threadTypes.ok) return threadTypes;
  // `registerPane` and `registerView` share one id namespace in the code,
  // so a reused id would install and then fail in every Thread.
  const pageIds = new Set(pages.value.map(({ id }) => id));
  const tabIds = new Set(tabs.value.map(({ id }) => id));
  for (const id of tabIds)
    if (pageIds.has(id))
      return {
        ok: false,
        reason: `A tab and a page share the id ${id}; give each view its own id.`,
      };
  for (const id of paneIds)
    if (tabIds.has(id) || pageIds.has(id))
      return {
        ok: false,
        reason: `A pane and a view share the id ${id}; panes, tabs, and pages each need their own id.`,
      };
  const missing = threadTypes.value.find(({ view }) => !tabIds.has(view));
  if (missing !== undefined)
    return {
      ok: false,
      reason: `The Thread type ${missing.id} names the view ${missing.view}, which views.tabs does not list.`,
    };
  if (
    tabs.value.length === 0 &&
    pages.value.length === 0 &&
    threadTypes.value.length === 0
  )
    return { ok: true, value: undefined };
  return {
    ok: true,
    value: {
      tabs: tabs.value,
      pages: pages.value,
      threadTypes: threadTypes.value,
    },
  };
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
