import type { MailFolder } from "@dx/api";
import type { MailListView } from "./mailbox-cache-queries.js";

/** The Mail's place, as its URL names it. */
export interface MailboxSearch {
  readonly folder?: MailFolder;
  readonly label?: string;
  readonly tag?: string;
  readonly q?: string;
  readonly conversation?: string;
}

export type MailboxNavigate = (
  next: MailboxSearch,
  options?: { readonly replace?: boolean },
) => void;

/** The list a place shows: a label or `+tag` wins over the folder. */
export const listViewOf = (search: MailboxSearch): MailListView =>
  search.label !== undefined
    ? { label: search.label, q: search.q }
    : search.tag !== undefined
      ? { tag: search.tag, q: search.q }
      : { folder: search.folder ?? "inbox", q: search.q };

/** The place's own link, so rows and folders open in a new tab too. */
export const mailboxHref = (search: MailboxSearch) => {
  const params = new URLSearchParams();
  if (search.folder !== undefined && search.folder !== "inbox")
    params.set("folder", search.folder);
  if (search.label !== undefined) params.set("label", search.label);
  if (search.tag !== undefined) params.set("tag", search.tag);
  if (search.q !== undefined && search.q !== "") params.set("q", search.q);
  if (search.conversation !== undefined)
    params.set("conversation", search.conversation);
  const query = params.toString();
  return query === "" ? "/mailbox" : `/mailbox?${query}`;
};

/** A plain click navigates in place; a modified one opens a new tab. */
export const isPlainClick = (event: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

export const FOLDER_NAMES: Readonly<Record<MailFolder, string>> = {
  inbox: "Inbox",
  sent: "Sent",
  archive: "Archive",
  spam: "Spam",
};
