import {
  DATA_VIEW_ACTION_TYPES,
  DATA_VIEW_FORMATS,
  DATA_VIEW_PART_TYPES,
  DATA_VIEW_TONES,
  type DataViewActionType,
  type DataViewDefinition,
  type DataViewPartType,
  MAX_DATA_VIEW_ACTION_LABEL,
  MAX_DATA_VIEW_HINT,
  MAX_DATA_VIEW_PARTS,
  MAX_DATA_VIEW_STATE_BYTES,
} from "./data-view.js";
import { parseStatePath } from "./data-view-state.js";

/**
 * Checks a view file and names the part and field that fail, so an author
 * (usually an agent) can fix it from the message alone. Core runs it at
 * install; the browser never loads it.
 */

const MAX_TAB_DEPTH = 2;
const MAX_COLUMNS = 12;
const MAX_SERIES = 6;
const MAX_FIELDS = 12;
const MAX_OPTIONS = 50;
const MAX_TABS = 8;
const MAX_TEXT = 500;
const MAX_TEMPLATE = 4_000;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ─── Validation ──────────────────────────────────────────────────────────

export type ValidateDataViewResult =
  | { readonly ok: true; readonly view: DataViewDefinition }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> };

type Rule = (
  value: unknown,
  at: string,
  errors: string[],
  context: Context,
) => void;

interface Context {
  parts: number;
  readonly formIds: Set<string>;
}

const quote = (value: unknown) => {
  const text = JSON.stringify(value);
  return text === undefined
    ? String(value)
    : text.length > 60
      ? `${text.slice(0, 57)}...`
      : text;
};

const string =
  (max = MAX_TEXT): Rule =>
  (value, at, errors) => {
    if (typeof value !== "string" || value.length === 0)
      errors.push(`${at} is ${quote(value)}; it must be text.`);
    else if (value.length > max)
      errors.push(`${at} is ${value.length} characters; at most ${max}.`);
  };

const oneOf =
  (values: ReadonlyArray<unknown>): Rule =>
  (value, at, errors) => {
    if (!values.includes(value))
      errors.push(
        `${at} is ${quote(value)}; it must be one of ${values.join(", ")}.`,
      );
  };

const boolean: Rule = (value, at, errors) => {
  if (typeof value !== "boolean")
    errors.push(`${at} is ${quote(value)}; it must be true or false.`);
};

const path: Rule = (value, at, errors) => {
  if (
    typeof value !== "string" ||
    value === "" ||
    parseStatePath(value) === undefined
  )
    errors.push(
      `${at} is ${quote(value)}; it must be a state path such as stats.errors or rows.0.name: keys of letters, digits, _ and -, and list indexes, joined by dots.`,
    );
};

const key: Rule = (value, at, errors) => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value)
  )
    errors.push(
      `${at} is ${quote(value)}; it must be a field name: letters, digits, _ and -.`,
    );
};

const tones: Rule = (value, at, errors) => {
  if (!isPlainObject(value)) {
    errors.push(
      `${at} must be an object of value to tone, such as {"failed": "danger"}.`,
    );
    return;
  }
  for (const [name, tone] of Object.entries(value))
    oneOf(DATA_VIEW_TONES)(tone, `${at}.${name}`, errors, {
      parts: 0,
      formIds: new Set(),
    });
};

const list =
  (item: Rule, max: number, min = 1): Rule =>
  (value, at, errors, context) => {
    if (!Array.isArray(value)) {
      errors.push(`${at} must be a list.`);
      return;
    }
    if (value.length < min) errors.push(`${at} needs at least ${min}.`);
    if (value.length > max)
      errors.push(`${at} has ${value.length}; at most ${max}.`);
    value.slice(0, max).forEach((entry, index) => {
      item(entry, `${at}[${index}]`, errors, context);
    });
  };

