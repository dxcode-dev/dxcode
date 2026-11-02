import type { NeedsYouItem } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, X } from "lucide-react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { PageShell } from "../../shared/layout/page-shell.js";
import { issueIcon, pullIcon } from "../../shared/ui/github-status.js";
import { TimeText } from "../../shared/ui/time-text.js";
import {
  dismissNeedsYouMutationOptions,
  needsYouQueryOptions,
} from "../notifications/needs-you-queries.js";
// The page list and empty state are Your Reports' (bug-reports-*).
import "../threads/bug-reports/bug-reports.css";
import { age, exactTime } from "./inbox-time.js";
import { NEEDS_YOU_KIND } from "./needs-you-kind.js";
import "./needs-you-inbox.css";
import "./needs-you-page.css";

/** Where the ask's own link points, such as `github.com`. */
const linkHost = (url: string) => {
  const parsed = URL.parse(url);
  return parsed === null ? url : parsed.host;
};

/**
 * Whether a URL is the linked issue or PR: GitHub serves one number at both
 * `/issues/<n>` and `/pull/<n>`, so the repository and number decide.
 */
const sameGitHubItem = (
  link: { readonly repository: string; readonly number: number },
  url: string,
) => {
  const parsed = URL.parse(url);
  const path = parsed?.pathname.match(
    /^\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/,
  );
  return (
    parsed?.host === "github.com" &&
    path?.[1]?.toLowerCase() === link.repository.toLowerCase() &&
    Number(path?.[2]) === link.number
  );
};

/** One waiting ask: the Thread, its ask, and what it links to. */
function NeedsYouPageRow({
  item,
  onDismiss,
}: {
  readonly item: NeedsYouItem;
  readonly onDismiss: (item: NeedsYouItem) => void;
}) {
  const kind = NEEDS_YOU_KIND[item.kind];
  const Icon = kind.icon;
  const links = item.links ?? [];
  // The ask's own link, unless it is one of the linked issues or PRs.
  const askLink =
    item.url === undefined ||
    links.some((link) => sameGitHubItem(link, item.url ?? ""))
      ? undefined
      : item.url;
  return (
    <li className="needs-you-page-row" data-kind={item.kind}>
      <span className="needs-you-kind" title={kind.label}>
        <Icon aria-hidden />
      </span>
      <div className="needs-you-page-body">
        <div className="needs-you-page-heading">
          <Link
            to="/threads/$threadId"
            params={{ threadId: item.threadId }}
            className="needs-you-page-title"
          >
            {item.threadTitle}
          </Link>
          <time
            dateTime={item.requestedAt}
            title={`Waiting since ${exactTime.format(new Date(item.requestedAt))}`}
          >
            <TimeText text={(now) => age(item.requestedAt, now)} />
          </time>
        </div>
        <p className="needs-you-page-ask">
          {item.summary ?? "The last turn failed."}
        </p>
        <div className="needs-you-page-meta">
          <span>{kind.label}</span>
          {item.projectName === "" ? null : <span>{item.projectName}</span>}
          {links.map((link) => (
            <a
              key={`${link.repository}#${link.number}`}
              className="needs-you-page-link"
              href={link.url}
              target="_blank"
              rel="noreferrer"
              title={
                link.title === undefined
                  ? `${link.repository}#${link.number} (${link.state})`
                  : `${link.title} (${link.state})`
              }
            >
              {link.kind === "pull"
                ? pullIcon(link.state)
                : issueIcon(link.state === "open" ? "open" : "closed")}
              {link.repository}#{link.number}
            </a>
          ))}
          {askLink === undefined ? null : (
            <a
              className="needs-you-page-link"
              href={askLink}
              target="_blank"
              rel="noreferrer"
              title={askLink}
            >
              <ExternalLink aria-hidden />
              {linkHost(askLink)}
            </a>
          )}
        </div>
      </div>
      <button
        type="button"
        className="needs-you-action"
        aria-label={`Dismiss ${item.threadTitle}`}
        title="Dismiss"
        onClick={() => onDismiss(item)}
      >
        <X />
      </button>
    </li>
  );
}

/**
 * `/needs-you`: every Thread that waits on the person, newest ask first,
 * with its project, kind, linked issues and pull requests, and how long it
 * has waited. A Thread leaves when its next turn starts or on Dismiss.
 */
export function NeedsYouPage() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const list = useQuery(needsYouQueryOptions(identity.id));
  const dismiss = useMutation(
    dismissNeedsYouMutationOptions(queryClient, identity.id),
  );
  const items = list.data?.items ?? [];
  return (
    <PageShell
      title={
        <strong className="needs-you-page-heading-title">
          Needs you
          {list.isSuccess ? (
            <span className="notification-count">{items.length}</span>
          ) : null}
        </strong>
      }
      contentClassName="bug-reports-content"
    >
      {list.isPending ? (
        <DxLoading label="Loading what waits on you…" />
      ) : list.isError && items.length === 0 ? (
        <div className="empty-state bug-reports-empty" role="alert">
          <strong>Needs you could not be loaded.</strong>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state bug-reports-empty">
          <strong>Nothing waits on you</strong>
          <span>
            Threads that wait on your answer, approval, or a failed turn show up
            here.
          </span>
        </div>
      ) : (
        <ul className="bug-reports-list" aria-label="Needs you">
          {items.map((item) => (
            <NeedsYouPageRow
              key={item.threadId}
              item={item}
              onDismiss={(dismissed) => dismiss.mutate(dismissed.threadId)}
            />
          ))}
        </ul>
      )}
    </PageShell>
  );
}
