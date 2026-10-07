import "./members.css";
import { Menu } from "@base-ui/react/menu";
import type { WorkspaceInviteLinkData, WorkspaceMemberData } from "@dx/api";
import type { WorkspaceSlug } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Ellipsis, Plus, Search } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { SettingsCard } from "../settings-primitives.js";
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

const activity = (member: WorkspaceMemberData) =>
  member.lastActiveAt === undefined
    ? "Not active yet"
    : `Active ${formatRelativeTime({
        epochMilliseconds: Date.parse(member.lastActiveAt),
      })}`;

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
    try {
      await confirmation.run();
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
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
}: {
  readonly member: WorkspaceMemberData;
  readonly onConfirm: (confirmation: Confirmation) => void;
  readonly setRole: (role: "admin" | "member") => Promise<unknown>;
  readonly remove: () => Promise<unknown>;
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

function CreateInviteLinkForm({
  onCancel,
  onCreate,
}: {
  readonly onCancel: () => void;
  readonly onCreate: (input: {
    readonly title: string;
    readonly expiresAt?: string;
  }) => Promise<unknown>;
}) {
  const [title, setTitle] = React.useState("Invite link");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const formId = React.useId();
  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      await onCreate({
        title,
        ...(expiresAt === ""
          ? {}
          : { expiresAt: new Date(expiresAt).toISOString() }),
      });
      onCancel();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };
  return (
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
          title="Leave empty to never expire."
          onChange={(event) => setExpiresAt(event.target.value)}
        />
      </div>
      <div className="members-link-form-actions">
        <Button size="xs" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          type="submit"
          disabled={pending || title.trim() === ""}
        >
          {pending ? "Creating…" : "Create Link"}
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="members-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function InviteLinksCard({
  workspaceSlug,
  onConfirm,
}: {
  readonly workspaceSlug: WorkspaceSlug;
  readonly onConfirm: (confirmation: Confirmation) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const links = useQuery(
    workspaceInviteLinksQueryOptions(identity.id, workspaceSlug),
  );
  const options = memberMutationOptions(
    queryClient,
    identity.id,
    workspaceSlug,
  );
  const create = useMutation(options.createLink);
  const revoke = useMutation(options.revokeLink);
  const [creating, setCreating] = React.useState(false);
  return (
    <SettingsCard
      className="members-card"
      title="Invite Links"
      description="Create shareable links for people to join this workspace."
      actions={
        creating ? undefined : (
          <Button size="xs" variant="outline" onClick={() => setCreating(true)}>
            <Plus /> Create Link
          </Button>
        )
      }
    >
      {creating ? (
        <CreateInviteLinkForm
          onCancel={() => setCreating(false)}
          onCreate={(input) => create.mutateAsync(input)}
        />
      ) : null}
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

export function MembersSettings({ workspaceSlug }: SettingsSectionProps) {
  return workspaceSlug === undefined ? null : (
    <MembersList workspaceSlug={workspaceSlug} />
  );
}

function MembersList({
  workspaceSlug,
}: {
  readonly workspaceSlug: WorkspaceSlug;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const [confirmation, setConfirmation] = React.useState<Confirmation>();
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
  const viewer = members.data?.viewer;
  const isAdmin = viewer?.role === "owner" || viewer?.role === "admin";
  const query = search.trim().toLocaleLowerCase();
  const visible = (members.data?.members ?? []).filter(
    (member) =>
      query === "" ||
      member.name.toLocaleLowerCase().includes(query) ||
      member.email.toLocaleLowerCase().includes(query),
  );
  return (
    <div className="members-settings">
      <header className="members-heading">
        <h1>Members</h1>
        {members.data === undefined ? null : (
          <span>— {members.data.members.length} total</span>
        )}
      </header>
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
            <div className="members-row" key={member.userId}>
              <span className="members-avatar" aria-hidden="true">
                {(member.name || member.email).slice(0, 1).toUpperCase()}
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
              <span className="members-activity">{activity(member)}</span>
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
                  />
                ) : null}
              </div>
            </div>
          ))
        )}
      </SettingsCard>
      {isAdmin ? (
        <InviteLinksCard
          workspaceSlug={workspaceSlug}
          onConfirm={setConfirmation}
        />
      ) : null}
      <ConfirmDialog
        confirmation={confirmation}
        onClose={() => setConfirmation(undefined)}
      />
    </div>
  );
}