const object =
  (
    fields: Readonly<
      Record<string, { readonly rule: Rule; readonly required?: boolean }>
    >,
    what: string,
  ): Rule =>
  (value, at, errors, context) => {
    if (!isPlainObject(value)) {
      errors.push(`${at} must be an object (${what}).`);
      return;
    }
    for (const field of Object.keys(value))
      if (!Object.hasOwn(fields, field))
        errors.push(
          `${at} has a field dx does not know: ${field}. Its fields are ${Object.keys(fields).join(", ")}.`,
        );
    for (const [field, { rule, required }] of Object.entries(fields)) {
      if (value[field] === undefined) {
        if (required === true) errors.push(`${at}.${field} is missing.`);
        continue;
      }
      rule(value[field], `${at}.${field}`, errors, context);
    }
  };

const req = (rule: Rule) => ({ rule, required: true });
const opt = (rule: Rule) => ({ rule });

const action: Rule = (value, at, errors, context) => {
  if (!isPlainObject(value)) {
    errors.push(
      `${at} must be an action object with a type: ${DATA_VIEW_ACTION_TYPES.join(", ")}.`,
    );
    return;
  }
  const rules: Record<DataViewActionType, Rule> = {
    open_thread: object(
      {
        type: req(oneOf(["open_thread"])),
        label: opt(string(MAX_DATA_VIEW_ACTION_LABEL)),
        thread: req(string()),
      },
      "open_thread",
    ),
    start_thread: object(
      {
        type: req(oneOf(["start_thread"])),
        label: opt(string(MAX_DATA_VIEW_ACTION_LABEL)),
        prompt: req(string(MAX_TEMPLATE)),
        title: opt(string()),
      },
      "start_thread",
    ),
    call: object(
      {
        type: req(oneOf(["call"])),
        label: opt(string(MAX_DATA_VIEW_ACTION_LABEL)),
        fn: req((fn, fnAt, fnErrors) => {
          if (typeof fn !== "string" || !/^[a-z][A-Za-z0-9_]{0,47}$/.test(fn))
            fnErrors.push(
              `${fnAt} is ${quote(fn)}; it must name a function the plugin exposes: a lowercase letter, then letters, digits, and _.`,
            );
        }),
        args: opt((args, argsAt, argsErrors) => {
          if (!isPlainObject(args))
            argsErrors.push(`${argsAt} must be an object.`);
        }),
        result: opt(path),
        confirm: opt(string()),
      },
      "call",
    ),
    open_link: object(
      {
        type: req(oneOf(["open_link"])),
        label: opt(string(MAX_DATA_VIEW_ACTION_LABEL)),
        url: req(string(2_000)),
      },
      "open_link",
    ),
    copy: object(
      {
        type: req(oneOf(["copy"])),
        label: opt(string(MAX_DATA_VIEW_ACTION_LABEL)),
        text: req(string(MAX_TEMPLATE)),
      },
      "copy",
    ),
  };
  const type = value.type;
  if (typeof type !== "string" || !Object.hasOwn(rules, type)) {
    errors.push(
      `${at}.type is ${quote(type)}; it must be one of ${DATA_VIEW_ACTION_TYPES.join(", ")}.`,
    );
    return;
  }
  rules[type as DataViewActionType](value, at, errors, context);
};

const base = { id: opt(string(64)), when: opt(path), unless: opt(path) };

const textOrBind =
  (rule: Rule): Rule =>
  (value, at, errors, context) => {
    rule(value, at, errors, context);
    if (
      isPlainObject(value) &&
      value.text === undefined &&
      value.bind === undefined
    )
      errors.push(`${at} needs text or bind.`);
  };

const column = object(
  {
    key: req(key),
    label: req(string(80)),
    hint: opt(string(MAX_DATA_VIEW_HINT)),
    format: opt(oneOf(DATA_VIEW_FORMATS)),
    tones: opt(tones),
    secondary: opt(boolean),
  },
  "a column: key and label",
);

const field: Rule = (value, at, errors, context) => {
  object(
    {
      type: req(oneOf(["input", "select", "switch", "textarea"])),
      name: req(key),
      label: req(string(80)),
      placeholder: opt(string(200)),
      options: opt(
        list(
          object(
            { value: req(string(200)), label: req(string(200)) },
            "an option: value and label",
          ),
          MAX_OPTIONS,
        ),
      ),
      bind: opt(path),
      required: opt(boolean),
    },
    "a field: type, name, and label",
  )(value, at, errors, context);
  if (
    isPlainObject(value) &&
    value.type === "select" &&
    value.options === undefined
  )
    errors.push(`${at}.options is missing: a select needs its options.`);
};

