/**
 * Masks the values of a Thread's secrets in text the agent, its tool results,
 * or the Thread's history would show. Commands still receive the values;
 * only what is read back is masked.
 *
 * A secret is masked as it is written and in the forms a command prints it:
 * JSON-escaped (once, and nested), URL-encoded, and base64 at any byte
 * alignment in either alphabet. Credentials dx itself gives the Thread (GitHub
 * tokens from the credential helper, the dxd key, Claude plan tokens) are
 * masked by their shape, since the agent's isolate never holds their values.
 */

/**
 * What reads show in place of the secret a variable holds. It has no quote
 * or backslash, so it stays valid inside a JSON string.
 */
export const environmentSecretMarker = (name: string) => `[REDACTED:${name}]`;

/** One form of a hidden secret's value, and the marker shown in its place. */
export interface EnvironmentSecret {
  readonly name: string;
  readonly value: string;
  readonly marker: string;
}

/**
 * Credentials dx gives the Thread, by shape. Each body is long and random
 * enough that a test fixture or prose rarely matches: `dxd_test-api-key`
 * and `ghs_short` do not.
 */
const CREDENTIALS = [
  {
    name: "GITHUB_TOKEN",
    prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
    body: "[A-Za-z0-9]",
    min: 36,
    max: 251,
  },
  {
    name: "GITHUB_TOKEN",
    prefixes: ["github_pat_"],
    body: "[A-Za-z0-9_]",
    min: 60,
    max: 251,
  },
  // Better Auth keys: the prefix and 64 letters.
  {
    name: "DXD_API_KEY",
    prefixes: ["dxd_"],
    body: "[A-Za-z]",
    min: 64,
    max: 64,
  },
  {
    name: "DX_API_KEY",
    prefixes: ["dxu_", "dxo_"],
    body: "[A-Za-z]",
    min: 64,
    max: 64,
  },
  {
    name: "CLAUDE_TOKEN",
    prefixes: ["sk-ant-oat01-", "sk-ant-ort01-", "sk-ant-api03-"],
    body: "[A-Za-z0-9_-]",
    min: 40,
    max: 400,
  },
] as const;

const BOUNDARY = "(?<![A-Za-z0-9_-])";
const credentialBodies = CREDENTIALS.map(
  ({ body }) => new RegExp(`^${body}*$`),
);
const CREDENTIAL_MARKERS = [
  ...new Set(CREDENTIALS.map(({ name }) => name)),
].map((name) => ({
  name,
  marker: environmentSecretMarker(name),
  credential: true,
}));
/** Long enough to hold any credential's prefix and body. */
const CREDENTIAL_SPAN = 420;
const TOKEN_TAIL = /[A-Za-z0-9_-]+$/;

/**
 * The least output a shell read sends before what it keeps, and the least
 * it may hold back. A masker with a longer secret uses its
 * `readContextBytes`, the most text any form of its secrets can span.
 */
export const READ_CONTEXT_BYTES = 4_096;

/**
 * The most context a read sends: 128 KiB, about 384 KB as hex and about
 * 540 KB with the 50 KB the read keeps. It covers every form of a secret
 * up to the 32 KiB a variable holds (base64 wrapped with `\r\n` after every
 * character spans 131,068 bytes) except JSON-escaped ones of a value made
 * mostly of control characters, which are masked within one read.
 */
const MAX_READ_CONTEXT_BYTES = 131_072;

/**
 * How much of a form the matcher's regular expression holds. A match of
 * these characters is checked against the rest of the form with string
 * comparison, so a secret of any length (a 32 KiB key) costs no more to
 * build or run than a short one.
 */
