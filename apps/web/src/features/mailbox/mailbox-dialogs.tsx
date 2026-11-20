import type { MailAgentAccess } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import { Input } from "../../shared/ui/input.js";
import {
  SettingsCard,
  SettingsRow,
  SettingsSelect,
} from "../../shared/ui/settings.js";
import { isEmailAddress } from "./mail-format.js";
import {
  type EnabledMailbox,
  mailErrorMessage,
  updateMailboxSettingsMutationOptions,
} from "./mailbox-queries.js";
import { LabelNameForm } from "./mailbox-rail.js";

const ACCESS_OPTIONS: ReadonlyArray<readonly [MailAgentAccess, string]> = [
  ["all", "Everything except private"],
  ["project", "Only project addresses"],
  ["none", "Nothing"],
];

/**
 * Mail settings: the address, what the person's agents may read, the
 * senders whose mail is always private, and today's sending.
 */
export function MailboxSettingsDialog({
  userId,
  mailbox,
  open,
  onOpenChange,
  onChangeUsername,
}: {
  readonly userId: UserId;
  readonly mailbox: EnabledMailbox;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChangeUsername: () => void;
}) {
  const queryClient = useQueryClient();
  const update = useMutation(
    updateMailboxSettingsMutationOptions(queryClient, userId),
  );
  const [sender, setSender] = React.useState("");
  const senderProblem =
    sender.trim() !== "" && !isEmailAddress(sender)
      ? "Enter an email address."
      : undefined;
  const addSender = () => {
    const address = sender.trim().toLowerCase();
    if (address === "" || senderProblem !== undefined) return;
    update.mutate(
      { addPrivateSender: address },
      { onSuccess: () => setSender("") },
    );
  };
  const { limits } = mailbox;
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="mailbox-dialog mailbox-settings">
        <DialogTitle className="mailbox-dialog-title">
          Mail settings
        </DialogTitle>
        <SettingsCard>
          <SettingsRow
            title="Address"
            description={
              <code className="mailbox-settings-address">
                {mailbox.address}
              </code>
            }
            control={
              mailbox.canChangeUsername ? (
                <Button size="xs" variant="outline" onClick={onChangeUsername}>
                  Change username
                </Button>
              ) : undefined
            }
          />
          <SettingsRow
            title="Agents can read"
            description="Spam and private mail are never shown to agents."
            control={
              <SettingsSelect
                label="Agents can read"
                value={mailbox.agentAccess}
                options={ACCESS_OPTIONS}
                onValueChange={(value) => {
                  const access = ACCESS_OPTIONS.find(
                    ([id]) => id === value,
                  )?.[0];
                  if (access !== undefined)
                    update.mutate({ agentAccess: access });
                }}
              />
            }
          />
          <SettingsRow
            title="Sending"
            description={
              mailbox.canSend
                ? `${limits.sentToday} of ${limits.sendsPerDay} sent today`
                : (mailbox.sendingBlockedReason ?? "Sending is off.")
            }
          />
          <SettingsRow
            title="Private senders"
            description={
              <div className="mailbox-settings-group">
                <p>Mail from these senders is always private.</p>
                {mailbox.privateSenders.length === 0 ? null : (
                  <ul
                    className="mailbox-settings-list"
                    aria-label="Private senders"
                  >
                    {mailbox.privateSenders.map((address) => (
                      <li key={address}>
                        <span>{address}</span>
                        <Button
                          variant="subtle"
                          size="icon-xs"
                          aria-label={`Remove ${address}`}
                          onClick={() =>
                            update.mutate({ removePrivateSender: address })
                          }
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  className="mailbox-settings-add"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addSender();
                  }}
                >
                  <Input
                    size="sm"
                    type="email"
                    aria-label="Sender to keep private"
                    placeholder="bank@example.com"
                    value={sender}
                    aria-invalid={
                      senderProblem === undefined ? undefined : true
                    }
                    onChange={(event) => setSender(event.target.value)}
                  />
                  <Button
                    type="submit"
                    size="xs"
                    variant="outline"
                    aria-disabled={
                      sender.trim() === "" ||
                      senderProblem !== undefined ||
                      undefined
                    }
                  >
                    Add
                  </Button>
                </form>
              </div>
            }
          />
          {mailbox.labels.some((label) => label.kind === "user") ? (
            <SettingsRow
              title="Labels"
              description={
                <ul className="mailbox-settings-list" aria-label="Labels">
                  {mailbox.labels.flatMap((label) =>
                    label.kind === "user"
                      ? [
                          <SettingsLabelRow
                            key={label.id}
                            userId={userId}
                            labelId={label.id}
                            name={label.name}
                          />,
                        ]
                      : [],
                  )}
                </ul>
              }
            />
          ) : null}
        </SettingsCard>
        {update.isError ? (
          <p className="mailbox-dialog-error" role="alert">
            {mailErrorMessage(update.error, "The setting could not be saved.")}
          </p>
        ) : null}
      </DialogContent>
    </DialogRoot>
  );
}

function SettingsLabelRow({
  userId,
  labelId,
  name,
}: {
  readonly userId: UserId;
  readonly labelId: string;
  readonly name: string;
}) {
  const [renaming, setRenaming] = React.useState(false);
  return (
    <li>
      {renaming ? (
        <LabelNameForm
          userId={userId}
          ariaLabel={`Rename ${name}`}
          label={{ id: labelId, name, kind: "user", unread: 0 }}
          onDone={() => setRenaming(false)}
        />
      ) : (
        <>
          <span>{name}</span>
          <Button size="xs" variant="ghost" onClick={() => setRenaming(true)}>
            Rename
          </Button>
        </>
      )}
    </li>
  );
}

/** Names a new label, then applies it to the open conversation. */
export function NewLabelDialog({
  userId,
  open,
  onOpenChange,
  onCreated,
}: {
  readonly userId: UserId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (labelId: string) => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" className="mailbox-dialog">
        <DialogTitle className="mailbox-dialog-title">New label</DialogTitle>
        <LabelNameForm
          userId={userId}
          ariaLabel="Label name"
          onCreated={onCreated}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </DialogRoot>
  );
}
