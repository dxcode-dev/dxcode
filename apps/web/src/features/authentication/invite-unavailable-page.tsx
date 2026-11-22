import { Link } from "@tanstack/react-router";
import { Link2Off } from "lucide-react";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { cn } from "../../shared/utils.js";
import { AuthLayout, AuthNotice } from "./auth-layout.js";
import { AuthShowcase } from "./auth-showcase.js";

/**
 * Signed-out `/join/<token>` when the invite cannot be used: it says why,
 * as the signed-in join page does, instead of a plain sign-up form.
 */
export function InviteUnavailablePage({
  message,
  onRetry,
}: {
  readonly message: string;
  /** Present when the invite could not be checked. */
  readonly onRetry?: () => void;
}) {
  return (
    <AuthLayout
      aside={<AuthShowcase />}
      screen="invite-unavailable"
      title="Invite unavailable"
      icon={<Link2Off />}
      tone="danger"
    >
      <AuthNotice
        actions={
          <>
            {onRetry === undefined ? null : (
              <Button size="lg" block className="auth-submit" onClick={onRetry}>
                Try again
              </Button>
            )}
            <Link
              to="/"
              className={cn(
                buttonVariants({ variant: "outline", size: "lg", block: true }),
                "auth-provider",
              )}
            >
              Go to dx
            </Link>
          </>
        }
      >
        <p role={onRetry ? "alert" : undefined}>{message}</p>
      </AuthNotice>
    </AuthLayout>
  );
}
