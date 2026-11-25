import type { RenderOptions, RenderResult } from "pele";
import "./markdown-mermaid.css";

export interface DiagramPicture {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

export interface MermaidImage extends DiagramPicture {
  readonly label: string;
  /**
   * The diagram laid out for a column narrower than `NARROW_DIAGRAM_WIDTH`
   * (a wide flowchart turns vertical), when that layout is narrower. The
   * `diagram-frame` container query shows it in place of the wide one.
   */
  readonly narrow?: DiagramPicture;
}

/** Keep in step with the container query in markdown-mermaid.css. */
export const NARROW_DIAGRAM_WIDTH = 640;

type Pele = typeof import("pele/lazy");

// Pele (https://pele.run) renders Mermaid syntax to SVG; the lazy entry loads
// each diagram type's parser and layout with its first diagram.
let pele: Promise<Pele> | undefined;
const loadPele = () => {
  pele ??= import("pele/lazy");
  return pele;
};

/**
 * Pele's colour and font variables, read from the design tokens the
 * transcript uses. The diagram becomes an image, which the page's custom
 * properties cannot reach, so each value is resolved to a plain colour here.
 * Fills are mixed over the diagram's background so they stay opaque.
 */
const THEME = {
  "--pele-bg":
    "color-mix(in srgb, var(--chat-foreground) 3%, var(--background))",
  "--pele-fg": "var(--chat-foreground)",
  "--pele-muted": "var(--muted-foreground)",
  "--pele-line":
    "color-mix(in srgb, var(--chat-foreground) 60%, var(--background))",
  "--pele-surface":
    "color-mix(in srgb, var(--chat-foreground) 8%, var(--background))",
  "--pele-surface-alt":
    "color-mix(in srgb, var(--chat-foreground) 14%, var(--background))",
  "--pele-border":
    "color-mix(in srgb, var(--chat-foreground) 32%, var(--background))",
  "--pele-accent": "var(--thread-color-blue)",
  "--pele-critical": "var(--destructive)",
  "--pele-error": "var(--destructive)",
  "--pele-series-1": "var(--thread-color-blue)",
  "--pele-series-2": "var(--thread-color-orange)",
  "--pele-series-3": "var(--thread-color-green)",
  "--pele-series-4": "var(--thread-color-red)",
  "--pele-series-5": "var(--thread-color-cyan)",
  "--pele-series-6": "var(--thread-color-yellow)",
  "--pele-series-7": "var(--thread-color-purple)",
  "--pele-series-8": "var(--thread-color-pink)",
} as const;

interface DiagramTheme {
  /** Custom property declarations for the SVG root's style. */
  readonly declarations: string;
  readonly font: string;
  readonly fontMono: string;
}

/** A diagram theme: the resolved appearance and the palette. */
export interface MermaidTheme {
  readonly appearance: "light" | "dark";
  readonly palette: string;
}

// The probe carries the theme itself, so the colours do not depend on when
// the document's own theme attributes change.
const resolveTheme = ({ appearance, palette }: MermaidTheme): DiagramTheme => {
  const probe = document.createElement("span");
  probe.hidden = true;
  probe.dataset.palette = palette;
  probe.style.colorScheme = `only ${appearance}`;
  document.body.append(probe);
  try {
    const style = getComputedStyle(probe);
    const declarations = Object.entries(THEME).map(([name, value]) => {
      probe.style.color = value;
      return `${name}:${style.color}`;
    });
    probe.style.fontFamily = "var(--font-ui)";
    const font = style.fontFamily;
    probe.style.fontFamily = "var(--font-mono-family)";
    const fontMono = style.fontFamily;
    declarations.push(`--pele-font:${font}`, `--pele-font-mono:${fontMono}`);
    return { declarations: declarations.join(";"), font, fontMono };
  } finally {
    probe.remove();
  }
};

/**
 * The SVG becomes an image, so nothing in it can run script, receive events,
 * load a resource, or restyle the page. Pele already sizes it from its
 * layout; the theme goes on its root, where Pele's styles read it.
 */
const toPicture = (
  result: RenderResult,
  theme: DiagramTheme,
): (DiagramPicture & { readonly title?: string }) | undefined => {
  const root = new DOMParser().parseFromString(
    result.svg,
    "image/svg+xml",
  ).documentElement;
  if (root.nodeName !== "svg") return undefined;
  const width = Math.ceil(result.width);
  const height = Math.ceil(result.height);
  if (!(width > 0 && height > 0)) return undefined;
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.setAttribute(
    "style",
    `${theme.declarations};${root.getAttribute("style") ?? ""}`,
  );
  const title = root.querySelector(":scope > title")?.textContent?.trim();
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      new XMLSerializer().serializeToString(root),
    )}`,
    width,
    height,
    ...(title ? { title } : {}),
  };
};

const draw = async (
  source: string,
  mermaidTheme: MermaidTheme,
): Promise<MermaidImage | undefined> => {
  const { renderAsync } = await loadPele();
  const theme = resolveTheme(mermaidTheme);
  const options: RenderOptions = {
    fontFamily: theme.font,
    fontFamilyMono: theme.fontMono,
    fontSize: 14,
    responsive: false,
    // An image cannot follow links or load images; leave them out.
    links: false,
    images: false,
    idPrefix: "dx-diagram",
  };
  const result = await renderAsync(source, options);
  const wide = toPicture(result, theme);
  if (wide === undefined) return undefined;
  const { title, ...picture } = wide;
  const image = { ...picture, label: title || `${result.type} diagram` };
  if (result.width <= NARROW_DIAGRAM_WIDTH) return image;
  // Below Pele's direction breakpoint a wide flowchart lays out vertically.
  const narrow = toPicture(
    await renderAsync(source, {
      ...options,
      maxWidth: NARROW_DIAGRAM_WIDTH - 40,
    }),
    theme,
  );
  if (narrow === undefined || narrow.width >= picture.width) return image;
  return {
    ...image,
    narrow: { src: narrow.src, width: narrow.width, height: narrow.height },
  };
};

/** `undefined` while rendering; `null` when the source cannot render. */
export type MermaidRender = MermaidImage | null | undefined;

const rendered = new Map<string, MermaidImage | null>();
const pending = new Set<string>();
const RENDERED_LIMIT = 128;
const listeners = new Set<() => void>();

const mermaidKey = (source: string, { appearance, palette }: MermaidTheme) =>
  `${appearance}/${palette}\n${source}`;

/**
 * Starts rendering Mermaid source once per theme (the resolved appearance
 * and palette, whose colours the image bakes in). Idempotent, so a component
 * may call it while rendering; the result arrives through `subscribeMermaid`
 * and `mermaidRender`.
 */
export const requestMermaid = (source: string, theme: MermaidTheme): void => {
  const key = mermaidKey(source, theme);
  if (rendered.has(key) || pending.has(key)) return;
  pending.add(key);
  void draw(source, theme)
    .catch(() => undefined)
    .then((image) => {
      pending.delete(key);
      if (rendered.size >= RENDERED_LIMIT)
        rendered.delete(rendered.keys().next().value as string);
      rendered.set(key, image ?? null);
      for (const listener of listeners) listener();
    });
};

export const subscribeMermaid = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The rendered image, `null` when the source is not valid Mermaid or the
 * renderer fails to load (callers keep showing the source), or `undefined`
 * while it renders.
 */
export const mermaidRender = (
  source: string,
  theme: MermaidTheme,
): MermaidRender => rendered.get(mermaidKey(source, theme));
