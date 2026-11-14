import type { MessageAutomation, MessagePlugin } from "@dx/api";
import { Clock, FileText, Globe, MessagesSquare } from "lucide-react";
import * as React from "react";
import { DisclosureTrigger } from "../../shared/ui/disclosure.js";
import { PluginIcon } from "../../shared/ui/plugin-icon.js";
import { TimeText } from "../../shared/ui/time-text.js";
import { GitHubEventRows } from "./automations/github-event-rows.js";
import { conciseAge } from "./sharing/sharing-format.js";
import { TranscriptMarkdown } from "./transcript-markdown.js";

/**
 * A message the Thread's schedule, a GitHub subscription, or a person's tick
 * or answer in an artifact delivered after a turn ended. A schedule wake-up
 * or an artifact wake is one collapsed line opening to its text; GitHub
 * events show one row each.
 */
export function AutomationMessage({
  automation,
  text,
  pending,
}: {
  readonly automation: MessageAutomation;
  readonly text: string;
  readonly pending: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  if (automation === "github")
    return <GitHubEventRows text={text} pending={pending} />;
  const artifact = automation === "artifact";
  const external = automation === "external";
  return (
    <div className="thread-source-message" data-open={open ? "" : undefined}>
      <DisclosureTrigger
        className="thread-source-toggle"
        expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {artifact ? (
          <FileText strokeWidth={2} />
        ) : external ? (
          <Globe strokeWidth={2} />
        ) : (
          <Clock strokeWidth={2} />
        )}
        <span>
          {artifact
            ? "From an artifact"
            : external
              ? "Sent from outside dx"
              : "Scheduled wake-up"}
        </span>
        {pending ? <small>Steering</small> : null}
      </DisclosureTrigger>
      {open ? (
        <div className="thread-source-body">
          <div className="message-text">
            <TranscriptMarkdown streaming={false}>{text}</TranscriptMarkdown>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The quote dx adds to a comment it sends the agent; the comment's panel shows it. */
const COMMENTED_MESSAGE =
  /\n*<dx_commented_message\b[^>]*>[\s\S]*?<\/dx_commented_message>\s*$/;

/**
 * A person's comment on a Space's message that asked dx: the comment stays
 * in that message's comments, so here it is one collapsed line opening to
 * what they wrote, and dx answers below it in the main chat.
 */
export function CommentPromptMessage({
  name,
  text,
  pending,
}: {
  readonly name: string;
  readonly text: string;
  readonly pending: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="thread-source-message" data-open={open ? "" : undefined}>
      <DisclosureTrigger
        className="thread-source-toggle"
        expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MessagesSquare strokeWidth={2} />
        <span>{name} asked dx in a comment</span>
        {pending ? <small>Steering</small> : null}
      </DisclosureTrigger>
      {open ? (
        <div className="thread-source-body">
          <p className="message-text">{text.replace(COMMENTED_MESSAGE, "")}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A message or note an installed plugin's code posted: the plugin's name in
 * place of a person's, so nobody reads it as the owner's own words, and the
 * text below. A note started no agent turn.
 */
export function PluginPostMessage({
  plugin,
  note,
  text,
  pending,
  sentAt,
}: {
  readonly plugin: MessagePlugin;
  readonly note: boolean;
  readonly text: string;
  readonly pending: boolean;
  readonly sentAt?: string;
}) {
  const kind = note ? "Note" : "Plugin";
  return (
    <div className="plugin-post-message">
      <div
        className="plugin-post-author"
        title={`Posted by the ${plugin.name} plugin${
          plugin.scope === "repository"
            ? " from the repository"
            : plugin.scope === "workspace"
              ? ", installed for the workspace"
              : ""
        }`}
      >
        <PluginIcon
          name={plugin.name}
          icon={
            plugin.iconHash === undefined ? undefined : { src: plugin.iconHash }
          }
          size={16}
          className="plugin-post-icon"
        />
        <span className="plugin-post-name">{plugin.name}</span>
        <span className="plugin-post-kind">{kind}</span>
        {plugin.scope === "personal" ? null : (
          <span className="plugin-post-kind">
            {plugin.scope === "workspace" ? "Workspace" : "Repository"}
          </span>
        )}
        {pending ? (
          <span className="plugin-post-kind">Steering</span>
        ) : sentAt === undefined ? null : (
          <time dateTime={sentAt} title={new Date(sentAt).toLocaleString()}>
            <TimeText text={(now) => conciseAge(sentAt, now)} />
          </time>
        )}
      </div>
      <div className="plugin-post-body message-text">
        <TranscriptMarkdown streaming={false}>{text}</TranscriptMarkdown>
      </div>
    </div>
  );
}
