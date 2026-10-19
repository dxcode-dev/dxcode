// The small HTML pages a Portal shows in place of the guest's response.
// Browsers get a page for a document request; everything else gets a plain
// status so scripts and asset loaders see an ordinary failure.

import { randomToken } from "./crypto.js";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Whether a request is a browser document load that should get a page. */
export const wantsDocument = (request: Request) => {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const destination = request.headers.get("sec-fetch-dest");
  if (destination !== null)
    return (
      destination === "document" ||
      destination === "iframe" ||
      destination === "frame"
    );
  return (request.headers.get("accept") ?? "").includes("text/html");
};

// Bounded automatic retry while a paused workspace wakes: about two minutes
// of backoff per episode, then a manual Retry button. The counter lives in
// sessionStorage so a reload loop cannot keep waking a broken workspace.
const wakingScript = `(() => {
  const key = "dx-portal-waking:" + location.pathname;
  const now = Date.now();
  let state;
  try { state = JSON.parse(sessionStorage.getItem(key) || "null"); } catch {}
  if (!state || now - state.started > 600000) state = { started: now, attempts: 0 };
  if (now - state.started > 120000) {
    sessionStorage.removeItem(key);
    document.getElementById("status").textContent = "The workspace is taking longer than usual.";
    document.getElementById("retry").hidden = false;
    return;
  }
  state.attempts += 1;
  sessionStorage.setItem(key, JSON.stringify(state));
  setTimeout(() => location.reload(), Math.min(1000 * 2 ** (state.attempts - 1), 8000));
})();`;

interface PageOptions {
  readonly status: number;
  readonly title: string;
  readonly message: string;
  readonly retry?: boolean;
  readonly waking?: boolean;
  /** Origin allowed to frame the page, besides the page itself. */
  readonly frameAncestor?: string;
  readonly headers?: HeadersInit;
}

export const portalPage = ({
  status,
  title,
  message,
  retry = false,
  waking = false,
  frameAncestor,
  headers,
}: PageOptions) => {
  const nonce = randomToken();
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { max-width: 28rem; padding: 2rem; }
h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 .5rem; }
p { margin: 0 0 1rem; font-size: .9rem; line-height: 1.45; opacity: .75; }
a { font-size: .85rem; color: inherit; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p id="status">${escapeHtml(message)}</p>
${retry || waking ? `<a id="retry" href=""${waking ? " hidden" : ""}>Retry</a>` : ""}
</main>
${waking ? `<script nonce="${nonce}">${wakingScript}</script>` : ""}
</body>
</html>
`;
  const response = new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        `script-src 'nonce-${nonce}'`,
        "base-uri 'none'",
        "form-action 'none'",
        `frame-ancestors 'self'${frameAncestor === undefined ? "" : ` ${frameAncestor}`}`,
      ].join("; "),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      ...(waking ? { "retry-after": "2" } : {}),
    },
  });
  return withHeaders(response, headers);
};

export const PORTAL_PUBLIC_CONTINUE_PATH = "/__dx_portal/public";
export const PORTAL_SIGN_IN_PATH = "/__dx_portal/sign-in";

/**
 * The page an anonymous visitor sees before a public Portal's first
 * document: whoever shared the link wrote what follows, not dx. Continuing
 * posts back to the same origin, so another site cannot skip it for them,
 * and no site may frame it.
 */
export const portalPublicNotice = (host: string, returnPath: string) => {
  const signIn = `${PORTAL_SIGN_IN_PATH}?${new URLSearchParams({ return: returnPath })}`;
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Public preview</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { max-width: 30rem; padding: 2rem; }
h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 .5rem; }
p { margin: 0 0 1rem; font-size: .9rem; line-height: 1.45; opacity: .75; }
code { font-size: .85rem; overflow-wrap: anywhere; }
form { display: flex; align-items: center; gap: 1rem; }
button { font: inherit; font-size: .9rem; padding: .4rem 1rem; border-radius: 6px; border: 1px solid currentColor; background: CanvasText; color: Canvas; cursor: pointer; }
a { font-size: .85rem; color: inherit; }
</style>
</head>
<body>
<main>
<h1>Public preview</h1>
<p><code>${escapeHtml(host)}</code> shows an app running in a dx workspace. Whoever shared this link controls its content, not dx. Do not enter passwords or payment details unless you trust them.</p>
<form method="post" action="${PORTAL_PUBLIC_CONTINUE_PATH}">
<input type="hidden" name="return" value="${escapeHtml(returnPath)}">
<button type="submit">Continue</button>
<a href="${escapeHtml(signIn)}">Sign in to dx</a>
</form>
</main>
</body>
</html>
`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
      // Under `no-referrer` a browser posts Continue with `Origin: null`,
      // which the same-origin check refuses; `same-origin` still sends
      // nothing to other sites.
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex",
    },
  });
};

const withHeaders = (response: Response, headers: HeadersInit | undefined) => {
  if (headers === undefined) return response;
  const extra = new Headers(headers);
  for (const [name, value] of extra)
    if (name !== "set-cookie") response.headers.set(name, value);
  for (const cookie of extra.getSetCookie())
    response.headers.append("set-cookie", cookie);
  return response;
};

/** A page for document requests, otherwise a plain-text status. */
export const portalFailure = (
  request: Request,
  options: PageOptions & { readonly plain?: string },
) =>
  wantsDocument(request)
    ? portalPage(options)
    : withHeaders(
        new Response(options.plain ?? options.title, {
          status: options.status,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            ...(options.waking ? { "retry-after": "2" } : {}),
          },
        }),
        options.headers,
      );
