import "./members.css";
import { Menu } from "@base-ui/react/menu";
import type { WorkspaceInviteLinkData, WorkspaceMemberData } from "@dx/api";
import type { WorkspaceSlug } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Ellipsis, Plus, Search } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useNowMinute } from "../../../shared/hooks/use-clock.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  memberMutationOptions,
  workspaceInviteLinksQueryOptions,
  workspaceMembersQueryOptions,
} from "./members-queries.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

const roleBadge = (role: WorkspaceMemberData["role"]) =>
  role === "owner"
    ? "Workspace Owner"
    : role === "admin"
      ? "Workspace Admin"
      : undefined;

const activity = (member: WorkspaceMemberData, now: number) =>
  member.lastActiveAt === undefined
    ? "Not active yet"
    : `Active ${formatRelativeTime(
        { epochMilliseconds: Date.parse(member.lastActiveAt) },
        now,
      )}`;

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

interface Confirmation {
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly destructive?: boolean;
  readonly run: () => Promise<unknown>;
}

function ConfirmDialog({
  confirmation,
  onClose,
}: {
  readonly confirmation: Confirmation | undefined;
  readonly onClose: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const confirm = async () => {
    if (confirmation === undefined) return;
    setPending(true);
    setError(undefined);
    const outcome = await settle(async () => {
      await confirmation.run();
      onClose();
    });
    if (!outcome.ok) {
      setError(message(outcome.error));
    }
    setPending(false);
  };
  return (
    <DialogRoot
      open={confirmation !== undefined}
      onOpenChange={(open) => {
        if (!open && !pending) {
          setError(undefined);
          onClose();
        }
      }}
    >
      <DialogContent className="members-dialog">
        <DialogTitle>{confirmation?.title}</DialogTitle>
        <DialogDescription>{confirmation?.body}</DialogDescription>
        {error === undefined ? null : (
          <p className="members-error" role="alert">
            {error}
          </p>
        )}
        <footer className="members-dialog-actions">
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="xs"
            variant={confirmation?.destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={() => void confirm()}
          >
            {confirmation?.action}
          </Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

function MemberMenu({
  member,
  onConfirm,
  setRole,
  remove,
  transferOwnership,
}: {
  readonly member: WorkspaceMemberData;
  readonly onConfirm: (confirmation: Confirmation) => void;
  readonly setRole: (role: "admin" | "member") => Promise<unknown>;
  readonly remove: () => Promise<unknown>;
  /** Set only for the owner, who can hand the workspace to this member. */
  readonly transferOwnership?: () => Promise<unknown>;
}) {
  const label = member.name || member.email;
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Manage ${label}`}
          />
        }
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup">
            {member.role === "admin" ? (
              <Menu.Item
                className="thread-menu-item"
                onClick={() =>
                  onConfirm({
                    title: "Revoke workspace admin?",
                    body: `${label} will keep using the workspace but can no longer change its settings or members.`,
                    action: "Revoke",
                    run: () => setRole("member"),
                  })
                }
              >
                Revoke Workspace Admin
              </Menu.Item>
            ) : (
              <Menu.Item
                className="thread-menu-item"
                onClick={() =>
                  onConfirm({
                    title: "Promote to workspace admin?",
                    body: "Workspace admins manage workspace settings, secrets, members, and invite links.",
                    action: "Promote",
                    run: () => setRole("admin"),
                  })
                }
              >
                Promote to Workspace Admin
              </Menu.Item>
            )}
            {transferOwnership === undefined ? null : (
              <Menu.Item
                className="thread-menu-item"
                onClick={() =>
                  onConfirm({
                    title: `Make ${label} the owner?`,
                    body: "They become the workspace owner and you become an admin. Only the owner can delete the workspace or hand it on.",
                    action: "Transfer",
                    destructive: true,
                    run: transferOwnership,
                  })
                }
              >
                Transfer Ownership
              </Menu.Item>
            )}
            <Menu.Item
              className="thread-menu-item members-danger"
              onClick={() =>
                onConfirm({
                  title: `Remove ${label}?`,
                  body: "They lose access to workspace projects, settings, and the threads they started in the workspace. Those threads come back if they rejoin.",
                  action: "Remove",
                  destructive: true,
                  run: remove,
                })
              }
            >
              Remove from Workspace
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function CopyLinkButton({ url }: { readonly url: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={copied ? "Invite link copied" : "Copy invite link"}
      title={copied ? "Copied" : "Copy link"}
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => setCopied(true));
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

const linkDescription = (link: WorkspaceInviteLinkData) =>
  [
    link.status === "expired"
      ? "Expired"
      : link.expiresAt === undefined
        ? "Never expires"
        : `Expires ${dateLabel(link.expiresAt)}`,
    `${link.useCount} joined`,
  ].join(" · ");

const ACTIVE_WINDOW_MS = 72 * 60 * 60 * 1000;

type MemberFilter = "all" | "active" | "admins";

const isActive = (member: WorkspaceMemberData, now: number) =>
  member.lastActiveAt !== undefined &&
  now - Date.parse(member.lastActiveAt) <= ACTIVE_WINDOW_MS;

const isAdminRole = (member: WorkspaceMemberData) => member.role !== "member";

function InviteLinkDialog({
  open,
  workspaceName,
  onOpenChange,
  onCreate,
}: {
  readonly open: boolean;
  readonly workspaceName: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: {
    readonly title: string;
    readonly expiresAt?: string;
  }) => Promise<WorkspaceInviteLinkData>;
}) {
  const [title, setTitle] = React.useState("Invite link");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [created, setCreated] = React.useState<WorkspaceInviteLinkData>();
  const formId = React.useId();
  const submit = async () => {
    setPending(true);
    setError(undefined);
    const outcome = await settle(() =>
      onCreate({
        title,
        ...(expiresAt === ""
          ? {}
          : { expiresAt: new Date(expiresAt).toISOString() }),
      }),
    );
    if (outcome.ok) {
      setCreated(outcome.value);
    } else {
      setError(message(outcome.error));
    }
    setPending(false);
  };
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="members-dialog">
        <DialogTitle>
          {created === undefined ? "Create invite link" : "Invite link ready"}
        </DialogTitle>
        <DialogDescription>
          Anyone with the link can join {workspaceName} as a member.
        </DialogDescription>
        {created === undefined ? (
          <form
            className="members-link-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="members-link-field">
              <label htmlFor={`${formId}-title`}>Title</label>
              <Input
                id={`${formId}-title`}
                className="members-input"
                value={title}
                maxLength={80}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="members-link-field">
              <label htmlFor={`${formId}-expires`}>Expires</label>
              <Input
                id={`${formId}-expires`}
                className="members-input"
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
              <span>Leave empty to never expire.</span>
            </div>
            {error === undefined ? null : (
              <p className="members-error" role="alert">
                {error}
              </p>
            )}
            <footer className="members-dialog-actions">
              <Button
                size="xs"
                variant="ghost"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                type="submit"
                disabled={pending || title.trim() === ""}
              >
                {pending ? "Creating…" : "Create Link"}
              </Button>
            </footer>
          </form>
        ) : (
          <>
            <div className="members-link-ready">
              <Input
                readOnly
                aria-label="Invite link"
                className="members-input"
                value={created.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <CopyLinkButton url={created.url} />
            </div>
            <footer className="members-dialog-actions">
              <Button size="xs" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </footer>
          </>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

function InviteLinksCard({
  workspaceSlug,
  workspaceName,
  onCreateLink,
  onConfirm,
}: {
  readonly workspaceSlug: WorkspaceSlug;
  readonly workspaceName: string;
  readonly onCreateLink: () => void;
  readonly onConfirm: (confirmation: Confirmation) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const links = useQuery(
    workspaceInviteLinksQueryOptions(identity.id, workspaceSlug),
  );
  const revoke = useMutation(
    memberMutationOptions(queryClient, identity.id, workspaceSlug).revokeLink,
  );
  return (
    <SettingsCard
      className="members-card"
      title="Invite Links"
      description={`Create shareable links for people to join ${workspaceName}.`}
      actions={
        <Button size="xs" variant="outline" onClick={onCreateLink}>
          <Plus /> Create Link
        </Button>
      }
    >
      {links.isPending ? (
        <p className="members-empty" role="status">
          Loading invite links…
        </p>
      ) : links.isError ? (
        <p className="members-error" role="alert">
          {message(links.error)}
        </p>
      ) : (
        links.data.map((link) => (
          <div className="members-row" key={link.id}>
            <div className="members-identity">
              <strong>{link.title}</strong>
              <span>{linkDescription(link)}</span>
            </div>
            <div className="members-row-actions">
              {link.status === "active" ? (
                <CopyLinkButton url={link.url} />
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                className="members-revoke"
                onClick={() =>
                  onConfirm({
                    title: `Revoke ${link.title}?`,
                    body: "The link stops working. People who already joined stay in the workspace.",
                    action: "Revoke",
                    destructive: true,
                    run: () => revoke.mutateAsync(link.id),
                  })
                }
              >
                Revoke
              </Button>
            </div>
          </div>
        ))
      )}
    </SettingsCard>
  );
}

function FilterChip({
  label,
  count,
  pressed,
  onToggle,
}: {
  readonly label: string;
  readonly count: number;
  readonly pressed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      className="members-chip"
      aria-pressed={pressed}
      onClick={onToggle}
    >
      {label} ({count})
    </Button>
  );
}

export function MembersSettings({
  workspace,
  workspaceSlug,
}: SettingsSectionProps) {
  return workspaceSlug === undefined ? null : (
    <MembersList
      workspaceSlug={workspaceSlug}
      workspaceName={workspace?.displayName ?? "this workspace"}
    />
  );
}

function MembersList({
  workspaceSlug,
  workspaceName,
}: {
  readonly workspaceSlug: WorkspaceSlug;
  readonly workspaceName: string;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const now = useNowMinute();
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<MemberFilter>("all");
  const [confirmation, setConfirmation] = React.useState<Confirmation>();
  const [inviteDialog, setInviteDialog] = React.useState(0);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const members = useQuery(
    workspaceMembersQueryOptions(identity.id, workspaceSlug),
  );
  const options = memberMutationOptions(
    queryClient,
    identity.id,
    workspaceSlug,
  );
  const setRole = useMutation(options.setRole);
  const remove = useMutation(options.remove);
  const transferOwnership = useMutation(options.transferOwnership);
  const createLink = useMutation(options.createLink);
  const viewer = members.data?.viewer;
  const isAdmin = viewer?.role === "owner" || viewer?.role === "admin";
  const all = members.data?.members ?? [];
  const activeCount = all.filter((member) => isActive(member, now)).length;
  const adminCount = all.filter(isAdminRole).length;
  const query = search.trim().toLocaleLowerCase();
  const visible = all.filter(
    (member) =>
      (filter === "all" ||
        (filter === "active" ? isActive(member, now) : isAdminRole(member))) &&
      (query === "" ||
        member.name.toLocaleLowerCase().includes(query) ||
        member.email.toLocaleLowerCase().includes(query)),
  );
  const toggleFilter = (next: MemberFilter) =>
    setFilter(filter === next ? "all" : next);
  const openInvite = () => {
    // A new key gives every opening a fresh form.
    setInviteDialog(inviteDialog + 1);
    setInviteOpen(true);
  };
  return (
    <div className="members-settings">
      <SettingsHeading
        title="Members"
        detail={
          members.data === undefined ? undefined : `— ${all.length} total`
        }
      />
      <div className="members-toolbar">
        <div className="members-search">
          <Input
            className="members-input"
            type="search"
            aria-label="Search members"
            placeholder="Search by name or email…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Search aria-hidden="true" />
        </div>
        {members.data === undefined ? null : (
          <div className="members-filters">
            <FilterChip
              label="Active 72h"
              count={activeCount}
              pressed={filter === "active"}
              onToggle={() => toggleFilter("active")}
            />
            <FilterChip
              label="Admins & Roles"
              count={adminCount}
              pressed={filter === "admins"}
              onToggle={() => toggleFilter("admins")}
            />
            {isAdmin ? (
              <Button size="xs" onClick={openInvite}>
                <Plus /> Invite
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <SettingsCard className="members-card">
        {members.isPending ? (
          <p className="members-empty" role="status">
            Loading members…
          </p>
        ) : members.isError ? (
          <p className="members-error" role="alert">
            {message(members.error)}
          </p>
        ) : visible.length === 0 ? (
          <p className="members-empty">No members match.</p>
        ) : (
          visible.map((member) => (
            <div className="members-row members-person" key={member.userId}>
              <span className="members-avatar" aria-hidden="true">
                {member.image === undefined ? (
                  (member.name || member.email).slice(0, 1).toUpperCase()
                ) : (
                  <img src={member.image} alt="" referrerPolicy="no-referrer" />
                )}
              </span>
              <div className="members-identity">
                <div>
                  <strong>{member.email}</strong>
                  {roleBadge(member.role) === undefined ? null : (
                    <span className="members-badge">
                      {roleBadge(member.role)}
                    </span>
                  )}
                </div>
                <span>{member.name}</span>
              </div>
              <span className="members-activity">
                <TimeText text={(at) => activity(member, at)} />
              </span>
              <div className="members-row-actions">
                {isAdmin &&
                member.role !== "owner" &&
                member.userId !== viewer?.userId ? (
                  <MemberMenu
                    member={member}
                    onConfirm={setConfirmation}
                    setRole={(role) =>
                      setRole.mutateAsync({ userId: member.userId, role })
                    }
                    remove={() => remove.mutateAsync(member.userId)}
                    {...(viewer?.role === "owner"
                      ? {
                          transferOwnership: () =>
                            transferOwnership.mutateAsync(member.userId),
                        }
                      : {})}
                  />
                ) : null}
              </div>
            </div>
          ))
        )}
      </SettingsCard>
      {isAdmin ? (
        <>
          <InviteLinksCard
            workspaceSlug={workspaceSlug}
            workspaceName={workspaceName}
            onCreateLink={openInvite}
            onConfirm={setConfirmation}
          />
          <InviteLinkDialog
            key={inviteDialog}
            open={inviteOpen}
            workspaceName={workspaceName}
            onOpenChange={setInviteOpen}
            onCreate={(input) => createLink.mutateAsync(input)}
          />
        </>
      ) : null}
      <ConfirmDialog
        confirmation={confirmation}
        onClose={() => setConfirmation(undefined)}
      />
    </div>
  );
}
