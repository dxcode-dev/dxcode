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
