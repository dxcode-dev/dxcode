import { Menu } from "@base-ui/react/menu";
import type {
  ThreadPortal,
  ThreadPortalPublicDuration,
  ThreadPortalPublicLink,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Globe,
  RotateCw,
} from "lucide-react";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import {
  threadPortalsQueryOptions,
  usePortalPublicLink,
  useWakePortals,
} from "./portals-queries.js";
import "./portals.css";

// The guest is another site: it may run scripts, keep its own cookies, and
// open popups, but never navigate the dx tab.
const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

const DURATIONS: ReadonlyArray<readonly [ThreadPortalPublicDuration, string]> =
  [
    ["1h", "1 hour"],
    ["1d", "1 day"],
    ["7d", "7 days"],
  ];

const untilFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const until = (link: ThreadPortalPublicLink) =>
  untilFormat.format(new Date(link.expiresAt.epochMilliseconds));

type PublicChange = (
  port: number,
  duration: ThreadPortalPublicDuration | "private",
) => void;

const OWNER_ONLY = "Only the Thread's owner can make a port public.";

/**
 * A member sees the globe too, disabled, so the control is not just
 * missing: it says whether the port is public and who can change that.
 */
function PublicStatus({
  port,
  link,
}: {
  readonly port: number;
  readonly link: ThreadPortalPublicLink | undefined;
}) {
  const state =
    link === undefined
      ? `Port ${port} is private.`
      : `Port ${port} is public until ${until(link)}.`;
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className="thread-portals-public-trigger"
      data-public={link === undefined ? undefined : ""}
      aria-disabled="true"
      aria-label={`${state} ${OWNER_ONLY}`}
      title={OWNER_ONLY}
    >
      <Globe aria-hidden="true" />
    </Button>
  );
}

