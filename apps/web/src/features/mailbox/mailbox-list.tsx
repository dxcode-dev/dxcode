import type { MailConversationSummary } from "@dx/api";
import {
  Archive,
  Eye,
  Inbox,
  Lock,
  Menu,
  OctagonAlert,
  Paperclip,
  PenSquare,
  Search,
  Send,
  Sparkles,
  Tag,
  X,
} from "lucide-react";
import * as React from "react";
import { Badge } from "../../shared/ui/badge.js";
import { Button } from "../../shared/ui/button.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import { Input } from "../../shared/ui/input.js";
import { TimeText } from "../../shared/ui/time-text.js";
import { listTime, participantsLabel, subjectText } from "./mail-format.js";
import {
  isPlainClick,
  type MailboxNavigate,
  type MailboxSearch,
  mailboxHref,
} from "./mailbox-search.js";

/** The list's state, as its query has it. */
export type MailListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly retry: () => void }
  | {
      readonly kind: "ready";
      readonly conversations: ReadonlyArray<MailConversationSummary>;
      readonly older?: {
        readonly loading: boolean;
        readonly failed: boolean;
        readonly load: () => void;
      };
    };

/**
 * The middle column: the list's name and search, then one compact row per
 * conversation, newest first, and "Load older" while older mail remains.
 */
export function MailboxList({
  title,
  address,
  search,
  state,
  onNavigate,
  onOpenFolders,
  onCompose,
  searchRef,
}: {
  readonly title: string;
  /** The address this list's mail was sent to, for its empty state. */
  readonly address?: string;
  readonly search: MailboxSearch;
  readonly state: MailListState;
  readonly onNavigate: MailboxNavigate;
  /** Opens the folders on a narrow screen, where the rail is hidden. */
  readonly onOpenFolders: () => void;
  readonly onCompose: () => void;
  readonly searchRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <section className="mailbox-list" aria-label={title}>
      <header className="mailbox-list-header">
        <Button
          variant="subtle"
          size="icon-sm"
          className="mailbox-stacked-only"
          aria-label="Folders"
          title="Folders"
          onClick={onOpenFolders}
        >
          <Menu aria-hidden="true" />
        </Button>
        <h1 className="mailbox-list-title">{title}</h1>
        <Button
          variant="subtle"
          size="icon-sm"
          className="mailbox-stacked-only"
          aria-label="New email"
          title="New email"
          onClick={onCompose}
        >
          <PenSquare aria-hidden="true" />
        </Button>
      </header>
      <MailSearchField
        key={search.q ?? ""}
        search={search}
        onNavigate={onNavigate}
        inputRef={searchRef}
      />
      <MailListBody
        title={title}
        address={address}
        search={search}
        state={state}
        onNavigate={onNavigate}
      />
    </section>
  );
}

/** Searches this list; Enter runs it, the clear button ends it. */
function MailSearchField({
  search,
  onNavigate,
  inputRef,
}: {
  readonly search: MailboxSearch;
  readonly onNavigate: MailboxNavigate;
  readonly inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [text, setText] = React.useState(search.q ?? "");
  const { conversation: _open, ...place } = search;
  const run = (q: string) =>
    onNavigate({ ...place, ...(q.trim() === "" ? { q: undefined } : { q }) });
  return (
    <form
      className="mailbox-search"
      onSubmit={(event) => {
        event.preventDefault();
        run(text);
      }}
    >
      <Search aria-hidden="true" />
      <Input
        ref={inputRef}
        variant="bare"
        type="search"
        aria-label="Search email"
        placeholder="Search email"
        maxLength={200}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.blur();
            if (search.q !== undefined) run("");
          }
        }}
      />
      {search.q === undefined ? null : (
        <Button
          type="button"
          variant="subtle"
          size="icon-2xs"
          aria-label="Clear search"
          title="Clear search"
          onClick={() => run("")}
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </form>
  );
}

const EMPTY_ICONS = {
  inbox: Inbox,
  sent: Send,
  archive: Archive,
  spam: OctagonAlert,
} as const;

function EmptyList({
  search,
  address,
}: {
  readonly search: MailboxSearch;
  readonly address?: string;
}) {
  if (search.q !== undefined)
    return (
      <EmptyState
        className="mailbox-state"
        icon={<Search />}
        title={`No email matches “${search.q}”`}
      />
    );
  if (search.label !== undefined)
    return (
      <EmptyState
        className="mailbox-state"
        icon={<Tag />}
        title="No email with this label"
      />
    );
  if (search.tag !== undefined)
    return (
      <EmptyState
        className="mailbox-state"
        icon={<Inbox />}
        title="No email for this project yet"
        description={
          address === undefined ? undefined : `Mail to ${address} shows here.`
        }
      />
    );
  const folder = search.folder ?? "inbox";
  const Icon = EMPTY_ICONS[folder];
  const copy = {
    inbox: {
      title: "You're all caught up",
      description:
        address === undefined ? undefined : `Mail to ${address} shows here.`,
    },
    sent: { title: "Nothing sent yet", description: undefined },
    archive: {
      title: "Nothing archived",
      description: "Archived conversations wait here.",
    },
    spam: { title: "No spam", description: undefined },
  }[folder];
  return (
    <EmptyState
      className="mailbox-state"
      icon={<Icon />}
      title={copy.title}
      description={copy.description}
    />
  );
}

