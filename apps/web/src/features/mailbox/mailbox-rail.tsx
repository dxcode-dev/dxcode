import type { MailFolder, MailLabel } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Copy,
  Inbox,
  MoreHorizontal,
  OctagonAlert,
  PenSquare,
  Plus,
  Send,
  Settings,
  Sparkles,
  Tag,
} from "lucide-react";
import * as React from "react";
import { copyText } from "../../shared/copy-text.js";
import { Button } from "../../shared/ui/button.js";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.js";
import { Input } from "../../shared/ui/input.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/ui/menu.js";
import { ProjectsIcon } from "../../shared/ui/projects-icon.js";
import {
  type EnabledMailbox,
  mailErrorMessage,
  mailLabelMutationOptions,
} from "./mailbox-queries.js";
import {
  FOLDER_NAMES,
  isPlainClick,
  type MailboxNavigate,
  type MailboxSearch,
  mailboxHref,
} from "./mailbox-search.js";

const FOLDER_ICONS = {
  inbox: Inbox,
  sent: Send,
  archive: Archive,
  spam: OctagonAlert,
} as const;
const FOLDERS: ReadonlyArray<MailFolder> = ["inbox", "sent", "archive", "spam"];

/** A count after a rail row's name; nothing at zero. */
function Count({ value }: { readonly value: number }) {
  if (value <= 0) return null;
  return (
    <span className="mailbox-rail-count">{value > 999 ? "999+" : value}</span>
  );
}

/** One rail row: a link to a list, current when shown. */
function RailLink({
  to,
  current,
  onNavigate,
  children,
  title,
}: {
  readonly to: MailboxSearch;
  readonly current: boolean;
  readonly onNavigate: MailboxNavigate;
  readonly children: React.ReactNode;
  readonly title?: string;
}) {
  return (
    <a
      className="mailbox-rail-row"
      href={mailboxHref(to)}
      aria-current={current ? "page" : undefined}
      title={title}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onNavigate(to);
      }}
    >
      {children}
    </a>
  );
}

/**
 * The Mailbox's left rail: Compose, the folders, one row per project
 * address, and the labels, which the person creates, renames, and deletes
 * here. The address and Mailbox settings sit at its foot.
 */