const partRules = (depth: number): Record<DataViewPartType, Rule> => ({
  heading: textOrBind(
    object(
      {
        type: req(oneOf(["heading"])),
        ...base,
        text: opt(string()),
        bind: opt(path),
        level: opt(oneOf([1, 2, 3])),
      },
      "heading",
    ),
  ),
  text: textOrBind(
    object(
      {
        type: req(oneOf(["text"])),
        ...base,
        text: opt(string(MAX_TEMPLATE)),
        bind: opt(path),
        tone: opt(oneOf(["default", "muted"])),
      },
      "text",
    ),
  ),
  stat: object(
    {
      type: req(oneOf(["stat"])),
      ...base,
      label: req(string(80)),
      hint: opt(string(MAX_DATA_VIEW_HINT)),
      bind: req(path),
      format: opt(oneOf(DATA_VIEW_FORMATS)),
      detail: opt(string(200)),
      change: opt(path),
      rising: opt(oneOf(["good", "bad"])),
    },
    "stat",
  ),
  table: object(
    {
      type: req(oneOf(["table"])),
      ...base,
      label: opt(string(80)),
      bind: req(path),
      columns: req(list(column, MAX_COLUMNS)),
      rowKey: opt(key),
      rowAction: opt(action),
      empty: opt(string(200)),
    },
    "table",
  ),
  list: object(
    {
      type: req(oneOf(["list"])),
      ...base,
      label: opt(string(80)),
      bind: req(path),
      primary: req(key),
      secondary: opt(key),
      meta: opt(key),
      badge: opt(key),
      tones: opt(tones),
      itemKey: opt(key),
      itemAction: opt(action),
      empty: opt(string(200)),
    },
    "list",
  ),
  chart: object(
    {
      type: req(oneOf(["chart"])),
      ...base,
      kind: req(oneOf(["line", "bar"])),
      label: req(string(80)),
      bind: req(path),
      x: req(key),
      series: req(
        list(
          object(
            { key: req(key), label: req(string(80)) },
            "a series: key and label",
          ),
          MAX_SERIES,
        ),
      ),
      format: opt(oneOf(DATA_VIEW_FORMATS)),
    },
    "chart",
  ),
  log: object(
    {
      type: req(oneOf(["log"])),
      ...base,
      label: opt(string(80)),
      bind: req(path),
      empty: opt(string(200)),
    },
    "log",
  ),
  form: (value, at, errors, context) => {
    object(
      {
        type: req(oneOf(["form"])),
        ...base,
        id: req(key),
        fields: req(list(field, MAX_FIELDS)),
        submit: req(
          object(
            { label: req(string(80)), action: req(action) },
            "submit: label and action",
          ),
        ),
      },
      "form",
    )(value, at, errors, context);
    if (isPlainObject(value) && typeof value.id === "string") {
      if (context.formIds.has(value.id))
        errors.push(`${at}.id ${quote(value.id)} is used by another form.`);
      context.formIds.add(value.id);
      const names = Array.isArray(value.fields)
        ? value.fields.flatMap((entry) =>
            isPlainObject(entry) && typeof entry.name === "string"
              ? [entry.name]
              : [],
          )
        : [];
      const twice = names.find((name, index) => names.indexOf(name) !== index);
      if (twice !== undefined)
        errors.push(`${at}.fields has two fields named ${twice}.`);
    }
  },
  button: object(
    {
      type: req(oneOf(["button"])),
      ...base,
      label: req(string(80)),
      action: req(action),
      variant: opt(oneOf(["default", "secondary", "outline", "danger"])),
    },
    "button",
  ),
  tabs: (value, at, errors, context) => {
    if (depth >= MAX_TAB_DEPTH) {
      errors.push(`${at}: tabs nest at most ${MAX_TAB_DEPTH} deep.`);
      return;
    }
    object(
      {
        type: req(oneOf(["tabs"])),
        ...base,
        tabs: req(
          list(
            object(
              { label: req(string(40)), parts: req(parts(depth + 1)) },
              "a tab: label and parts",
            ),
            MAX_TABS,
          ),
        ),
      },
      "tabs",
    )(value, at, errors, context);
  },
  code: textOrBind(
    object(
      {
        type: req(oneOf(["code"])),
        ...base,
        text: opt(string(16_000)),
        bind: opt(path),
        language: opt(key),
      },
      "code",
    ),
  ),
  badge: textOrBind(
    object(
      {
        type: req(oneOf(["badge"])),
        ...base,
        text: opt(string(80)),
        bind: opt(path),
        tone: opt(oneOf(DATA_VIEW_TONES)),
        tones: opt(tones),
      },
      "badge",
    ),
  ),
  empty: object(
    {
      type: req(oneOf(["empty"])),
      ...base,
      title: req(string(120)),
      description: opt(string()),
    },
    "empty",
  ),
});

