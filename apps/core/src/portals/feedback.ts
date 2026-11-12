// The Feedback Widget in a Thread's Portal. When the signed-in member has the
// Feedback Widget experimental feature on, every HTML page the Portal relays
// gets a script tag for the widget, and the widget posts comments back to the
// same Portal host, which delivers them to the Thread as that member's
// message. An anonymous visitor of a public link has no identity, so never
// gets the widget and cannot send.
//
//   page ── <script src=/__dx_portal/feedback.js> ──▶ Portal (session) ──▶ Core
//   Send ── POST /__dx_portal/feedback {comments} ──▶ Portal (session) ──▶ Core
//
// The Portal Worker stays free of Core's modules: Core implements
// PortalFeedbackService (feedback-widget/portal-feedback.ts) and the Portal
// Worker reaches it through a service binding to Core's PortalFeedback
// entrypoint. Locally, the Portal handler runs inside Core and is handed the
// service directly.

import { readBoundedText } from "../http/bounded-body.js";

export const PORTAL_FEEDBACK_SCRIPT_PATH = "/__dx_portal/feedback.js";
export const PORTAL_FEEDBACK_SEND_PATH = "/__dx_portal/feedback";
const MAX_SEND_BYTES = 128 * 1024;

export interface PortalFeedbackSend {
  readonly threadId: string;
  readonly port: number;
  /** The Portal origin; every comment's page must be on it. */
  readonly origin: string;
  readonly userId: string;
  /** The request body as the widget sent it; Core validates it. */
  readonly body: unknown;
}

export interface PortalFeedbackResult {
  readonly status: number;
  readonly body: unknown;
}

export interface PortalFeedbackService {
  /** Whether the person has the Feedback Widget feature on. */
  enabled(userId: string): Promise<boolean>;
  /** The widget script, or undefined when the feature is off for them. */
  script(userId: string): Promise<string | undefined>;
  send(input: PortalFeedbackSend): Promise<PortalFeedbackResult>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const failure = (status: number, code: string, message: string) =>
  json(status, { status: "error", data: { code, message } });

/** A navigation that may get the widget: a GET for a document or frame. */
export const wantsFeedbackWidget = (request: Request) => {
  if (request.method !== "GET") return false;
  const destination = request.headers.get("sec-fetch-dest");
  if (destination !== null)
    return (
      destination === "document" ||
      destination === "iframe" ||
      destination === "frame"
    );
  return (request.headers.get("accept") ?? "").includes("text/html");
};

/** The widget's script, for a signed-in member with the feature on. */
export const serveFeedbackScript = async (
  service: PortalFeedbackService | undefined,
  userId: string,
) => {
  const source =
    service === undefined
      ? undefined
      : await service.script(userId).catch(() => undefined);
  return new Response(source ?? "/* dx Feedback Widget: turned off. */\n", {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
};

/** The widget's Send: a same-origin POST that carries the Portal session. */
export const sendFeedback = async (
  request: Request,
  service: PortalFeedbackService | undefined,
  input: Omit<PortalFeedbackSend, "body">,
) => {
  if (request.method !== "POST")
    return failure(405, "METHOD_NOT_ALLOWED", "Send comments with POST.");
  // Only the page on this Portal may send, never another site or Portal.
  if (request.headers.get("origin") !== input.origin)
    return failure(403, "CROSS_SITE_REFUSED", "Cross-site request refused.");
  if (service === undefined)
    return failure(503, "UNAVAILABLE", "Feedback is unavailable right now.");
  const text = await readBoundedText(request, MAX_SEND_BYTES);
  if (text === undefined)
    return failure(413, "PAYLOAD_TOO_LARGE", "Too many comments.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure(400, "INVALID_REQUEST", "Request validation failed.");
  }
  const result = await service.send({ ...input, body });
  return json(result.status, result.body);
};

const scriptTag = `<script src="${PORTAL_FEEDBACK_SCRIPT_PATH}" async></script>`;

/**
 * The guest's HTML page with the widget's script tag at the end of its body
 * (or document, for a page without one). A response still encoded, or not
 * HTML, passes unchanged.
 */
export const injectFeedbackWidget = (response: Response) => {
  const type = response.headers.get("content-type") ?? "";
  if (
    response.status !== 200 ||
    response.body === null ||
    !type.toLowerCase().startsWith("text/html") ||
    response.headers.has("content-encoding")
  )
    return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");
  let injected = false;
  const rewritten = new HTMLRewriter()
    .on("body", {
      element(element) {
        element.onEndTag((end) => {
          if (injected) return;
          injected = true;
          end.before(scriptTag, { html: true });
        });
      },
    })
    .onDocument({
      end(end) {
        if (injected) return;
        injected = true;
        end.append(scriptTag, { html: true });
      },
    })
    .transform(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
    );
  return rewritten;
};
