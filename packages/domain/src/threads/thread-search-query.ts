/**
 * The Thread search query language shared by the search popup, the
 * `/v1/thread-search` route, and the agent's `find_thread` tool. Bare words
 * and quoted groups are keywords combined with AND, quotes only group, and
 * `key:value` filters narrow by Thread metadata. An unknown `key:value`
 * stays a keyword.
 */

export const THREAD_SEARCH_QUERY_MAX_LENGTH = 1_000;

export const THREAD_SEARCH_FILTER_KEYS = [
  "id",
  "parent",
  "project",
  "author",
  "visibility",
  "repo",
  "issue",
  "pinned",
  "snoozed",
  "archived",
  "color",
  "after",
  "before",
  "updated_after",
  "updated_before",
] as const;

export type ThreadSearchFilterKey = (typeof THREAD_SEARCH_FILTER_KEYS)[number];

export interface ThreadSearchFilters {
  readonly id?: string;
  readonly parent?: string;
  readonly project?: string;
  /** `me` or a username, name, or email. */
  readonly author?: string;
  /** `none` matches nothing: dx has no group or unlisted sharing. */
  readonly visibility?: "private" | "workspace" | "none";
  /** `owner/repo`, lowercased. */
  readonly repo?: string;
  /** A GitHub issue or pull request a Thread is linked to. */
  readonly issue?: {
    /** `owner/repo`, lowercased. */
    readonly repository: string;
    readonly number: number;
  };
  readonly pinned?: boolean;
  /** The requester's own Threads that are snoozed now, or that are not. */
  readonly snoozed?: boolean;
  readonly archived?: boolean;
  /** A Thread color, or `auto` for no chosen color. */
  readonly color?: string;
  /** ISO timestamps bounding the last activity: `after` ≤ activity < `before`. */
  readonly after?: string;
  readonly before?: string;
}

export interface ThreadSearchQuery {
  /** Keyword groups as written, quotes removed; terms derive from these. */
  readonly keywords: ReadonlyArray<string>;
  readonly filters: ThreadSearchFilters;
}

export class ThreadSearchQueryError extends Error {
  override readonly name = "ThreadSearchQueryError";
}

const THREAD_ID =
  /thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;
const DAY_MS = 86_400_000;

const isFilterKey = (key: string): key is ThreadSearchFilterKey =>
  (THREAD_SEARCH_FILTER_KEYS as ReadonlyArray<string>).includes(key);

/** Splits on whitespace outside double quotes; a quoted group is one chunk. */
const chunks = (input: string) => {
  const result: Array<{ readonly text: string; readonly quoted: boolean }> = [];
  const pattern = /"([^"]*)"?|(\S+)/g;
  for (const match of input.matchAll(pattern)) {
    if (match[1] !== undefined) {
      if (match[1].trim() !== "")
        result.push({ text: match[1].trim(), quoted: true });
    } else if (match[2] !== undefined)
      result.push({ text: match[2], quoted: false });
  }
  return result;
};

const threadIdValue = (key: string, value: string) => {
  const id = THREAD_ID.exec(value)?.[0];
  if (id === undefined)
    throw new ThreadSearchQueryError(
      `${key}: takes a Thread ID (thr_…) or a dx Thread URL.`,
    );
  return id;
};

const booleanValue = (key: string, value: string) => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ThreadSearchQueryError(`${key}: takes true or false.`);
};

/** `7d`, `2w`, `2026-03-01`, or a full ISO timestamp. */
const dateValue = (key: string, value: string, now: Date) => {
  const relative = /^(\d{1,4})([dw])$/.exec(value);
  if (relative !== null) {
    const days = Number(relative[1]) * (relative[2] === "w" ? 7 : 1);
    return new Date(now.getTime() - days * DAY_MS).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  throw new ThreadSearchQueryError(
    `${key}: takes a date such as 2026-03-01, or a relative age such as 7d or 2w.`,
  );
};

const repoValue = (value: string) =>
  value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^(github\.com|bitbucket\.org)\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

/**
 * `owner/repo#12`, or an issue or pull request URL on github.com, such as
 * `https://github.com/owner/repo/issues/12`.
 */
const issueValue = (value: string) => {
  const match =
    /^(?:https?:\/\/)?github\.com\/([^/\s]+\/[^/\s#]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i.exec(
      value,
    ) ?? /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(value);
  const number = Number(match?.[2]);
  if (match?.[1] === undefined || !Number.isSafeInteger(number) || number < 1)
    throw new ThreadSearchQueryError(
      "issue: takes owner/repo#12 or a GitHub issue or pull request URL.",
    );
  return { repository: match[1].toLowerCase(), number };
};

const later = (left: string | undefined, right: string) =>
  left === undefined || right > left ? right : left;
const earlier = (left: string | undefined, right: string) =>
  left === undefined || right < left ? right : left;

/** Parses a query; throws `ThreadSearchQueryError` for an invalid filter value. */
export const parseThreadSearchQuery = (
  input: string,
  now: Date = new Date(),
): ThreadSearchQuery => {
  if (input.length > THREAD_SEARCH_QUERY_MAX_LENGTH)
    throw new ThreadSearchQueryError(
      `A query is at most ${THREAD_SEARCH_QUERY_MAX_LENGTH} characters.`,
    );
  const keywords: string[] = [];
  const filters: {
    -readonly [Key in keyof ThreadSearchFilters]: ThreadSearchFilters[Key];
  } = {};
  for (const chunk of chunks(input)) {
    const separator = chunk.quoted ? -1 : chunk.text.indexOf(":");
    const key = separator > 0 ? chunk.text.slice(0, separator) : "";
    const value = separator > 0 ? chunk.text.slice(separator + 1) : "";
    if (!isFilterKey(key) || value === "") {
      keywords.push(chunk.text);
      continue;
    }
    switch (key) {
      case "id":
      case "parent":
        filters[key] = threadIdValue(key, value);
        break;
      case "project":
        filters.project = value;
        break;
      case "author":
        filters.author = value.toLowerCase();
        break;
      case "visibility":
        if (value === "private" || value === "workspace")
          filters.visibility = value;
        else if (value === "group" || value === "unlisted")
          filters.visibility = "none";
        else
          throw new ThreadSearchQueryError(
            "visibility: takes private or workspace.",
          );
        break;
      case "repo":
        filters.repo = repoValue(value);
        break;
      case "issue":
        filters.issue = issueValue(value);
        break;
      case "pinned":
      case "snoozed":
      case "archived":
        filters[key] = booleanValue(key, value);
        break;
      case "color":
        filters.color = value.toLowerCase();
        break;
      case "after":
      case "updated_after":
        filters.after = later(filters.after, dateValue(key, value, now));
        break;
      case "before":
      case "updated_before":
        filters.before = earlier(filters.before, dateValue(key, value, now));
        break;
    }
  }
  return { keywords, filters };
};
