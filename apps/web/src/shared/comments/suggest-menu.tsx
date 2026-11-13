import {
  AppWindow,
  Bot,
  Calendar,
  Clock,
  FolderGit2,
  Heading1,
  Heading2,
  Heading3,
  Image,
  List,
  ListChecks,
  ListOrdered,
  type LucideIcon,
  Minus,
  SquareChevronDown,
  SquareCode,
  Table,
  TextQuote,
  ToggleLeft,
  Type,
  Users,
} from "lucide-react";
import { Fragment } from "react";
import { ShortcutKeycaps } from "../commands/shortcut-keycaps.js";
import { Avatar } from "../ui/avatar.js";
import "./comments.css";

/** One row of the open menu, as it shows. */
export interface SuggestMenuRow {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** The `/` menu's heading the row sits under. */
  readonly group?: string;
  readonly shortcut?: string;
  /** A person's picture; a person has a `userId`, and dx has none. */
  readonly userId?: string;
  readonly image?: string;
}

/** The open `/` (blocks) or `@` (people) menu. */
export interface SuggestMenuState {
  readonly kind: "slash" | "mention";
  readonly items: ReadonlyArray<SuggestMenuRow>;
  readonly active: number;
  /**
   * In the page's coordinates: the menu's top edge under the trigger, or,
   * when it opens `above` (no room below), its bottom edge over the trigger.
   */
  readonly top: number;
  readonly left: number;
  readonly above: boolean;
  /** The room it has, so it scrolls instead of leaving the editor. */
  readonly maxHeight: number;
}

const ICONS: Readonly<Record<string, LucideIcon>> = {
  paragraph: Type,
  heading1: Heading1,
  heading2: Heading2,
  heading3: Heading3,
  quote: TextQuote,
  code: SquareCode,
  divider: Minus,
  checklist: ListChecks,
  bullet: List,
  ordered: ListOrdered,
  image: Image,
  table: Table,
  view: AppWindow,
  date: Calendar,
  time: Clock,
  dropdown: SquareChevronDown,
  toggle: ToggleLeft,
  project: FolderGit2,
};

/**
 * Keeps the active row in the list's view; the first row of a group brings
 * its heading along.
 */
const reveal = (row: HTMLElement | null) => {
  const list = row?.closest<HTMLElement>(".artifact-suggest");
  if (row === null || list === null || list === undefined) return;
  const heading = row.previousElementSibling;
  const top =
    heading instanceof HTMLElement && heading.role === "presentation"
      ? heading.offsetTop
      : row.offsetTop;
  const bottom = row.offsetTop + row.offsetHeight;
  if (top < list.scrollTop + 4) list.scrollTop = top - 4;
  else if (bottom > list.scrollTop + list.clientHeight - 4)
    list.scrollTop = bottom - list.clientHeight + 4;
};

function Lead({ row }: { readonly row: SuggestMenuRow }) {
  if (row.group !== undefined) {
    const Icon = ICONS[row.id] ?? Type;
    return <Icon aria-hidden="true" />;
  }
  if (row.userId === undefined)
    return (
      <span className="dx-avatar composer-mention-agent" aria-hidden="true">
        {row.id === "here" ? <Users /> : <Bot />}
      </span>
    );
  return <Avatar name={row.label} image={row.image} seed={row.userId} />;
}

/**
 * The open `/` or `@` menu, by what was typed, styled as dx's other menus:
 * a leading icon or avatar, the label, and the Markdown shortcut or
 * @username. The editor keeps the focus, so typing goes on filtering;
 * arrows and Enter pick there, and a click or tap picks here.
 */
export function SuggestMenu({
  menu,
  onPick,
  onHighlight,
}: {
  readonly menu: SuggestMenuState | undefined;
  readonly onPick: (index: number) => void;
  readonly onHighlight: (index: number) => void;
}) {
  if (menu === undefined) return null;
  const option = (row: SuggestMenuRow, index: number) => (
    <button
      key={row.id}
      ref={index === menu.active ? reveal : undefined}
      type="button"
      role="option"
      aria-selected={index === menu.active}
      data-highlighted={index === menu.active ? "" : undefined}
      className="dx-menu-item artifact-suggest-option"
      // Keep the caret in the document while choosing.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => onHighlight(index)}
      onClick={() => onPick(index)}
    >
      <Lead row={row} />
      <span className="artifact-suggest-text">
        <span className="artifact-suggest-label">{row.label}</span>
        {row.hint === undefined ? null : (
          <span className="artifact-suggest-hint">{row.hint}</span>
        )}
      </span>
      {row.shortcut === undefined ? null : (
        <ShortcutKeycaps keycaps={[row.shortcut]} />
      )}
    </button>
  );
  const groups: Array<{
    readonly name: string | undefined;
    readonly rows: Array<readonly [SuggestMenuRow, number]>;
  }> = [];
  menu.items.forEach((row, index) => {
    const last = groups.at(-1);
    if (last !== undefined && last.name === row.group)
      last.rows.push([row, index]);
    else groups.push({ name: row.group, rows: [[row, index]] });
  });
  return (
    <div
      className="dx-menu artifact-suggest"
      role="listbox"
      aria-label={menu.kind === "slash" ? "Insert a block" : "Mention someone"}
      data-above={menu.above ? "" : undefined}
      style={{ top: menu.top, left: menu.left, maxHeight: menu.maxHeight }}
    >
      {menu.items.length === 0 ? (
        <p className="artifact-suggest-empty">
          {menu.kind === "slash" ? "No blocks match." : "No one matches."}
        </p>
      ) : (
        groups.map((group) =>
          group.name === undefined ? (
            group.rows.map(([row, index]) => option(row, index))
          ) : (
            <Fragment key={group.name}>
              <div role="presentation" className="artifact-folder-label">
                {group.name}
              </div>
              {group.rows.map(([row, index]) => option(row, index))}
            </Fragment>
          ),
        )
      )}
    </div>
  );
}
