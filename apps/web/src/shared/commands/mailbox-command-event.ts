/**
 * The Mail's keyboard actions. The command registry dispatches them as a
 * document event, with `{ action }` as its detail, and the open Mail page
 * acts on them. Its own module, so the page does not load the command
 * provider with it.
 */
export const MAILBOX_COMMAND_EVENT = "dx-mailbox-command";

export type MailboxCommand =
  | "next"
  | "previous"
  | "close"
  | "archive"
  | "spam"
  | "unread"
  | "reply"
  | "reply-all"
  | "forward"
  | "compose"
  | "search";

export const requestMailboxCommand = (action: MailboxCommand) =>
  document.dispatchEvent(
    new CustomEvent(MAILBOX_COMMAND_EVENT, { detail: { action } }),
  );

/** Runs `run` for each Mail action until the returned cleanup. */
export const onMailboxCommand = (run: (action: MailboxCommand) => void) => {
  const listener = (event: Event) => {
    const action = (event as CustomEvent<{ action?: MailboxCommand }>).detail
      ?.action;
    if (action !== undefined) run(action);
  };
  document.addEventListener(MAILBOX_COMMAND_EVENT, listener);
  return () => document.removeEventListener(MAILBOX_COMMAND_EVENT, listener);
};
