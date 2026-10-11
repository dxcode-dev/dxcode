import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
import { threadQueryOptions } from "./thread-queries.js";
import { TranscriptMarkdown } from "./transcript-markdown.js";

/**
 * A message another of the owner's Threads sent with a Thread tool: one
 * collapsed line naming that Thread, opening to the message. Agents write
 * Markdown, so the message renders as Markdown.
 */
export function ThreadSourceMessage({
  sourceThreadId,
  text,
  pending,
}: {
  readonly sourceThreadId: string;
  readonly text: string;
  /** Sent while this Thread worked; it joins the running turn. */
  readonly pending: boolean;
}) {
  const { identity } = useAuthenticatedIdentity();
  const [open, setOpen] = React.useState(false);
  // Only the title is needed: read it once, without the detail query's
  // readiness polling or refetches. Members of a shared Thread may not read
  // the owner's other Threads; their one 404 is not retried.
  const title = useQuery({
    ...threadQueryOptions(identity.id, sourceThreadId as ThreadId),
    select: (thread) => thread.title,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  }).data;
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
