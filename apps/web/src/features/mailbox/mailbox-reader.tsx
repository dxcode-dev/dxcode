import type { MailConversation, MailMessage } from "@dx/api";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Bot,
  Copy,
  Download,
  Eye,
  FileText,
  Forward,
  Inbox,
  Lock,
  LockOpen,
  Mail,
  MailOpen,
  MoreHorizontal,
  OctagonAlert,
  Paperclip,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tag,
} from "lucide-react";
import * as React from "react";
import { copyText } from "../../shared/copy-text.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { Avatar } from "../../shared/ui/avatar.js";
import { Badge } from "../../shared/ui/badge.js";
import { Button } from "../../shared/ui/button.js";
import { chipVariants } from "../../shared/ui/chip-variants.js";
import { EmailFrame } from "../../shared/ui/email-frame.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import {
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/ui/menu.js";
import { SegmentedControl } from "../../shared/ui/segmented-control.js";
import {
  conversationFolder,
  conversationLabels,
  latestMessage,
  splitQuote,
} from "./mail-conversation.js";
import {
  addressLine,
  addressName,
  formatBytes,
  fullTime,
  subjectText,
} from "./mail-format.js";
import { type EnabledMailbox, mailAttachmentUrl } from "./mailbox-queries.js";

/** What the reader can do to the open conversation. */
export interface ConversationActions {
  readonly close: () => void;
  readonly archive: () => void;
  readonly spam: () => void;
  readonly markUnread: () => void;
  readonly markRead: () => void;
  readonly setPrivate: (on: boolean) => void;
  readonly setLabel: (labelId: string, on: boolean) => void;
  readonly newLabel: () => void;
  readonly keepSenderPrivate: (address: string, on: boolean) => void;
  readonly reply: (message: MailMessage, all: boolean) => void;
  readonly forward: (message: MailMessage) => void;
  readonly startThread: (message: MailMessage) => void;
}

export type ConversationState =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly retry: () => void }
  | { readonly kind: "ready"; readonly conversation: MailConversation };

/**
 * The right column: the open conversation, each email a card, the newest
 * open and older ones folded; or, with none open, the person's address.
 */
export function MailboxReader({
  mailbox,
  state,
  actions,
  onChangeUsername,
}: {
  readonly mailbox: EnabledMailbox;
  readonly state: ConversationState;
  readonly actions: ConversationActions;
  readonly onChangeUsername: () => void;
}) {
  if (state.kind === "none")
    return (
      <section className="mailbox-reader" aria-label="Email">
        <AddressCard mailbox={mailbox} onChangeUsername={onChangeUsername} />
      </section>
    );
  return (
    <section className="mailbox-reader" aria-label="Email">
      {state.kind === "ready" ? (
        <OpenConversation
          key={state.conversation.key}
          mailbox={mailbox}
          conversation={state.conversation}
          actions={actions}
        />
      ) : (
        <>
          <div className="mailbox-toolbar">
            <BackButton onClick={actions.close} />
          </div>
          {state.kind === "loading" ? (
            <ReaderSkeleton />
          ) : state.kind === "missing" ? (
            <EmptyState
              className="mailbox-state"
              icon={<Mail />}
              title="That email was not found."
              description="It may have been deleted, or it belongs to another mailbox."
            />
          ) : (
            <EmptyState
              className="mailbox-state"
              tone="error"
              role="alert"
              title="The email could not be loaded."
              action={
                <Button size="xs" variant="outline" onClick={state.retry}>
                  Retry
                </Button>
              }
            />
          )}
        </>
      )}
    </section>
  );
}

function BackButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <Button
      variant="subtle"
      size="icon-sm"
      className="mailbox-stacked-only"
      aria-label="Back to the list"
      title="Back to the list"
      onClick={onClick}
    >
      <ArrowLeft aria-hidden="true" />
    </Button>
  );
}

