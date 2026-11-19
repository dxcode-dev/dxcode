import type { MailMessage, UpdateMailConversationRequest } from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Mail } from "lucide-react";
import * as React from "react";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import {
  type MailboxCommand,
  onMailboxCommand,
} from "../../shared/commands/mailbox-command-event.js";
import { useEventSubscription } from "../../shared/hooks/use-event-subscription.js";
import { Button } from "../../shared/ui/button.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import { SheetContent, SheetRoot, SheetTitle } from "../../shared/ui/sheet.js";
import { useMobile } from "../../shared/use-mobile.js";
import { conversationFolder, latestMessage } from "./mail-conversation.js";
import { type ComposeIntent, MailboxComposer } from "./mailbox-composer.js";
import {
  MailboxSettingsDialog,
  NewLabelDialog,
  StartThreadDialog,
} from "./mailbox-dialogs.js";
import { MailboxList, type MailListState } from "./mailbox-list.js";
import {
  type EnabledMailbox,
  isMissingMail,
  mailboxQueryOptions,
  mailConversationQueryOptions,
  mailConversationsQueryOptions,
  updateMailboxSettingsMutationOptions,
  updateMailConversationMutationOptions,
} from "./mailbox-queries.js";
import { MailboxRail } from "./mailbox-rail.js";
import {
  type ConversationActions,
  type ConversationState,
  MailboxReader,
} from "./mailbox-reader.js";
import {
  FOLDER_NAMES,
  listViewOf,
  type MailboxNavigate,
  type MailboxSearch,
} from "./mailbox-search.js";
import {
  ChangeUsernameDialog,
  MailboxUsernamePick,
} from "./mailbox-username.js";
import "./mailbox.css";

export type { MailboxSearch } from "./mailbox-search.js";

/**
 * The Mail page: the person's one mailbox at `username@<mail domain>`,
 * which they and their agents share. A person whose username is a
 * placeholder or reserved picks one first.
 */
