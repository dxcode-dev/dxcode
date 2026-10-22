// The dx-view contract: how a ```dx-view block's HTML becomes the document
// the transcript frames. The web app frames views with it, and the
// creating-views skill's preview script frames drafts with the same code, so
// a preview shows what the reader will see. Plain JavaScript, because the
// skill runs it with Node in the workspace.

/** The fence language of a view block. */
export const VIEW_LANGUAGE = "dx-view";

/** Taller views scroll inside their frame. */
export const VIEW_MAX_HEIGHT = 1200;

/** `source` on every message a view frame posts to the transcript. */
export const VIEW_FRAME_MESSAGE = "dx-view";

/** `source` on every message the transcript posts to a view frame. */
export const VIEW_HOST_MESSAGE = "dx-view-host";

const sans = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const mono = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';

// Chart colors tuned so the first four stay apart for colorblind readers.
const chart = {
  light: ["#1a609e", "#b36d2a", "#0e9a94", "#913c5b", "#71640b", "#7377c6"],
  dark: ["#5b9ddf", "#f6ab6b", "#47d6cf", "#d47795", "#b0a03c", "#b1b7fd"],
};
const series = [
  "#12a88a",
  "#e36f4a",
  "#3d82e8",
  "#9b5de5",
  "#eab308",
  "#ef476f",
  "#00b8d9",
  "#f77f00",
  "#7cb342",
  "#94a3b8",
];

/**
 * dx's palettes, as `[light, dark]` pairs taken from the web app's
 * `styles.css`. `--background` is the transcript's surface.
 */
export const VIEW_PALETTES = {
  daydream: {
    "--background": ["oklch(99% 0.01 131.32)", "#0c1516"],
    "--foreground": ["#0b0d0b", "#d4d7d1"],
    "--muted-foreground": ["#59605a", "#939b94"],
    "--border": ["rgba(11, 13, 11, 0.13)", "rgba(135, 139, 134, 0.2)"],
    "--link": ["hsl(213, 65%, 45%)", "#6ca0e0"],
    "--success": ["#247443", "#54b879"],
    "--warning": ["#805c0b", "#d6a038"],
    "--destructive": ["#a92f2a", "#d67670"],
  },
  deadpan: {
    "--background": ["#fcfcfc", "#121212"],
    "--foreground": ["#111", "#cbcbcb"],
    "--muted-foreground": ["#5b5b5b", "#969696"],
    "--border": ["rgba(0, 0, 0, 0.13)", "rgba(255, 255, 255, 0.13)"],
    "--link": ["hsl(213, 65%, 45%)", "#6ca0e0"],
    "--success": ["#247443", "#54b879"],
    "--warning": ["#805c0b", "#d6a038"],
    "--destructive": ["#a92f2a", "#d67670"],
  },
};

/**
 * Every token as `light-dark()`, so the frame follows the color scheme the
 * transcript gives it without reloading.
 */
const tokens = (palette) =>
  [
    "color-scheme:light dark",
    ...Object.entries(VIEW_PALETTES[palette] ?? VIEW_PALETTES.daydream).map(
      ([name, [light, dark]]) => `${name}:light-dark(${light}, ${dark})`,
    ),
    ...chart.light.map(
      (light, index) =>
        `--chart-${index + 1}:light-dark(${light}, ${chart.dark[index]})`,
    ),
    "--card:color-mix(in oklab, var(--foreground) 2.5%, transparent)",
    "--muted:color-mix(in oklab, var(--foreground) 7%, transparent)",
    "--grid:color-mix(in oklab, var(--foreground) 8%, transparent)",
    "--chart-context:color-mix(in oklab, var(--muted-foreground) 65%, var(--background))",
    ...series.map((color, index) => `--series-${index + 1}:${color}`),
    "--radius:8px",
    `--font-sans:${sans}`,
    `--font-mono:${mono}`,
  ].join(";");

/**
 * No request leaves the view: every fetch, image, font, and frame outside
 * the document itself is blocked. Inline data URLs still load. The shell's
 * copy of the policy also blocks navigations of the view's own frame.
 */
const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Runs before the view's own scripts. It hands link clicks to the
 * transcript, reports the content height and script errors, and applies the
 * color scheme the transcript sends.
 */
