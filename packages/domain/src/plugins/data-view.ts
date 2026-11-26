/**
 * A plugin view described as data: a JSON file in the plugin's package that
 * dx draws with its own UI parts. Parts read their data from paths in the
 * view's state, which the plugin's code sets with
 * `ctx.views.set(viewId, path, value)`. Nothing in a view runs code: state
 * is drawn as text, and actions are dx's own (open or start a Thread, call
 * the plugin, open a link, copy).
 *
 * `validateDataView` checks a file and names the part and field that fail,
 * so an author (usually an agent) can fix it from the message alone.
 */

// ─── Limits ──────────────────────────────────────────────────────────────

/** A view file is at most this many bytes of JSON. */
export const MAX_DATA_VIEW_BYTES = 64 * 1_024;
/** A view's state is at most this many bytes of JSON. */
export const MAX_DATA_VIEW_STATE_BYTES = 512 * 1_024;
/** A plugin declares at most this many views described as data. */
export const MAX_DATA_VIEWS = 8;
/** Parts in one view, counting those inside tabs. */
export const MAX_DATA_VIEW_PARTS = 200;

// ─── Types ───────────────────────────────────────────────────────────────

export const DATA_VIEW_PLACES = ["page", "panel", "card", "app"] as const;
export type DataViewPlace = (typeof DATA_VIEW_PLACES)[number];

export const DATA_VIEW_PART_TYPES = [
  "heading",
  "text",
  "stat",
  "table",
  "list",
  "chart",
  "log",
  "form",
  "button",
  "tabs",
  "code",
  "badge",
  "empty",
] as const;
export type DataViewPartType = (typeof DATA_VIEW_PART_TYPES)[number];

export const DATA_VIEW_FORMATS = [
  "text",
  "number",
  "percent",
  "bytes",
  "duration",
  "money",
  "time",
] as const;
/**
 * How a value is written: `percent` reads 0.25 as 25%, `bytes` a byte count,
 * `duration` milliseconds, `money` US dollars, `time` an ISO timestamp.
 */
export type DataViewFormat = (typeof DATA_VIEW_FORMATS)[number];

export const DATA_VIEW_TONES = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
] as const;
export type DataViewTone = (typeof DATA_VIEW_TONES)[number];

export const DATA_VIEW_ACTION_TYPES = [
  "open_thread",
  "start_thread",
  "call",
  "open_link",
  "copy",
] as const;
export type DataViewActionType = (typeof DATA_VIEW_ACTION_TYPES)[number];

/**
 * A dx action. Text fields are templates: `{{path}}` is replaced with the
 * value at that path of the view's state, or of the row (`row.<key>`) or
 * form (`form.<name>`) the action belongs to.
 */
export type DataViewAction =
  | {
      readonly type: "open_thread";
      /** The Thread's id, a template such as `{{row.threadId}}`. */
      readonly thread: string;
    }
  | {
      readonly type: "start_thread";
      /** The first message of the new Thread. */
      readonly prompt: string;
      readonly title?: string;
    }
  | {
      readonly type: "call";
      /** A function the plugin exposes (`dx.expose`, manifest `exports`). */
      readonly fn: string;
      /** Arguments; each string in it is a template. */
      readonly args?: Readonly<Record<string, unknown>>;
      /** Where the function's reply goes in the view's state. */
      readonly result?: string;
      /** Asks this question before calling. */
      readonly confirm?: string;
    }
  | { readonly type: "open_link"; readonly url: string }
  | { readonly type: "copy"; readonly text: string };

interface PartBase {
  /** Names the part in error messages; a form's id names its values. */
  readonly id?: string;
  /** Shown only while the value at this path is not empty. */
  readonly when?: string;
  /** Shown only while the value at this path is empty. */
  readonly unless?: string;
}

export interface DataViewColumn {
  readonly key: string;
  readonly label: string;
  readonly format?: DataViewFormat;
  /** Draws the value as a badge, colored by value. */
  readonly tones?: Readonly<Record<string, DataViewTone>>;
  /** Hidden on phones. */
  readonly secondary?: boolean;
}

export interface DataViewSeries {
  readonly key: string;
  readonly label: string;
}

export interface DataViewOption {
  readonly value: string;
  readonly label: string;
}

export interface DataViewField {
  readonly type: "input" | "select" | "switch" | "textarea";
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly options?: ReadonlyArray<DataViewOption>;
  /** The field's first value, from this path of the state. */
  readonly bind?: string;
  readonly required?: boolean;
}

export type DataViewPart =
  | (PartBase & {
      readonly type: "heading";
      readonly text?: string;
      readonly bind?: string;
      readonly level?: 1 | 2 | 3;
    })
  | (PartBase & {
      readonly type: "text";
      readonly text?: string;
      readonly bind?: string;
      readonly tone?: "default" | "muted";
    })
  | (PartBase & {
      readonly type: "stat";
      readonly label: string;
      readonly bind: string;
      readonly format?: DataViewFormat;
      readonly detail?: string;
      /** A change since the last period, as a number. */
      readonly change?: string;
      /** Whether a rise is good news (default) or bad news. */
      readonly rising?: "good" | "bad";
    })
  | (PartBase & {
      readonly type: "table";
      readonly label?: string;
      readonly bind: string;
      readonly columns: ReadonlyArray<DataViewColumn>;
      /** The row field that tells rows apart. */
      readonly rowKey?: string;
      readonly rowAction?: DataViewAction;
      readonly empty?: string;
    })
  | (PartBase & {
      readonly type: "list";
      readonly label?: string;
      readonly bind: string;
      readonly primary: string;
      readonly secondary?: string;
      readonly meta?: string;
      readonly badge?: string;
      readonly tones?: Readonly<Record<string, DataViewTone>>;
      readonly itemKey?: string;
      readonly itemAction?: DataViewAction;
      readonly empty?: string;
    })
  | (PartBase & {
      readonly type: "chart";
      readonly kind: "line" | "bar";
      readonly label: string;
      readonly bind: string;
      /** The point field that labels the x axis. */
      readonly x: string;
      readonly series: ReadonlyArray<DataViewSeries>;
      readonly format?: DataViewFormat;
    })
  | (PartBase & {
      readonly type: "log";
      readonly label?: string;
      readonly bind: string;
      readonly empty?: string;
    })
  | (PartBase & {
      readonly type: "form";
      readonly id: string;
      readonly fields: ReadonlyArray<DataViewField>;
      readonly submit: {
        readonly label: string;
        readonly action: DataViewAction;
      };
    })
  | (PartBase & {
      readonly type: "button";
      readonly label: string;
      readonly action: DataViewAction;
      readonly variant?: "default" | "secondary" | "outline" | "danger";
    })
  | (PartBase & {
      readonly type: "tabs";
      readonly tabs: ReadonlyArray<{
        readonly label: string;
        readonly parts: ReadonlyArray<DataViewPart>;
      }>;
    })
  | (PartBase & {
      readonly type: "code";
      readonly text?: string;
      readonly bind?: string;
      readonly language?: string;
    })
  | (PartBase & {
      readonly type: "badge";
      readonly text?: string;
      readonly bind?: string;
      readonly tone?: DataViewTone;
      readonly tones?: Readonly<Record<string, DataViewTone>>;
    })
  | (PartBase & {
      readonly type: "empty";
      readonly title: string;
      readonly description?: string;
    });

export interface DataViewDefinition {
  readonly title: string;
  readonly description?: string;
  /** The state a view starts with, before its plugin sets any. */
  readonly state?: unknown;
  readonly parts: ReadonlyArray<DataViewPart>;
}
