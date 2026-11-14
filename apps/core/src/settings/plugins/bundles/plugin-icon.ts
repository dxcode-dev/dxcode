import {
  MAX_PLUGIN_ICON_BYTES,
  MAX_PLUGIN_ITEM_ICONS,
  PLUGIN_LUCIDE_ICON_PATTERN,
  type PluginBundleIcon,
  type PluginIconRef,
  type PluginIconSet,
} from "@dx/domain";
import { Effect } from "effect";
import {
  type BundleFolder,
  isRecord,
  manifestPath,
  skipUnknownFields,
} from "./bundle-reader.js";

/**
 * A plugin's icon, from the Agent Plugins 1.1.0 candidates dx renders
 * (§4.3.1): `assets/icon.png`, or `assets/icon.svg` when there is no usable
 * PNG. A PNG is kept when its signature is right. An SVG
 * is rebuilt from an allowlist of shape elements and attributes, so no
 * script, link, style, or outside resource survives; dx also shows it only
 * through an `<img>`, where SVG never runs script.
 */

export const PNG_ICON_PATH = "assets/icon.png";
export const SVG_ICON_PATH = "assets/icon.svg";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

export const iconBytes = (icon: PluginBundleIcon) =>
  Uint8Array.from(atob(icon.data), (character) => character.charCodeAt(0));

/** The icon as a data URL, for an `<img>`. */
export const iconDataUrl = (icon: PluginBundleIcon) =>
  `data:${icon.mediaType};base64,${icon.data}`;

/** Reads the bundle's icon, or skips it with a reason. */
export const readPluginIcon = Effect.fn("readPluginIcon")(function* (
  folder: BundleFolder,
) {
  // An unusable candidate is skipped and the next one considered (§4.3.1).
  if (folder.files.has(PNG_ICON_PATH)) {
    const read = yield* folder.peekBytes(PNG_ICON_PATH, MAX_PLUGIN_ICON_BYTES);
    if (!read.ok) folder.skip(PNG_ICON_PATH, read.reason);
    else if (
      read.bytes.byteLength <= PNG_SIGNATURE.length ||
      PNG_SIGNATURE.some((byte, index) => read.bytes[index] !== byte)
    )
      folder.skip(PNG_ICON_PATH, "The icon is not a PNG image.");
    else
      return {
        mediaType: "image/png",
        data: toBase64(read.bytes),
      } satisfies PluginBundleIcon;
  }
  if (folder.files.has(SVG_ICON_PATH)) {
    const read = yield* folder.peek(SVG_ICON_PATH, MAX_PLUGIN_ICON_BYTES);
    if (!read.ok) {
      folder.skip(SVG_ICON_PATH, read.reason);
      return undefined;
    }
    const clean = sanitizeSvg(read.text);
    if (!clean.ok) {
      folder.skip(SVG_ICON_PATH, clean.reason);
      return undefined;
    }
    const bytes = new TextEncoder().encode(clean.svg);
    if (bytes.byteLength > MAX_PLUGIN_ICON_BYTES) {
      folder.skip(SVG_ICON_PATH, "The icon is too large.");
      return undefined;
    }
    return {
      mediaType: "image/svg+xml",
      data: toBase64(bytes),
    } satisfies PluginBundleIcon;
  }
  return undefined;
});

/**
 * Shape and paint elements; everything else is dropped with its content.
 * `use` and `symbol` are left out: nested references multiply, so a small
 * file could expand to millions of shapes and stall the page.
 */
const ELEMENTS = canonical([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
]);

/** Geometry and paint attributes; no event, style, or link attribute. */
const ATTRIBUTES = canonical([
  "id",
  "class",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "d",
  "points",
  "pathLength",
  "transform",
  "preserveAspectRatio",
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "clip-path",
  "mask",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "color",
  "display",
  "visibility",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "dx",
  "dy",
  "href",
  "version",
]);

function canonical(names: ReadonlyArray<string>) {
  return new Map(names.map((name) => [name.toLowerCase(), name]));
}

/** XML's five predefined entities, keyed by their full spelling. */
const NAMED_ENTITIES = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
]);

/**
 * Decodes the entities XML allows without a DOCTYPE. Undefined for a bare
 * `&` or an entity XML would not know, which a browser would refuse.
 */
const decodeEntities = (value: string): string | undefined => {
  if (/&(?!#x[0-9a-fA-F]+;|#[0-9]+;|[A-Za-z]+;)/.test(value)) return undefined;
  let failed = false;
  const decoded = value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) {
          failed = true;
          return "";
        }
        return String.fromCodePoint(code);
      }
      const named = NAMED_ENTITIES.get(match);
      if (named === undefined) failed = true;
      return named ?? "";
    },
  );
  return failed ? undefined : decoded;
};

const escapeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttribute = (value: string) =>
  escapeText(value).replace(/"/g, "&quot;");

/** A value that could reach outside the image or run code. */
const unsafeValue = (value: string) => {
  const compact = value.replace(/[\s\p{Cc}]/gu, "").toLowerCase();
  if (/javascript:|vbscript:|data:|expression\(|@import|<|\\/.test(compact)) {
    return true;
  }
  // Paint and clip references may name an element in this image only.
  for (const match of compact.matchAll(/url\(([^)]*)\)/g)) {
    if (!/^['"]?#[a-z0-9_.:-]+['"]?$/.test(match[1] ?? "")) return true;
  }
  return /url\((?![^)]*\))/.test(compact);
};

type Sanitized =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): Sanitized => ({ ok: false, reason });

const attributePattern =
  /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/;

const namePattern = /^([A-Za-z_][A-Za-z0-9_.:-]*)/;

/**
 * Rebuilds an SVG from allowlisted elements and attributes. A DOCTYPE,
 * entity declaration, CDATA section, processing instruction (other than a
 * leading XML declaration), or malformed markup refuses the whole icon,
 * since a browser could read such input differently from this parser.
 */
export const sanitizeSvg = (input: string): Sanitized => {
  let source = input.replace(/^﻿/, "");
  const declaration = /^\s*<\?xml\s[^?<>]*\?>/.exec(source);
  if (declaration !== null) source = source.slice(declaration[0].length);
  const output: Array<string> = [];
  /** Open elements, each kept or dropped with everything inside it. */
  const stack: Array<{ readonly name: string; readonly kept: boolean }> = [];
  const keeping = () => stack.every(({ kept }) => kept);
  let finished = false;
  let position = 0;
  while (position < source.length) {
    const next = source.indexOf("<", position);
    const text = source.slice(position, next === -1 ? source.length : next);
    if (text.trim() !== "" && (stack.length === 0 || finished)) {
      return refuse("The icon has text outside <svg>.");
    }
    if (stack.length > 0) {
      const decoded = decodeEntities(text);
      if (decoded === undefined) {
        return refuse("The icon has text dx cannot read.");
      }
      if (keeping()) output.push(escapeText(decoded));
    }
    if (next === -1) break;
    if (source.startsWith("<!--", next)) {
      const end = source.indexOf("-->", next + 4);
      if (end === -1) return refuse("The icon has an unclosed comment.");
      position = end + 3;
      continue;
    }
    if (source.startsWith("<!", next) || source.startsWith("<?", next)) {
      return refuse(
        "The icon has a DOCTYPE, CDATA, or processing instruction, which dx does not accept.",
      );
    }
    if (finished) return refuse("The icon has content after </svg>.");
    const close = source.indexOf(">", next);
    if (close === -1) return refuse("The icon has an unclosed tag.");
    const tag = source.slice(next + 1, close);
    position = close + 1;
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== name) {
        return refuse("The icon's tags do not match.");
      }
      const allowed = ELEMENTS.get(name.toLowerCase());
      if (open.kept && keeping() && allowed !== undefined) {
        output.push(`</${allowed}>`);
      }
      if (stack.length === 0) finished = true;
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameMatch = namePattern.exec(body);
    if (nameMatch === null) return refuse("The icon has a malformed tag.");
    const name = nameMatch[1] ?? "";
    if (stack.length === 0 && name.toLowerCase() !== "svg") {
      return refuse("The icon's root element is not <svg>.");
    }
    let rest = body.slice(name.length);
    const attributes: Array<string> = [];
    const seen = new Set<string>();
    for (;;) {
      const trimmed = rest.replace(/^\s+/, "");
      if (trimmed === "") break;
      if (trimmed.length === rest.length) {
        return refuse("The icon has a malformed attribute.");
      }
      const match = attributePattern.exec(trimmed);
      if (match === null) {
        return refuse("The icon has an unquoted or malformed attribute.");
      }
      rest = trimmed.slice(match[0].length);
      const value = decodeEntities(match[2] ?? match[3] ?? "");
      if (value === undefined) {
        return refuse("The icon has an attribute dx cannot read.");
      }
      // SVG 2 reads a plain href, so xlink:href needs no namespace.
      const lower = (match[1] ?? "")
        .toLowerCase()
        .replace(/^xlink:href$/, "href");
      const attribute = ATTRIBUTES.get(lower);
      if (attribute === undefined || seen.has(attribute)) continue;
      if (attribute === "href") {
        if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value)) continue;
      } else if (unsafeValue(value)) {
        continue;
      }
      seen.add(attribute);
      attributes.push(`${attribute}="${escapeAttribute(value)}"`);
    }
    const element = ELEMENTS.get(name.toLowerCase());
    if (element !== undefined && keeping()) {
      const head =
        element === "svg"
          ? ['xmlns="http://www.w3.org/2000/svg"', ...attributes]
          : attributes;
      output.push(
        `<${element}${head.length === 0 ? "" : ` ${head.join(" ")}`}${selfClosing ? "/" : ""}>`,
      );
    }
    if (selfClosing) {
      if (stack.length === 0) finished = true;
    } else {
      stack.push({ name, kept: element !== undefined });
    }
  }
  if (!finished || stack.length > 0) {
    return refuse("The icon is not a complete <svg> element.");
  }
  return { ok: true, svg: output.join("") };
};

