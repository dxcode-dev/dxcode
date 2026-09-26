import type { ReactNode } from "react";

export function PageShell({
  title,
  actions,
  children,
  contentClassName,
}: {
  readonly title?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly contentClassName?: string;
}) {
  return (
    <section className="standard-page">
      {title !== undefined || actions !== undefined ? (
        <header className="page-topbar">
          {title !== undefined ? (
            typeof title === "string" ? (
              <strong>{title}</strong>
            ) : (
              title
            )
          ) : null}
          <span />
          {actions}
        </header>
      ) : null}
      <div className={`standard-page-content ${contentClassName ?? ""}`}>
        {children}
      </div>
    </section>
  );
}
