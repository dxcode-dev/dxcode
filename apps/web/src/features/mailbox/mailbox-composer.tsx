import type { MailMessage, SendMailRequest } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Paperclip, Send, Trash2, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "../../shared/ui/button.js";
import { Card } from "../../shared/ui/card.js";
import { Input } from "../../shared/ui/input.js";
import { Keycaps } from "../../shared/ui/kbd.js";
import { Select } from "../../shared/ui/select.js";
import { SheetContent, SheetRoot, SheetTitle } from "../../shared/ui/sheet.js";
import { Textarea } from "../../shared/ui/textarea.js";
import { TokenField } from "../../shared/ui/token-field.js";
import {
  formatBytes,
  forwardedBody,
  forwardSubject,
  isEmailAddress,
  ownAddressTest,
  quotedReply,
  replyRecipients,
  replySubject,
} from "./mail-format.js";
import {
  type EnabledMailbox,
  mailErrorMessage,
  sendMailMutationOptions,
} from "./mailbox-queries.js";

/** What the composer was opened for. */
export type ComposeIntent =
  | { readonly id: number; readonly mode: "new" }
  | {
      readonly id: number;
      readonly mode: "reply" | "reply-all" | "forward";
      readonly message: MailMessage;
    };

const TITLES = {
  new: "New email",
  reply: "Reply",
  "reply-all": "Reply all",
  forward: "Forward",
} as const;

/** The plain address: `username@`, or empty for a project's `+tag`. */
const OWN = "";

const fileBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
    reader.readAsDataURL(file);
  });

/** A reply or forward is written above the quoted email. */
const placeCaretAtStart = (node: HTMLTextAreaElement | null) => {
  node?.setSelectionRange(0, 0);
  if (node !== null) node.scrollTop = 0;
};

/** One attached file; picking the same file again does not add it twice. */
const fileKey = (file: File) =>
  `${file.name}:${file.size}:${file.lastModified}`;

const isMac = () => /mac|iphone|ipad/i.test(navigator.platform);

/** Why the draft cannot go yet: a bad address, too many, or too large. */
const draftProblem = (
  lists: ReadonlyArray<ReadonlyArray<string>>,
  limit: number,
  size: { readonly tooLarge: boolean; readonly attachmentBytes: number },
) => {
  const all = lists.flat();
  const invalid = all.find((value) => !isEmailAddress(value));
  if (invalid !== undefined) return `${invalid} is not an email address.`;
  if (all.length > limit)
    return `An email can go to at most ${limit} recipients in total.`;
  if (size.tooLarge)
    return `Attachments may total ${formatBytes(size.attachmentBytes)}.`;
  return undefined;
};

/** One of To, Cc, and Bcc: its label and its address tokens. */
function RecipientRow({
  id,
  label,
  values,
  onValuesChange,
  limit,
  disabled,
  autoFocus = false,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly values: ReadonlyArray<string>;
  readonly onValuesChange: (values: ReadonlyArray<string>) => void;
  /** The most this row may take: the total limit less the other rows. */
  readonly limit: number;
  readonly disabled: boolean;
  readonly autoFocus?: boolean;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="mailbox-composer-row">
      <label className="mailbox-composer-label" htmlFor={id}>
        {label}
      </label>
      <TokenField
        id={id}
        aria-label={label}
        className="mailbox-composer-tokens"
        values={values}
        onValuesChange={onValuesChange}
        isValid={isEmailAddress}
        max={limit}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      {children}
    </div>
  );
}