const partLabel = (value: unknown, at: string) => {
  if (!isPlainObject(value)) return at;
  const name =
    typeof value.id === "string"
      ? value.id
      : typeof value.label === "string"
        ? value.label
        : typeof value.title === "string"
          ? value.title
          : typeof value.text === "string"
            ? value.text
            : undefined;
  const type = typeof value.type === "string" ? value.type : "part";
  return name === undefined
    ? `${at} (${type})`
    : `${at} (${type} ${quote(name.slice(0, 40))})`;
};

const part =
  (depth: number): Rule =>
  (value, at, errors, context) => {
    context.parts += 1;
    const label = partLabel(value, at);
    if (!isPlainObject(value)) {
      errors.push(
        `${at} must be an object with a type: ${DATA_VIEW_PART_TYPES.join(", ")}.`,
      );
      return;
    }
    const rules = partRules(depth);
    const type = value.type;
    if (typeof type !== "string" || !Object.hasOwn(rules, type)) {
      errors.push(
        `${label}: type is ${quote(type)}; it must be one of ${DATA_VIEW_PART_TYPES.join(", ")}.`,
      );
      return;
    }
    const own: string[] = [];
    rules[type as DataViewPartType](value, at, own, context);
    // Name the part once, before the field, so the author finds it.
    for (const error of own)
      errors.push(
        error.startsWith(`${at}.`)
          ? `${label}: ${error.slice(at.length + 1)}`
          : error.startsWith(`${at} `)
            ? `${label}:${error.slice(at.length)}`
            : error,
      );
  };

const parts = (depth: number): Rule => list(part(depth), MAX_DATA_VIEW_PARTS);

/**
 * Checks a view file's parsed JSON. Errors name the part by its place and
 * id or label, then the field, then what it must be, at most 20 of them.
 */
export const validateDataView = (raw: unknown): ValidateDataViewResult => {
  const errors: string[] = [];
  const context: Context = { parts: 0, formIds: new Set() };
  object(
    {
      title: req(string(80)),
      description: opt(string()),
      state: opt(() => undefined),
      parts: req(parts(0)),
    },
    "a view: title and parts",
  )(raw, "view", errors, context);
  if (context.parts > MAX_DATA_VIEW_PARTS)
    errors.push(
      `view has ${context.parts} parts counting those in tabs; at most ${MAX_DATA_VIEW_PARTS}.`,
    );
  if (isPlainObject(raw) && raw.state !== undefined) {
    const bytes = new TextEncoder().encode(
      JSON.stringify(raw.state),
    ).byteLength;
    if (bytes > MAX_DATA_VIEW_STATE_BYTES)
      errors.push(
        `view.state is ${bytes} bytes; a view's state is at most ${MAX_DATA_VIEW_STATE_BYTES}.`,
      );
  }
  // Paths read from the file's root: parts[2], not view.parts[2].
  for (const [index, error] of errors.entries())
    errors[index] = error.replace(/^view\./, "");
  if (errors.length > 0)
    return {
      ok: false,
      errors:
        errors.length > 20
          ? [...errors.slice(0, 20), `and ${errors.length - 20} more.`]
          : errors,
    };
  return { ok: true, view: raw as unknown as DataViewDefinition };
};