const ANCHOR = 64;

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** The characters of base64 that only the secret's bytes decide. */
const base64Cores = (bytes: Uint8Array) => {
  const cores: string[] = [];
  for (const shift of [0, 1, 2]) {
    const padded = new Uint8Array(shift + bytes.length);
    padded.set(bytes, shift);
    const encoded = Buffer.from(padded).toString("base64");
    const start = Math.ceil((8 * shift) / 6);
    const end = Math.floor((8 * padded.length) / 6);
    const core = encoded.slice(start, end);
    cores.push(core, core.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return cores;
};

/**
 * Every literal form a command prints a secret in: as written, JSON-escaped
 * once and nested (Claude Code's stream-json), URL-encoded, and base64. The
 * matcher also accepts any mix of percent-encoded and plain characters and
 * base64 wrapped across lines; these literal forms are what a fragment's
 * tail is compared with.
 */
export const secretForms = (secret: string): ReadonlyArray<string> => {
  const once = JSON.stringify(secret).slice(1, -1);
  const uri = encodeURIComponent(secret);
  const forms = [
    secret,
    once,
    JSON.stringify(once).slice(1, -1),
    uri,
    uri.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
    uri.replaceAll("%20", "+"),
    ...base64Cores(new TextEncoder().encode(secret)),
  ];
  return [...new Set(forms)].filter((form) => form.length >= 8);
};

/** The text a matcher reads: decoded text, or bytes as Latin-1. */
type Alphabet = (text: string) => string;
const asText: Alphabet = (text) => text;
const asLatin1: Alphabet = (text) => Buffer.from(text).toString("latin1");

/** A hex digit in either case. */
const hexDigit = (digit: string) =>
  /[A-F]/.test(digit) ? `[${digit}${digit.toLowerCase()}]` : digit;

const UNRESERVED = /^[A-Za-z0-9._~-]*$/;

/**
 * One character of a secret as any URL encoder prints it: as itself, or
 * percent-encoded in either case, and a space also as `+`. Unreserved
 * characters only as themselves.
 */
interface UrlCharacter {
  readonly plain: string;
  /** Its UTF-8 bytes in uppercase hex, two digits each. */
  readonly encoded?: string;
  readonly plus: boolean;
}

const urlCharacters = (secret: string, alphabet: Alphabet) =>
  [...secret].map((character): UrlCharacter => {
    if (UNRESERVED.test(character)) return { plain: character, plus: false };
    return {
      plain: alphabet(character),
      encoded: [...new TextEncoder().encode(character)]
        .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
        .join(""),
      plus: character === " ",
    };
  });

/** A regular expression for these characters, whichever an encoder left. */
const urlSource = (characters: ReadonlyArray<UrlCharacter>) =>
  characters
    .map(({ plain, encoded, plus }) =>
      encoded === undefined
        ? escapeRegExp(plain)
        : `(?:${escapeRegExp(plain)}|${(encoded.match(/../g) ?? [])
            .map((byte) => `%${[...byte].map(hexDigit).join("")}`)
            .join("")}${plus ? "|\\+" : ""})`,
    )
    .join("");

/**
 * Where the URL form of these characters that starts at `start` ends, or
 * -1; the same language as urlSource, without a regular expression.
 */
const urlEnd = (
  characters: ReadonlyArray<UrlCharacter>,
  text: string,
  start: number,
) => {
  // A literal `%` and an encoded character both begin with `%`, so a
  // position can be reached more than one way; keep each.
  let positions = [start];
  for (const { plain, encoded, plus } of characters) {
    const next = new Set<number>();
    for (const at of positions) {
      if (text.startsWith(plain, at)) next.add(at + plain.length);
      if (plus && text.charCodeAt(at) === 0x2b) next.add(at + 1);
      if (encoded !== undefined) {
        let offset = at;
        for (let digit = 0; digit < encoded.length; digit += 2) {
          if (
            text.charCodeAt(offset) !== 0x25 ||
            text.slice(offset + 1, offset + 3).toUpperCase() !==
              encoded.slice(digit, digit + 2)
          ) {
            offset = -1;
            break;
          }
          offset += 3;
        }
        if (offset >= 0) next.add(offset);
      }
    }
    if (next.size === 0) return -1;
    positions = [...next];
  }
  return Math.max(...positions);
};

/**
 * One form of a secret: what the scan's regular expression holds of it,
 * where a match that starts at an offset ends (-1 when none does), and the
 * most text it can span.
 */
interface Alternative {
  readonly source: string;
  readonly marker: string;
  /** The secret's size, so a longer secret is tried first. */
  readonly size: number;
  readonly endAt: (text: string, start: number) => number;
  readonly span: number;
  /** A base64 form, which the text may also hold wrapped across lines. */
  readonly base64?: boolean;
}

const literalAlternative = (
  form: string,
  marker: string,
  size: number,
): Alternative => ({
  source: escapeRegExp(form.slice(0, ANCHOR)),
  marker,
  size,
  endAt: (text, start) =>
    text.startsWith(form, start) ? start + form.length : -1,
  span: form.length,
});

/**
 * A line break that base64 output wraps at: one `\n` or `\r\n` that another
 * does not follow. Two in a row leave one behind, so base64 matches across
 * at most one break, as a wrapped form prints it.
 */
const WRAP = /\r?\n(?![\r\n])/g;

/**
 * Text without the line breaks base64 wraps at, and where each of its
 * characters is in the text.
 */
const unwrap = (text: string) => {
  // Without `\r` or a blank line every `\n` is such a break, and removing
  // them all, or finding the next, is several times faster.
  const everyNewline = !text.includes("\r") && !text.includes("\n\n");
  const unwrapped = everyNewline
    ? text.replaceAll("\n", "")
    : text.replace(WRAP, "");
  const wrap = new RegExp(WRAP);
  /** Where the next break at or after `from` is, and its length. */
  const nextBreak = (from: number): readonly [number, number] | undefined => {
    if (everyNewline) {
      const at = text.indexOf("\n", from);
      return at < 0 ? undefined : [at, 1];
    }
    wrap.lastIndex = from;
    const found = wrap.exec(text);
    return found === null ? undefined : [found.index, found[0].length];
  };
  // Each removed break's offset in `unwrapped` and how many characters were
  // removed up to it, found only as far as a match needs.
  const offsets: number[] = [];
  const removed: number[] = [];
  let cursor = 0;
  let total = 0;
  let done = unwrapped.length === text.length;
  const offsetOf = (index: number) => {
    while (!done && (offsets.at(-1) ?? -1) <= index) {
      const found = nextBreak(cursor);
      if (found === undefined) {
        done = true;
        break;
      }
      total += found[1];
      cursor = found[0] + found[1];
      offsets.push(cursor - total);
      removed.push(total);
    }
    let low = 0;
    let high = offsets.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((offsets[middle] ?? 0) <= index) low = middle + 1;
      else high = middle;
    }
    return index + (low === 0 ? 0 : (removed[low - 1] ?? 0));
  };
  return { unwrapped, offsetOf };
};

/**
 * A read's tail without its base64 line breaks: a cut between `\r` and
 * `\n` leaves a `\r` that the next read's `\n` completes.
 */
const unwrapTail = (text: string) =>
  unwrap(text.endsWith("\r") ? text.slice(0, -1) : text);

interface Match {
  readonly start: number;
  readonly end: number;
  readonly marker: string;
}

interface ScanMatch extends Match {
  readonly base64: boolean;
}

/**
 * Finds every form of the given alternatives in a text: one regular
 * expression scans for each form's first ANCHOR characters, longest secret
 * first, and string comparison checks the rest.
 */
const scannerFor = (alternatives: ReadonlyArray<Alternative>) => {
  const sorted = [...alternatives].sort(
    (left, right) => right.size - left.size,
  );
  const sources = [...new Set(sorted.map(({ source }) => source))];
  const pattern =
    sources.length === 0 ? undefined : new RegExp(sources.join("|"), "g");
  return (text: string): ScanMatch[] => {
    const found: ScanMatch[] = [];
    if (pattern === undefined) return found;
    pattern.lastIndex = 0;
    for (
      let match = pattern.exec(text);
      match !== null;
      match = pattern.exec(text)
    ) {
      const start = match.index;
      for (const alternative of sorted) {
        const end = alternative.endAt(text, start);
        if (end < 0) continue;
        found.push({
          start,
          end,
          marker: alternative.marker,
          base64: alternative.base64 === true,
        });
        break;
      }
      // Another secret may begin inside this one: look again from its
      // next character, so the two are masked together.
      pattern.lastIndex = start + 1;
    }
    return found;
  };
};

/**
 * Where the tail of a text, at or after `from`, could still begin one of
 * `forms` that more text would complete: the earliest offset whose rest is
 * a shorter start of a form; the text's length when none is. A rest longer
 * than ANCHOR must begin with a form's first ANCHOR characters, so one
 * regular expression finds those offsets.
 */
const tailPrefixFinder = (forms: ReadonlyArray<string>) => {
  const longest = Math.max(0, ...forms.map(({ length }) => length));
  const long = forms.filter(({ length }) => length > ANCHOR);
  const anchors =
    long.length === 0
      ? undefined
      : new RegExp(
          [
            ...new Set(long.map((form) => escapeRegExp(form.slice(0, ANCHOR)))),
          ].join("|"),
          "g",
        );
  const starts = new Set(forms.map((form) => form[0]));
  const begins = (rest: string) =>
    forms.some((form) => form.length > rest.length && form.startsWith(rest));
  return (text: string, from: number) => {
    const lowest = Math.max(from, text.length - longest + 1);
    const near = Math.max(lowest, text.length - ANCHOR + 1);
    if (anchors !== undefined && lowest < near) {
      anchors.lastIndex = lowest;
      for (
        let match = anchors.exec(text);
        match !== null && match.index < near;
        match = anchors.exec(text)
      ) {
        if (begins(text.slice(match.index))) return match.index;
        anchors.lastIndex = match.index + 1;
      }
    }
    for (let offset = near; offset < text.length; offset += 1)
      if (starts.has(text[offset]) && begins(text.slice(offset))) return offset;
    return text.length;
  };
};

/**
 * One alphabet's matcher. `values` are the hidden secrets, first name first;
 * `forms` their literal forms, longest first.
 */
const matcherFor = (
  values: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  forms: ReadonlyArray<EnvironmentSecret>,
  alphabet: Alphabet,
) => {
  const seen = new Set<string>();
  const plain: Alternative[] = [];
  const wrapped: Alternative[] = [];
  for (const { name, value } of values) {
    const marker = environmentSecretMarker(name);
    const size = Buffer.byteLength(value) * 6;
    const once = JSON.stringify(value).slice(1, -1);
    for (const form of [value, once, JSON.stringify(once).slice(1, -1)]) {
      const literal = alphabet(form);
      if (seen.has(literal)) continue;
      seen.add(literal);
      plain.push(literalAlternative(literal, marker, size));
    }
    if (!UNRESERVED.test(value)) {
      const characters = urlCharacters(value, alphabet);
      plain.push({
        source: urlSource(characters.slice(0, ANCHOR)),
        marker,
        size,
        endAt: (text, start) => urlEnd(characters, text, start),
        span: characters.reduce(
          (total, { plain: text, encoded }) =>
            total + Math.max(text.length, (encoded?.length ?? 0) * 1.5),
          0,
        ),
      });
    }
    // Base64 is matched in the text without its line breaks, so it may
    // wrap at any column.
    for (const core of new Set(base64Cores(new TextEncoder().encode(value)))) {
      const alternative = {
        ...literalAlternative(core, marker, size),
        base64: true,
      };
      plain.push(alternative);
      // With `\r\n` after every character.
      wrapped.push({ ...alternative, span: 3 * core.length - 2 });
    }
  }
  const scanPlain = scannerFor(plain);
  const scanWrapped = scannerFor(wrapped);
  const credentialPattern = new RegExp(
    CREDENTIALS.map(
      ({ prefixes, body, min, max }) =>
        `(${BOUNDARY}(?:${prefixes.join("|")})${body}{${min},${max}}(?!${body}))`,
    ).join("|"),
    "g",
  );
  const literals = forms.map(({ value }) => alphabet(value));
  const cores = [
    ...new Set(
      values.flatMap(({ value }) =>
        base64Cores(new TextEncoder().encode(value)).filter(
          (core) => core.length >= 8,
        ),
      ),
    ),
  ];
  const longestCore = Math.max(0, ...cores.map(({ length }) => length));
  const literalTail = tailPrefixFinder(literals);
  const coreTail = tailPrefixFinder(cores);
  /** The most text any form of a secret, or a credential, can span. */
  const span = Math.max(
    CREDENTIAL_SPAN,
    ...plain.map(({ span }) => span),
    ...wrapped.map(({ span }) => span),
  );
  const find = (text: string): Match[] => {
    const found: Array<Match & { readonly credential: boolean }> = [];
    const plainMatches = scanPlain(text);
    for (const { start, end, marker } of plainMatches)
      found.push({ start, end, marker, credential: false });
    if (wrapped.length > 0 && text.includes("\n")) {
      const { unwrapped, offsetOf } = unwrap(text);
      const unwrappedMatches = scanWrapped(unwrapped);
      // Base64 on one line is a match above as well; only when the text
      // without line breaks holds a match those do not are any wrapped.
      // Removing breaks never splits a match above, so each is also found
      // here, at its own place and in the same order. With as many matches
      // here, of the same lengths and markers in turn, each match here is
      // one of those, on one line, and none is wrapped. Anything else, even
      // a match above that another form won here, maps them all back.
      const inLine = plainMatches.filter(({ base64 }) => base64);
      const same =
        inLine.length === unwrappedMatches.length &&
        inLine.every(
          ({ start, end, marker }, index) =>
            end - start ===
              (unwrappedMatches[index]?.end ?? 0) -
                (unwrappedMatches[index]?.start ?? 0) &&
            marker === unwrappedMatches[index]?.marker,
        );
      if (!same)
        for (const { start, end, marker } of unwrappedMatches)
          found.push({
            start: offsetOf(start),
            end: offsetOf(end - 1) + 1,
            marker,
            credential: false,
          });
    }
    for (const match of text.matchAll(credentialPattern)) {
      const group = match.findIndex(
        (value, index) => index > 0 && value !== undefined,
      );
      found.push({
        start: match.index,
        end: match.index + match[0].length,
        marker: environmentSecretMarker(
          CREDENTIALS[group - 1]?.name ?? "SECRET",
        ),
        credential: true,
      });
    }
    found.sort(
      (left, right) =>
        left.start - right.start ||
        Number(left.credential) - Number(right.credential),
    );
    // Overlapping matches become one span that shows each secret's marker
    // once; where a saved secret and a credential overlap, the secret names
    // it.
    const spans: Array<{
      start: number;
      end: number;
      secrets: string[];
      credentials: string[];
    }> = [];
    for (const match of found) {
      const last = spans.at(-1);
      const span =
        last !== undefined && match.start < last.end
          ? last
          : {
              start: match.start,
              end: match.end,
              secrets: [],
              credentials: [],
            };
      if (span !== last) spans.push(span);
      span.end = Math.max(span.end, match.end);
      const markers = match.credential ? span.credentials : span.secrets;
      if (!markers.includes(match.marker)) markers.push(match.marker);
    }
    return spans.map(({ start, end, secrets, credentials }) => ({
      start,
      end,
      marker: (secrets.length > 0 ? secrets : credentials).join(""),
    }));
  };
  /** Whether `text` is the start of a longer literal form. */
  const beginsLonger = (text: string) => {
    if (
      literals.some(
        (value) => value.length > text.length && value.startsWith(text),
      )
    )
      return true;
    const { unwrapped } = unwrapTail(text);
    return cores.some(
      (core) => core.length > unwrapped.length && core.startsWith(unwrapped),
    );
  };
  /**
   * Where the tail of `text` from `from` on, without its base64 line
   * breaks, could still begin a base64 form; `limit` when it cannot before.
   */
  const wrappedPartialStart = (text: string, from: number, limit: number) => {
    // With `\r\n` after every character, the most a base64 form spans.
    const offset = Math.max(from, text.length - (3 * longestCore - 2));
    if (longestCore === 0 || offset >= limit) return limit;
    const { unwrapped, offsetOf } = unwrapTail(text.slice(offset));
    const index = coreTail(unwrapped, 0);
    return index === unwrapped.length
      ? limit
      : Math.min(limit, offset + offsetOf(index));
  };
  /**
   * Where a text's tail could still begin a secret that more text would
   * complete, at or after `from`; the text's length when it cannot.
   */
  const partialStart = (text: string, from: number) => {
    let found = literalTail(text, from);
    found = wrappedPartialStart(text, from, found);
    const tail = TOKEN_TAIL.exec(
      text.slice(Math.max(from, text.length - CREDENTIAL_SPAN)),
    );
    if (tail === null) return found;
    const start = text.length - tail[0].length;
    if (start >= found) return found;
    const run = tail[0];
    for (const [index, { prefixes, max }] of CREDENTIALS.entries())
      for (const prefix of prefixes)
        if (
          (run.length < prefix.length && prefix.startsWith(run)) ||
          (run.startsWith(prefix) &&
            run.length - prefix.length < max &&
            credentialBodies[index]?.test(run.slice(prefix.length)))
        )
          return start;
    return found;
  };
  /**
   * Where the text could stop being final: the start of a match that more
   * text could grow, into a longer secret it begins or more of a
   * credential's body; of a tail that could begin a secret; or of the match
   * such a tail begins inside, since another secret may overlap it.
   */
  const openStart = (text: string, matches: ReadonlyArray<Match>) => {
    const last = matches.at(-1);
    const open =
      last !== undefined &&
      (last.end === text.length || beginsLonger(text.slice(last.start)));
    const settled = open ? matches.at(-2) : last;
    const partial = partialStart(
      text,
      settled === undefined ? 0 : settled.start + 1,
    );
    const start =
      settled !== undefined && partial < settled.end ? settled.start : partial;
    return open ? Math.min(last.start, start) : start;
  };
  return { find, openStart, span };
};

/** Bytes as Latin-1, one character each. */
const latin1Of = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "latin1",
  );

