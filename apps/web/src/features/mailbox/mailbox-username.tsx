import {
  normalizePersonalAccountUsername,
  personalAccountUsernameChoiceProblem,
  personalAccountUsernameProblem,
  type UserId,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { Card } from "../../shared/ui/card.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import { Field } from "../../shared/ui/field.js";
import { Input } from "../../shared/ui/input.js";
import { personalAccountQueryOptions } from "../settings/account/personal-account-queries.js";
import {
  changeMailUsernameMutationOptions,
  type EnabledMailbox,
  mailErrorMessage,
} from "./mailbox-queries.js";

/**
 * Picks a username, and with it the address `username@<domain>`. The typed
 * name previews as the address; a name the server refuses shows its words.
 */
function UsernameForm({
  userId,
  mailbox,
  submitLabel,
  onDone,
  onCancel,
}: {
  readonly userId: UserId;
  readonly mailbox: EnabledMailbox;
  readonly submitLabel: string;
  readonly onDone?: () => void;
  readonly onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const account = useQuery(personalAccountQueryOptions(userId));
  const change = useMutation(
    changeMailUsernameMutationOptions(queryClient, userId),
  );
  const [typed, setTyped] = React.useState(
    mailbox.needsUsername ? "" : mailbox.username,
  );
  const [touched, setTouched] = React.useState(false);
  const username = normalizePersonalAccountUsername(typed);
  const unchanged = username === mailbox.username && !mailbox.needsUsername;
  // The server's rules as typed, reserved and placeholder names included,
  // as account settings checks them.
  const problem =
    personalAccountUsernameProblem(typed) ??
    (unchanged ? undefined : personalAccountUsernameChoiceProblem(typed));
  const error = change.isError
    ? mailErrorMessage(change.error, "Your username could not be changed.")
    : touched
      ? problem
      : undefined;
  const id = React.useId();
  return (
    <form
      className="mailbox-username-form"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (problem !== undefined || unchanged || account.data === undefined)
          return;
        change.mutate(
          { displayName: account.data.displayName, username },
          { onSuccess: () => onDone?.() },
        );
      }}
    >
      <Field
        id={`${id}-username`}
        label="Username"
        error={error}
        hint={
          <>
            Your address:{" "}
            <strong>
              {username === "" ? "username" : username}@{mailbox.domain}
            </strong>
          </>
        }
      >
        <div className="mailbox-username-input">
          <Input
            id={`${id}-username`}
            size="md"
            autoFocus
            autoComplete="username"
            spellCheck={false}
            maxLength={32}
            value={typed}
            aria-invalid={error === undefined ? undefined : true}
            disabled={change.isPending}
            onChange={(event) => {
              setTyped(event.target.value);
              if (change.isError) change.reset();
            }}
            onBlur={() => setTouched(typed !== "")}
          />
          <span className="mailbox-username-domain">@{mailbox.domain}</span>
        </div>
      </Field>
      <div className="mailbox-username-actions">
        {onCancel === undefined ? null : (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          busy={change.isPending}
          aria-disabled={unchanged || account.data === undefined || undefined}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * Before Mail opens, a person with a placeholder or reserved
 * username picks one. That pick does not use up their one change.
 */
export function MailboxUsernamePick({
  userId,
  mailbox,
}: {
  readonly userId: UserId;
  readonly mailbox: EnabledMailbox;
}) {
  return (
    <div className="mailbox-welcome">
      <Card variant="raised" padding="md" className="mailbox-welcome-card">
        <Mail className="mailbox-address-icon" aria-hidden="true" />
        <h1 className="mailbox-welcome-title">Pick your dx address</h1>
        <p className="mailbox-welcome-copy">
          Your Mail needs a username first. You and your agents share this
          address. Picking it now doesn't use up your one username change.
        </p>
        <UsernameForm
          userId={userId}
          mailbox={mailbox}
          submitLabel="Open Mail"
        />
      </Card>
    </div>
  );
}

/** Changes the username once; after that it is fixed. */
export function ChangeUsernameDialog({
  userId,
  mailbox,
  open,
  onOpenChange,
}: {
  readonly userId: UserId;
  readonly mailbox: EnabledMailbox;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className="mailbox-dialog">
        <DialogTitle className="mailbox-dialog-title">
          Change your username
        </DialogTitle>
        <DialogDescription className="mailbox-dialog-description">
          You can change it once; after that it is fixed. Mail to{" "}
          <strong>{mailbox.address}</strong> keeps reaching you.
        </DialogDescription>
        <UsernameForm
          userId={userId}
          mailbox={mailbox}
          submitLabel="Change username"
          onDone={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </DialogRoot>
  );
}
