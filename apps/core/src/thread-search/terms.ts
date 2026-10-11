/**
 * How text becomes search terms. The index tokenizes message text with
 * SQLite FTS5 `porter unicode61` (stemmed words, split on punctuation). A
 * compound token — a path, file name, hyphenated or snake_case word, or
 * version such as `apps/core/agent-tools.ts`, `agent-tools`, `0.2.10` — is
 * also kept whole by encoding it as one alphanumeric term
 * in the hidden `aux` column. A path's file name is encoded too, so
 * `agent-tools.ts` finds the full path.
 */

/** PostgreSQL's English stopwords, dropped from queries. */
const STOPWORDS = new Set(
  `i me my myself we our ours ourselves you your yours yourself yourselves he
  him his himself she her hers herself it its itself they them their theirs
  themselves what which who whom this that these those am is are was were be
  been being have has had having do does did doing a an the and but if or
  because as until while of at by for with about against between into through
  during before after above below to from up down in out on off over under
  again further then once here there when where why how all any both each few
  more most other some such no nor not only own same so than too very s t can
  will just don should now d ll m o re ve y ain aren couldn didn doesn hadn
  hasn haven isn ma mightn mustn needn shan shouldn wasn weren won wouldn`
    .split(/\s+/)
    .filter((word) => word !== ""),
);

/** Runs of word characters plus the compound joiners `. _ / -`. */
const RUN = /[\p{L}\p{N}._/-]+/gu;
const JOINER = /[._/-]/;
const EDGE_JOINERS = /^[._/-]+|[._/-]+$/g;
const ENCODED: Record<string, string> = {
  ".": "0d",
  _: "0u",
  "/": "0s",
  "-": "0h",
};
/** A compound longer than this is not kept whole. */
const COMPOUND_MAX_CHARS = 200;
/** At most this many encoded terms per indexed message. */
const AUX_MAX_TERMS = 512;

/** One alphanumeric term for a whole compound; never a natural word. */
const encode = (compound: string) =>
  `zz${compound.toLowerCase().replace(/[._/-]/g, (joiner) => ENCODED[joiner] ?? "")}`;

const tokens = (text: string) =>
  Array.from(text.matchAll(RUN), ([run]) =>
    run.replace(EDGE_JOINERS, ""),
  ).filter((token) => token !== "");

/** The last path segment, or undefined for a token that is not a path. */
const basename = (token: string) => {
  const slash = token.lastIndexOf("/");
  return slash < 0 ? undefined : token.slice(slash + 1);
};

/** `agent-tools.ts` → `agent-tools`; undefined when there is no extension. */
const withoutExtension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : undefined;
};

/** Encoded compound terms for the `aux` column of one message. */
export const auxTerms = (text: string): string => {
  const terms = new Set<string>();
  for (const token of tokens(text)) {
    if (terms.size >= AUX_MAX_TERMS) break;
    if (!JOINER.test(token) || token.length > COMPOUND_MAX_CHARS) continue;
    terms.add(encode(token));
    const name = basename(token) ?? token;
    if (name !== token && JOINER.test(name)) terms.add(encode(name));
    const stem = withoutExtension(name);
    if (stem !== undefined && JOINER.test(stem)) terms.add(encode(stem));
  }
  return [...terms].join(" ");
};

/**
 * The FTS5 terms a query's keywords require, all of them, in any message of
 * a Thread. Stopwords drop out, so a query of only stopwords has no terms.
 * A path with a file extension searches for its file name.
 */
export const queryTerms = (keywords: ReadonlyArray<string>): string[] => {
  const terms = new Set<string>();
  for (const keyword of keywords)
    for (const token of tokens(keyword)) {
      if (JOINER.test(token)) {
        const name = basename(token);
        terms.add(
          encode(
            name !== undefined && withoutExtension(name) !== undefined
              ? name
              : token,
          ),
        );
        continue;
      }
      const word = token.toLowerCase();
      if (!STOPWORDS.has(word)) terms.add(word);
    }
  return [...terms];
};

/** An FTS5 query string matching one term (quoted, so never an operator). */
export const ftsTerm = (term: string) => `"${term.replaceAll('"', '""')}"`;

/** Whether a term is a plain word, which can appear in a snippet. */
export const isPlainTerm = (term: string) => !term.startsWith("zz");

/** The term a snippet centers on: the first plain word, else the first term. */
export const snippetTerm = (terms: ReadonlyArray<string>) =>
  terms.find(isPlainTerm) ?? terms[0];

/** Words in an excerpt, and how many of them come before the match. */
const EXCERPT_WORDS = 32;
const EXCERPT_LEAD = 10;

/**
 * About `EXCERPT_WORDS` words around the first word that starts like `term`
 * (a stemmed match shares at least its first few letters), else the start.
 */
export const excerptAround = (text: string, term: string) => {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lower = term.toLowerCase();
  const prefix = lower.slice(0, Math.max(4, lower.length - 3));
  const key = (word: string) =>
    word.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "");
  let at = words.findIndex((word) => key(word).startsWith(lower));
  if (at < 0) at = words.findIndex((word) => key(word).startsWith(prefix));
  const start = Math.max(0, at - EXCERPT_LEAD);
  const end = Math.min(words.length, start + EXCERPT_WORDS);
  return `${start > 0 ? "…" : ""}${words.slice(start, end).join(" ")}${
    end < words.length ? "…" : ""
  }`;
};
