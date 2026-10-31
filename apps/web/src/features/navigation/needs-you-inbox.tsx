import { Popover } from "@base-ui/react/popover";
import type { NeedsYouItem } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Hand,
  MessageCircleQuestion,
  X,
} from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { TimeText } from "../../shared/ui/time-text.js";
import {
  dismissNeedsYouMutationOptions,
  needsYouQueryOptions,
} from "../notifications/needs-you-queries.js";
import { age, exactTime } from "./inbox-time.js";
import "./notification-inbox.css";
import "./needs-you-inbox.css";

const KIND = {
  question: { icon: MessageCircleQuestion, label: "Question" },
  approval: { icon: CircleCheck, label: "Approval" },
  failed: { icon: CircleAlert, label: "Failed" },
} as const;

function NeedsYouRow({
  item,
  onOpen,
  onDismiss,
}: {
  readonly item: NeedsYouItem;
  readonly onOpen: () => void;
  readonly onDismiss: (item: NeedsYouItem) => void;
}) {
  const kind = KIND[item.kind];
  const Icon = kind.icon;
  const ask = item.summary ?? "The last turn failed.";
  return (
    <div className="needs-you-row" data-kind={item.kind}>
      <Link
        to="/threads/$threadId"
        params={{ threadId: item.threadId }}
        className="notification-row"
        onClick={onOpen}
      >
        <span className="needs-you-kind" title={kind.label}>
          <Icon aria-hidden />
          <span className="sr-only">{kind.label}</span>
        </span>
        <span className="notification-row-body">
          <span className="notification-row-heading">
            <strong>{item.threadTitle}</strong>
            <time
              dateTime={item.requestedAt}
              title={exactTime.format(new Date(item.requestedAt))}
            >
              <TimeText text={(now) => age(item.requestedAt, now)} />
            </time>
          </span>
          <span className="notification-excerpt" title={ask}>
            {item.projectName === "" ? null : (
              <span className="needs-you-project">{item.projectName} · </span>
            )}
            {ask}
          </span>
        </span>
      </Link>
      <span className="needs-you-actions">
        {item.url === undefined ? null : (
          <a
            className="needs-you-action"
            href={item.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open the link for ${item.threadTitle}`}
            title={item.url}
          >
            <ExternalLink />
          </a>
        )}
        <button
          type="button"
          className="needs-you-action"
          aria-label={`Dismiss ${item.threadTitle}`}
          title="Dismiss"
          onClick={() => onDismiss(item)}
        >
          <X />
        </button>
      </span>
    </div>
  );
}

/**
 * The button beside Mentions: the person's Threads that wait on them across
 * every Project, newest ask first. A Thread leaves the list when its next
 * turn starts or when it is dismissed here.
 */
export function NeedsYouInbox({
  userId,
  onNavigate,
}: {
  readonly userId: UserId;
  readonly onNavigate: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const list = useQuery(needsYouQueryOptions(userId));
  const dismiss = useMutation(
    dismissNeedsYouMutationOptions(queryClient, userId),
  );
  const items = list.data?.items ?? [];
  const count = items.length;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button
            aria-label={count === 0 ? "Needs you" : `Needs you, ${count}`}
            title="Needs you"
            variant="ghost"
            size="icon-xs"
            className="needs-you-trigger"
            data-count={count > 0 ? "" : undefined}
          />
        }
      >
        <Hand />
        {count > 0 ? (
          <span className="needs-you-count" aria-hidden>
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="notification-positioner"
          side="bottom"
          align="start"
          sideOffset={6}
        >
          <Popover.Popup className="notification-popup" aria-label="Needs you">
            <header className="notification-header">
              <Popover.Title className="notification-title">
                Needs you
              </Popover.Title>
              <span className="notification-count">{count}</span>
            </header>
            {list.isPending ? (
              <p className="notification-empty">Loading…</p>
            ) : list.isError && items.length === 0 ? (
              <p className="notification-empty" role="alert">
                Needs you could not be loaded.
              </p>
            ) : items.length === 0 ? (
              <p className="notification-empty">
                Threads that wait on your answer, approval, or a failed turn
                show up here.
              </p>
            ) : (
              <div className="notification-list">
                {items.map((item) => (
                  <NeedsYouRow
                    key={item.threadId}
                    item={item}
                    onOpen={() => {
                      setOpen(false);
                      onNavigate();
                    }}
                    onDismiss={(dismissed) =>
                      dismiss.mutate(dismissed.threadId)
                    }
                  />
                ))}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