/**
 * Where a UTF-8 character that `latin1` cuts off at its end begins; its
 * length when the last character is whole.
 */
const utf8Cut = (latin1: string) => {
  for (let back = 1; back <= Math.min(3, latin1.length); back += 1) {
    const byte = latin1.charCodeAt(latin1.length - back);
    if (byte < 0x80) break;
    if (byte < 0xc0) continue;
    const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return size > back ? latin1.length - back : latin1.length;
  }
  return latin1.length;
};

const replaceMatches = (
  text: string,
  matches: ReadonlyArray<Match>,
  from = 0,
) => {
  let output = "";
  let offset = from;
  for (const { start, end, marker } of matches) {
    if (end <= from) continue;
    output += text.slice(offset, Math.max(start, from)) + marker;
    offset = end;
  }
  return output + text.slice(offset);
};

export interface SecretMasker {
  /** Each saved secret's forms, longest first. */
  readonly secrets: ReadonlyArray<EnvironmentSecret>;
  /**
   * Every name and marker this masker shows; `credential` for dx's own
   * credentials, which no variable holds.
   */
  readonly markers: ReadonlyArray<{
    readonly name: string;
    readonly marker: string;
    readonly credential: boolean;
  }>;
  mask(text: string): string;
  maskBytes(bytes: Uint8Array): Uint8Array;
  /**
   * How much output a shell read sends before what it keeps, and the most
   * it holds back: READ_CONTEXT_BYTES, or the most bytes any form of a
   * saved secret spans when that is more, up to MAX_READ_CONTEXT_BYTES, so
   * a secret split between reads is masked whole.
   */
  readonly readContextBytes: number;
  /**
   * Masks one shell read of a running command's output. `before` is up to
   * readContextBytes of output just before `text`, read again so a secret
   * that began there is masked here too. `context` is how many bytes the
   * read asked for, its readContextBytes when it was sent, and the window it
   * decides what to hold from. With `heldBefore`, the read shows
   * the tail of `before` that the read before it held back. Unless `final`,
   * the read holds back its own tail where that could begin a secret or
   * ends inside a UTF-8 character, for the next read to show.
   */
  maskRead(
    before: Uint8Array,
    text: Uint8Array,
    options: {
      readonly heldBefore: boolean;
      readonly final: boolean;
      readonly context: number;
    },
  ): string;
  /**
   * Masks text that arrives in fragments, such as a streamed message. `held`
   * is the tail an earlier call kept back. Returns the masked text that is
   * final and the tail that could still begin a secret; with `final`, nothing
   * is held back.
   */
  maskFragment(
    held: string,
    fragment: string,
    final?: boolean,
  ): { readonly released: string; readonly held: string };
}