/** With nothing open: the person's address, and their one change. */
function AddressCard({
  mailbox,
  onChangeUsername,
}: {
  readonly mailbox: EnabledMailbox;
  readonly onChangeUsername: () => void;
}) {
  return (
    <div className="mailbox-address-card">
      <Mail className="mailbox-address-icon" aria-hidden="true" />
      <p className="mailbox-address-lead">Your dx address is</p>
      <p className="mailbox-address-value">
        <strong>{mailbox.address}</strong>
        <Button
          variant="subtle"
          size="icon-xs"
          aria-label="Copy email address"
          title="Copy email address"
          onClick={() => void copyText(mailbox.address, "Email address")}
        >
          <Copy aria-hidden="true" />
        </Button>
      </p>
      <p className="mailbox-address-note">
        Your agents use it too.
        {mailbox.canChangeUsername
          ? " You can change your username once; after that it is fixed."
          : null}
      </p>
      {mailbox.canChangeUsername ? (
        <Button size="sm" variant="outline" onClick={onChangeUsername}>
          Change username
        </Button>
      ) : null}
    </div>
  );
}

function ReaderSkeleton() {
  return (
    <div
      className="mailbox-skeleton-reader"
      role="status"
      aria-label="Loading the email"
    >
      <span className="mailbox-skeleton-line" data-width="title" />
      <span className="mailbox-skeleton-line" data-width="sender" />
      <span className="mailbox-skeleton-block" />
    </div>
  );
}

/**
 * Marks an unread conversation read as it opens. Mounted once per
 * conversation, so Mark unread while reading leaves it unread.
 */
function MarkReadOnOpen({
  unread,
  onMarkRead,
}: {
  readonly unread: boolean;
  readonly onMarkRead: () => void;
}) {
  useMountEffect(() => {
    if (unread) onMarkRead();
  });
  return null;
}