// --- Icon sets, item icons, and hashed icon files ---

/** An icon file ready to store in `plugin_icon`, keyed by its sha256. */
export interface PluginIconFile {
  readonly hash: string;
  readonly mediaType: "image/png" | "image/svg+xml";
  readonly bytes: Uint8Array;
}

/** The smallest PNG icon side dx accepts; 256 is recommended. */
export const MIN_PNG_ICON_SIDE = 128;

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const iconHash = async (bytes: Uint8Array) =>
  hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));

/** A PNG's width and height from its IHDR chunk. */
const pngSize = (bytes: Uint8Array) => {
  if (bytes.byteLength < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

/**
 * Reads one icon file the manifest names: a square PNG at least 128 px, or
 * an SVG rebuilt from the allowlist. Skips it with a reason otherwise.
 */
export const readIconFile = Effect.fn("readIconFile")(function* (
  folder: BundleFolder,
  path: string,
  label: string,
  /** Plugin icons need 128 px; item icons drawn at 16 to 20 px need less. */
  minPngSide = MIN_PNG_ICON_SIDE,
) {
  if (!folder.files.has(path)) {
    folder.skip(label, `${path} is missing.`);
    return undefined;
  }
  if (/\.png$/i.test(path)) {
    const read = yield* folder.peekBytes(path, MAX_PLUGIN_ICON_BYTES);
    if (!read.ok) {
      folder.skip(label, read.reason);
      return undefined;
    }
    if (
      read.bytes.byteLength <= PNG_SIGNATURE.length ||
      PNG_SIGNATURE.some((byte, index) => read.bytes[index] !== byte)
    ) {
      folder.skip(label, `${path} is not a PNG image.`);
      return undefined;
    }
    const size = pngSize(read.bytes);
    if (
      size === undefined ||
      size.width !== size.height ||
      size.width < minPngSide
    ) {
      folder.skip(
        label,
        `${path} must be a square PNG of at least ${minPngSide}×${minPngSide}${minPngSide === MIN_PNG_ICON_SIDE ? " (256×256 is best)" : ""}.`,
      );
      return undefined;
    }
    return {
      hash: yield* Effect.promise(() => iconHash(read.bytes)),
      mediaType: "image/png",
      bytes: read.bytes,
    } satisfies PluginIconFile;
  }
  if (/\.svg$/i.test(path)) {
    const read = yield* folder.peek(path, MAX_PLUGIN_ICON_BYTES);
    if (!read.ok) {
      folder.skip(label, read.reason);
      return undefined;
    }
    const clean = sanitizeSvg(read.text);
    if (!clean.ok) {
      folder.skip(label, clean.reason);
      return undefined;
    }
    const bytes = new TextEncoder().encode(clean.svg);
    if (bytes.byteLength > MAX_PLUGIN_ICON_BYTES) {
      folder.skip(label, `${path} is too large.`);
      return undefined;
    }
    return {
      hash: yield* Effect.promise(() => iconHash(bytes)),
      mediaType: "image/svg+xml",
      bytes,
    } satisfies PluginIconFile;
  }
  folder.skip(label, `${path} is not an .svg or .png file.`);
  return undefined;
});

/** The icon file behind a legacy `icon` kept in the manifest as base64. */
export const legacyIconFile = async (
  icon: PluginBundleIcon,
): Promise<PluginIconFile> => {
  const bytes = iconBytes(icon);
  return { hash: await iconHash(bytes), mediaType: icon.mediaType, bytes };
};

/**
 * The plugin's icon set: `extensions["dev.dxcode"].icon` when it names one,
 * else the legacy `assets/icon.png` or `assets/icon.svg` as `src`. A plugin
 * with none still installs; the install review warns that it has no icon,
 * which catalogs and the verified tier need.
 */
export const readPluginIconSet = Effect.fn("readPluginIconSet")(function* (
  folder: BundleFolder,
  block: unknown,
  legacy: PluginBundleIcon | undefined,
) {
  const label = "plugin.json#extensions.dev.dxcode.icon";
  const files: Array<PluginIconFile> = [];
  const set: { -readonly [K in keyof PluginIconSet]: PluginIconSet[K] } = {};
  if (block !== undefined) {
    // A bare string is shorthand for `{ "src": ... }`.
    const fields = typeof block === "string" ? { src: block } : block;
    if (!isRecord(fields)) folder.skip(label, "icon must be an object.");
    else {
      skipUnknownFields(
        (path, reason) => folder.skip(path, reason),
        fields,
        ["src", "dark", "monochrome", "background"],
        label,
      );
      for (const key of ["src", "dark", "monochrome"] as const) {
        const raw = fields[key];
        if (raw === undefined) continue;
        const path = typeof raw === "string" ? manifestPath(raw) : "outside";
        if (path === "outside" || path === "") {
          folder.skip(`${label}.${key}`, "Must name a file in the plugin.");
          continue;
        }
        const file = yield* readIconFile(folder, path, `${label}.${key}`);
        if (file === undefined) continue;
        files.push(file);
        set[key] = file.hash;
      }
      if (fields.background !== undefined) {
        if (
          typeof fields.background === "string" &&
          /^#[0-9a-fA-F]{6}$/.test(fields.background)
        )
          set.background = fields.background.toLowerCase();
        else folder.skip(`${label}.background`, "background must be #rrggbb.");
      }
    }
  }
  if (set.src === undefined && legacy !== undefined) {
    const file = yield* Effect.promise(() => legacyIconFile(legacy));
    files.push(file);
    set.src = file.hash;
  }
  return {
    set: Object.keys(set).length === 0 ? undefined : (set as PluginIconSet),
    files,
  };
});

/**
 * Icon files the plugin carries for its items: every `.svg` and `.png`
 * under `assets/`, so an item `icon` naming one, in the manifest or in
 * code, resolves to its hash without reading the bundle again.
 */
export const readItemIconAssets = Effect.fn("readItemIconAssets")(function* (
  folder: BundleFolder,
) {
  const files: Array<PluginIconFile> = [];
  const byPath: Record<string, string> = {};
  const candidates = folder
    .under("assets")
    .filter((path) => /\.(?:svg|png)$/i.test(path))
    .sort();
  for (const path of candidates) {
    if (Object.keys(byPath).length >= MAX_PLUGIN_ITEM_ICONS) {
      folder.skip(
        path,
        `A plugin carries at most ${MAX_PLUGIN_ITEM_ICONS} icon files; this one is not an icon.`,
      );
      continue;
    }
    // Item icons may be any square size; small PNGs are fine at 16 to 20 px.
    const file = yield* readIconFile(folder, path, path, 16);
    if (file === undefined) continue;
    files.push(file);
    byPath[path] = file.hash;
  }
  return { byPath, files };
});

/**
 * An item's `icon` as stored: `lucide:<name>` as written, an asset path as
 * its hash. Undefined, with a skip naming the item, for anything else.
 */
export const readItemIcon = (
  folder: BundleFolder,
  raw: unknown,
  label: string,
  assets: Readonly<Record<string, string>>,
): PluginIconRef | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && PLUGIN_LUCIDE_ICON_PATTERN.test(raw))
    return raw;
  const path = typeof raw === "string" ? manifestPath(raw) : "outside";
  const hash = path === "outside" ? undefined : assets[path];
  if (hash === undefined) {
    folder.skip(
      label,
      "icon must be lucide:<name> or an .svg or .png under assets/.",
    );
    return undefined;
  }
  return hash;
};

/** Resolves an icon a plugin's code registered, by the same rules. */
export const resolveItemIcon = (
  raw: unknown,
  assets: Readonly<Record<string, string>> | undefined,
): PluginIconRef | undefined => {
  if (typeof raw !== "string") return undefined;
  if (PLUGIN_LUCIDE_ICON_PATTERN.test(raw)) return raw;
  if (/^[0-9a-f]{64}$/.test(raw)) return raw;
  const path = manifestPath(raw);
  return path === "outside" ? undefined : assets?.[path];
};