/**
 * A masker for the given secret values. Where values share a form, the
 * first given names it.
 */
export const secretMasker = (
  values: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): SecretMasker => {
  const names = new Map<string, string>();
  for (const { name, value } of values)
    for (const form of secretForms(value))
      if (!names.has(form)) names.set(form, name);
  const secrets: ReadonlyArray<EnvironmentSecret> = [...names]
    .map(([value, name]) => ({
      name,
      value,
      marker: environmentSecretMarker(name),
    }))
    .sort((left, right) => right.value.length - left.value.length);
  const text = matcherFor(values, secrets, asText);
  let bytes: ReturnType<typeof matcherFor> | undefined;
  const bytesMatcher = () => {
    bytes ??= matcherFor(values, secrets, asLatin1);
    return bytes;
  };
  const readContextBytes = () =>
    Math.min(
      MAX_READ_CONTEXT_BYTES,
      Math.max(READ_CONTEXT_BYTES, bytesMatcher().span),
    );
  const mask = (value: string) => replaceMatches(value, text.find(value));
  return {
    secrets,
    markers: [
      ...new Map(
        [
          ...secrets.map(({ name, marker }) => ({
            name,
            marker,
            credential: false,
          })),
          ...CREDENTIAL_MARKERS,
        ].map((entry) => [entry.marker, entry] as const),
      ).values(),
    ],
    mask,
    get readContextBytes() {
      return readContextBytes();
    },
    maskBytes: (input) => {
      const bytes = bytesMatcher();
      const latin1 = Buffer.from(
        input.buffer,
        input.byteOffset,
        input.byteLength,
      ).toString("latin1");
      const matches = bytes.find(latin1);
      if (matches.length === 0) return input;
      return new Uint8Array(
        Buffer.from(replaceMatches(latin1, matches), "latin1"),
      );
    },
    maskRead: (before, text, { heldBefore, final, context: windowSize }) => {
      const matcher = bytesMatcher();
      /**
       * How many bytes at the end of `output` a running read holds back.
       * It reads only the last `context` bytes, the bytes the next read
       * gets as its context, so both find the same tail.
       */
      const held = (output: string) => {
        const window = output.slice(-windowSize);
        const start = Math.min(
          matcher.openStart(window, matcher.find(window)),
          utf8Cut(window),
        );
        return window.length - start;
      };
      const context = latin1Of(before);
      const joined = context + latin1Of(text);
      const start = context.length - (heldBefore ? held(context) : 0);
      const end = Math.max(
        start,
        final ? joined.length : joined.length - held(joined),
      );
      // A read that skipped output may hold back from before what it kept,
      // a secret longer than a read among it: the next read shows it all.
      if (end === start) return "";
      let shown = "";
      let offset = start;
      for (const match of matcher.find(joined)) {
        if (match.end <= start) continue;
        if (match.start >= end) break;
        shown +=
          joined.slice(offset, Math.max(match.start, start)) + match.marker;
        offset = Math.min(match.end, end);
      }
      shown += joined.slice(offset, end);
      return new TextDecoder().decode(Buffer.from(shown, "latin1"));
    },
    maskFragment: (held, fragment, final = false) => {
      const value = held + fragment;
      if (final) return { released: mask(value), held: "" };
      const matches = text.find(value);
      const start = text.openStart(value, matches);
      return {
        released: replaceMatches(
          value.slice(0, start),
          matches.filter(({ end }) => end <= start),
        ),
        held: value.slice(start),
      };
    },
  };
};
