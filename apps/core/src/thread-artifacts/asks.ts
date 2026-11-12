/**
 * Asks: checklist items in an artifact that mention people, such as
 * `- [ ] @[Ada](user:usr_1) Approve merging #1240`. An unchecked one waits on
 * the people it mentions; a person ticking it, or writing under it, answers
 * it. The grammar matches the web editor's chips (`features/artifacts/
 * markdown/chips.ts`): `@[Name](user:ID)` for people and `@[dx](agent)`.
 */

export interface ArtifactChecklistItem {
  /** 1-based line of the item's marker. */
  readonly line: number;
  readonly checked: boolean;
  /** The item's first line after its checkbox, trimmed. */
  readonly text: string;
  /** Which occurrence of `text` this is, from 0, so repeats stay apart. */
  readonly occurrence: number;
  /** User IDs the item's text mentions, in order, without repeats. */
  readonly mentions: ReadonlyArray<string>;
  readonly mentionsAgent: boolean;
  /** The lines nested under the item, joined: where a person answers it. */
  readonly body: string;
}

const ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+\[( |x|X)\]\s?(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const PERSON = /@\[[^\]\n]+\]\(user:([A-Za-z0-9_-]+)\)/g;
const AGENT = /@\[[^\]\n]+\]\(agent\)/;
const ITEM_TEXT_LIMIT = 500;

const indentOf = (line: string) => /^\s*/.exec(line)?.[0].length ?? 0;

/** Every checklist item outside code fences, in document order. */
export const checklistItems = (
  markdown: string,
): ReadonlyArray<ArtifactChecklistItem> => {
  const lines = markdown.split(/\r\n|\r|\n/);
  const items: ArtifactChecklistItem[] = [];
  const seen = new Map<string, number>();
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const opener = FENCE.exec(line)?.[1];
    if (opener !== undefined) {
      if (fence === undefined) fence = opener;
      else if (opener[0] === fence[0] && opener.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const match = ITEM.exec(line);
    if (match === null) continue;
    const indent = match[1]?.length ?? 0;
    const text = (match[3] ?? "").trim().slice(0, ITEM_TEXT_LIMIT);
    const occurrence = seen.get(text) ?? 0;
    seen.set(text, occurrence + 1);
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const child = lines[next] ?? "";
      if (child.trim() !== "" && indentOf(child) <= indent) break;
      body.push(child);
    }
    items.push({
      line: index + 1,
      checked: match[2] !== " ",
      text,
      occurrence,
      mentions: [
        ...new Set([...text.matchAll(PERSON)].map((found) => found[1] ?? "")),
      ].filter((id) => id !== ""),
      mentionsAgent: AGENT.test(text),
      body: body.join("\n").trim(),
    });
  }
  return items;
};

/** Open asks: unchecked items that mention a person. */
export const openAsks = (markdown: string) =>
  checklistItems(markdown).filter(
    (item) => !item.checked && item.mentions.length > 0,
  );

const mentionsIn = (markdown: string) => {
  const found = new Set<string>();
  let fence: string | undefined;
  for (const line of markdown.split(/\r\n|\r|\n/)) {
    const opener = FENCE.exec(line)?.[1];
    if (opener !== undefined) {
      if (fence === undefined) fence = opener;
      else if (opener[0] === fence[0] && opener.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    for (const match of line.matchAll(PERSON))
      if (match[1] !== undefined) found.add(match[1]);
  }
  return found;
};

/** People mentioned anywhere in `after` who were not in `before`. */
export const newMentions = (before: string, after: string) => {
  const had = mentionsIn(before);
  return [...mentionsIn(after)].filter((id) => !had.has(id));
};