function OpenConversation({
  mailbox,
  conversation,
  actions,
}: {
  readonly mailbox: EnabledMailbox;
  readonly conversation: MailConversation;
  readonly actions: ConversationActions;
}) {
  const messages = conversation.messages;
  const latest = latestMessage(conversation);
  const folder = conversationFolder(conversation);
  const isPrivate =
    messages.length > 0 && messages.every((message) => message.private);
  const labels = conversationLabels(messages);
  const tag = messages.find((message) => message.tag !== undefined)?.tag;
  const threads = [
    ...new Map(
      messages.flatMap((message) =>
        message.thread === undefined
          ? []
          : [[message.thread.threadId, message.thread] as const],
      ),
    ).values(),
  ];
  const project = mailbox.projects.find((item) => item.tag === tag);
  // The newest email and those unread as the conversation opened start
  // open, older read ones folded; a click on a header flips one.
  const [unreadAtOpen] = React.useState<ReadonlySet<string>>(
    () =>
      new Set(
        messages.flatMap((message) => (message.read ? [] : [message.id])),
      ),
  );
  const [flipped, setFlipped] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const latestId = latest?.id;
  const expanded = (id: string) =>
    (id === latestId || unreadAtOpen.has(id)) !== flipped.has(id);
  const toggle = (id: string) =>
    setFlipped((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const sender = [...messages]
    .reverse()
    .find((message) => message.direction === "in")?.from;
  return (
    <>
      <MarkReadOnOpen
        unread={messages.some((message) => !message.read)}
        onMarkRead={actions.markRead}
      />
      <ReaderToolbar
        mailbox={mailbox}
        folder={folder}
        isPrivate={isPrivate}
        labelIds={new Set(labels.map((label) => label.id))}
        sender={sender?.address}
        latest={latest}
        actions={actions}
      />
      <div className="mailbox-reader-scroll">
        <header className="mailbox-conversation-header">
          <h2 className="mailbox-conversation-subject">
            {subjectText(conversation.subject)}
          </h2>
          {threads.length === 0 ? null : (
            <div className="mailbox-conversation-threads">
              {threads.map((thread) => (
                <Link
                  key={thread.threadId}
                  className={chipVariants({ variant: "soft", size: "sm" })}
                  to="/threads/$threadId"
                  params={{ threadId: thread.threadId }}
                >
                  <ArrowRight aria-hidden="true" />
                  {thread.kind === "started"
                    ? "Started thread"
                    : "Followed up in"}{" "}
                  <strong>{thread.title}</strong>
                </Link>
              ))}
            </div>
          )}
          {labels.length === 0 && project === undefined && !isPrivate ? null : (
            <div className="mailbox-conversation-labels">
              {isPrivate ? (
                <Badge title="Agents cannot read this conversation.">
                  <Lock aria-hidden="true" />
                  Private
                </Badge>
              ) : null}
              {project === undefined ? null : (
                <Badge title={project.address}>
                  {project.projectName} · +{project.tag}
                </Badge>
              )}
              {labels.map((label) => (
                <Badge
                  key={label.id}
                  title={
                    label.automatic
                      ? `${label.name}: labelled automatically`
                      : undefined
                  }
                >
                  {label.automatic ? (
                    <Sparkles aria-hidden="true" />
                  ) : (
                    <Tag aria-hidden="true" />
                  )}
                  {label.name}
                </Badge>
              ))}
            </div>
          )}
        </header>
        <ol className="mailbox-messages">
          {messages.map((message) => (
            <li key={message.id}>
              <MessageCard
                message={message}
                ownAddress={mailbox.address}
                expanded={expanded(message.id)}
                onToggle={() => toggle(message.id)}
              />
            </li>
          ))}
        </ol>
        {latest === undefined ? null : (
          <div className="mailbox-reply-bar">
            <Button
              size="sm"
              variant="outline"
              onClick={() => actions.reply(latest, false)}
            >
              <Reply aria-hidden="true" />
              Reply
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => actions.reply(latest, true)}
            >
              <ReplyAll aria-hidden="true" />
              Reply all
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => actions.forward(latest)}
            >
              <Forward aria-hidden="true" />
              Forward
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

/** The conversation's actions: move it, mark it, label it, keep it private. */
function ReaderToolbar({
  mailbox,
  folder,
  isPrivate,
  labelIds,
  sender,
  latest,
  actions,
}: {
  readonly mailbox: EnabledMailbox;
  readonly folder: "inbox" | "archive" | "spam" | "sent";
  readonly isPrivate: boolean;
  readonly labelIds: ReadonlySet<string>;
  readonly sender?: string;
  readonly latest?: MailMessage;
  readonly actions: ConversationActions;
}) {
  const senderPrivate =
    sender !== undefined &&
    mailbox.privateSenders.some(
      (item) => item.toLowerCase() === sender.toLowerCase(),
    );
  const userLabels = mailbox.labels.filter((label) => label.kind === "user");
  const autoLabels = mailbox.labels.filter((label) => label.kind === "auto");
  return (
    <div
      className="mailbox-toolbar"
      role="toolbar"
      aria-label="Conversation actions"
    >
      <BackButton onClick={actions.close} />
      <Button
        variant="subtle"
        size="icon-sm"
        aria-label={folder === "archive" ? "Move to Inbox" : "Archive"}
        title={folder === "archive" ? "Move to Inbox (E)" : "Archive (E)"}
        onClick={actions.archive}
      >
        {folder === "archive" ? (
          <Inbox aria-hidden="true" />
        ) : (
          <Archive aria-hidden="true" />
        )}
      </Button>
      <Button
        variant="subtle"
        size="icon-sm"
        aria-label={folder === "spam" ? "Not spam" : "Report spam"}
        title={folder === "spam" ? "Not spam (#)" : "Report spam (#)"}
        onClick={actions.spam}
      >
        {folder === "spam" ? (
          <ShieldCheck aria-hidden="true" />
        ) : (
          <OctagonAlert aria-hidden="true" />
        )}
      </Button>
      <Button
        variant="subtle"
        size="icon-sm"
        aria-label="Mark unread"
        title="Mark unread (U)"
        onClick={actions.markUnread}
      >
        <MailOpen aria-hidden="true" />
      </Button>
      <span className="mailbox-toolbar-divider" aria-hidden="true" />
      <MenuRoot>
        <MenuTrigger
          render={
            <Button
              variant="subtle"
              size="icon-sm"
              aria-label="Labels"
              title="Labels"
            >
              <Tag aria-hidden="true" />
            </Button>
          }
        />
        <MenuPopup align="start" aria-label="Labels">
          {userLabels.length === 0 && autoLabels.length === 0 ? null : (
            <MenuGroup>
              {userLabels.map((label) => (
                <MenuCheckboxItem
                  key={label.id}
                  checked={labelIds.has(label.id)}
                  onCheckedChange={(checked) =>
                    actions.setLabel(label.id, checked)
                  }
                >
                  {label.name}
                </MenuCheckboxItem>
              ))}
              {autoLabels.map((label) => (
                <MenuCheckboxItem
                  key={label.id}
                  checked={labelIds.has(label.id)}
                  onCheckedChange={(checked) =>
                    actions.setLabel(label.id, checked)
                  }
                >
                  {label.name}
                  <Sparkles
                    className="mailbox-menu-auto"
                    aria-label="automatic"
                  />
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
          )}
          {userLabels.length === 0 && autoLabels.length === 0 ? null : (
            <MenuSeparator />
          )}
          <MenuItem onClick={actions.newLabel}>New label…</MenuItem>
        </MenuPopup>
      </MenuRoot>
      <Button
        variant="subtle"
        size="icon-sm"
        aria-pressed={isPrivate}
        aria-label={
          isPrivate ? "Private: agents cannot read it" : "Make private"
        }
        title={
          isPrivate
            ? "Private: agents cannot read it"
            : "Make private: hide it from agents"
        }
        onClick={() => actions.setPrivate(!isPrivate)}
      >
        {isPrivate ? (
          <Lock aria-hidden="true" />
        ) : (
          <LockOpen aria-hidden="true" />
        )}
      </Button>
      {sender === undefined ? null : (
        <MenuRoot>
          <MenuTrigger
            render={
              <Button
                variant="subtle"
                size="icon-sm"
                aria-label="More actions"
                title="More actions"
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            }
          />
          <MenuPopup align="start">
            {/* A label must sit inside its group (Base UI error #31). */}
            <MenuGroup>
              <MenuLabel>{sender}</MenuLabel>
              <MenuItem
                onClick={() =>
                  actions.keepSenderPrivate(sender, !senderPrivate)
                }
              >
                {senderPrivate ? (
                  <LockOpen aria-hidden="true" />
                ) : (
                  <Lock aria-hidden="true" />
                )}
                {senderPrivate
                  ? "Stop keeping their mail private"
                  : "Always keep their mail private"}
              </MenuItem>
              <MenuItem onClick={() => void copyText(sender, "Email address")}>
                <Copy aria-hidden="true" />
                Copy address
              </MenuItem>
            </MenuGroup>
          </MenuPopup>
        </MenuRoot>
      )}
      <span className="mailbox-toolbar-spacer" />
      {latest === undefined ? null : (
        <Button
          size="sm"
          variant="outline"
          className="mailbox-start-thread"
          aria-label="Start thread"
          onClick={() => actions.startThread(latest)}
        >
          <Bot aria-hidden="true" />
          <span>Start thread</span>
        </Button>
      )}
    </div>
  );
}

/** "to me, Ben" under a sender's name. */
const recipientsLine = (message: MailMessage, own: string) => {
  const name = (address: {
    readonly address: string;
    readonly name?: string;
  }) =>
    address.address.toLowerCase() === own.toLowerCase()
      ? "me"
      : addressName(address);
  const to = message.to.map(name).join(", ");
  const cc = message.cc.map(name).join(", ");
  return `to ${to === "" ? "(no one)" : to}${cc === "" ? "" : `, cc ${cc}`}`;
};

function MessageCard({
  message,
  ownAddress,
  expanded,
  onToggle,
}: {
  readonly message: MailMessage;
  readonly ownAddress: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const from = message.direction === "out" ? "Me" : addressName(message.from);
  return (
    <article
      className="mailbox-message"
      data-expanded={expanded || undefined}
      data-unread={message.read ? undefined : ""}
      aria-label={`${from}, ${fullTime(message.receivedAt)}`}
    >
      <button
        type="button"
        className="mailbox-message-header"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <Avatar name={addressName(message.from)} seed={message.from.address} />
        <span className="mailbox-message-who">
          <span className="mailbox-message-from">
            <strong>{from}</strong>
            {message.direction === "out" ? null : (
              <span className="mailbox-message-address">
                {message.from.address}
              </span>
            )}
            {message.authenticated || message.direction === "out" ? null : (
              <Badge tone="warning">Unverified</Badge>
            )}
          </span>
          <span className="mailbox-message-to">
            {expanded
              ? recipientsLine(message, ownAddress)
              : message.text.slice(0, 160)}
          </span>
        </span>
        <span className="mailbox-message-meta">
          {message.readBy.length > 0 ? (
            <Eye
              aria-label={`Read by agent in ${message.readBy.map((read) => read.title).join(", ")}`}
              role="img"
            />
          ) : null}
          {message.attachments.length > 0 ? (
            <Paperclip aria-label="Has attachments" role="img" />
          ) : null}
          <time
            dateTime={message.receivedAt}
            title={new Date(message.receivedAt).toLocaleString()}
          >
            {fullTime(message.receivedAt)}
          </time>
        </span>
      </button>
      {expanded ? <MessageDetails message={message} /> : null}
    </article>
  );
}

function MessageDetails({ message }: { readonly message: MailMessage }) {
  return (
    <div className="mailbox-message-body">
      {message.authenticated ||
      message.direction === "out" ? null : message.trust === "unverified" ? (
        <p className="mailbox-notice" role="note">
          <ShieldAlert aria-hidden="true" />
          <span>
            Unverified sender: <strong>{addressLine(message.from)}</strong>. Its
            domain doesn't sign its mail with DMARC, so dx only knows it came
            from a server that domain allows. Take care with its links and
            requests.
          </span>
        </p>
      ) : (
        <p className="mailbox-notice" data-tone="warning" role="note">
          <ShieldAlert aria-hidden="true" />
          <span>
            Sender not verified: this email may be forged. It claims to be from{" "}
            <strong>{addressLine(message.from)}</strong>.
          </span>
        </p>
      )}
      {message.spamReason === undefined ? null : (
        <p className="mailbox-notice" data-tone="danger" role="note">
          <OctagonAlert aria-hidden="true" />
          <span>
            <strong>In Spam:</strong> {message.spamReason}
          </span>
        </p>
      )}
      <MessageContent message={message} />
      {message.attachments.length === 0 ? null : (
        <ul className="mailbox-attachments" aria-label="Attachments">
          {message.attachments.map((attachment) => (
            <li key={attachment.index}>
              <a
                className="mailbox-attachment"
                href={mailAttachmentUrl(message.id, attachment.index)}
                download={attachment.filename}
                title={`Download ${attachment.filename}`}
              >
                <FileText aria-hidden="true" />
                <span className="mailbox-attachment-name">
                  {attachment.filename}
                </span>
                <span className="mailbox-attachment-size">
                  {formatBytes(attachment.size)}
                </span>
                <Download aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {message.readBy.length === 0 ? null : (
        <footer className="mailbox-message-footer">
          {message.readBy.map((read) => (
            <Link
              key={read.threadId}
              className={chipVariants({ variant: "outline", size: "sm" })}
              to="/threads/$threadId"
              params={{ threadId: read.threadId }}
              title={`Read ${new Date(read.readAt).toLocaleString()}`}
            >
              <Eye aria-hidden="true" />
              Read by agent in <strong>{read.title}</strong>
            </Link>
          ))}
        </footer>
      )}
    </div>
  );
}

/** Plain text first; the HTML part, if any, in a frame that loads nothing. */
function MessageContent({ message }: { readonly message: MailMessage }) {
  const [view, setView] = React.useState<"text" | "html">("text");
  const html = message.html;
  const shown = html === undefined ? "text" : view;
  return (
    <div className="mailbox-message-content">
      {html === undefined ? null : (
        <SegmentedControl
          className="mailbox-message-switch"
          label="Show the email as"
          value={shown}
          onValueChange={setView}
          options={[
            ["text", "Text"],
            ["html", "HTML"],
          ]}
        />
      )}
      {shown === "html" && html !== undefined ? (
        <EmailFrame
          html={html}
          title={`${subjectText(message.subject)} as HTML`}
        />
      ) : (
        <MessageText text={message.text} />
      )}
    </div>
  );
}

/** The text, with the quoted email it replies to folded behind "•••". */
function MessageText({ text }: { readonly text: string }) {
  const [quoteShown, setQuoteShown] = React.useState(false);
  if (text.trim() === "")
    return <div className="mailbox-message-text">(no text)</div>;
  const { body, quote } = splitQuote(text);
  return (
    <div className="mailbox-message-text">
      {quote === undefined || quoteShown ? text : body}
      {quote === undefined ? null : (
        <Button
          variant="subtle"
          size="xs"
          className="mailbox-quote-toggle"
          aria-expanded={quoteShown}
          aria-label={quoteShown ? "Hide quoted text" : "Show quoted text"}
          title={quoteShown ? "Hide quoted text" : "Show quoted text"}
          onClick={() => setQuoteShown(!quoteShown)}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
