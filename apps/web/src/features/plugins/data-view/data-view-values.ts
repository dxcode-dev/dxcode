import {
  type DataViewAction,
  type DataViewPart,
  type DataViewScope,
  type DataViewTone,
  isEmptyViewValue,
  readStatePath,
} from "@dx/domain";
import { formatViewValue } from "./data-view-format.js";

/** What every part is drawn with, and how it reads state as text. */

export interface PartContext {
  readonly state: unknown;
  /** Runs an action; `id` names the control that shows it busy. */
  readonly run: (
    id: string,
    action: DataViewAction,
    scope: DataViewScope,
  ) => Promise<void>;
  readonly busy: string | undefined;
  /** Why actions are off here; controls show disabled with it as the reason. */
  readonly disabledReason: string | undefined;
}

export const text = (value: unknown) => formatViewValue(value);

export const listOf = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

export const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const shows = (part: DataViewPart, state: unknown) =>
  (part.when === undefined ||
    !isEmptyViewValue(readStatePath(state, part.when))) &&
  (part.unless === undefined ||
    isEmptyViewValue(readStatePath(state, part.unless)));

export const toneOf = (
  value: unknown,
  tones: Readonly<Record<string, DataViewTone>> | undefined,
  fallback: DataViewTone = "neutral",
): DataViewTone => tones?.[text(value)] ?? fallback;

export const keyOf = (
  row: unknown,
  field: string | undefined,
  index: number,
) => {
  const value = field === undefined ? undefined : recordOf(row)[field];
  return value === undefined || value === null ? String(index) : text(value);
};

/** The action's own `label`, or a word for its type. */
export const actionLabel = (action: DataViewAction) =>
  action.label ??
  (action.type === "open_thread"
    ? "Open"
    : action.type === "start_thread"
      ? "Investigate"
      : action.type === "open_link"
        ? "Open Link"
        : action.type === "copy"
          ? "Copy"
          : "Run");