/** The files attached so far, and a forward's original attachments. */
function ComposerFiles({
  files,
  forwarded,
  onRemove,
}: {
  readonly files: ReadonlyArray<File>;
  readonly forwarded: number;
  readonly onRemove: (index: number) => void;
}) {
  if (files.length === 0 && forwarded === 0) return null;
  return (
    <ul className="mailbox-composer-files" aria-label="Attachments">
      {forwarded === 0 ? null : (
        <li className="mailbox-composer-file" data-forwarded="">
          <Paperclip aria-hidden="true" />
          <span className="mailbox-attachment-name">
            {forwarded === 1
              ? "The original attachment is included"
              : `The ${forwarded} original attachments are included`}
          </span>
        </li>
      )}
      {files.map((file, index) => (
        <li key={fileKey(file)} className="mailbox-composer-file">
          <FileText aria-hidden="true" />
          <span className="mailbox-attachment-name">{file.name}</span>
          <span className="mailbox-attachment-size">
            {formatBytes(file.size)}
          </span>
          <Button
            type="button"
            variant="subtle"
            size="icon-2xs"
            aria-label={`Remove ${file.name}`}
            onClick={() => onRemove(index)}
          >
            <X aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The draft an intent starts from. */
const startingDraft = (intent: ComposeIntent, mailbox: EnabledMailbox) => {
  if (intent.mode === "new")
    return { to: [], cc: [], subject: "", text: "", fromTag: OWN };
  const { message } = intent;
  const fromTag =
    message.tag !== undefined &&
    mailbox.projects.some((project) => project.tag === message.tag)
      ? message.tag
      : OWN;
  if (intent.mode === "forward")
    return {
      to: [],
      cc: [],
      subject: forwardSubject(message.subject),
      text: forwardedBody(message),
      fromTag,
    };
  const { to, cc } = replyRecipients(
    message,
    ownAddressTest(mailbox.username, mailbox.domain),
    intent.mode === "reply-all",
  );
  return {
    to,
    cc,
    subject: replySubject(message.subject),
    text: quotedReply(message),
    fromTag,
  };
};

/**
 * Writes an email: a new one, a reply, a reply to all, or a forward. Docked
 * at the bottom right of the Mailbox on a wide screen, full screen on a
 * phone. Send with ⌘/Ctrl+Enter; Send is off, with the reason, while the
 * person may not send.
 */
export function MailboxComposer({
  userId,
  mailbox,
  intent,
  phone,
  onClose,
  onSent,
}: {
  readonly userId: UserId;
  readonly mailbox: EnabledMailbox;
  readonly intent: ComposeIntent;
  readonly phone: boolean;
  readonly onClose: () => void;
  readonly onSent: (conversationKey: string) => void;
}) {
  const form = (
    <ComposerForm
      inSheet={phone}
      userId={userId}
      mailbox={mailbox}
      intent={intent}
      onClose={onClose}
      onSent={onSent}
    />
  );
  if (phone)
    return (
      <SheetRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
        <SheetContent
          size="full"
          padded={false}
          className="mailbox-composer-sheet"
          aria-label={TITLES[intent.mode]}
        >
          {form}
        </SheetContent>
      </SheetRoot>
    );
  return (
    <Card
      as="section"
      variant="raised"
      className="mailbox-composer-dock"
      aria-label={TITLES[intent.mode]}
    >
      {form}
    </Card>
  );
}

/** The composer's title and its close button. */
function ComposerHeader({
  title,
  inSheet,
  onClose,
}: {
  readonly title: string;
  readonly inSheet: boolean;
  readonly onClose: () => void;
}) {
  return (
    <header className="mailbox-composer-header">
      {inSheet ? (
        <SheetTitle className="mailbox-composer-title">{title}</SheetTitle>
      ) : (
        <h2 className="mailbox-composer-title">{title}</h2>
      )}
      <Button
        type="button"
        variant="subtle"
        size="icon-xs"
        aria-label="Close and discard"
        title="Close and discard"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </header>
  );
}

/** Which address sends: the person's own or one of their projects' `+tag`s. */
function FromRow({
  mailbox,
  fromTag,
  onFromTagChange,
}: {
  readonly mailbox: EnabledMailbox;
  readonly fromTag: string;
  readonly onFromTagChange: (tag: string) => void;
}) {
  if (mailbox.projects.length === 0) return null;
  return (
    <label className="mailbox-composer-row">
      <span className="mailbox-composer-label">From</span>
      <Select
        className="mailbox-composer-from"
        aria-label="From"
        value={fromTag}
        onValueChange={onFromTagChange}
        options={[
          [OWN, mailbox.address],
          ...mailbox.projects.map(
            (project) => [project.tag, project.address] as const,
          ),
        ]}
      />
    </label>
  );
}

type Recipients = ReadonlyArray<string>;

/** To, and Cc and Bcc once asked for (or when a reply starts with copies). */
function ComposerRecipients({
  intentId,
  autoFocus,
  to,
  cc,
  bcc,
  onToChange,
  onCcChange,
  onBccChange,
  limit,
  disabled,
}: {
  readonly intentId: number;
  readonly autoFocus: boolean;
  readonly to: Recipients;
  readonly cc: Recipients;
  readonly bcc: Recipients;
  readonly onToChange: (values: Recipients) => void;
  readonly onCcChange: (values: Recipients) => void;
  readonly onBccChange: (values: Recipients) => void;
  /** The most recipients the email may take in total. */
  readonly limit: number;
  readonly disabled: boolean;
}) {
  const [showCopies, setShowCopies] = React.useState(cc.length > 0);
  const total = to.length + cc.length + bcc.length;
  // A row may grow only into the room the others leave, so the total holds.
  const rowLimit = (row: Recipients) =>
    Math.max(row.length, limit - total + row.length);
  return (
    <>
      <RecipientRow
        id={`compose-to-${intentId}`}
        label="To"
        values={to}
        onValuesChange={onToChange}
        limit={rowLimit(to)}
        disabled={disabled}
        autoFocus={autoFocus}
      >
        {showCopies ? null : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setShowCopies(true)}
          >
            Cc Bcc
          </Button>
        )}
      </RecipientRow>
      {showCopies ? (
        <>
          <RecipientRow
            id={`compose-cc-${intentId}`}
            label="Cc"
            values={cc}
            onValuesChange={onCcChange}
            limit={rowLimit(cc)}
            disabled={disabled}
          />
          <RecipientRow
            id={`compose-bcc-${intentId}`}
            label="Bcc"
            values={bcc}
            onValuesChange={onBccChange}
            limit={rowLimit(bcc)}
            disabled={disabled}
          />
        </>
      ) : null}
    </>
  );
}

/** A hidden file picker behind the paperclip; a file already attached is skipped. */
function AttachFilesButton({
  files,
  onFilesChange,
  disabled,
}: {
  readonly files: ReadonlyArray<File>;
  readonly onFilesChange: (files: ReadonlyArray<File>) => void;
  readonly disabled: boolean;
}) {
  const fileInput = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const attached = new Set(files.map(fileKey));
          const picked = [...(event.target.files ?? [])].filter((file) => {
            if (attached.has(fileKey(file))) return false;
            attached.add(fileKey(file));
            return true;
          });
          onFilesChange([...files, ...picked]);
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="subtle"
        size="icon-sm"
        aria-label="Attach files"
        title="Attach files"
        disabled={disabled}
        onClick={() => fileInput.current?.click()}
      >
        <Paperclip aria-hidden="true" />
      </Button>
    </>
  );
}

/** Send with its shortcut, the attachment size, Attach, and Discard. */
function ComposerFooter({
  busy,
  ready,
  sendTitle,
  files,
  onFilesChange,
  showSize,
  totalBytes,
  attachmentBytes,
  tooLarge,
  onClose,
}: {
  readonly busy: boolean;
  readonly ready: boolean;
  /** Why Send is off, when it is. */
  readonly sendTitle: string | undefined;
  readonly files: ReadonlyArray<File>;
  readonly onFilesChange: (files: ReadonlyArray<File>) => void;
  readonly showSize: boolean;
  readonly totalBytes: number;
  readonly attachmentBytes: number;
  readonly tooLarge: boolean;
  readonly onClose: () => void;
}) {
  const shortcut = isMac() ? ["⌘", "Enter"] : ["Ctrl", "Enter"];
  return (
    <footer className="mailbox-composer-footer">
      <Button
        type="submit"
        size="sm"
        busy={busy}
        aria-disabled={!ready || undefined}
        title={sendTitle}
      >
        <Send aria-hidden="true" />
        Send
      </Button>
      <Keycaps keys={shortcut} />
      <span className="mailbox-composer-spacer" />
      {showSize ? (
        <span
          className="mailbox-composer-size"
          data-over={tooLarge || undefined}
        >
          {formatBytes(totalBytes)} of {formatBytes(attachmentBytes)}
        </span>
      ) : null}
      <AttachFilesButton
        files={files}
        onFilesChange={onFilesChange}
        disabled={busy}
      />
      <Button
        type="button"
        variant="subtle"
        size="icon-sm"
        aria-label="Discard"
        title="Discard"
        disabled={busy}
        onClick={onClose}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </footer>
  );
}

/** Reads each attached file into the request; absent when none is attached. */
const readAttachments = async (
  files: ReadonlyArray<File>,
): Promise<SendMailRequest["attachments"]> =>
  files.length === 0
    ? undefined
    : Promise.all(
        files.map(async (file) => ({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          contentBase64: await fileBase64(file),
        })),
      );

function ComposerForm({
  inSheet,
  userId,
  mailbox,
  intent,
  onClose,
  onSent,
}: {
  readonly inSheet: boolean;
  readonly userId: UserId;
  readonly mailbox: EnabledMailbox;
  readonly intent: ComposeIntent;
  readonly onClose: () => void;
  readonly onSent: (conversationKey: string) => void;
}) {
  const queryClient = useQueryClient();
  const send = useMutation(sendMailMutationOptions(queryClient, userId));
  const [draft] = React.useState(() => startingDraft(intent, mailbox));
  const [to, setTo] = React.useState<Recipients>(draft.to);
  const [cc, setCc] = React.useState<Recipients>(draft.cc);
  const [bcc, setBcc] = React.useState<Recipients>([]);
  const [subject, setSubject] = React.useState(draft.subject);
  const [text, setText] = React.useState(draft.text);
  const [fromTag, setFromTag] = React.useState(draft.fromTag);
  const [files, setFiles] = React.useState<ReadonlyArray<File>>([]);
  const [readError, setReadError] = React.useState<string>();
  const [reading, setReading] = React.useState(false);
  const limit = mailbox.limits.recipientsPerEmail;
  const forwardedAttachments =
    intent.mode === "forward" ? intent.message.attachments : [];
  const forwarded = forwardedAttachments.length;
  // A forward's original attachments go with it and count toward the limit.
  const totalBytes =
    files.reduce((sum, file) => sum + file.size, 0) +
    forwardedAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
  const tooLarge = totalBytes > mailbox.limits.attachmentBytes;
  const problem = draftProblem([to, cc, bcc], limit, {
    tooLarge,
    attachmentBytes: mailbox.limits.attachmentBytes,
  });
  const blockedReason = mailbox.canSend
    ? undefined
    : (mailbox.sendingBlockedReason ?? "Sending is off for your Mailbox.");
  const busy = send.isPending || reading;
  const ready =
    blockedReason === undefined &&
    to.length > 0 &&
    problem === undefined &&
    !busy;

  const submit = async () => {
    if (!ready) return;
    setReadError(undefined);
    // Reading attachments takes a moment; a second press must not send again.
    setReading(true);
    let attachments: SendMailRequest["attachments"];
    try {
      attachments = await readAttachments(files);
    } catch {
      setReading(false);
      setReadError(
        "An attachment could not be read. Remove it and attach it again.",
      );
      return;
    }
    setReading(false);
    send.mutate(
      {
        to,
        ...(cc.length === 0 ? {} : { cc }),
        ...(bcc.length === 0 ? {} : { bcc }),
        subject,
        text,
        ...(intent.mode === "reply" || intent.mode === "reply-all"
          ? { replyTo: intent.message.id }
          : intent.mode === "forward"
            ? { forwardOf: intent.message.id }
            : {}),
        ...(fromTag === OWN ? {} : { fromTag }),
        ...(attachments === undefined ? {} : { attachments }),
      },
      {
        onSuccess: (sent) => {
          toast.success("Email sent.");
          onSent(sent.conversationKey);
        },
      },
    );
  };

  const error =
    readError ??
    (send.isError
      ? mailErrorMessage(send.error, "The email could not be sent.")
      : undefined);
  const notice = error ?? blockedReason ?? problem;
  return (
    <form
      className="mailbox-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        // A recipient field takes the first press to confirm what was
        // typed (and prevents it); the next press sends.
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !event.defaultPrevented
        ) {
          event.preventDefault();
          void submit();
        }
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
        }
      }}
    >
      <ComposerHeader
        title={TITLES[intent.mode]}
        inSheet={inSheet}
        onClose={onClose}
      />
      <div className="mailbox-composer-fields">
        <FromRow
          mailbox={mailbox}
          fromTag={fromTag}
          onFromTagChange={setFromTag}
        />
        <ComposerRecipients
          intentId={intent.id}
          autoFocus={intent.mode === "new" || intent.mode === "forward"}
          to={to}
          cc={cc}
          bcc={bcc}
          onToChange={setTo}
          onCcChange={setCc}
          onBccChange={setBcc}
          limit={limit}
          disabled={busy}
        />
        <div className="mailbox-composer-row">
          <Input
            variant="bare"
            aria-label="Subject"
            placeholder="Subject"
            className="mailbox-composer-subject"
            maxLength={998}
            value={subject}
            disabled={busy}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
      </div>
      <Textarea
        variant="bare"
        className="mailbox-composer-body"
        aria-label="Message"
        placeholder="Write your email"
        autoFocus={intent.mode === "reply" || intent.mode === "reply-all"}
        ref={intent.mode === "new" ? undefined : placeCaretAtStart}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
      />
      <ComposerFiles
        files={files}
        forwarded={forwarded}
        onRemove={(index) => setFiles(files.filter((_, at) => at !== index))}
      />
      {notice === undefined ? null : (
        <p
          className="mailbox-composer-problem"
          role={error === undefined ? "note" : "alert"}
        >
          {notice}
        </p>
      )}
      <ComposerFooter
        busy={busy}
        ready={ready}
        sendTitle={
          blockedReason ?? (to.length === 0 ? "Add a recipient" : undefined)
        }
        files={files}
        onFilesChange={setFiles}
        showSize={files.length > 0 || forwarded > 0}
        totalBytes={totalBytes}
        attachmentBytes={mailbox.limits.attachmentBytes}
        tooLarge={tooLarge}
        onClose={onClose}
      />
    </form>
  );
}
