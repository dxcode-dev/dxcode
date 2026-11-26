import {
  DATA_VIEW_PLACES,
  type DataViewPlace,
  MAX_DATA_VIEW_BYTES,
  MAX_DATA_VIEWS,
  type PluginDataViewEntry,
  PluginViewId,
  validateDataView,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import {
  type BundleFolder,
  isRecord,
  manifestPath,
  skipUnknownFields,
} from "./bundle-reader.js";
import type { PluginCodeModule } from "./dx-extension.js";

/**
 * Reads the array form of `extensions["dev.dxcode"].views`: views
 * described as data, each a JSON file in the plugin that dx draws with its
 * own parts. Every file is parsed and validated here, at install, so a
 * broken view never reaches a browser. A view that fails is left out and
 * listed as skipped with the part and field at fault; the rest of the
 * plugin installs. The files are stored with the version's files.
 */

const ENTRY_FIELDS = ["id", "title", "icon", "show", "file"];

export interface ReadDataViews {
  readonly entries: ReadonlyArray<PluginDataViewEntry>;
  /** Each view's file, stored beside the version's modules. */
  readonly files: ReadonlyArray<PluginCodeModule>;
}

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

export const readDxDataViews = Effect.fn("readDxDataViews")(function* (
  folder: BundleFolder,
  raw: ReadonlyArray<unknown>,
  label: string,
  /** Resolves an entry's icon as other item icons resolve. */
  resolveIcon: (raw: unknown, path: string) => string | undefined,
) {
  const skip = (index: number, reason: string) =>
    folder.skip(`${label}.views[${index}]`, `This view is left out. ${reason}`);
  const entries: Array<PluginDataViewEntry> = [];
  const files: Array<PluginCodeModule> = [];
  if (raw.length > MAX_DATA_VIEWS)
    folder.skip(
      `${label}.views`,
      `A plugin declares at most ${MAX_DATA_VIEWS} views; the ones after the ${MAX_DATA_VIEWS}th are left out.`,
    );
  for (const [index, item] of raw.slice(0, MAX_DATA_VIEWS).entries()) {
    if (!isRecord(item)) {
      skip(index, "Each view is an object with id, title, file, and show.");
      continue;
    }
    skipUnknownFields(
      (path, reason) => folder.skip(path, reason),
      item,
      ENTRY_FIELDS,
      `${label}.views[${index}]`,
    );
    const id = item.id;
    if (!Schema.is(PluginViewId)(id)) {
      skip(
        index,
        `id is ${JSON.stringify(id)}; it must be 1 to 48 lowercase letters, digits, and hyphens, starting with a letter.`,
      );
      continue;
    }
    if (id === "app") {
      skip(
        index,
        "The id app is taken by a plugin's own web app; give the view another id.",
      );
      continue;
    }
    if (entries.some((entry) => entry.id === id)) {
      skip(index, `Another view already has the id ${id}.`);
      continue;
    }
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (title.length < 1 || title.length > 40) {
      skip(index, "title must be 1 to 40 characters.");
      continue;
    }
    const show = item.show ?? ["page"];
    if (
      !Array.isArray(show) ||
      show.length === 0 ||
      show.some(
        (place) =>
          !(DATA_VIEW_PLACES as ReadonlyArray<unknown>).includes(place),
      )
    ) {
      skip(
        index,
        `show is ${JSON.stringify(show)}; it lists where the view shows: ${DATA_VIEW_PLACES.join(", ")}.`,
      );
      continue;
    }
    const path =
      typeof item.file === "string" ? manifestPath(item.file) : "outside";
    if (path === "outside" || path === "" || !path.endsWith(".json")) {
      skip(index, "file must name a .json file inside the plugin.");
      continue;
    }
    if (!folder.files.has(path)) {
      skip(index, `${path} is missing.`);
      continue;
    }
    const text = yield* folder.read(path, MAX_DATA_VIEW_BYTES);
    if (!text.ok) {
      skip(index, `${path}: ${text.reason}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch (error) {
      skip(
        index,
        `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      );
      continue;
    }
    const checked = validateDataView(parsed);
    if (!checked.ok) {
      // One entry per problem, each naming the part and field, under the
      // file's path: the reasons are short, so none is cut.
      skip(index, `${path} does not describe a view; its problems follow.`);
      for (const error of checked.errors) folder.skip(path, error);
      continue;
    }
    const icon =
      item.icon === undefined
        ? undefined
        : resolveIcon(item.icon, `views[${index}].icon`);
    entries.push({
      id,
      title,
      ...(icon === undefined ? {} : { icon }),
      show: [...new Set(show as ReadonlyArray<DataViewPlace>)],
      file: path,
      integrity: yield* Effect.promise(() => sha256(text.text)),
      bytes: new TextEncoder().encode(text.text).byteLength,
    });
    if (!files.some((file) => file.path === path))
      files.push({ path, content: text.text });
  }
  return { entries, files } satisfies ReadDataViews;
});
