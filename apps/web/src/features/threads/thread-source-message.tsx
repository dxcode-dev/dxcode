import type { MessageAuthor } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DisclosureTrigger } from "../../shared/ui/disclosure.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
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
      <DisclosureTrigger
        className="thread-source-toggle"
        expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <SubthreadIcon strokeWidth={2} />
        <span>Message from {name}</span>
        {pending ? <small>Steering</small> : null}
      </DisclosureTrigger>
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
