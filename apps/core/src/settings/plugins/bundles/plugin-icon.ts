import { MAX_PLUGIN_ICON_BYTES, type PluginBundleIcon } from "@dx/domain";
import { Effect } from "effect";
import type { BundleFolder } from "./bundle-reader.js";

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
