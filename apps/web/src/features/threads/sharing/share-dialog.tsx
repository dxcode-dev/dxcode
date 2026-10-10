import { Menu } from "@base-ui/react/menu";
import type { ThreadDetailData } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  LockKeyhole,
  UsersRound,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { absoluteThreadUrl } from "../../../shared/thread-url.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { settingsContextQueryOptions } from "../../settings/settings-context-queries.js";
import { formatUntil } from "./sharing-format.js";
import { useUpdateThreadSharing } from "./sharing-mutations.js";
import "./thread-sharing.css";

type Access = "none" | "view" | "contribute";

const accessLabel: Record<Access, string> = {
  none: "No access",
  view: "View",
  contribute: "Contribute",
};

const MULTIPLAYER_CONSENT =
  "Everyone in your workspace will be able to view this thread, ask the agent to run commands and tools as you, and send messages using your credits until multiplayer ends.";

/**
 * "Enable Multiplayer for Thread?" Shown before Contribute unless the owner
 * chose "Don't ask me again".
 */
function MultiplayerConfirmDialog({
  open,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (skipNextTime: boolean) => void;
}) {
  const [skipNextTime, setSkipNextTime] = React.useState(false);
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <DialogContent className="thread-share-confirm">
        <DialogTitle>Enable Multiplayer for Thread?</DialogTitle>
        <DialogDescription>{MULTIPLAYER_CONSENT}</DialogDescription>
        <label className="thread-share-checkbox">
          <input
            type="checkbox"
            checked={skipNextTime}
            onChange={(event) => setSkipNextTime(event.currentTarget.checked)}
          />
          Don't ask me again
        </label>
        <footer className="thread-share-actions">
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            size="xs"
            disabled={pending}
            onClick={() => onConfirm(skipNextTime)}
          >
            Enable Multiplayer
          </Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

function PermissionMenu({
  value,
  disabled,
  onChange,
}: {
  readonly value: Access;
  readonly disabled: boolean;
  readonly onChange: (access: Access) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        render={
          <Button
            size="xs"
            variant="ghost"
            className="thread-share-permission"
            aria-label={`Workspace access: ${accessLabel[value]}`}
          />
        }
      >
        {accessLabel[value]}
        <ChevronDown />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner thread-share-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup thread-share-menu">
            <Menu.RadioGroup
              value={value}
              onValueChange={(next) => onChange(next as Access)}
            >
              {(["none", "view", "contribute"] as const).map((access) => (
                <Menu.RadioItem
                  key={access}
                  value={access}
                  className="thread-menu-item thread-share-radio"
                  closeOnClick
                >
                  <span className="thread-share-radio-dot">
                    <Menu.RadioItemIndicator className="thread-share-radio-indicator" />
                  </span>
                  {accessLabel[access]}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Where the Thread stands now: Private, shared for viewing, or multiplayer. */
function SharingStatus({
  thread,
  ownerName,
}: {
  readonly thread: Pick<ThreadDetailData, "sharing" | "access">;
  readonly ownerName?: string;
}) {
  const sharing = thread.sharing;
  const own = thread.access === undefined || thread.access === "owner";
  if (sharing === undefined)
    return (
      <div className="thread-share-status">
        <LockKeyhole aria-hidden="true" />
        <div>
          <strong>Private</strong>
          <span>Only you can see this thread.</span>
        </div>
      </div>
    );
  if (sharing.workspaceAccess === "view")
    return (
      <div className="thread-share-status">
        <UsersRound aria-hidden="true" />
        <div>
          <strong>Shared with workspace</strong>
          <span>
            Workspace members can view this thread
            {own
              ? ""
              : `. Ask ${ownerName ?? "the owner"} for Contribute access`}
            .
          </span>
        </div>
      </div>
    );
  return (
    <div className="thread-share-status" data-multiplayer="">
      <UsersRound aria-hidden="true" />
      <div>
        <strong>Multiplayer</strong>
        <span>
          {sharing.contributeUntil === undefined
            ? "On. "
            : `On until ${formatUntil(sharing.contributeUntil)}. `}
          Contributors can ask the agent to run commands and tools as{" "}
          {own ? "you" : (ownerName ?? "the owner")}, and send messages using{" "}
          {own ? "your" : "their"} credits.
        </span>
      </div>
    </div>
  );
}

export function ShareDialog({
  thread,
  ownerName,
  open,
  onOpenChange,
}: {
  readonly thread: ThreadDetailData;
  readonly ownerName?: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const own = thread.access === undefined || thread.access === "owner";
  const settings = useQuery({
    ...settingsContextQueryOptions(identity.id),
    enabled: open && own,
  });
  const workspace = settings.data?.workspace;
  const mutation = useUpdateThreadSharing(identity.id, thread.id);
  const [confirming, setConfirming] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [notice, setNotice] = React.useState<string>();
  const url = absoluteThreadUrl(thread.id, window.location.href);
  const current: Access = thread.sharing?.workspaceAccess ?? "none";

  const apply = (
    workspaceAccess: Access,
    skipMultiplayerConfirmation?: boolean,
  ) =>
    mutation.mutate(
      {
        workspaceAccess,
        ...(skipMultiplayerConfirmation === undefined
          ? {}
          : { skipMultiplayerConfirmation }),
      },
      {
        onSuccess: () => {
          setConfirming(false);
          setNotice("Sharing updated");
          window.setTimeout(() => setNotice(undefined), 2_500);
        },
      },
    );
  const choose = (next: Access) => {
    if (next === current && next !== "contribute") return;
    if (next === "contribute" && thread.skipMultiplayerConfirmation !== true) {
      setConfirming(true);
      return;
    }
    apply(next);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <DialogRoot open={open && !confirming} onOpenChange={onOpenChange}>
        <DialogContent className="thread-share-dialog">
          <DialogTitle>Share</DialogTitle>
          <DialogDescription className="sr-only">
            Choose who in your workspace can see or use this thread.
          </DialogDescription>
          <section className="thread-share-section">
            <h3>URL</h3>
            <div className="thread-share-url">
              <span className="thread-share-url-text" title={url}>
                {url.replace(/^https?:\/\//, "")}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={copied ? "Copied" : "Copy thread URL"}
                title={copied ? "Copied" : "Copy thread URL"}
                onClick={() => void copy()}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
              <a
                className="thread-share-open"
                href={url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open thread in new tab"
                title="Open thread in new tab"
              >
                <ExternalLink />
              </a>
            </div>
          </section>
          <section className="thread-share-section">
            <h3>Permissions</h3>
            {own ? (
              workspace === undefined ? (
                settings.isPending ? (
                  <div className="thread-share-row" aria-busy="true">
                    <span className="thread-share-workspace-mark">…</span>
                    <div>
                      <strong>Workspace</strong>
                      <span>Loading…</span>
                    </div>
                  </div>
                ) : (
                  <div className="thread-share-row">
                    <span className="thread-share-workspace-mark">
                      <UsersRound />
                    </span>
                    <div>
                      <strong>No workspace</strong>
                      <span>
                        <Link
                          to="/settings"
                          onClick={() => onOpenChange(false)}
                        >
                          Create or join a workspace
                        </Link>{" "}
                        to share threads.
                      </span>
                    </div>
                  </div>
                )
              ) : (
                <div className="thread-share-row">
                  <span
                    className="thread-share-workspace-mark"
                    aria-hidden="true"
                  >
                    {workspace.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <strong>{workspace.displayName}</strong>
                    <span>Your workspace</span>
                  </div>
                  <PermissionMenu
                    value={current}
                    disabled={mutation.isPending}
                    onChange={choose}
                  />
                </div>
              )
            ) : (
              <div className="thread-share-row">
                <span className="thread-share-workspace-mark">
                  <UsersRound />
                </span>
                <div>
                  <strong>Your workspace</strong>
                  <span>Shared by {ownerName ?? "the owner"}</span>
                </div>
                <span className="thread-share-permission-static">
                  {accessLabel[current]}
                </span>
              </div>
            )}
            {mutation.error === null ? null : (
              <p className="thread-share-error" role="alert">
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : "Sharing could not be updated."}
              </p>
            )}
          </section>
          <SharingStatus thread={thread} ownerName={ownerName} />
        </DialogContent>
      </DialogRoot>
      <MultiplayerConfirmDialog
        key={confirming ? "open" : "closed"}
        open={open && confirming}
        pending={mutation.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={(skip) => apply("contribute", skip ? true : undefined)}
      />
      {notice === undefined ? null : (
        <div className="thread-archive-toast" role="status" aria-live="polite">
          <Check aria-hidden="true" />
          <strong>{notice}</strong>
        </div>
      )}
    </>
  );
}
