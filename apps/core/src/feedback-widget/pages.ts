// The documents the Feedback Widget serves from the dx origin: the panel a
// website frames, and the sign-in popup's consent and result pages.

import panelSource from "./client/panel.js?raw";
import widgetSource from "./client/widget.js?raw";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** JSON that is safe inside a `<script>` element. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

const nonce = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes));
};

/** dx's palette, shared by the panel and the sign-in popup. */
const base = `
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --fg: #f6fff5; --muted: #939b94; --faint: #6b736c; --bg: #0c1516; --line: rgba(135,139,134,.16);
  --primary: #dce6dc; --primary-fg: #0b0d0b; --brand: #f34e3f; --danger: #f0a49f; --success: #54b879; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font-size: 13px; line-height: 1.5; }
h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
p { margin: 0; color: var(--muted); }
.error { color: var(--danger); }
button, .wide, .light { font: inherit; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
button { border: 0; border-radius: 999px; height: 30px; padding: 0 12px; background: rgba(246,255,245,.08); color: var(--fg); font-weight: 500; }
button:hover { background: rgba(246,255,245,.14); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, a:focus-visible { outline: 2px solid #6ca0e0; outline-offset: 2px; }
.light, .primary { background: var(--primary); color: var(--primary-fg); border-radius: 8px; height: 34px; padding: 0 14px; font-weight: 500; }
.light:hover, .primary:hover { background: var(--fg); }
.quiet { background: transparent; }
.link { background: transparent; height: auto; padding: 0; color: var(--muted); font-size: 12px; text-decoration: underline; border-radius: 4px; }
.link:hover { background: transparent; color: var(--fg); }
`;

const panelStyles = `${base}
main { display: flex; flex-direction: column; }
section { display: flex; flex-direction: column; gap: 10px; padding: 16px 16px 14px; }
footer { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 16px; background: rgba(0,0,0,.25); border-top: 1px solid var(--line); }
.grow { flex: 1; }
.eyebrow { color: var(--muted); font: 12px/16px ui-monospace, SFMono-Regular, Menlo, monospace; }
.identity { color: var(--faint); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.actions { display: flex; }
.wide { width: 100%; height: 34px; border-radius: 8px; background: var(--primary); color: var(--primary-fg); font-weight: 500; }
.wide:hover { background: var(--fg); }
.wide:disabled { opacity: .5; }
.bubbles { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; max-height: 300px; overflow: auto; }
.bubbles li { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.bubble { max-width: 92%; padding: 8px 12px; border-radius: 12px; background: rgba(246,255,245,.07); border: 1px solid var(--line); overflow-wrap: anywhere; }
.where { max-width: 92%; color: var(--faint); font: 11px/15px ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 6px; background: rgba(243,78,63,.14); color: #ff8a7d;
  font: 12px/18px ui-monospace, SFMono-Regular, Menlo, monospace; vertical-align: baseline; }
.chip svg { width: 10px; height: 10px; }
.done { color: var(--success); display: flex; }
.done svg { width: 22px; height: 22px; padding: 4px; border: 2px solid var(--success); border-radius: 999px; box-sizing: content-box; }
.loading { display: flex; align-items: center; gap: 8px; }
.loading span { width: 6px; height: 6px; border-radius: 999px; background: var(--muted); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .3; } }
`;

const popupStyles = `${base}
body { min-height: 100vh; display: grid; place-items: center; }
main { width: min(420px, 100vw); padding: 28px 24px; display: flex; flex-direction: column; gap: 12px; }
.mark { font-weight: 700; font-size: 18px; letter-spacing: -.03em; color: var(--fg); }
.identity { font-size: 12px; color: var(--faint); }
.row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.spacer { flex: 1; }
strong { color: var(--fg); font-weight: 600; }
`;

const documentHeaders = (
  scriptNonce: string,
  frameAncestors: string,
  // A form posted under `no-referrer` carries `Origin: null`; the consent
  // form needs its own origin.
  referrerPolicy: "no-referrer" | "same-origin" = "no-referrer",
) => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${scriptNonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; "),
  "referrer-policy": referrerPolicy,
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
});

