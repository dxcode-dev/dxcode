import { Schema } from "effect";

export const MAX_FEEDBACK_WIDGET_ORIGINS = 20;
export const MAX_FEEDBACK_WIDGET_COMMENTS = 20;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin (scheme, host, and port) of an address someone typed, or
 * undefined when the widget cannot use it. A bare host means HTTPS. Plain
 * HTTP is allowed only on a loopback host, on any port, for local
 * development.
 */
export const normalizeFeedbackWidgetOrigin = (
  input: string,
): string | undefined => {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > 300) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.hostname === "" || url.origin === "null") return undefined;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
    return url.origin;
  return undefined;
};

export const FeedbackWidgetOrigin = Schema.String.check(
  Schema.makeFilter(
    (value: string) => normalizeFeedbackWidgetOrigin(value) === value,
    { description: "an https origin, or an http origin on a loopback host" },
  ),
);

/** The public ID in the widget script's address. */
export const FeedbackWidgetClientId = Schema.String.check(
  Schema.isPattern(/^fbw_[a-z0-9]{24}$/),
);

export const FeedbackWidgetComment = Schema.Struct({
  /** The page the element is on; its origin must be allowed. */
  pageUrl: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(2000)),
  selector: Schema.String.check(Schema.isMaxLength(600)),
  /** The element's tag and attributes, as `<button class="cta">`. */
  element: Schema.String.check(Schema.isMaxLength(600)),
  /** The element's visible text, shortened. */
  text: Schema.String.check(Schema.isMaxLength(400)),
  comment: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
});

export type FeedbackWidgetComment = typeof FeedbackWidgetComment.Type;

const SCRIPT_PATH = /^\/api\/feedback-widget\/(fbw_[a-z0-9]{24})\.js$/;

/**
 * The widget script address in a pasted script tag or address, or
 * undefined when it is not one. Its origin is the dx host that receives
 * feedback; its client ID names the Project.
 */
export const parseFeedbackWidgetScriptUrl = (
  input: string,
):
  | {
      readonly scriptUrl: string;
      readonly host: string;
      readonly clientId: string;
    }
  | undefined => {
  const trimmed = input.trim();
  const source =
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(trimmed)?.[1] ?? trimmed;
  if (source.length > 400) return undefined;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  const origin = normalizeFeedbackWidgetOrigin(url.origin);
  const clientId = SCRIPT_PATH.exec(url.pathname)?.[1];
  if (
    origin === undefined ||
    clientId === undefined ||
    url.search !== "" ||
    url.hash !== ""
  )
    return undefined;
  return { scriptUrl: `${origin}${url.pathname}`, host: url.host, clientId };
};
