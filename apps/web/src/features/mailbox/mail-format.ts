import type { MailAddress, MailMessage } from "@dx/api";

/** What a person reads for an address: its name, else the address. */
export const addressName = (address: MailAddress) =>
  address.name !== undefined && address.name.trim() !== ""
    ? address.name.trim()
    : address.address;

/** `Maya Fernandez <maya@example.com>`, or the bare address. */
export const addressLine = (address: MailAddress) =>
  address.name !== undefined && address.name.trim() !== ""
    ? `${address.name.trim()} <${address.address}>`
    : address.address;

/** "Maya, Ben, and 2 others": a list row's senders. */
export const participantsLabel = (
  participants: ReadonlyArray<MailAddress>,
): string => {
  const names = participants.map((address) => {
    const name = addressName(address);
    // First names keep a row short once there are several people.
    return participants.length > 1 && name !== address.address
      ? (name.split(/\s+/)[0] ?? name)
      : name;
  });
  if (names.length === 0) return "(no sender)";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
};

export const subjectText = (subject: string) =>
  subject.trim() === "" ? "(no subject)" : subject;

const RECIPIENT = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/;

/** Whether text reads as one email address. */
export const isEmailAddress = (value: string) => RECIPIENT.test(value.trim());

export const formatBytes = (bytes: number) => {
  if (bytes < 1_024) return `${bytes} B`;
  const kibibytes = bytes / 1_024;
  if (kibibytes < 1_024) return `${Math.round(kibibytes)} KB`;
  return `${(kibibytes / 1_024).toFixed(1)} MB`;
};

const dayFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const monthFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const yearFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const fullFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A list row's time: the clock today, the date this year, else the year. */
export const listTime = (iso: string, now: number) => {
  const date = new Date(iso);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString())
    return dayFormat.format(date);
  if (date.getFullYear() === today.getFullYear())
    return monthFormat.format(date);
  return yearFormat.format(date);
};

/** "Tue, Nov 14, 2026, 3:04 PM": an opened email's time. */
export const fullTime = (iso: string) => fullFormat.format(new Date(iso));

const prefixed = (prefix: string, subject: string) =>
  new RegExp(`^${prefix}:\\s`, "i").test(subject)
    ? subject
    : `${prefix}: ${subject}`;

export const replySubject = (subject: string) => prefixed("Re", subject);
export const forwardSubject = (subject: string) => prefixed("Fwd", subject);

/**
 * Whether an address is the person's own: `username@domain` or any
 * `username+tag@domain`, whatever the case.
 */
export const ownAddressTest =
  (username: string, domain: string) => (address: string) => {
    const [local = "", host = ""] = address.trim().toLowerCase().split("@");
    const name = username.toLowerCase();
    return (
      host === domain.toLowerCase() &&
      (local === name || local.startsWith(`${name}+`))
    );
  };

/**
 * Who a reply goes to: the sender of the email (or, replying to the
 * person's own email, its recipients), and with Reply all everyone else on
 * it except the person's own addresses.
 */
export const replyRecipients = (
  message: MailMessage,
  isOwn: (address: string) => boolean,
  all: boolean,
): {
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
} => {
  const unique = (addresses: ReadonlyArray<string>) => {
    const byKey = new Map<string, string>();
    for (const address of addresses)
      if (!isOwn(address)) byKey.set(address.toLowerCase(), address);
    return [...byKey.values()];
  };
  const to =
    message.direction === "out"
      ? unique(message.to.map((address) => address.address))
      : unique([message.from.address]);
  if (!all) return { to, cc: [] };
  const taken = new Set(to.map((address) => address.toLowerCase()));
  const cc = unique(
    [...(message.direction === "out" ? [] : message.to), ...message.cc].map(
      (address) => address.address,
    ),
  ).filter((address) => !taken.has(address.toLowerCase()));
  return { to, cc };
};

/** The replied email below the reply, each line marked with `>`. */
export const quotedReply = (message: MailMessage) =>
  `\n\nOn ${fullTime(message.receivedAt)}, ${addressLine(message.from)} wrote:\n${message.text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n")}`;

/** The forwarded email below the note, with its headers. */
export const forwardedBody = (message: MailMessage) =>
  [
    "",
    "",
    "---------- Forwarded message ----------",
    `From: ${addressLine(message.from)}`,
    `Date: ${fullTime(message.receivedAt)}`,
    `Subject: ${subjectText(message.subject)}`,
    `To: ${message.to.map(addressLine).join(", ")}`,
    ...(message.cc.length === 0
      ? []
      : [`Cc: ${message.cc.map(addressLine).join(", ")}`]),
    "",
    message.text,
  ].join("\n");
