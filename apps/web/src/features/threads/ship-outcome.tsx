import { parseMessageAuthor } from "@dx/api";
import { shipWorkflowOf, type ThreadId } from "@dx/domain";
import type { FlueConversationMessage, UseFlueAgentResult } from "@flue/react";
import { Archive, GitPullRequest } from "lucide-react";
import { useOptionalThreadArchive } from "../../shared/thread-archive.js";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import {
  type AgentSource,
  useAgentSelection,
} from "./use-frame-coalesced-agent-session.js";
import "./ship-outcome.css";

type ShipOutcome =
  | { readonly kind: "ship" }
  | { readonly kind: "push"; readonly url: string; readonly create: boolean };

const URL_PATTERN = /https?:\/\/[^\s<>()[\]{}"'`]+/g;
// After the repository's own path: a pull request, merge request, or the
// page that opens one, on GitHub, GitLab, or Bitbucket.
const OPEN_PATH =
  /^\/(?:-\/)?(?:pull|merge_requests|pull-requests)\/\d+(?:\/|$)/;
const CREATE_PATH =
  /^\/(?:(?:-\/)?(?:pull|merge_requests|pull-requests)\/new(?:\/|$)|compare\/)/;

const textOf = (message: FlueConversationMessage) =>
  message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");

const parsed = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

const segments = (path: string) =>
  path
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.toLowerCase());

/**
 * The last URL in a run's replies that is a pull request of the project's
 * own repository, and whether it opens a new one. A link to any other host
 * or repository is never shown: the reply may quote it, or repository
 * content may have put it there.
 */
const lastPullRequest = (text: string, repositoryUrl: string) => {
  const repository = parsed(repositoryUrl);
  if (repository === undefined) return undefined;
  const repositoryPath = segments(repository.pathname);
  if (repositoryPath.length < 2) return undefined;
  let found: { readonly url: string; readonly create: boolean } | undefined;
  for (const [match] of text.matchAll(URL_PATTERN)) {
    const url = parsed(match.replace(/[.,;:!?*_]+$/, ""));
    if (
      url === undefined ||
      url.origin !== repository.origin ||
      url.username !== "" ||
      url.password !== ""
    )
      continue;
    const path = url.pathname.split("/").filter((segment) => segment !== "");
    if (
      path.length <= repositoryPath.length ||
      repositoryPath.some(
        (segment, index) => path[index]?.toLowerCase() !== segment,
      )
    )
      continue;
    const rest = `/${path.slice(repositoryPath.length).join("/")}`;
    if (OPEN_PATH.test(rest)) found = { url: url.href, create: false };
    else if (CREATE_PATH.test(rest)) found = { url: url.href, create: true };
  }
  return found;
};

/**
 * What the last message's Ship or Push to Branch run left to do, once it
 * finished: nothing while it runs, after it failed or stopped, or once
 * anyone sends another message.
 */
const shipOutcome = (
  messages: ReadonlyArray<FlueConversationMessage>,
  active: boolean,
  repositoryUrl: string | undefined,
): ShipOutcome | undefined => {
  if (active) return undefined;
  const start = messages.findLastIndex(({ role }) => role === "user");
  const sent = messages[start];
  if (sent === undefined || sent.purpose !== "user") return undefined;
  const workflow = shipWorkflowOf(parseMessageAuthor(textOf(sent)).text);
  if (workflow === undefined) return undefined;
  const after = messages.slice(start + 1);
  if (after.some(({ settlement }) => settlement !== undefined))
    return undefined;
  const replies = after.filter(({ role }) => role === "assistant");
  if (replies.length === 0) return undefined;
  if (workflow === "ship") return { kind: "ship" };
  const pullRequest =
    repositoryUrl === undefined
      ? undefined
      : lastPullRequest(replies.map(textOf).join("\n"), repositoryUrl);
  return pullRequest === undefined
    ? undefined
    : { kind: "push", ...pullRequest };
};

const sameOutcome = (
  previous: ShipOutcome | undefined,
  next: ShipOutcome | undefined,
) =>
  previous?.kind === next?.kind &&
  (previous?.kind !== "push" ||
    (next?.kind === "push" &&
      previous.url === next.url &&
      previous.create === next.create));

/**
 * Above the composer after a Ship or Push to Branch run: Archive for a
 * shipped Thread, or the pull request a pushed branch has or can open.
 */
export function ShipOutcomeActions({
  threadId,
  source,
  canArchive,
  repositoryUrl,
}: {
  readonly threadId: ThreadId;
  readonly source: AgentSource<Pick<UseFlueAgentResult, "messages" | "status">>;
  /** Only the Thread's owner archives it. */
  readonly canArchive: boolean;
  /** The project repository's web page; links go only to its pull requests. */
  readonly repositoryUrl: string | undefined;
}) {
  const outcome = useAgentSelection(
    source,
    (agent) =>
      shipOutcome(
        agent.messages,
        agent.status === "submitted" || agent.status === "streaming",
        repositoryUrl,
      ),
    sameOutcome,
  );
  const archive = useOptionalThreadArchive();
  if (outcome === undefined) return null;
  if (outcome.kind === "ship") {
    if (!canArchive || archive === undefined) return null;
    return (
      <div className="ship-outcome-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={archive.pendingThreadId === threadId}
          // Archived after its Ship run, its work counts as shipped.
          onClick={() => archive.setArchived(threadId, true, false, "ship")}
        >
          <Archive aria-hidden="true" />
          Archive
        </Button>
      </div>
    );
  }
  return (
    <div className="ship-outcome-actions">
      <a
        className={buttonVariants({ variant: "outline", size: "sm" })}
        href={outcome.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <GitPullRequest aria-hidden="true" />
        {outcome.create ? "Create Pull Request" : "Open Pull Request"}
      </a>
    </div>
  );
}