export function MailboxPage({
  userId,
  search,
  onSearchChange,
}: {
  readonly userId: UserId;
  readonly search: MailboxSearch;
  readonly onSearchChange: MailboxNavigate;
}) {
  const mailbox = useQuery(mailboxQueryOptions(userId));
  if (mailbox.data === undefined)
    return (
      <div className="mailbox-page">
        {mailbox.isError ? (
          <EmptyState
            className="mailbox-state"
            tone="error"
            role="alert"
            title="Your Mail could not be loaded."
            action={
              <Button
                size="xs"
                variant="outline"
                onClick={() => void mailbox.refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : (
          <div className="mailbox-page-loading">
            <DxLoading label="Loading your Mail" />
          </div>
        )}
      </div>
    );
  if (!mailbox.data.enabled)
    return (
      <div className="mailbox-page">
        <EmptyState
          className="mailbox-state"
          icon={<Mail />}
          title="dx Mail is off for you."
          description="Turn it on in Settings → Experimental Features, where this dx offers it."
        />
      </div>
    );
  if (mailbox.data.needsUsername)
    return (
      <div className="mailbox-page">
        <MailboxUsernamePick userId={userId} mailbox={mailbox.data} />
      </div>
    );
  return (
    <div className="mailbox-page">
      <MailboxWorkspace
        userId={userId}
        mailbox={mailbox.data}
        search={search}
        onSearchChange={onSearchChange}
      />
    </div>
  );
}

type OpenDialog =
  | { readonly kind: "settings" }
  | { readonly kind: "username" }
  | { readonly kind: "label"; readonly conversationKey: string }
  | { readonly kind: "start-thread"; readonly message: MailMessage };

/** Whether focus sits in an overlay, which takes Escape itself. */
const focusInOverlay = () =>
  document.activeElement?.closest(
    "[role='dialog'], [role='menu'], [role='listbox'], .mailbox-composer",
  ) != null;

function listTitle(mailbox: EnabledMailbox, search: MailboxSearch) {
  if (search.label !== undefined)
    return (
      mailbox.labels.find((label) => label.id === search.label)?.name ?? "Label"
    );
  if (search.tag !== undefined)
    return (
      mailbox.projects.find((project) => project.tag === search.tag)
        ?.projectName ?? `+${search.tag}`
    );
  return FOLDER_NAMES[search.folder ?? "inbox"];
}

function MailboxWorkspace({
  userId,
  mailbox,
  search,
  onSearchChange,
}: {
  readonly userId: UserId;
  readonly mailbox: EnabledMailbox;
  readonly search: MailboxSearch;
  readonly onSearchChange: MailboxNavigate;
}) {
  const queryClient = useQueryClient();
  const phone = useMobile();
  const view = listViewOf(search);
  const list = useInfiniteQuery(mailConversationsQueryOptions(userId, view));
  const openKey = search.conversation;
  const conversation = useQuery({
    ...mailConversationQueryOptions(userId, openKey ?? ""),
    enabled: openKey !== undefined,
  });
  const update = useMutation(
    updateMailConversationMutationOptions(queryClient, userId),
  );
  const settings = useMutation(
    updateMailboxSettingsMutationOptions(queryClient, userId),
  );
  const [composer, setComposer] = React.useState<ComposeIntent>();
  const [dialog, setDialog] = React.useState<OpenDialog>();
  const [foldersOpen, setFoldersOpen] = React.useState(false);
  const searchInput = React.useRef<HTMLInputElement>(null);

  const conversations = (list.data?.pages ?? []).flatMap(
    (page) => page.conversations,
  );
  const listState: MailListState =
    list.data !== undefined
      ? {
          kind: "ready",
          conversations,
          ...(list.hasNextPage
            ? {
                older: {
                  loading: list.isFetchingNextPage,
                  failed: list.isFetchNextPageError,
                  load: () => void list.fetchNextPage(),
                },
              }
            : {}),
        }
      : list.isError
        ? { kind: "error", retry: () => void list.refetch() }
        : { kind: "loading" };
  const open = conversation.data;
  const readerState: ConversationState =
    openKey === undefined
      ? { kind: "none" }
      : open !== undefined
        ? { kind: "ready", conversation: open }
        : conversation.isError
          ? isMissingMail(conversation.error)
            ? { kind: "missing" }
            : { kind: "error", retry: () => void conversation.refetch() }
          : { kind: "loading" };

  const place = (next: MailboxSearch) => {
    setFoldersOpen(false);
    onSearchChange(next);
  };
  const openConversation = (key: string | undefined) =>
    onSearchChange(
      { ...search, conversation: key },
      { replace: openKey !== undefined },
    );
  const close = () => onSearchChange({ ...search, conversation: undefined });
  const neighbour = (step: 1 | -1) => {
    const index = conversations.findIndex((item) => item.key === openKey);
    return conversations[index < 0 ? (step === 1 ? 0 : -1) : index + step]?.key;
  };
  const change = (key: string, request: UpdateMailConversationRequest) =>
    update.mutate({ key, change: request });
  /** Moves the open conversation away, then opens the next one. */
  const moveAway = (request: UpdateMailConversationRequest) => {
    if (openKey === undefined) return;
    const next = neighbour(1) ?? neighbour(-1);
    change(openKey, request);
    if (next === undefined) close();
    else openConversation(next);
  };
  const folder = open === undefined ? undefined : conversationFolder(open);
  const compose = (
    intent:
      | { readonly mode: "new" }
      | {
          readonly mode: "reply" | "reply-all" | "forward";
          readonly message: MailMessage;
        },
  ) => setComposer({ ...intent, id: Date.now() });
  const actions: ConversationActions = {
    close,
    archive: () =>
      moveAway({ folder: folder === "archive" ? "inbox" : "archive" }),
    spam: () => moveAway({ folder: folder === "spam" ? "inbox" : "spam" }),
    markUnread: () => {
      if (openKey === undefined) return;
      change(openKey, { read: false });
      close();
    },
    markRead: () => {
      if (openKey !== undefined) change(openKey, { read: true });
    },
    setPrivate: (on) => {
      if (openKey !== undefined) change(openKey, { private: on });
    },
    setLabel: (labelId, on) => {
      if (openKey !== undefined)
        change(
          openKey,
          on ? { addLabels: [labelId] } : { removeLabels: [labelId] },
        );
    },
    newLabel: () => {
      if (openKey !== undefined)
        setDialog({ kind: "label", conversationKey: openKey });
    },
    keepSenderPrivate: (address, on) =>
      settings.mutate(
        on ? { addPrivateSender: address } : { removePrivateSender: address },
      ),
    reply: (message, all) =>
      compose({ mode: all ? "reply-all" : "reply", message }),
    forward: (message) => compose({ mode: "forward", message }),
    startThread: (message) => setDialog({ kind: "start-thread", message }),
  };

  useEventSubscription(onMailboxCommand, (action: MailboxCommand) => {
    // While a draft is open, no shortcut replaces it, moves to another
    // conversation, or acts on the email underneath it.
    if (composer !== undefined && action !== "search") return;
    const latest = open === undefined ? undefined : latestMessage(open);
    switch (action) {
      case "next":
      case "previous": {
        const key = neighbour(action === "next" ? 1 : -1);
        if (key !== undefined) {
          openConversation(key);
          document
            .querySelector(`[data-mail-row="${CSS.escape(key)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      case "close":
        if (!focusInOverlay() && openKey !== undefined) close();
        return;
      case "archive":
        if (open !== undefined) actions.archive();
        return;
      case "spam":
        if (open !== undefined) actions.spam();
        return;
      case "unread":
        if (open !== undefined) actions.markUnread();
        return;
      case "reply":
      case "reply-all":
        if (latest !== undefined) actions.reply(latest, action === "reply-all");
        return;
      case "forward":
        if (latest !== undefined) actions.forward(latest);
        return;
      case "compose":
        compose({ mode: "new" });
        return;
      case "search":
        searchInput.current?.focus();
        searchInput.current?.select();
        return;
    }
  });

  const rail = (
    <MailboxRail
      userId={userId}
      mailbox={mailbox}
      search={search}
      onNavigate={place}
      onCompose={() => {
        setFoldersOpen(false);
        compose({ mode: "new" });
      }}
      onOpenSettings={() => {
        setFoldersOpen(false);
        setDialog({ kind: "settings" });
      }}
    />
  );
  const tagAddress = mailbox.projects.find(
    (project) => project.tag === search.tag,
  )?.address;
  return (
    <div
      className="mailbox"
      data-pane={openKey === undefined ? "list" : "reader"}
      data-composing={composer === undefined ? undefined : ""}
    >
      {rail}
      <MailboxList
        title={listTitle(mailbox, search)}
        address={search.tag === undefined ? mailbox.address : tagAddress}
        search={search}
        state={listState}
        onNavigate={place}
        onOpenFolders={() => setFoldersOpen(true)}
        onCompose={() => compose({ mode: "new" })}
        searchRef={searchInput}
      />
      <MailboxReader
        mailbox={mailbox}
        state={readerState}
        actions={actions}
        onChangeUsername={() => setDialog({ kind: "username" })}
      />
      {composer === undefined ? null : (
        <MailboxComposer
          key={composer.id}
          userId={userId}
          mailbox={mailbox}
          intent={composer}
          phone={phone}
          onClose={() => setComposer(undefined)}
          onSent={(key) => {
            setComposer(undefined);
            if (composer.mode !== "new" && openKey !== undefined) return;
            onSearchChange({ folder: "sent", conversation: key });
          }}
        />
      )}
      <SheetRoot open={foldersOpen} onOpenChange={setFoldersOpen}>
        <SheetContent
          side="left"
          inset
          padded={false}
          className="mailbox-folders-sheet"
          aria-label="Folders"
        >
          <SheetTitle className="visually-hidden">Folders</SheetTitle>
          {rail}
        </SheetContent>
      </SheetRoot>
      <MailboxSettingsDialog
        userId={userId}
        mailbox={mailbox}
        open={dialog?.kind === "settings"}
        onOpenChange={(next) =>
          setDialog(next ? { kind: "settings" } : undefined)
        }
        onChangeUsername={() => setDialog({ kind: "username" })}
      />
      <ChangeUsernameDialog
        userId={userId}
        mailbox={mailbox}
        open={dialog?.kind === "username"}
        onOpenChange={(next) =>
          setDialog(next ? { kind: "username" } : undefined)
        }
      />
      <NewLabelDialog
        userId={userId}
        open={dialog?.kind === "label"}
        onOpenChange={(next) => {
          if (!next) setDialog(undefined);
        }}
        onCreated={(labelId) => {
          if (dialog?.kind === "label")
            change(dialog.conversationKey, { addLabels: [labelId] });
        }}
      />
      {dialog?.kind === "start-thread" ? (
        <StartThreadDialog
          userId={userId}
          mailbox={mailbox}
          message={dialog.message}
          onOpenChange={(next) => {
            if (!next) setDialog(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
