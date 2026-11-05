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
 * The output a shell read sends before what it keeps, and the most a read
 * holds back. A read decides what to hold from only its last this many
 * bytes, so the next read, given the same bytes as its context, finds the
 * same held tail and shows it.
 */
export const READ_CONTEXT_BYTES = 4_096;

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

/**
 * The secret with each character as itself or percent-encoded, in either
 * case, and a space also as `+`: what any URL encoder prints, whichever
 * characters it leaves alone.
 */
const urlSource = (secret: string, alphabet: Alphabet) =>
  [...secret]
    .map((character) => {
      if (/[A-Za-z0-9._~-]/.test(character)) return escapeRegExp(character);
      const encoded = [...new TextEncoder().encode(character)]
        .map(
          (byte) =>
            `%${[...byte.toString(16).toUpperCase().padStart(2, "0")].map(hexDigit).join("")}`,
        )
        .join("");
      return `(?:${escapeRegExp(alphabet(character))}|${encoded}${character === " " ? "|\\+" : ""})`;
    })
    .join("");

/** Base64 as `base64` and `openssl` print it, wrapped at any column. */
const wrappedSource = (core: string) =>
  [...core].map(escapeRegExp).join("(?:\\r?\\n)?");

/** Each regular expression that matches a form of the secret. */
const secretSources = (secret: string, alphabet: Alphabet) => {
  const once = JSON.stringify(secret).slice(1, -1);
  const sources = [
    escapeRegExp(alphabet(secret)),
    escapeRegExp(alphabet(once)),
    escapeRegExp(alphabet(JSON.stringify(once).slice(1, -1))),
    ...(/^[A-Za-z0-9._~-]*$/.test(secret) ? [] : [urlSource(secret, alphabet)]),
    ...base64Cores(new TextEncoder().encode(secret)).map(wrappedSource),
  ];
  return [...new Set(sources)];
};

interface Match {
  readonly start: number;
  readonly end: number;
  readonly marker: string;
}

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
  const alternatives: Array<{ source: string; marker: string; size: number }> =
    [];
  for (const { name, value } of values)
    for (const source of secretSources(value, alphabet)) {
      if (seen.has(source)) continue;
      seen.add(source);
      alternatives.push({
        source,
        marker: environmentSecretMarker(name),
        // The longest text it can match, so a longer secret is tried first.
        size: Buffer.byteLength(value) * 6,
      });
    }
  alternatives.sort((left, right) => right.size - left.size);
  // Two passes: V8 matches the secrets' forms and the credential shapes
  // several times faster apart than in one alternation.
  const secretPattern =
    alternatives.length === 0
      ? undefined
      : new RegExp(alternatives.map(({ source }) => source).join("|"), "g");
  /** Each form's own anchored pattern, to name the secret a match is. */
  let anchored: ReadonlyArray<RegExp> | undefined;
  const markerOf = (matched: string) => {
    anchored ??= alternatives.map(
      ({ source }) => new RegExp(`^(?:${source})$`),
    );
    const index = anchored.findIndex((pattern) => pattern.test(matched));
    return alternatives[index]?.marker ?? environmentSecretMarker("SECRET");
  };
  const credentialPattern = new RegExp(
    CREDENTIALS.map(
      ({ prefixes, body, min, max }) =>
        `(${BOUNDARY}(?:${prefixes.join("|")})${body}{${min},${max}}(?!${body}))`,
    ).join("|"),
    "g",
  );
  const literals = forms.map((form) => ({
    ...form,
    value: alphabet(form.value),
  }));
  const longest = Math.max(0, ...literals.map(({ value }) => value.length));
  const find = (text: string): Match[] => {
    const found: Array<Match & { readonly credential: boolean }> = [];
    if (secretPattern !== undefined) {
      secretPattern.lastIndex = 0;
      for (
        let match = secretPattern.exec(text);
        match !== null;
        match = secretPattern.exec(text)
      ) {
        found.push({
          start: match.index,
          end: match.index + match[0].length,
          marker: markerOf(match[0]),
          credential: false,
        });
        // Another secret may begin inside this one: look again from its
        // next character, so the two are masked together.
        secretPattern.lastIndex = match.index + 1;
      }
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
  const beginsLonger = (text: string) =>
    literals.some(
      ({ value }) => value.length > text.length && value.startsWith(text),
    );
  /**
   * Where a text's tail could still begin a secret that more text would
   * complete, at or after `from`; the text's length when it cannot.
   */
  const partialStart = (text: string, from: number) => {
    let found = text.length;
    for (
      let offset = Math.max(from, text.length - longest + 1);
      offset < text.length;
      offset += 1
    ) {
      const rest = text.slice(offset);
      if (
        literals.some(
          ({ value }) => value.length > rest.length && value.startsWith(rest),
        )
      ) {
        found = offset;
        break;
      }
    }
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
  return { find, openStart };
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
   * Masks one shell read of a running command's output. `before` is up to
   * READ_CONTEXT_BYTES of output just before `text`, read again so a secret
   * that began there is masked here too. With `heldBefore`, the read shows
   * the tail of `before` that the read before it held back. Unless `final`,
   * the read holds back its own tail where that could begin a secret or
   * ends inside a UTF-8 character, for the next read to show.
   */
  maskRead(
    before: Uint8Array,
    text: Uint8Array,
    options: { readonly heldBefore: boolean; readonly final: boolean },
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
    maskBytes: (input) => {
      bytes ??= matcherFor(values, secrets, asLatin1);
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
    maskRead: (before, text, { heldBefore, final }) => {
      bytes ??= matcherFor(values, secrets, asLatin1);
      const matcher = bytes;
      /**
       * How many bytes at the end of `output` a running read holds back.
       * It reads only the last READ_CONTEXT_BYTES, the bytes the next read
       * gets as its context, so both find the same tail.
       */
      const held = (output: string) => {
        const window = output.slice(-READ_CONTEXT_BYTES);
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
