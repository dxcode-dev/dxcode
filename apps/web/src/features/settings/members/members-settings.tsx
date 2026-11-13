import { Select } from "../../../shared/ui/select.js";
import "./members.css";
import type { WorkspaceInviteLinkData, WorkspaceMemberData } from "@dx/api";
import type { WorkspaceSlug } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Ellipsis, Plus, Search } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useNowMinute } from "../../../shared/hooks/use-clock.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";

import { Input } from "../../../shared/ui/input.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  type InviteLinkFieldErrors,
  inviteLinkFieldErrors,
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
    <MenuRoot>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Manage ${label}`}
          />
        }
      >
        <Ellipsis />
      </MenuTrigger>
      <MenuPopup align="end">
        {member.role === "admin" ? (
          <MenuItem
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
          </MenuItem>
        ) : (
          <MenuItem
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
          </MenuItem>
        )}
        {transferOwnership === undefined ? null : (
          <MenuItem
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
          </MenuItem>
        )}
        <MenuItem
          tone="danger"
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
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
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
      : link.status === "used-up"
        ? "Used up"
        : link.expiresAt === undefined
          ? "Never expires"
          : `Expires ${dateLabel(link.expiresAt)}`,
    link.maxUses === undefined
      ? `${link.useCount} joined`
      : `${link.useCount} of ${link.maxUses} joined`,
  ].join(" · ");

const USE_LIMITS = [1, 5, 10, 25] as const;

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
    readonly maxUses?: number;
  }) => Promise<WorkspaceInviteLinkData>;
}) {
  const [title, setTitle] = React.useState("Invite link");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [maxUses, setMaxUses] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [fieldErrors, setFieldErrors] = React.useState<InviteLinkFieldErrors>(
    {},
  );
  const [created, setCreated] = React.useState<WorkspaceInviteLinkData>();
  const formId = React.useId();
  const submit = async () => {
    setPending(true);
    setError(undefined);
    setFieldErrors({});
    const outcome = await settle(() =>
      onCreate({
        title,
        ...(expiresAt === ""
          ? {}
          : { expiresAt: new Date(expiresAt).toISOString() }),
        ...(maxUses === "" ? {} : { maxUses: Number(maxUses) }),
      }),
    );
    if (outcome.ok) {
      setCreated(outcome.value);
    } else {
      const fields = inviteLinkFieldErrors(outcome.error);
      if (fields === undefined) setError(message(outcome.error));
      else setFieldErrors(fields);
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
      <DialogContent size="sm" className="members-dialog">
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
                size="sm"
                id={`${formId}-title`}
                className="members-input"
                value={title}
                maxLength={80}
                aria-invalid={
                  fieldErrors.title === undefined ? undefined : true
                }
                aria-describedby={
                  fieldErrors.title === undefined
                    ? undefined
                    : `${formId}-title-error`
                }
                onChange={(event) => {
                  setTitle(event.target.value);
                  setFieldErrors({ ...fieldErrors, title: undefined });
                }}
              />
              {fieldErrors.title === undefined ? null : (
                <span id={`${formId}-title-error`} className="members-error">
                  {fieldErrors.title}
                </span>
              )}
            </div>
            <div className="members-link-field">
              <label htmlFor={`${formId}-expires`}>Expires</label>
              <Input
                size="sm"
                id={`${formId}-expires`}
                className="members-input"
                type="datetime-local"
                value={expiresAt}
                aria-invalid={
                  fieldErrors.expiresAt === undefined ? undefined : true
                }
                aria-describedby={
                  fieldErrors.expiresAt === undefined
                    ? undefined
                    : `${formId}-expires-error`
                }
                onChange={(event) => {
                  setExpiresAt(event.target.value);
                  setFieldErrors({ ...fieldErrors, expiresAt: undefined });
                }}
              />
              {fieldErrors.expiresAt === undefined ? (
                <span>Leave empty to never expire.</span>
              ) : (
                <span id={`${formId}-expires-error`} className="members-error">
                  {fieldErrors.expiresAt}
                </span>
              )}
            </div>
            <div className="members-link-field">
              <label htmlFor={`${formId}-uses`}>Use limit</label>
              <Select
                id={`${formId}-uses`}
                value={maxUses}
                aria-invalid={
                  fieldErrors.maxUses === undefined ? undefined : true
                }
                aria-describedby={
                  fieldErrors.maxUses === undefined
                    ? undefined
                    : `${formId}-uses-error`
                }
                onChange={(event) => {
                  setMaxUses(event.target.value);
                  setFieldErrors({ ...fieldErrors, maxUses: undefined });
                }}
              >
                <option value="">Unlimited</option>
                {USE_LIMITS.map((limit) => (
                  <option key={limit} value={limit}>
                    {limit === 1 ? "1 person" : `${limit} people`}
                  </option>
                ))}
              </Select>
              {fieldErrors.maxUses === undefined ? null : (
                <span id={`${formId}-uses-error`} className="members-error">
                  {fieldErrors.maxUses}
                </span>
              )}
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
                size="sm"
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
                variant="danger"
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
  const [confirming, setConfirming] = React.useState(false);
  const [confirmError, setConfirmError] = React.useState<string>();
  const closeConfirmation = () => {
    setConfirmError(undefined);
    setConfirmation(undefined);
  };
  const confirm = async () => {
    if (confirmation === undefined) return;
    setConfirming(true);
    setConfirmError(undefined);
    const outcome = await settle(async () => {
      await confirmation.run();
      closeConfirmation();
    });
    if (!outcome.ok) setConfirmError(message(outcome.error));
    setConfirming(false);
  };
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
            size="sm"
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
        open={confirmation !== undefined}
        onOpenChange={(open) => {
          if (!open) closeConfirmation();
        }}
        title={confirmation?.title}
        description={confirmation?.body}
        error={confirmError}
        confirmLabel={confirmation?.action}
        destructive={confirmation?.destructive}
        pending={confirming}
        onConfirm={() => void confirm()}
      />
    </div>
  );
}
