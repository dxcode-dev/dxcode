/**
 * A unified line diff for the owner's confirm card: what a change replaces,
 * with three lines of context. Text past the size the card can show is
 * diffed by its first lines only, and says so.
 */

const CONTEXT = 3;
/** Lines each side: the diff is quadratic in them. */
const MAX_LINES = 2_500;

const split = (text: string) =>
  text === ""
    ? []
    : text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");

type Op = { readonly kind: " " | "-" | "+"; readonly line: string };

/** The edit script from a longest-common-subsequence table. */
const script = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): Op[] => {
  // Shared head and tail are cheap to take out before the table.
  let head = 0;
  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  )
    head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
  const ops: Op[] = before.slice(0, head).map((line) => ({ kind: " ", line }));
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] ?? "" });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j >= b.length ||
        (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))
    ) {
      // A removal comes before the insertion that replaces it.
      ops.push({ kind: "-", line: a[i] ?? "" });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] ?? "" });
      j++;
    }
  }
  for (const line of before.slice(before.length - tail))
    ops.push({ kind: " ", line });
  return ops;
};

/**
 * `before` to `after` as unified diff hunks, or undefined when they are the
 * same text.
 */
export const unifiedDiff = (before: string, after: string) => {
  if (before === after) return undefined;
  const allBefore = split(before);
  const allAfter = split(after);
  const cut =
    allBefore.length > MAX_LINES || allAfter.length > MAX_LINES
      ? `\n… diff of the first ${MAX_LINES} lines only`
      : "";
  const ops = script(
    allBefore.slice(0, MAX_LINES),
    allAfter.slice(0, MAX_LINES),
  );
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (changed.length === 0) return cut === "" ? undefined : cut.trim();
  const hunks: string[] = [];
  let start = 0;
  while (start < changed.length) {
    let end = start;
    while (
      end + 1 < changed.length &&
      (changed[end + 1] ?? 0) - (changed[end] ?? 0) <= CONTEXT * 2 + 1
    )
      end++;
    const from = Math.max(0, (changed[start] ?? 0) - CONTEXT);
    const to = Math.min(ops.length, (changed[end] ?? 0) + CONTEXT + 1);
    let oldLine = 1;
    let newLine = 1;
    for (const op of ops.slice(0, from)) {
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
    }
    const body = ops.slice(from, to);
    const oldCount = body.filter(({ kind }) => kind !== "+").length;
    const newCount = body.filter(({ kind }) => kind !== "-").length;
    hunks.push(
      `@@ -${oldLine},${oldCount} +${newLine},${newCount} @@\n${body
        .map(({ kind, line }) => `${kind}${line}`)
        .join("\n")}`,
    );
    start = end + 1;
  }
  return `${hunks.join("\n")}${cut}`;
};