export function MailboxRail({
  userId,
  mailbox,
  search,
  onNavigate,
  onCompose,
  onOpenSettings,
}: {
  readonly userId: UserId;
  readonly mailbox: EnabledMailbox;
  readonly search: MailboxSearch;
  readonly onNavigate: MailboxNavigate;
  readonly onCompose: () => void;
  readonly onOpenSettings: () => void;
}) {
  const userLabels = mailbox.labels.filter((label) => label.kind === "user");
  const autoLabels = mailbox.labels.filter((label) => label.kind === "auto");
  const [adding, setAdding] = React.useState(false);
  const shownFolder =
    search.label === undefined && search.tag === undefined
      ? (search.folder ?? "inbox")
      : undefined;
  return (
    <nav className="mailbox-rail" aria-label="Mailbox folders">
      <div className="mailbox-rail-compose">
        <Button block onClick={onCompose}>
          <PenSquare aria-hidden="true" />
          New email
        </Button>
      </div>
      <div className="mailbox-rail-scroll">
        <ul className="mailbox-rail-list">
          {FOLDERS.map((folder) => {
            const Icon = FOLDER_ICONS[folder];
            return (
              <li key={folder}>
                <RailLink
                  to={{ folder }}
                  current={shownFolder === folder}
                  onNavigate={onNavigate}
                >
                  <Icon aria-hidden="true" />
                  <span className="mailbox-rail-name">
                    {FOLDER_NAMES[folder]}
                  </span>
                  <Count
                    value={
                      folder === "inbox"
                        ? mailbox.unread.inbox
                        : folder === "spam"
                          ? mailbox.unread.spam
                          : 0
                    }
                  />
                </RailLink>
              </li>
            );
          })}
        </ul>
        {mailbox.projects.length === 0 ? null : (
          <section className="mailbox-rail-section" aria-label="Projects">
            <h2 className="mailbox-rail-heading">Projects</h2>
            <ul className="mailbox-rail-list">
              {mailbox.projects.map((project) => (
                <li key={project.tag}>
                  <RailLink
                    to={{ tag: project.tag }}
                    current={search.tag === project.tag}
                    onNavigate={onNavigate}
                    title={project.address}
                  >
                    <ProjectsIcon aria-hidden="true" />
                    <span className="mailbox-rail-name">
                      {project.projectName}
                      <span className="mailbox-rail-tag">+{project.tag}</span>
                    </span>
                    <Count value={project.unread} />
                  </RailLink>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="mailbox-rail-section" aria-label="Labels">
          <div className="mailbox-rail-heading-row">
            <h2 className="mailbox-rail-heading">Labels</h2>
            <Button
              variant="subtle"
              size="icon-2xs"
              aria-label="New label"
              title="New label"
              onClick={() => setAdding(true)}
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
          <ul className="mailbox-rail-list">
            {userLabels.map((label) => (
              <UserLabelRow
                key={label.id}
                userId={userId}
                label={label}
                current={search.label === label.id}
                onNavigate={onNavigate}
              />
            ))}
            {adding ? (
              <li>
                <LabelNameForm
                  userId={userId}
                  ariaLabel="New label name"
                  onDone={() => setAdding(false)}
                />
              </li>
            ) : null}
            {autoLabels.map((label) => (
              <li key={label.id}>
                <RailLink
                  to={{ label: label.id }}
                  current={search.label === label.id}
                  onNavigate={onNavigate}
                  title={`${label.name}: labelled automatically`}
                >
                  <Sparkles aria-hidden="true" />
                  <span className="mailbox-rail-name">{label.name}</span>
                  <Count value={label.unread} />
                </RailLink>
              </li>
            ))}
          </ul>
          {userLabels.length === 0 && autoLabels.length === 0 && !adding ? (
            <p className="mailbox-rail-empty">No labels yet</p>
          ) : null}
        </section>
      </div>
      <footer className="mailbox-rail-footer">
        <button
          type="button"
          className="mailbox-rail-address"
          title={`Copy ${mailbox.address}`}
          onClick={() => void copyText(mailbox.address, "Email address")}
        >
          <span>{mailbox.address}</span>
          <Copy aria-hidden="true" />
        </button>
        <Button
          variant="subtle"
          size="icon-xs"
          aria-label="Mailbox settings"
          title="Mailbox settings"
          onClick={onOpenSettings}
        >
          <Settings aria-hidden="true" />
        </Button>
      </footer>
    </nav>
  );
}

/** A label of the person's own: its row, with Rename and Delete. */
function UserLabelRow({
  userId,
  label,
  current,
  onNavigate,
}: {
  readonly userId: UserId;
  readonly label: MailLabel;
  readonly current: boolean;
  readonly onNavigate: MailboxNavigate;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation(mailLabelMutationOptions(queryClient, userId));
  const [renaming, setRenaming] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  if (renaming)
    return (
      <li>
        <LabelNameForm
          userId={userId}
          ariaLabel={`Rename ${label.name}`}
          label={label}
          onDone={() => setRenaming(false)}
        />
      </li>
    );
  return (
    <li className="mailbox-rail-label">
      <RailLink
        to={{ label: label.id }}
        current={current}
        onNavigate={onNavigate}
      >
        <Tag aria-hidden="true" />
        <span className="mailbox-rail-name">{label.name}</span>
        <Count value={label.unread} />
      </RailLink>
      <MenuRoot>
        <MenuTrigger
          render={
            <Button
              variant="subtle"
              size="icon-2xs"
              className="mailbox-rail-row-menu"
              aria-label={`More for ${label.name}`}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          }
        />
        <MenuPopup align="end">
          <MenuItem onClick={() => setRenaming(true)}>Rename</MenuItem>
          <MenuItem tone="danger" onClick={() => setConfirming(true)}>
            Delete
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete the label “${label.name}”?`}
        description="Email keeps its place; only the label comes off."
        confirmLabel="Delete label"
        destructive
        pending={remove.isPending}
        error={
          remove.isError
            ? mailErrorMessage(remove.error, "The label could not be deleted.")
            : undefined
        }
        onConfirm={() =>
          remove.mutate(
            { kind: "delete", id: label.id },
            {
              onSuccess: () => {
                setConfirming(false);
                if (current) onNavigate({});
              },
            },
          )
        }
      />
    </li>
  );
}

/** Names a new label, or renames one; Enter saves, Escape cancels. */
export function LabelNameForm({
  userId,
  label,
  ariaLabel,
  onDone,
  onCreated,
}: {
  readonly userId: UserId;
  readonly label?: MailLabel;
  readonly ariaLabel: string;
  readonly onDone: () => void;
  readonly onCreated?: (labelId: string) => void;
}) {
  const queryClient = useQueryClient();
  const save = useMutation(mailLabelMutationOptions(queryClient, userId));
  const [name, setName] = React.useState(label?.name ?? "");
  const trimmed = name.trim();
  const submit = () => {
    if (trimmed === "" || trimmed === label?.name) {
      onDone();
      return;
    }
    save.mutate(
      label === undefined
        ? { kind: "create", name: trimmed }
        : { kind: "rename", id: label.id, name: trimmed },
      {
        onSuccess: (saved) => {
          if (label === undefined && saved !== undefined) onCreated?.(saved.id);
          onDone();
        },
      },
    );
  };
  return (
    <form
      className="mailbox-label-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        size="sm"
        autoFocus
        aria-label={ariaLabel}
        placeholder="Label name"
        maxLength={40}
        value={name}
        disabled={save.isPending}
        aria-invalid={save.isError || undefined}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          }
        }}
        onBlur={() => {
          if (!save.isPending && !save.isError) submit();
        }}
      />
      {save.isError ? (
        <p className="mailbox-label-form-error" role="alert">
          {mailErrorMessage(save.error, "The label could not be saved.")}
        </p>
      ) : null}
    </form>
  );
}
