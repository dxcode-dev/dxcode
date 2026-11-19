import type { ProjectMailData } from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { copyText } from "../../shared/copy-text.js";
import { Button } from "../../shared/ui/button.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
} from "../../shared/ui/settings.js";
import { projectMailQueryOptions } from "./project-mail-queries.js";
import "./project-email-settings.css";

type EnabledProjectMail = Extract<ProjectMailData, { readonly enabled: true }>;

/**
 * Project Settings → Email: the viewer's own address for the Project. Mail
 * sent to it is filed under the Project in their Mail; it starts nothing by
 * itself (Start thread in Mail does). Project Settings renders it only
 * where the deployment has a mail domain, so its request (which makes the
 * address) runs only in this section.
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
        description="Mail sent to this address is filed under this project in your Mail. To work on an email, open it in Mail and choose Start thread."
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
          dx Mail is off for you. Turn it on in Settings → Experimental
          Features, where this dx offers it.
        </p>
      ) : (
        <ProjectEmailCards data={mailbox.data} />
      )}
    </div>
  );
}

function ProjectEmailCards({ data }: { readonly data: EnabledProjectMail }) {
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
    </SettingsCard>
  );
}
