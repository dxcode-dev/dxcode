import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

export function SidebarExtensionRegion({
  children,
}: {
  readonly children?: ReactNode;
}) {
  if (children === undefined || children === null || children === false)
    return null;

  return (
    <section
      className="sidebar-extension-region"
      aria-label="Sidebar extensions"
    >
      {children}
    </section>
  );
}

export function SidebarNewsStack({
  children,
  collapsed = false,
}: {
  readonly children?: ReactNode;
  readonly collapsed?: boolean;
}) {
  if (collapsed || children === undefined || children === null) return null;

  return (
    <section className="sidebar-news-stack" aria-label="News">
      {children}
    </section>
  );
}

export function SidebarNewsCard({
  title,
  description,
  onSelect,
}: {
  readonly title: string;
  readonly description: string;
  readonly onSelect?: () => void;
}) {
  const copy = (
    <>
      <strong>{title}</strong>
      <span>{description}</span>
    </>
  );

  return onSelect === undefined ? (
    <article className="sidebar-news-card">{copy}</article>
  ) : (
    <button className="sidebar-news-card" type="button" onClick={onSelect}>
      {copy}
    </button>
  );
}

export function SidebarUpdateAction({
  label,
  shortcut,
  onSelect,
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly onSelect: () => void;
}) {
  return (
    <button className="sidebar-update-action" type="button" onClick={onSelect}>
      <RefreshCw aria-hidden="true" />
      <span>{label}</span>
      {shortcut === undefined ? null : <kbd>{shortcut}</kbd>}
    </button>
  );
}
