import type { MailFolder } from "@dx/api";
import type { UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Which conversations a list shows: one folder, a label, or a project's
 * `+tag`, optionally narrowed by a search.
 */
export interface MailListView {
  readonly folder?: MailFolder;
  readonly label?: string;
  readonly tag?: string;
  readonly q?: string;
}

/**
 * Mail query keys and their invalidation, apart from the requests
 * (mailbox-queries.ts), so the realtime client refreshes the Mail without
 * loading the mail schemas.
 */
export const mailboxKeys = {
  all: (userId: UserId) => ["mailbox", userId] as const,
  summary: (userId: UserId) => [...mailboxKeys.all(userId), "summary"] as const,
  lists: (userId: UserId) => [...mailboxKeys.all(userId), "list"] as const,
  list: (userId: UserId, view: MailListView) =>
    [
      ...mailboxKeys.lists(userId),
      view.folder ?? "",
      view.label ?? "",
      view.tag ?? "",
      view.q ?? "",
    ] as const,
  conversations: (userId: UserId) =>
    [...mailboxKeys.all(userId), "conversation"] as const,
  conversation: (userId: UserId, key: string) =>
    [...mailboxKeys.conversations(userId), key] as const,
};

/** `mailbox.invalidated`: mail arrived or changed; refetch what is shown. */
export const invalidateMailbox = (client: QueryClient, userId: UserId) =>
  client.invalidateQueries(
    { queryKey: mailboxKeys.all(userId) },
    { cancelRefetch: false },
  );
