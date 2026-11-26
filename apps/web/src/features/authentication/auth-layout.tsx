import type * as React from "react";
import { DxWordmark } from "../../shared/brand/dx-wordmark.js";
import "./auth.css";

/** The signed-out screen a page shows; the boot tracker reads it from `data-screen`. */
export type AuthScreen =
  | "signin"
  | "signup"
  | "join"
  | "check-email"
  | "verify-email"
  | "waitlisted"
  | "invite-unavailable"
  | "unavailable"
  | "open-app";

/**
 * Every signed-out screen: the form column, and from 1024px the `aside` panel
 * beside it (the team panel, `AuthShowcase`). The dx wordmark
 * is static and one color in every state.
 *
 * The heading sits at a fixed offset from the top: moving between steps
 * changes what is below it and never moves it.
 */
export function AuthLayout({
  screen,
  title,
  subtitle,
  children,
  footer,
  stepKey,
  icon,
  tone = "neutral",
  aside,
}: {
  readonly screen: AuthScreen;
  readonly title: React.ReactNode;
  readonly subtitle?: React.ReactNode;
  readonly children: React.ReactNode;
  /** Legal links at the foot of the form column. */
  readonly footer?: React.ReactNode;
  /**
   * Changes when the person moves to another step, which plays the step's
   * entrance. Leave it out on the first screen so first paint has no motion.
   */
  readonly stepKey?: string;
  /** A step with nothing to type shows its icon above the heading. */
  readonly icon?: React.ReactNode;
  readonly tone?: "neutral" | "success" | "warning" | "danger";
  /**
   * The panel beside the form from 1024px, such as `AuthShowcase`. A page
   * on the app's first load (dx unreachable) leaves it out and centers.
   */
  readonly aside?: React.ReactNode;
}) {
  return (
    <main
      className="auth"
      data-screen={screen}
      data-solo={aside === undefined ? "" : undefined}
    >
      <header className="auth-header">
        <DxWordmark href="/" />
      </header>
      <div
        key={stepKey}
        className="auth-step"
        data-enter={stepKey === undefined ? undefined : ""}
      >
        {icon === undefined ? null : (
          <div className="auth-icon" data-tone={tone} aria-hidden="true">
            {icon}
          </div>
        )}
        <h1 className="auth-title">{title}</h1>
        {subtitle === undefined ? null : (
          <p className="auth-subtitle">{subtitle}</p>
        )}
        <div className="auth-body">{children}</div>
      </div>
      {footer === undefined ? null : (
        <footer className="auth-footer">{footer}</footer>
      )}
      {aside}
    </main>
  );
}

/**
 * Takes the form's place when there is nothing to type: an email is on its
 * way, the address is waitlisted, or the page cannot continue. The heading
 * says what happened; this says what to do next.
 */
export function AuthNotice({
  children,
  actions,
}: {
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
}) {
  return (
    <div className="auth-notice" role="status">
      <div className="auth-notice-text">{children}</div>
      {actions === undefined ? null : (
        <div className="auth-notice-actions">{actions}</div>
      )}
    </div>
  );
}
