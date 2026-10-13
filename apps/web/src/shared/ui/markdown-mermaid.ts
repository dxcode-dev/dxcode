import type mermaidModule from "mermaid";

export interface MermaidImage {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly label: string;
}

type Mermaid = typeof mermaidModule;

let mermaid: Promise<Mermaid> | undefined;
const loadMermaid = () => {
  mermaid ??= import("mermaid").then((module) => module.default);
  return mermaid;
};

/**
 * The SVG becomes an image, so nothing in it can run script, receive events,
 * or restyle the page. Its intrinsic size comes from the viewBox.
 */
const toImage = (svg: string): MermaidImage | undefined => {
  const root = new DOMParser().parseFromString(
    svg,
    "image/svg+xml",
  ).documentElement;
  if (root.nodeName !== "svg") return undefined;
  const [, , width = 0, height = 0] = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!(width > 0 && height > 0)) return undefined;
  root.setAttribute("width", String(Math.ceil(width)));
  root.setAttribute("height", String(Math.ceil(height)));
  root.removeAttribute("style");
  const title = root.querySelector(":scope > title")?.textContent?.trim();
  const kind = root.getAttribute("aria-roledescription")?.trim();
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      new XMLSerializer().serializeToString(root),
    )}`,
    width: Math.ceil(width),
    height: Math.ceil(height),
    label: title || (kind ? `${kind} diagram` : "Mermaid diagram"),
  };
};

let sequence = 0;
const draw = async (
  source: string,
  appearance: "light" | "dark",
): Promise<MermaidImage | undefined> => {
  const renderer = await loadMermaid();
  renderer.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: appearance === "dark" ? "dark" : "default",
    // An image cannot lay out HTML labels reliably; keep labels in SVG text.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
  });
  if (!(await renderer.parse(source, { suppressErrors: true })))
    return undefined;
  sequence += 1;
  const id = `dx-mermaid-${sequence}`;
  try {
    return toImage((await renderer.render(id, source)).svg);
  } finally {
    // Mermaid measures text in temporary nodes; remove any it left behind.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
};

/** `undefined` while rendering; `null` when the source cannot render. */
export type MermaidRender = MermaidImage | null | undefined;

const rendered = new Map<string, MermaidImage | null>();
const pending = new Set<string>();
const RENDERED_LIMIT = 128;
const listeners = new Set<() => void>();
// Mermaid keeps global configuration and measuring nodes, so render serially.
let queue: Promise<unknown> = Promise.resolve();

const mermaidKey = (source: string, appearance: "light" | "dark") =>
  `${appearance}\n${source}`;

/**
 * Starts rendering Mermaid source once per appearance. Idempotent, so a
 * component may call it while rendering; the result arrives through
 * `subscribeMermaid` and `mermaidRender`.
 */
export const requestMermaid = (
  source: string,
  appearance: "light" | "dark",
): void => {
  const key = mermaidKey(source, appearance);
  if (rendered.has(key) || pending.has(key)) return;
  pending.add(key);
  const result = queue
    .then(() => draw(source, appearance))
    .catch(() => undefined)
    .then((image) => {
      pending.delete(key);
      if (rendered.size >= RENDERED_LIMIT)
        rendered.delete(rendered.keys().next().value as string);
      rendered.set(key, image ?? null);
      for (const listener of listeners) listener();
    });
  queue = result;
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
  appearance: "light" | "dark",
): MermaidRender => rendered.get(mermaidKey(source, appearance));
