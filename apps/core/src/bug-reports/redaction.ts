const REDACTED = "[redacted]";

/**
 * The query string of each http(s) URL. It matches a whole URL and cuts in
 * code, so a URL that holds many `http://` without a `?` is scanned once,
 * not once per `http://` (#2369).
 */
const redactUrlQuery = (url: string) => {
  const query = url.indexOf("?", url.indexOf("//") + 3);
  return query < 0 ? url : `${url.slice(0, query + 1)}${REDACTED}`;
};

/**
 * Removes what a bug report must not carry from one string: credentials in
 * URLs, URL query strings, provider and dx tokens, JWTs, private keys,
 * Authorization and Cookie values, and secret-looking assignments. `values`
 * are exact secrets known for the Thread, such as its environment's secret
 * values; each is replaced wherever it appears.
 *
 * A signed-in person sends up to 4 MB, so every pattern runs in linear time:
 * none may rescan the same run of characters from each position in it
 * (#2369).
 */
export const redactBugReportText = (
  text: string,
  values: ReadonlyArray<string> = [],
) => {
  let result = text;
  for (const value of [...values].sort((a, b) => b.length - a.length))
    if (value.length >= 4) result = result.split(value).join(REDACTED);
  return result
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      REDACTED,
    )
    .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@"'<>]+@/gi, `$1${REDACTED}@`)
    .replace(/\bhttps?:\/\/[^\s#"'<>]+/gi, redactUrlQuery)
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|e2b_[A-Za-z0-9]{16,}|dx_[A-Za-z0-9_]{24,}|dx(?:u|o|d|br)_[A-Za-z0-9._~-]{16,})/g,
      REDACTED,
    )
    .replace(
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      REDACTED,
    )
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(
      /\b(basic)\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/gi,
      `$1 ${REDACTED}`,
    )
    .replace(
      /\b((?:set-)?cookie|authorization|proxy-authorization|x-api-key)(["']?\s*[:=]\s*["']?)[^"'\n]+/gi,
      `$1$2${REDACTED}`,
    )
    .replace(
      /\b(?=[A-Za-z_]*?(?:token|secret|password|passwd|credential|api_?key|private_?key))([A-Za-z_]+)(["']?\s*[=:]\s*["']?)(?!\[redacted\])[^\s"',;}]+/gi,
      `$1$2${REDACTED}`,
    );
};

/**
 * Redacts every string in a JSON value, keys included, and drops the value
 * of any key that names a credential.
 */
export const redactBugReportValue = (
  value: unknown,
  values: ReadonlyArray<string> = [],
): unknown => {
  if (typeof value === "string") return redactBugReportText(value, values);
  if (Array.isArray(value))
    return value.map((item) => redactBugReportValue(item, values));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactBugReportText(key, values),
        SECRET_KEY.test(key) && typeof item === "string"
          ? REDACTED
          : redactBugReportValue(item, values),
      ]),
    );
  return value;
};

const SECRET_KEY =
  /^(?:authorization|cookie|set-cookie|password|passwd|secret|token|access_?token|refresh_?token|api_?key|private_?key|client_?secret)$/i;
