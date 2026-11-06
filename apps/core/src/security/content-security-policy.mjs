// dx's Content Security Policy: one authority for the header the production
// package writes for static documents (`_headers`), the header Core adds to
// its own responses, and the report endpoint both point at. Plain JavaScript,
// because the package script runs it with Node before anything is bundled.
// wiki/content-security-policy.md explains every source it allows.

import { createHash } from "node:crypto";
import {
  VIEW_FRAME_CONTENT_SECURITY_POLICY,
  VIEW_FRAME_PATH,
} from "../../../../packages/api/src/views/view-frame.mjs";

/** Where browsers send violation reports; Core answers it. */
export const CSP_REPORT_PATH = "/api/csp-reports";

/**
 * Enforced since the critical suite and the main journeys ran on a preview
 * with no app, api, or docs reports (#1518); false sends every policy
 * Report-Only again.
 */
export const CSP_ENFORCED = true;

/** The policies reports name, so a report says which header it broke. */
export const CSP_POLICIES = Object.freeze(["app", "api", "docs"]);

const TURNSTILE = "https://challenges.cloudflare.com";
/**
 * Cloudflare Web Analytics: the zone injects its beacon script into every
 * HTML response, and the beacon posts page timings back.
 */
const ANALYTICS_SCRIPT = "https://static.cloudflareinsights.com";
const ANALYTICS_REPORTS = "https://cloudflareinsights.com";
/** Google sign-in profile pictures. */
const GOOGLE_AVATARS = "https://*.googleusercontent.com";

const reportTo = (policy) => [
  `report-uri ${CSP_REPORT_PATH}?policy=${policy}`,
  `report-to csp-${policy}`,
];

const enforcedHeader = () =>
  CSP_ENFORCED
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

/** `'sha256-…'` for each classic or module script written inline in `html`. */
export const inlineScriptHashes = (html) => {
  const hashes = new Set();
  for (const [, attributes, body] of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1];
    if (type !== undefined && !/^(?:module|text\/javascript)$/i.test(type))
      continue;
    hashes.add(
      `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`,
    );
  }
  return [...hashes].sort();
};

/**
 * The app document's policy. Scripts are strict; styles allow
 * `'unsafe-inline'`, because the diff and code viewer, the file tree, and
 * toasts write inline styles and offer no way not to (the owner kept this
 * on 2026-11-04; see wiki/content-security-policy.md).
 *
 * `storageOrigin` is the deployment's R2 S3 origin: attachments and Thread
 * storage files redirect there to presigned reads, and uploads PUT their
 * parts there.
 *
 * `feedbackWidgetOrigins` are other dx hosts whose Feedback Widget the app
 * may load (experimental): their script runs in the app and frames their
 * panel. The app's own origin is always allowed through 'self'.
 *
 * @param {{ scriptHashes: readonly string[]; portalDomain?: string; storageOrigin?: string; feedbackWidgetOrigins?: readonly string[] }} options
 */
export const appPolicy = ({
  scriptHashes,
  portalDomain,
  storageOrigin,
  feedbackWidgetOrigins = [],
}) => {
  const storage = storageOrigin === undefined ? "" : ` ${storageOrigin}`;
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' compiles WebAssembly (Terminal, Shiki) and nothing else.
    [
      "script-src 'self' 'wasm-unsafe-eval'",
      ...scriptHashes,
      TURNSTILE,
      ANALYTICS_SCRIPT,
      ...feedbackWidgetOrigins,
    ].join(" "),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${GOOGLE_AVATARS}${storage}`,
    "font-src 'self'",
    // 'self' covers the same-origin WebSockets too.
    `connect-src 'self' ${ANALYTICS_REPORTS}${storage}`,
    `media-src 'self' blob:${storage}`,
    "worker-src 'self'",
    [
      "frame-src 'self' blob:",
      TURNSTILE,
      ...(portalDomain === undefined ? [] : [`https://*.${portalDomain}`]),
      ...feedbackWidgetOrigins,
    ].join(" "),
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...reportTo("app"),
  ].join("; ");
};

/** The docs site's policy: Starlight writes its scripts and styles inline. */
export const docsPolicy = ({ scriptHashes }) =>
  [
    "default-src 'self'",
    // Pagefind searches with WebAssembly.
    [
      "script-src 'self' 'wasm-unsafe-eval'",
      ...scriptHashes,
      ANALYTICS_SCRIPT,
    ].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${ANALYTICS_REPORTS}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...reportTo("docs"),
  ].join("; ");

/**
 * Core's own responses: JSON, files, and a few plain pages (unsubscribe).
 * None loads a script; a file served as a document can run nothing.
 */
export const apiPolicy = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  ...reportTo("api"),
].join("; ");

/** The response header Core's policy goes in. */
export const apiPolicyHeader = () => enforcedHeader();

export const reportingEndpoints = () =>
  CSP_POLICIES.map(
    (policy) => `csp-${policy}="${CSP_REPORT_PATH}?policy=${policy}"`,
  ).join(", ");

/**
 * Workers static assets' `_headers` file: the app policy on every document
 * and asset (workers read their own response's policy), the view shell's own
 * policy, and the docs site's.
 *
 * @param {{ indexHtml: string; docsHtml?: readonly string[]; portalDomain?: string; storageOrigin?: string; feedbackWidgetOrigins?: readonly string[] }} options
 */
export const staticHeaders = ({
  indexHtml,
  docsHtml,
  portalDomain,
  storageOrigin,
  feedbackWidgetOrigins,
}) => {
  const scriptHashes = inlineScriptHashes(indexHtml);
  const detach = [
    "  ! Content-Security-Policy",
    "  ! Content-Security-Policy-Report-Only",
  ];
  const rules = [
    "/*",
    `  ${enforcedHeader()}: ${appPolicy({ scriptHashes, portalDomain, storageOrigin, feedbackWidgetOrigins })}`,
    `  Reporting-Endpoints: ${reportingEndpoints()}`,
    "  X-Content-Type-Options: nosniff",
    VIEW_FRAME_PATH,
    ...detach,
    `  Content-Security-Policy: ${VIEW_FRAME_CONTENT_SECURITY_POLICY}`,
  ];
  if (docsHtml !== undefined)
    rules.push(
      "/docs/*",
      ...detach,
      `  ${enforcedHeader()}: ${docsPolicy({
        scriptHashes: [
          ...new Set(docsHtml.flatMap((html) => inlineScriptHashes(html))),
        ].sort(),
      })}`,
    );
  return `${rules.join("\n")}\n`;
};