const bridge = `(() => {
  const post = (message) => parent.postMessage({ source: "${VIEW_FRAME_MESSAGE}", ...message }, "*");
  addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || link.getAttribute("href").startsWith("#")) return;
    event.preventDefault();
    if (/^https?:$/.test(link.protocol)) post({ type: "open", url: link.href });
  }, true);
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || data?.source !== "${VIEW_HOST_MESSAGE}") return;
    if (data.type === "scheme" && (data.scheme === "light" || data.scheme === "dark"))
      document.documentElement.style.colorScheme = "only " + data.scheme;
  });
  addEventListener("error", (event) => {
    const message = String(event.message || "Script error");
    // Benign: a resize handler changed layout again within one frame.
    if (!message.startsWith("ResizeObserver loop")) post({ type: "error", message });
  });
  let height = -1;
  const report = () => {
    const next = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (next !== height) post({ type: "size", height: (height = next) });
  };
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener("load", report);
})();`;

/**
 * The shell between the transcript and the view. A sandboxed frame may
 * always navigate itself, and the Navigation API is off in opaque origins,
 * so the view's own scripts cannot be stopped from `location.href = …`.
 * The browser checks such a navigation against the CSP of the document that
 * embeds the frame before it sends any request, so the view is embedded here,
 * under `default-src 'none'`. The shell relays messages between the view
 * and the transcript, and reports when the view's frame loads anything else.
 */
const shell = `(() => {
  const view = document.querySelector("iframe");
  let loads = 0;
  view.addEventListener("load", () => {
    if (++loads > 1) parent.postMessage({ source: "${VIEW_FRAME_MESSAGE}", type: "escaped" }, "*");
  });
  addEventListener("message", (event) => {
    if (event.source === view.contentWindow && event.data?.source === "${VIEW_FRAME_MESSAGE}")
      parent.postMessage(event.data, "*");
    else if (event.source === parent && event.data?.source === "${VIEW_HOST_MESSAGE}") {
      if (event.data.type === "scheme" && (event.data.scheme === "light" || event.data.scheme === "dark"))
        document.documentElement.style.colorScheme = "only " + event.data.scheme;
      view.contentWindow?.postMessage(event.data, "*");
    }
  });
})();`;

const leadingDoctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i;

const escapeAttribute = (value) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/**
 * The view's own document: its HTML with dx's CSP, theme tokens, kit, and
 * bridge placed before anything of its own. `scheme` fixes light or dark, as
 * a preview does; without it the view follows the transcript.
 *
 * @param {string} source
 * @param {{ kit: { css: string; js: string; icons: string }; palette?: string; scheme?: "light" | "dark" }} options
 */
export const viewDocument = (source, { kit, palette = "daydream", scheme }) => {
  const icons = kit.icons.replace(/<!--[\s\S]*?-->/g, "");
  const kitScript = kit.js.replace("'__DX_VIEW_ICONS__'", () =>
    JSON.stringify(icons),
  );
  // In the transcript the view is transparent over the reply; a preview
  // paints the transcript's surface itself.
  const fixedScheme =
    scheme === undefined
      ? "html{background:transparent}"
      : `:root{color-scheme:only ${scheme}}`;
  const head =
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>:root{${tokens(palette)}}${kit.css}${fixedScheme}</style>` +
    `<script>${bridge}</script><script>${kitScript}</script>`;
  const doctype = leadingDoctype.exec(source);
  // The head goes first so it applies before any of the view's own markup;
  // the parser folds a later <html> or <head> tag into the same elements.
  return doctype === null
    ? `<!doctype html>${head}${source}`
    : `${source.slice(0, doctype[0].length)}${head}${source.slice(doctype[0].length)}`;
};

/**
 * The document the transcript's frame loads: the shell, with the view's
 * document in a sandboxed frame that fills it.
 *
 * @param {string} source
 * @param {{ kit: { css: string; js: string; icons: string }; palette?: string }} options
 */
export const frameView = (source, options) =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">` +
  "<style>:root{color-scheme:light dark}html,body{height:100%;margin:0;background:transparent}iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style>" +
  `<iframe sandbox="allow-scripts" srcdoc="${escapeAttribute(viewDocument(source, { ...options, scheme: undefined }))}"></iframe>` +
  `<script>${shell}</script>`;
