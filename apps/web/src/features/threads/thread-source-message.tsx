import type { MessageAuthor, MessageAutomation } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Clock, FileText, MessagesSquare } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
import { GitHubEventRows } from "./automations/github-event-rows.js";
import {
  MessageAuthorLabel,
  useMessageAuthor,
} from "./sharing/message-authors.js";
import { threadQueryOptions } from "./thread-queries.js";
import { TranscriptMarkdown } from "./transcript-markdown.js";

/**
 * A message another of the owner's Threads sent with a Thread tool: one
 * collapsed line naming that Thread, opening to the message. Agents write
 * Markdown, so the message renders as Markdown. A Space's request that
 * started this Thread shows as the person's who asked it (`author`).
 */
export function ThreadSourceMessage(props: {
  readonly sourceThreadId: string;
  readonly text: string;
  /** Sent while this Thread worked; it joins the running turn. */
  readonly pending: boolean;
  /** Whom the message's author tag names. */
  readonly author?: MessageAuthor;
  readonly sentAt?: string;
}) {
  return <CollapsedThreadMessage {...props} />;
}

/**
 * What a Space asked this Thread on someone's behalf: their message, under
 * their name and avatar, with a quiet link to the Space that started it.
 */
function SpaceRequestMessage({
  spaceThreadId,
  spaceName,
  author,
  sentAt,
  text,
}: {
  readonly spaceThreadId: string;
  readonly spaceName: string;
  readonly author: MessageAuthor;
  readonly sentAt?: string;
  readonly text: string;
}) {
  const { identity } = useAuthenticatedIdentity();
  const resolved = useMessageAuthor(author, true, sentAt) ?? {
    userId: author.userId,
    name: author.name,
    ...(sentAt === undefined ? {} : { sentAt }),
    mine: author.userId === identity.id,
  };
  return (
    <div className="thread-request-message">
      <MessageAuthorLabel author={resolved} />
      <div className="message-text">
        <TranscriptMarkdown streaming={false}>{text}</TranscriptMarkdown>
      </div>
      <Link
        className="thread-request-source"
        to="/threads/$threadId"
        params={{ threadId: spaceThreadId }}
      >
        Started in {spaceName}
      </Link>
    </div>
  );
}

function CollapsedThreadMessage({
  sourceThreadId,
  text,
  pending,
  author,
  sentAt,
}: {
  readonly sourceThreadId: string;
  readonly text: string;
  readonly pending: boolean;
  readonly author?: MessageAuthor;
  readonly sentAt?: string;
}) {
  const { identity } = useAuthenticatedIdentity();
  const [open, setOpen] = React.useState(false);
  // Only the title and kind are needed: read them once, without the detail
  // query's readiness polling or refetches. Members of a shared Thread may
  // not read the owner's other Threads; their one 404 is not retried.
  const source = useQuery({
    ...threadQueryOptions(identity.id, sourceThreadId as ThreadId),
    select: (thread) => ({ title: thread.title, kind: thread.kind }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  }).data;
  const title = source?.title;
  if (source?.kind === "space" && author !== undefined && title !== undefined)
    return (
      <SpaceRequestMessage
        spaceThreadId={sourceThreadId}
        spaceName={title}
        author={author}
        {...(sentAt === undefined ? {} : { sentAt })}
        text={text}
      />
    );
  const name = title ?? "another thread";
  return (
    <div className="thread-source-message" data-open={open ? "" : undefined}>
      <button
        type="button"
        className="thread-source-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <SubthreadIcon strokeWidth={2} />
        <span>Message from {name}</span>
        {pending ? <small>Steering</small> : null}
        <ChevronDown className="thread-source-chevron" aria-hidden />
      </button>
      {open ? (
        <div className="thread-source-body">
          {pending ? (
            <p className="thread-source-pending">
              The agent reads this message at its next step; it shows here then.
            </p>
          ) : (
            <div className="message-text">
              <TranscriptMarkdown streaming={false}>{text}</TranscriptMarkdown>
            </div>
          )}
          {title === undefined ? null : (
            <Link
              className="thread-source-link"
              to="/threads/$threadId"
              params={{ threadId: sourceThreadId }}
            >
              <span>Open {title}</span>
            </Link>
          )}
        </div>
      ) : null}
    </div>
  );
}

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
  return (
    <div className="thread-source-message" data-open={open ? "" : undefined}>
      <button
        type="button"
        className="thread-source-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {artifact ? <FileText strokeWidth={2} /> : <Clock strokeWidth={2} />}
        <span>
          {artifact ? "Artifact ask ticked or answered" : "Scheduled wake-up"}
        </span>
        {pending ? <small>Steering</small> : null}
        <ChevronDown className="thread-source-chevron" aria-hidden />
      </button>
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
      <button
        type="button"
        className="thread-source-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MessagesSquare strokeWidth={2} />
        <span>{name} asked dx in a comment</span>
        {pending ? <small>Steering</small> : null}
        <ChevronDown className="thread-source-chevron" aria-hidden />
      </button>
      {open ? (
        <div className="thread-source-body">
          <p className="message-text">{text.replace(COMMENTED_MESSAGE, "")}</p>
        </div>
      ) : null}
    </div>
  );
}
