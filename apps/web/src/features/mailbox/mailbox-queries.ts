import {
  GetMailboxResponseSchema,
  GetMailConversationResponseSchema,
  ListMailConversationsResponseSchema,
  type MailboxData,
  type MailConversation,
  type MailConversationSummary,
  MailErrorResponseSchema,
  type MailFolder,
  type MailItemLabelSchema,
  MailLabelResponseSchema,
  type SendMailRequest,
  SendMailResponseSchema,
  type UpdateMailboxSettingsRequestSchema,
  type UpdateMailConversationRequest,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  type InfiniteData,
  infiniteQueryOptions,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { Schema } from "effect";
import { ApiError, request } from "../../shared/api/client.js";
import { updatePersonalAccountMutationOptions } from "../settings/account/personal-account-queries.js";
import { type MailListView, mailboxKeys } from "./mailbox-cache-queries.js";

export type { MailListView } from "./mailbox-cache-queries.js";
export { mailboxKeys } from "./mailbox-cache-queries.js";

export type EnabledMailbox = Extract<MailboxData, { readonly enabled: true }>;
type MailItemLabel = typeof MailItemLabelSchema.Type;
type ConversationPage = {
  readonly conversations: ReadonlyArray<MailConversationSummary>;
  readonly nextCursor?: string;
};

/** A change answered with no data the page reads; it refetches instead. */
const AcknowledgedSchema = Schema.Struct({
  status: Schema.Literal("success"),
});

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

const conversationPath = (key: string) =>
  `/v1/mailbox/conversations/${encodeURIComponent(key)}`;

/** The error the API explained in words, or a fallback. */
export const mailErrorMessage = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.hasValidatedPayload
    ? error.message
    : fallback;

export const isMissingMail = (error: unknown) =>
  error instanceof ApiError && error.status === 404;

/**
 * The person's Mail: their address, unread counts, labels, `+tag`
 * addresses, and limits; `enabled: false` where the deployment has no mail
 * domain. The sidebar's unread count reads it too.
 */
export const mailboxQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: mailboxKeys.summary(userId),
    queryFn: async ({ signal }): Promise<MailboxData> =>
      (
        await request(
          "/v1/mailbox",
          GetMailboxResponseSchema,
          { signal },
          MailErrorResponseSchema,
        )
      ).data,
    staleTime: 30_000,
    // The realtime event refetches at once; this is the fallback while the
    // socket is down.
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

const listSearch = (view: MailListView, before: string | undefined) => {
  const search = new URLSearchParams();
  if (view.label !== undefined) search.set("label", view.label);
  else if (view.tag !== undefined) search.set("tag", view.tag);
  else search.set("folder", view.folder ?? "inbox");
  if (view.q !== undefined && view.q !== "") search.set("q", view.q);
  if (before !== undefined) search.set("before", before);
  return search.toString();
};

/** One list of conversations, newest first, a page at a time. */
export const mailConversationsQueryOptions = (
  userId: UserId,
  view: MailListView,
) =>
  infiniteQueryOptions({
    queryKey: mailboxKeys.list(userId, view),
    queryFn: async ({ signal, pageParam }): Promise<ConversationPage> =>
      (
        await request(
          `/v1/mailbox/conversations?${listSearch(view, pageParam)}`,
          ListMailConversationsResponseSchema,
          { signal },
          MailErrorResponseSchema,
        )
      ).data,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 30_000,
    retry: 1,
  });

/** One conversation opened: every email in it, oldest first. */
export const mailConversationQueryOptions = (userId: UserId, key: string) =>
  queryOptions({
    queryKey: mailboxKeys.conversation(userId, key),
    queryFn: async ({ signal }): Promise<MailConversation> =>
      (
        await request(
          conversationPath(key),
          GetMailConversationResponseSchema,
          { signal },
          MailErrorResponseSchema,
        )
      ).data,
    staleTime: 30_000,
    retry: (count, error) => !isMissingMail(error) && count < 2,
  });

/** Where a downloaded attachment comes from. */
export const mailAttachmentUrl = (mailId: string, index: number) =>
  `/v1/mailbox/messages/${encodeURIComponent(mailId)}/attachments/${index}`;

const labelNames = (client: QueryClient, userId: UserId) => {
  const mailbox = client.getQueryData<MailboxData>(mailboxKeys.summary(userId));
  return new Map(
    (mailbox?.enabled === true ? mailbox.labels : []).map((label) => [
      label.id,
      label,
    ]),
  );
};

const changedLabels = (
  labels: ReadonlyArray<MailItemLabel>,
  change: UpdateMailConversationRequest,
  names: ReturnType<typeof labelNames>,
): ReadonlyArray<MailItemLabel> => {
  const removed = new Set(change.removeLabels ?? []);
  const kept = labels.filter((label) => !removed.has(label.id));
  const added = (change.addLabels ?? []).flatMap((id) => {
    const label = names.get(id);
    return label === undefined || kept.some((item) => item.id === id)
      ? []
      : [{ id, name: label.name, automatic: false }];
  });
  return [...kept, ...added];
};

/** Whether a conversation still belongs in a list after it moved. */
const stillListed = (
  listKey: ReadonlyArray<unknown>,
  folder: MailFolder | undefined,
) => {
  if (folder === undefined) return true;
  const [, , , listFolder] = listKey;
  // A label or project list spans folders, except Spam.
  if (listFolder === "") return folder !== "spam";
  return listFolder === folder;
};

/**
 * Changes a whole conversation: read, folder, private, labels. The lists and
 * the open conversation show it at once and roll back if it fails.
 */
export const updateMailConversationMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...mailboxKeys.all(userId), "update-conversation"],
    mutationFn: async ({
      key,
      change,
    }: {
      readonly key: string;
      readonly change: UpdateMailConversationRequest;
    }) => {
      await request(
        conversationPath(key),
        AcknowledgedSchema,
        json("PATCH", change),
        MailErrorResponseSchema,
      );
    },
    onMutate: async ({ key, change }) => {
      await client.cancelQueries({ queryKey: mailboxKeys.lists(userId) });
      await client.cancelQueries({
        queryKey: mailboxKeys.conversation(userId, key),
      });
      const names = labelNames(client, userId);
      const lists = client.getQueriesData<InfiniteData<ConversationPage>>({
        queryKey: mailboxKeys.lists(userId),
      });
      const conversation = client.getQueryData<MailConversation>(
        mailboxKeys.conversation(userId, key),
      );
      for (const [listKey, data] of lists) {
        if (data === undefined) continue;
        const keep = stillListed(listKey, change.folder);
        client.setQueryData<InfiniteData<ConversationPage>>(listKey, {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            conversations: page.conversations.flatMap((item) =>
              item.key !== key
                ? [item]
                : keep
                  ? [
                      {
                        ...item,
                        ...(change.read === undefined
                          ? {}
                          : { unread: !change.read }),
                        ...(change.private === undefined
                          ? {}
                          : { private: change.private }),
                        labels: changedLabels(item.labels, change, names),
                      },
                    ]
                  : [],
            ),
          })),
        });
      }
      if (conversation !== undefined)
        client.setQueryData<MailConversation>(
          mailboxKeys.conversation(userId, key),
          {
            ...conversation,
            messages: conversation.messages.map((message) => ({
              ...message,
              ...(change.read === undefined ? {} : { read: change.read }),
              ...(change.private === undefined
                ? {}
                : { private: change.private }),
              ...(change.folder === undefined || message.direction === "out"
                ? {}
                : { folder: change.folder }),
              labels: changedLabels(message.labels, change, names),
            })),
          },
        );
      return { lists, conversation };
    },
    onError: (_error, { key }, context) => {
      for (const [listKey, data] of context?.lists ?? [])
        client.setQueryData(listKey, data);
      if (context?.conversation !== undefined)
        client.setQueryData(
          mailboxKeys.conversation(userId, key),
          context.conversation,
        );
    },
    onSettled: () =>
      client.invalidateQueries({ queryKey: mailboxKeys.all(userId) }),
  });

