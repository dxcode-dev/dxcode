import type { ProjectMailData } from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { copyText } from "../../shared/copy-text.js";
import { MODE_LABELS, MODES } from "../../shared/mode-labels.js";
import { Button } from "../../shared/ui/button.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  type SettingsSelectOption,
  SettingsToggle,
} from "../../shared/ui/settings.js";
import { mailErrorMessage } from "../mailbox/mailbox-queries.js";
import {
  projectMailQueryOptions,
  updateProjectMailMutationOptions,
} from "./project-mail-queries.js";
import "./project-email-settings.css";

type EnabledProjectMail = Extract<ProjectMailData, { readonly enabled: true }>;

/** The select's value for `agentMode: null`, the sender's own default. */
const SENDER_DEFAULT = "";

/**
 * Project Settings → Email: the viewer's own address for the Project, the
 * mode new Threads they start by email run in, and whether those are shared
 * with the workspace. Project Settings renders it only where the deployment
 * has a mail domain, so its request (which makes the address) runs only in
 * this section.
 */
export function ProjectEmailSettings({
  projectId,
  userId,
}: {
  readonly projectId: ProjectId;
  readonly userId: UserId;
}) {
  const mailbox = useQuery(projectMailQueryOptions(userId, projectId));
  return (
    <div className="project-settings-content project-email-settings">
      <SettingsHeading
        title="Email"
        description="Email this address from your sign-in email to start a thread in this project."
      />
      {mailbox.data === undefined ? (
        mailbox.error ? (
          <p className="project-settings-state" role="alert">
            Email settings could not be loaded.
          </p>
        ) : (
          <p className="project-settings-state">Loading…</p>
        )
      ) : !mailbox.data.enabled ? (
        <p className="project-settings-state">
          dx Mailbox is off for you. Turn it on in Settings → Experimental
          Features, where this dx offers it.
        </p>
      ) : (
        <ProjectEmailCards
          projectId={projectId}
          userId={userId}
          data={mailbox.data}
        />
      )}
    </div>
  );
}

function ProjectEmailCards({
  projectId,
  userId,
  data,
}: {
  readonly projectId: ProjectId;
  readonly userId: UserId;
  readonly data: EnabledProjectMail;
}) {
  const queryClient = useQueryClient();
  const update = useMutation(
    updateProjectMailMutationOptions(queryClient, userId, projectId),
  );
  // A pick shows at once while it saves; null is the sender's default.
  const pendingMode = update.isPending ? update.variables.agentMode : undefined;
  const mode =
    pendingMode === undefined
      ? (data.agentMode ?? SENDER_DEFAULT)
      : (pendingMode ?? SENDER_DEFAULT);
  // The built-in modes only: a viewer's own plugin agents are not the
  // sender's.
  const modeOptions: ReadonlyArray<SettingsSelectOption> = [
    [SENDER_DEFAULT, "Sender's default"],
    ...MODES.map((id): SettingsSelectOption => [id, MODE_LABELS[id]]),
  ];
  const shared =
    update.isPending && update.variables.visibility !== undefined
      ? update.variables.visibility === "workspace"
      : data.visibility === "workspace";
  const startThreads =
    update.isPending && update.variables.startThreads !== undefined
      ? update.variables.startThreads
      : data.startThreads;
  const error = update.isError
    ? mailErrorMessage(update.error, "The setting could not be saved.")
    : undefined;
  return (
    <SettingsCard>
      <SettingsRow
        title="Your address for this project"
        description={
          <code className="project-email-address">{data.address}</code>
        }
        control={
          <Button
            size="xs"
            variant="outline"
            onClick={() => void copyText(data.address, "Email address")}
          >
            <Copy aria-hidden="true" />
            Copy
          </Button>
        }
      />
      <SettingsRow
        title="Start threads from email"
        description="Your own email to your address here starts a thread, and your replies continue it. It must come from your sign-in address, on a domain that signs its mail (DKIM with DMARC), as Gmail and most providers do. Off, the email is only filed under this project."
        control={
          <SettingsToggle
            label="Start threads from email"
            checked={startThreads}
            pending={
              update.isPending && update.variables.startThreads !== undefined
            }
            disabled={!data.canManage || update.isPending}
            onCheckedChange={(checked) =>
              update.mutate({ startThreads: checked })
            }
          />
        }
      />
      <SettingsRow
        title="New threads run in mode"
        control={
          <SettingsSelect
            label="New threads run in mode"
            value={mode}
            disabled={!data.canManage || update.isPending}
            options={modeOptions}
            onValueChange={(value) =>
              update.mutate({
                agentMode: MODES.find((id) => id === value) ?? null,
              })
            }
          />
        }
      />
      {data.workspace ? (
        <SettingsRow
          title="Share new threads with the workspace"
          description="Workspace members can open threads started by email."
          control={
            <SettingsToggle
              label="Share new threads with the workspace"
              checked={shared}
              pending={
                update.isPending && update.variables.visibility !== undefined
              }
              disabled={!data.canManage || update.isPending}
              onCheckedChange={(checked) =>
                update.mutate({
                  visibility: checked ? "workspace" : "private",
                })
              }
            />
          }
        />
      ) : null}
      {error === undefined ? null : (
        <p className="project-email-error" role="alert">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}