/** Rows standing in for conversations while the first page loads. */
function ListSkeleton() {
  return (
    <div
      className="mailbox-skeleton-list"
      role="status"
      aria-label="Loading email"
    >
      {["a", "b", "c", "d", "e", "f", "g"].map((row) => (
        <div key={row} className="mailbox-skeleton-row" aria-hidden="true">
          <span className="mailbox-skeleton-line" data-width="sender" />
          <span className="mailbox-skeleton-line" data-width="subject" />
          <span className="mailbox-skeleton-line" data-width="preview" />
        </div>
      ))}
    </div>
  );
}

function MailListBody({
  title,
  address,
  search,
  state,
  onNavigate,
}: {
  readonly title: string;
  readonly address?: string;
  readonly search: MailboxSearch;
  readonly state: MailListState;
  readonly onNavigate: MailboxNavigate;
}) {
  if (state.kind === "loading") return <ListSkeleton />;
  if (state.kind === "error")
    return (
      <EmptyState
        className="mailbox-state"
        tone="error"
        role="alert"
        title="Email could not be loaded."
        action={
          <Button size="xs" variant="outline" onClick={state.retry}>
            Retry
          </Button>
        }
      />
    );
  if (state.conversations.length === 0)
    return <EmptyList search={search} address={address} />;
  const sent = search.folder === "sent";
  return (
    <div className="mailbox-list-scroll">
      <ul className="mailbox-rows" aria-label={title}>
        {state.conversations.map((conversation) => (
          <li key={conversation.key}>
            <ConversationRow
              conversation={conversation}
              selected={search.conversation === conversation.key}
              sent={sent}
              href={mailboxHref({ ...search, conversation: conversation.key })}
              onOpen={() =>
                onNavigate({ ...search, conversation: conversation.key })
              }
            />
          </li>
        ))}
      </ul>
      {state.older === undefined ? null : (
        <div className="mailbox-more">
          {state.older.failed ? (
            <span className="mailbox-more-error" role="alert">
              Older email could not be loaded.
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            busy={state.older.loading}
            disabled={state.older.loading}
            onClick={state.older.load}
          >
            {state.older.failed ? "Try again" : "Load older"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** One conversation: who, subject, a preview, its time, and its marks. */
function ConversationRow({
  conversation,
  selected,
  sent,
  href,
  onOpen,
}: {
  readonly conversation: MailConversationSummary;
  readonly selected: boolean;
  /** In Sent, the row names the recipients. */
  readonly sent: boolean;
  readonly href: string;
  readonly onOpen: () => void;
}) {
  const who = participantsLabel(conversation.participants);
  return (
    <a
      className="mailbox-row"
      href={href}
      data-mail-row={conversation.key}
      data-unread={conversation.unread || undefined}
      aria-current={selected ? "true" : undefined}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen();
      }}
    >
      <span className="mailbox-row-dot" aria-hidden="true" />
      <span className="mailbox-row-top">
        <span className="mailbox-row-from" title={who}>
          {sent ? `To: ${who}` : who}
          {conversation.count > 1 ? (
            <span className="mailbox-row-count">{conversation.count}</span>
          ) : null}
        </span>
        <span className="mailbox-row-marks">
          {conversation.authenticated ? null : (
            <Badge
              tone="warning"
              title="Sender not verified: this email may be forged."
            >
              Unverified
            </Badge>
          )}
          {conversation.readByAgent ? (
            <Eye aria-label="Read by an agent" role="img" />
          ) : null}
          {conversation.private ? (
            <Lock aria-label="Private" role="img" />
          ) : null}
          {conversation.hasAttachments ? (
            <Paperclip aria-label="Has attachments" role="img" />
          ) : null}
          <time
            className="mailbox-row-time"
            dateTime={conversation.latestAt}
            title={new Date(conversation.latestAt).toLocaleString()}
          >
            <TimeText text={(now) => listTime(conversation.latestAt, now)} />
          </time>
        </span>
      </span>
      <span className="mailbox-row-subject">
        {subjectText(conversation.subject)}
      </span>
      <span className="mailbox-row-bottom">
        <span className="mailbox-row-preview">{conversation.preview}</span>
        {conversation.tag === undefined &&
        conversation.labels.length === 0 ? null : (
          <span className="mailbox-row-labels">
            {conversation.tag === undefined ? null : (
              <Badge>+{conversation.tag}</Badge>
            )}
            {conversation.labels.slice(0, 2).map((label) => (
              <Badge
                key={label.id}
                title={
                  label.automatic
                    ? `${label.name}: labelled automatically`
                    : label.name
                }
              >
                {label.automatic ? <Sparkles aria-hidden="true" /> : null}
                {label.name}
              </Badge>
            ))}
            {conversation.labels.length > 2 ? (
              <Badge>+{conversation.labels.length - 2}</Badge>
            ) : null}
          </span>
        )}
      </span>
    </a>
  );
}
