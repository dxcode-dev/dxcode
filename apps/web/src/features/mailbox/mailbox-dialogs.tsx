import type { MailAgentAccess, MailMessage } from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import { Field } from "../../shared/ui/field.js";
import { Input } from "../../shared/ui/input.js";
import { Select } from "../../shared/ui/select.js";
import {
  SettingsCard,
  SettingsRow,
  SettingsSelect,
} from "../../shared/ui/settings.js";
import { Textarea } from "../../shared/ui/textarea.js";
import { projectsQueryOptions } from "../projects/project-queries.js";
import { addressName, isEmailAddress, subjectText } from "./mail-format.js";
import {
  type EnabledMailbox,
  mailErrorMessage,
  startThreadFromMailMutationOptions,
  updateMailboxSettingsMutationOptions,
} from "./mailbox-queries.js";
import { LabelNameForm } from "./mailbox-rail.js";

const ACCESS_OPTIONS: ReadonlyArray<readonly [MailAgentAccess, string]> = [
  ["all", "Everything except private"],
  ["project", "Only project addresses"],
  ["none", "Nothing"],
];

/**
 * Mailbox settings: the address, what the person's agents may read, the
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
          Mailbox settings
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

/**
 * Starts a Thread from one email: a Project and an instruction. The email
 * then links to the Thread it started.
 */
export function StartThreadDialog({
  userId,
  mailbox,
  message,
  onOpenChange,
}: {
  readonly userId: UserId;
  readonly mailbox: EnabledMailbox;
  readonly message: MailMessage;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(userId));
  const projects = (projectsQuery.data?.pages ?? []).flatMap(
    (page) => page.items,
  );
  const start = useMutation(
    startThreadFromMailMutationOptions(queryClient, userId),
  );
  const taggedProject = mailbox.projects.find(
    (project) => project.tag === message.tag,
  );
  const tagged = taggedProject?.projectId;
  // The email's own Project stays a choice even past the first page.
  const options: ReadonlyArray<readonly [string, string]> = [
    ...(taggedProject === undefined ||
    projects.some((project) => project.id === taggedProject.projectId)
      ? []
      : [[taggedProject.projectId, taggedProject.projectName] as const]),
    ...projects.map((project) => [project.id, project.name] as const),
  ];
  const [picked, setPicked] = React.useState<string>();
  const projectId = picked ?? tagged ?? projects[0]?.id;
  const [instruction, setInstruction] = React.useState("");
  const id = React.useId();
  const ready =
    projectId !== undefined && instruction.trim() !== "" && !start.isPending;
  return (
    <DialogRoot open onOpenChange={onOpenChange}>
      <DialogContent size="md" className="mailbox-dialog">
        <DialogTitle className="mailbox-dialog-title">
          Start a thread
        </DialogTitle>
        <DialogDescription className="mailbox-dialog-description">
          The agent gets “{subjectText(message.subject)}” from{" "}
          {addressName(message.from)} and your instruction.
        </DialogDescription>
        <form
          className="mailbox-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            start.mutate(
              {
                mailId: message.id,
                projectId: projectId as ProjectId,
                instruction: instruction.trim(),
              },
              {
                onSuccess: ({ threadId }) => {
                  onOpenChange(false);
                  toast.success("Thread started.", {
                    action: {
                      label: "Open",
                      onClick: () =>
                        void navigate({
                          to: "/threads/$threadId",
                          params: { threadId },
                        }),
                    },
                  });
                },
              },
            );
          }}
        >
          <Field id={`${id}-project`} label="Project">
            <Select
              id={`${id}-project`}
              size="md"
              value={projectId ?? ""}
              disabled={options.length === 0}
              onValueChange={setPicked}
              options={
                options.length === 0
                  ? [
                      [
                        "",
                        projectsQuery.isPending
                          ? "Loading projects…"
                          : "No projects",
                      ],
                    ]
                  : options
              }
            />
          </Field>
          <Field id={`${id}-instruction`} label="Instruction">
            <Textarea
              id={`${id}-instruction`}
              autoFocus
              rows={4}
              maxLength={20_000}
              placeholder="What should the agent do with this email?"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </Field>
          {start.isError ? (
            <p className="mailbox-dialog-error" role="alert">
              {mailErrorMessage(
                start.error,
                "The thread could not be started.",
              )}
            </p>
          ) : null}
          <div className="mailbox-dialog-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              busy={start.isPending}
              aria-disabled={!ready || undefined}
            >
              Start thread
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