/** Creates, renames, or deletes one of the person's own labels. */
export const mailLabelMutationOptions = (client: QueryClient, userId: UserId) =>
  mutationOptions({
    mutationKey: [...mailboxKeys.all(userId), "label"],
    mutationFn: async (
      change:
        | { readonly kind: "create"; readonly name: string }
        | {
            readonly kind: "rename";
            readonly id: string;
            readonly name: string;
          }
        | { readonly kind: "delete"; readonly id: string },
    ) => {
      if (change.kind === "create")
        return (
          await request(
            "/v1/mailbox/labels",
            MailLabelResponseSchema,
            json("POST", { name: change.name }),
            MailErrorResponseSchema,
          )
        ).data;
      const path = `/v1/mailbox/labels/${encodeURIComponent(change.id)}`;
      if (change.kind === "rename")
        return (
          await request(
            path,
            MailLabelResponseSchema,
            json("PATCH", { name: change.name }),
            MailErrorResponseSchema,
          )
        ).data;
      await request(
        path,
        AcknowledgedSchema,
        { method: "DELETE" },
        MailErrorResponseSchema,
      );
      return undefined;
    },
    onSettled: () =>
      client.invalidateQueries({ queryKey: mailboxKeys.all(userId) }),
  });

/** Who among the person's agents may read, and which senders stay private. */
export const updateMailboxSettingsMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...mailboxKeys.all(userId), "settings"],
    mutationFn: async (
      change: typeof UpdateMailboxSettingsRequestSchema.Type,
    ) => {
      await request(
        "/v1/mailbox/settings",
        AcknowledgedSchema,
        json("PATCH", change),
        MailErrorResponseSchema,
      );
    },
    onMutate: async (change) => {
      await client.cancelQueries({ queryKey: mailboxKeys.summary(userId) });
      const before = client.getQueryData<MailboxData>(
        mailboxKeys.summary(userId),
      );
      if (before?.enabled === true) {
        const next: EnabledMailbox = {
          ...before,
          ...(change.agentAccess === undefined
            ? {}
            : { agentAccess: change.agentAccess }),
          privateSenders: [
            ...before.privateSenders.filter(
              (sender) => sender !== change.removePrivateSender,
            ),
            ...(change.addPrivateSender === undefined ||
            before.privateSenders.includes(change.addPrivateSender)
              ? []
              : [change.addPrivateSender]),
          ],
        };
        client.setQueryData<MailboxData>(mailboxKeys.summary(userId), next);
      }
      return { before };
    },
    onError: (_error, _change, context) => {
      if (context?.before !== undefined)
        client.setQueryData(mailboxKeys.summary(userId), context.before);
    },
    onSettled: () =>
      client.invalidateQueries({ queryKey: mailboxKeys.summary(userId) }),
  });

/** Sends an email as the person; it then shows in Sent. */
export const sendMailMutationOptions = (client: QueryClient, userId: UserId) =>
  mutationOptions({
    mutationKey: [...mailboxKeys.all(userId), "send"],
    mutationFn: async (mail: SendMailRequest) =>
      (
        await request(
          "/v1/mailbox/send",
          SendMailResponseSchema,
          json("POST", mail),
          MailErrorResponseSchema,
        )
      ).data,
    onSuccess: () =>
      client.invalidateQueries({ queryKey: mailboxKeys.all(userId) }),
  });

/**
 * Changes the person's username, and with it their address, through the
 * account settings route; its error message shows as it is.
 */
export const changeMailUsernameMutationOptions = (
  client: QueryClient,
  userId: UserId,
) => {
  const account = updatePersonalAccountMutationOptions(client, userId);
  return mutationOptions({
    ...account,
    onSuccess: async (
      ...args: Parameters<NonNullable<typeof account.onSuccess>>
    ) => {
      await account.onSuccess?.(...args);
      await client.invalidateQueries({ queryKey: mailboxKeys.all(userId) });
    },
  });
};
