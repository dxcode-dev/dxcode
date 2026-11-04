/**
 * What the `/` menu offers (blocks, then chips) and whom `@` lists (dx, then
 * the Thread's people), filtered by what follows the trigger.
 */
import type { ThreadMemberData } from "@dx/api";
import type { BlockKind } from "./block-commands.js";
import type { SuggestItem } from "./suggestions.js";

type ChipKind = "date" | "time" | "dropdown" | "toggle";

/** The `/` menu's groups, in the order it shows them. */
export const SLASH_GROUPS = [
  "Basic blocks",
  "Lists",
  "Media and views",
  "Chips",
] as const;
export type SlashGroup = (typeof SLASH_GROUPS)[number];

export interface SlashItem extends SuggestItem {
  readonly group: SlashGroup;
  /** The Markdown typed at a line's start that makes the same block. */
  readonly shortcut?: string;
  readonly action:
    | { readonly kind: "block"; readonly block: BlockKind }
    | { readonly kind: "chip"; readonly chip: ChipKind }
    | { readonly kind: "image" };
  readonly keywords: ReadonlyArray<string>;
}

const block = (
  group: SlashGroup,
  id: BlockKind,
  label: string,
  shortcut: string | undefined,
  keywords: ReadonlyArray<string>,
): SlashItem => ({
  id,
  label,
  group,
  ...(shortcut === undefined ? {} : { shortcut }),
  keywords,
  action: { kind: "block", block: id },
});

const chip = (
  id: ChipKind,
  label: string,
  keywords: ReadonlyArray<string>,
): SlashItem => ({
  id,
  label,
  group: "Chips",
  keywords,
  action: { kind: "chip", chip: id },
});

export const SLASH_ITEMS: ReadonlyArray<SlashItem> = [
  block("Basic blocks", "paragraph", "Text", undefined, ["paragraph", "p"]),
  block("Basic blocks", "heading1", "Heading 1", "#", ["h1", "title"]),
  block("Basic blocks", "heading2", "Heading 2", "##", ["h2"]),
  block("Basic blocks", "heading3", "Heading 3", "###", ["h3"]),
  block("Basic blocks", "quote", "Quote", ">", ["blockquote"]),
  block("Basic blocks", "code", "Code", "```", ["fence", "snippet"]),
  block("Basic blocks", "divider", "Divider", "---", ["hr", "rule", "line"]),
  block("Lists", "checklist", "Checklist", "[ ]", ["todo", "task", "check"]),
  block("Lists", "bullet", "Bulleted list", "-", ["ul", "list", "bullet"]),
  block("Lists", "ordered", "Numbered list", "1.", ["ol", "number"]),
  {
    id: "image",
    label: "Image",
    group: "Media and views",
    keywords: ["picture", "photo", "upload", "img"],
    action: { kind: "image" },
  },
  block("Media and views", "table", "Table", undefined, ["grid"]),
  block("Media and views", "view", "View", undefined, [
    "dx-view",
    "html",
    "chart",
  ]),
  chip("date", "Date", ["day", "due"]),
  chip("time", "Time", ["clock"]),
  chip("dropdown", "Dropdown", ["status", "select"]),
  chip("toggle", "Toggle", ["switch"]),
];

/** Whether `query` starts any word of `text`, ignoring case. */
const startsAWord = (text: string, query: string) =>
  text
    .toLowerCase()
    .split(/[\s_-]+/)
    .some((word) => word.startsWith(query));

/**
 * The `/` items for `query`, in their groups' order; in each group, labels
 * starting with it come before the rest that match.
 */
export const slashItems = (query: string): ReadonlyArray<SlashItem> => {
  const wanted = query.toLowerCase();
  if (wanted === "") return SLASH_ITEMS;
  const matches = SLASH_ITEMS.filter(
    (item) =>
      startsAWord(item.label, wanted) ||
      item.keywords.some((keyword) => keyword.startsWith(wanted)),
  );
  const leads = (item: SlashItem) =>
    item.label.toLowerCase().startsWith(wanted);
  return SLASH_GROUPS.flatMap((group) => {
    const inGroup = matches.filter((item) => item.group === group);
    return [
      ...inGroup.filter(leads),
      ...inGroup.filter((item) => !leads(item)),
    ];
  });
};

export interface PersonItem extends SuggestItem {
  /** Absent for the agent. */
  readonly userId?: string;
  readonly image?: string;
}

/**
 * Whom `@query` can mention: dx, then the Thread's people (its owner and its
 * members while it is shared) other than you, by name or username.
 */
export const peopleItems = (
  query: string,
  members: ReadonlyArray<ThreadMemberData>,
  viewerId: string,
): ReadonlyArray<PersonItem> => {
  const wanted = query.toLowerCase();
  const agent: PersonItem = { id: "agent", label: "dx", hint: "the agent" };
  return [
    ...(startsAWord("dx agent", wanted) ? [agent] : []),
    ...members.flatMap((member) =>
      member.userId !== viewerId &&
      (startsAWord(member.name, wanted) ||
        member.handle.toLowerCase().startsWith(wanted))
        ? [
            {
              id: member.userId,
              label: member.name,
              hint: `@${member.handle}`,
              userId: member.userId,
              ...(member.image === undefined ? {} : { image: member.image }),
            },
          ]
        : [],
    ),
  ].slice(0, 8);
};