const page = (title: string, body: string, styles: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${styles}</style>
</head>
<body>
${body}
</body>
</html>
`;

export interface PanelConfig {
  readonly clientId: string;
  readonly appOrigin: string;
  readonly projectLabel: string;
  readonly allowedOrigins: ReadonlyArray<string>;
}

/**
 * The panel a website frames when someone sends. Only allowed origins may
 * frame it, so it never opens elsewhere, including inside another site that
 * frames an allowed one.
 */
export const panelPage = (config: PanelConfig) => {
  const scriptNonce = nonce();
  const ancestors =
    config.allowedOrigins.length === 0
      ? "'none'"
      : config.allowedOrigins.join(" ");
  return new Response(
    page(
      "dx Feedback Widget",
      `<main id="panel" aria-live="polite"></main>
<script nonce="${scriptNonce}">(() => {
${panelSource}
dxFeedbackPanel(${scriptJson(config)});
})();</script>`,
      panelStyles,
    ),
    { status: 200, headers: documentHeaders(scriptNonce, ancestors) },
  );
};

/** The script a website embeds; an unknown or turned-off widget does nothing. */
export const widgetScript = (
  config:
    | {
        readonly clientId: string;
        readonly appOrigin: string;
        readonly allowedOrigins: ReadonlyArray<string>;
      }
    | undefined,
) =>
  new Response(
    config === undefined
      ? "/* dx Feedback Widget: this widget is turned off. */\n"
      : `/* dx Feedback Widget */\n(() => {\n${widgetSource}\ndxFeedbackWidget(${scriptJson(config)});\n})();\n`,
    {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        // Revalidated on every load, so turning the widget off or changing
        // its origins applies at once.
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    },
  );

/** A first-party page in the sign-in popup; nothing may frame it. */
export const popupPage = (
  status: number,
  title: string,
  body: string,
  script?: string,
) => {
  const scriptNonce = nonce();
  return new Response(
    page(
      title,
      `<main><div class="mark">dx</div>${body}</main>${
        script === undefined
          ? ""
          : `<script nonce="${scriptNonce}">${script}</script>`
      }`,
      popupStyles,
    ),
    { status, headers: documentHeaders(scriptNonce, "'none'", "same-origin") },
  );
};

export const consentPage = (input: {
  readonly projectLabel: string;
  readonly userLabel: string;
  readonly challenge: string;
  readonly action: string;
}) =>
  popupPage(
    200,
    "Allow the Feedback Widget",
    `<h1>Allow the Feedback Widget for ${escapeHtml(input.projectLabel)}?</h1>
<p>It will start Threads in <strong>${escapeHtml(input.projectLabel)}</strong> as you with the comments you send from your website. You can turn this off by signing out in the widget, and the Project's admins can turn the widget off for everyone.</p>
<p class="identity">Signed in as ${escapeHtml(input.userLabel)}</p>
<form method="post" action="${escapeHtml(input.action)}" class="row">
<input type="hidden" name="challenge" value="${escapeHtml(input.challenge)}">
<button type="button" id="cancel">Cancel</button>
<span class="spacer"></span>
<button type="submit" class="primary" id="allow">Allow</button>
</form>`,
    `document.getElementById("cancel").addEventListener("click", () => window.close());`,
  );

/** After Allow: tell the panel, which claims the grant, then close. */
export const approvedPage = (appOrigin: string) =>
  popupPage(
    200,
    "You're signed in",
    `<h1>You're signed in</h1><p>Go back to your website to send your comments. You can close this window.</p>`,
    `try { window.opener && window.opener.postMessage({ type: "dx-fw:approved" }, ${scriptJson(appOrigin)}); } catch {}
setTimeout(() => window.close(), 600);`,
  );

export const messagePage = (status: number, title: string, message: string) =>
  popupPage(
    status,
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
  );
