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
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { usePageVisible } from "../../../shared/hooks/use-page-visible.js";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import {
  threadPortalsQueryOptions,
  usePortalPublicLink,
  useWakePortals,
} from "./portals-queries.js";
import "./portals.css";
import {
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { useThreadWorkspaceStatus } from "../realtime/realtime-provider.js";

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
      tone={link === undefined ? undefined : "success"}
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
    <MenuRoot>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="thread-portals-public-trigger"
            tone={link === undefined ? undefined : "success"}
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
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuLabel>
            {link === undefined
              ? "Anyone with the link can open it"
              : `Public until ${until(link)}`}
          </MenuLabel>
          {DURATIONS.map(([duration, label]) => (
            <MenuItem key={duration} onClick={() => onChange(port, duration)}>
              Public for {label}
            </MenuItem>
          ))}
        </MenuGroup>
        {link === undefined ? null : (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onChange(port, "private")}>
              Make private
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </MenuRoot>
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

/** Wakes the workspace once, when it mounts; keyed by the attention it serves. */
function AutoWake({ onWake }: { readonly onWake: () => void }) {
  useMountEffect(onWake);
  return null;
}

/** What a row says about its port besides its number. */
const portalStatus = (portal: ThreadPortal) =>
  [
    portal.listening
      ? undefined
      : portal.declared
        ? "Starts when opened"
        : "Not running",
    portal.declared ? undefined : "Not in .dx/services.yaml",
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

export function ThreadPortalsPane({
  threadId,
  active,
}: {
  readonly threadId: ThreadId;
  readonly active: boolean;
}) {
  const [chosen, setChosen] = React.useState<ThreadPortal>();
  const [frameGeneration, setFrameGeneration] = React.useState(0);
  const [copiedPort, setCopiedPort] = React.useState<number>();
  const [announcement, setAnnouncement] = React.useState("");
  const visible = usePageVisible();
  const workspaceStatus = useThreadWorkspaceStatus(threadId);
  const portals = useQuery(threadPortalsQueryOptions(threadId, active));
  const publicLink = usePortalPublicLink(threadId);
  const wake = useWakePortals(threadId);

  // Each time someone turns to the Portal (the pane shows, or the browser
  // tab comes back), a paused workspace wakes once. A workspace that falls
  // asleep while nobody looks stays asleep, so a forgotten tab cannot keep
  // it awake.
  const attentive = active && visible;
  const [attention, setAttention] = React.useState({
    attentive,
    generation: 0,
  });
  if (attention.attentive !== attentive)
    setAttention({
      attentive,
      generation: attention.generation + (attentive ? 1 : 0),
    });
  const [wokenGeneration, setWokenGeneration] = React.useState<number>();

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
  const rows: ReadonlyArray<ThreadPortal> = data?.portals ?? [];
  // The open port as the list last reported it, so its state stays live.
  const selected =
    chosen === undefined
      ? undefined
      : (rows.find(({ port }) => port === chosen.port) ?? chosen);
  // The open port started listening: load it again instead of leaving the
  // "Nothing is listening" page up.
  if (
    selected !== undefined &&
    chosen !== undefined &&
    selected.listening !== chosen.listening
  ) {
    setChosen(selected);
    if (selected.listening) setFrameGeneration((generation) => generation + 1);
  }
  const failedPort =
    publicLink.isError && publicLink.variables !== undefined
      ? publicLink.variables.port
      : undefined;

  const autoWake =
    attentive &&
    data?.workspace === "paused" &&
    wokenGeneration !== attention.generation &&
    !wake.isPending ? (
      <AutoWake
        key={attention.generation}
        onWake={() => {
          setWokenGeneration(attention.generation);
          wake.mutate();
        }}
      />
    ) : null;

  const hint = (portal: ThreadPortal) => {
    if (portal.port === failedPort)
      return (
        <span className="thread-portals-hint" role="alert">
          {publicLink.error instanceof Error
            ? publicLink.error.message
            : "Could not change the link."}
        </span>
      );
    const link = links.get(portal.port);
    const parts = [
      portalStatus(portal),
      link === undefined ? "" : `Public until ${until(link)}`,
    ].filter((part) => part !== "");
    return parts.length === 0 ? null : (
      <span className="thread-portals-hint">{parts.join(" · ")}</span>
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
            onClick={() => setChosen(undefined)}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <span className="thread-portals-address" title={selected.url}>
            {selected.url}
          </span>
          {hint(selected)}
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
            (and stops keeping the workspace awake); the port stays chosen.
            Loading it wakes a paused workspace. */}
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

  const waking =
    wake.isPending ||
    workspaceStatus !== undefined ||
    (data?.workspace === "paused" &&
      !wake.isError &&
      wokenGeneration !== attention.generation);
  const empty =
    data === undefined
      ? portals.isError
        ? "Ports could not load."
        : "Loading ports…"
      : rows.length > 0
        ? undefined
        : data.workspace === "running"
          ? "No Portals yet. Declare a server in .dx/services.yaml, or open a Portal link."
          : waking
            ? "Waking the workspace…"
            : data.workspace === "paused"
              ? wake.isError
                ? "The workspace could not be woken."
                : "The workspace is asleep. It wakes when you come back to this tab."
              : "Ports are unavailable right now.";
  const notice =
    data?.servicesFile === "invalid"
      ? "dx can't read .dx/services.yaml, so its services are not listed. Check the file for errors."
      : undefined;

  return (
    <div className="thread-portals-pane">
      {autoWake}
      {notice === undefined ? null : (
        <p className="thread-portals-notice" role="status">
          {notice}
        </p>
      )}
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
          ) : data?.workspace === "paused" && !waking ? (
            <Button size="xs" variant="outline" onClick={() => wake.mutate()}>
              Wake now
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
                onClick={() => setChosen(portal)}
              >
                <AppWindow aria-hidden="true" />
                <span>{portal.port}</span>
                {portal.name === undefined ? null : (
                  <span className="thread-portals-name">{portal.name}</span>
                )}
                {hint(portal)}
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