/** The owner's control: make the port public for a while, or private. */
function PublicMenu({
  port,
  link,
  onChange,
}: {
  readonly port: number;
  readonly link: ThreadPortalPublicLink | undefined;
  readonly onChange: PublicChange;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="thread-portals-public-trigger"
            data-public={link === undefined ? undefined : ""}
            aria-label={
              link === undefined
                ? `Make port ${port} public`
                : `Port ${port} is public until ${until(link)}`
            }
            title={link === undefined ? "Make public" : "Public"}
          />
        }
      >
        <Globe aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup">
            <Menu.Group>
              <Menu.GroupLabel className="thread-portals-menu-label">
                {link === undefined
                  ? "Anyone with the link can open it"
                  : `Public until ${until(link)}`}
              </Menu.GroupLabel>
              {DURATIONS.map(([duration, label]) => (
                <Menu.Item
                  key={duration}
                  className="thread-menu-item"
                  onClick={() => onChange(port, duration)}
                >
                  Public for {label}
                </Menu.Item>
              ))}
            </Menu.Group>
            {link === undefined ? null : (
              <>
                <Menu.Separator className="thread-menu-separator" />
                <Menu.Item
                  className="thread-menu-item"
                  onClick={() => onChange(port, "private")}
                >
                  Make private
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function PortalActions({
  portal,
  link,
  canPublish,
  copied,
  onCopy,
  onPublicChange,
}: {
  readonly portal: ThreadPortal;
  readonly link: ThreadPortalPublicLink | undefined;
  readonly canPublish: boolean;
  readonly copied: boolean;
  readonly onCopy: (portal: ThreadPortal) => void;
  readonly onPublicChange: PublicChange;
}) {
  return (
    <>
      {canPublish ? (
        <PublicMenu port={portal.port} link={link} onChange={onPublicChange} />
      ) : (
        <PublicStatus port={portal.port} link={link} />
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={copied ? "Link copied" : `Copy link to port ${portal.port}`}
        title={copied ? "Copied" : "Copy link"}
        onClick={() => onCopy(portal)}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
      <a
        className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
        href={portal.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open port ${portal.port} in a new tab`}
        title="Open in new tab"
      >
        <ExternalLink aria-hidden="true" />
      </a>
    </>
  );
}

export function ThreadPortalsPane({
  threadId,
  active,
}: {
  readonly threadId: ThreadId;
  readonly active: boolean;
}) {
  const [selected, setSelected] = React.useState<ThreadPortal>();
  const [frameGeneration, setFrameGeneration] = React.useState(0);
  const [copiedPort, setCopiedPort] = React.useState<number>();
  const [announcement, setAnnouncement] = React.useState("");
  const portals = useQuery(
    threadPortalsQueryOptions(threadId, active && selected === undefined),
  );
  const publicLink = usePortalPublicLink(threadId);
  const wake = useWakePortals(threadId);

  const copy = async (portal: ThreadPortal) => {
    try {
      await navigator.clipboard.writeText(portal.url);
      setCopiedPort(portal.port);
      setAnnouncement(`Link to port ${portal.port} copied.`);
      setTimeout(
        () =>
          setCopiedPort((current) =>
            current === portal.port ? undefined : current,
          ),
        1_500,
      );
    } catch {
      setAnnouncement("Could not copy the link.");
    }
  };

  const changePublic: PublicChange = (port, duration) =>
    publicLink.mutate(
      { port, duration },
      {
        onSuccess: () =>
          setAnnouncement(
            duration === "private"
              ? `Port ${port} is private.`
              : `Port ${port} is public. Anyone with the link can open it.`,
          ),
      },
    );

  const data = portals.data;
  const canPublish = data?.canPublish === true;
  const links = new Map(
    (data?.publicLinks ?? []).map((link) => [link.port, link]),
  );
  // A public port stays listed while nothing listens on it, so it can be
  // made private.
  const rows: ReadonlyArray<ThreadPortal> = [
    ...(data?.portals ?? []),
    ...(data?.publicLinks ?? []).filter(
      (link) => !data?.portals.some(({ port }) => port === link.port),
    ),
  ]
    .map(({ port, url }) => ({ port, url }))
    .sort((left, right) => left.port - right.port);
  const failedPort =
    publicLink.isError && publicLink.variables !== undefined
      ? publicLink.variables.port
      : undefined;

  const hint = (port: number) => {
    if (port === failedPort)
      return (
        <span className="thread-portals-hint" role="alert">
          {publicLink.error instanceof Error
            ? publicLink.error.message
            : "Could not change the link."}
        </span>
      );
    const link = links.get(port);
    return link === undefined ? null : (
      <span className="thread-portals-hint">Public until {until(link)}</span>
    );
  };

  const live = (
    <span className="sr-only" aria-live="polite">
      {announcement}
    </span>
  );

  if (selected !== undefined)
    return (
      <div className="thread-portals-pane">
        <header className="thread-portals-toolbar">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Back to ports"
            title="Back to ports"
            onClick={() => setSelected(undefined)}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <span className="thread-portals-address" title={selected.url}>
            {selected.url}
          </span>
          {hint(selected.port)}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Reload"
            title="Reload"
            onClick={() => setFrameGeneration((generation) => generation + 1)}
          >
            <RotateCw aria-hidden="true" />
          </Button>
          <PortalActions
            portal={selected}
            link={links.get(selected.port)}
            canPublish={canPublish}
            copied={copiedPort === selected.port}
            onCopy={(portal) => void copy(portal)}
            onPublicChange={changePublic}
          />
        </header>
        {/* Unloaded while the tab is hidden so the guest page stops running
            (and stops keeping the workspace awake); the port stays chosen. */}
        {active ? (
          <iframe
            key={frameGeneration}
            className="thread-portals-frame"
            src={selected.url}
            title={`Port ${selected.port}`}
            sandbox={FRAME_SANDBOX}
            allow="clipboard-write"
          />
        ) : null}
        {live}
      </div>
    );

  const empty =
    data === undefined
      ? portals.isError
        ? "Ports could not load."
        : "Loading ports…"
      : rows.length > 0
        ? undefined
        : wake.isPending
          ? "Waking the workspace…"
          : data.workspace === "paused"
            ? wake.isError
              ? "The workspace could not be woken."
              : "The workspace is paused."
            : data.workspace === "unavailable"
              ? "Ports are unavailable right now."
              : "Nothing is listening. Start a server on 0.0.0.0 or 127.0.0.1.";

  return (
    <div className="thread-portals-pane">
      {empty !== undefined ? (
        <div className="thread-files-state" role="status">
          <span>{empty}</span>
          {portals.isError || data?.workspace === "unavailable" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void portals.refetch()}
            >
              Retry
            </Button>
          ) : data?.workspace === "paused" && !wake.isPending ? (
            <Button size="xs" variant="outline" onClick={() => wake.mutate()}>
              Wake workspace
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="thread-portals-list" aria-label="Ports">
          {rows.map((portal) => (
            <li className="thread-portals-row" key={portal.port}>
              <button
                type="button"
                className="thread-portals-open"
                title={`Preview port ${portal.port}`}
                onClick={() => setSelected(portal)}
              >
                <AppWindow aria-hidden="true" />
                <span>{portal.port}</span>
                {hint(portal.port)}
              </button>
              <PortalActions
                portal={portal}
                link={links.get(portal.port)}
                canPublish={canPublish}
                copied={copiedPort === portal.port}
                onCopy={(target) => void copy(target)}
                onPublicChange={changePublic}
              />
            </li>
          ))}
        </ul>
      )}
      {live}
    </div>
  );
}
