import type { UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Files, Mail } from "lucide-react";
import { ProjectsIcon } from "../../shared/ui/projects-icon.js";
import { mailboxQueryOptions } from "../mailbox/mailbox-summary-queries.js";
import {
  createSidebarSections,
  type SidebarSectionRegistration,
} from "./sidebar-slots.js";

const projects: SidebarSectionRegistration = {
  id: "dx.projects",
  slot: "dock",
  render: ({ pathname, onNavigate }) => (
    <Link
      to="/projects"
      className={`dock-link ${pathname === "/projects" ? "selected" : ""}`}
      onClick={onNavigate}
    >
      <ProjectsIcon />
      <span>Projects</span>
    </Link>
  ),
};

const artifacts: SidebarSectionRegistration = {
  id: "dx.artifacts",
  slot: "dock",
  render: ({ pathname, onNavigate }) => (
    <Link
      to="/artifacts"
      className={`dock-link ${pathname === "/artifacts" || pathname.startsWith("/artifacts/") ? "selected" : ""}`}
      onClick={onNavigate}
    >
      <Files aria-hidden="true" />
      <span>Artifacts</span>
    </Link>
  ),
};

/** Mail, where the deployment has a mail domain. */
const mail: SidebarSectionRegistration = {
  id: "dx.mail",
  slot: "dock",
  shownWhen: ({ userId, settingsContext }) =>
    userId !== undefined && settingsContext?.mailDomain !== undefined,
  render: ({ userId, pathname, onNavigate }) =>
    userId === undefined ? null : (
      <MailboxDockLink
        userId={userId}
        selected={pathname === "/mailbox"}
        onNavigate={onNavigate}
      />
    ),
};

/** dx's own sidebar sections, in the order each slot shows them. */
export const DX_SIDEBAR_SECTION_REGISTRATIONS: ReadonlyArray<SidebarSectionRegistration> =
  [projects, artifacts, mail];

export const DX_SIDEBAR_SECTIONS = createSidebarSections(
  DX_SIDEBAR_SECTION_REGISTRATIONS,
);

function MailboxDockLink({
  userId,
  selected,
  onNavigate,
}: {
  readonly userId: UserId;
  readonly selected: boolean;
  readonly onNavigate: () => void;
}) {
  const mailbox = useQuery(mailboxQueryOptions(userId));
  const unread = mailbox.data?.enabled === true ? mailbox.data.unread.inbox : 0;
  return (
    <Link
      to="/mailbox"
      className={`dock-link ${selected ? "selected" : ""}`}
      aria-label={unread > 0 ? `Mail, ${unread} unread` : undefined}
      onClick={onNavigate}
    >
      <span className="dock-link-icon">
        <Mail aria-hidden="true" />
        {unread > 0 ? (
          <span className="dock-link-count" aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </span>
      <span>Mail</span>
    </Link>
  );
}
