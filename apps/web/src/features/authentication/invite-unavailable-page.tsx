import { Link } from "@tanstack/react-router";
import { DxWordmark } from "../../shared/brand/dx-wordmark.js";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { cn } from "../../shared/utils.js";
import "./sign-in.css";

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
    <main className="sign-in-page">
      <div className="sign-in-column">
        <DxWordmark />
        <h1 className="sign-in-title">Invite unavailable</h1>
        <p className="sign-in-subtitle" role={onRetry ? "alert" : undefined}>
          {message}
        </p>
        <section className="sign-in-card" aria-label="Invite unavailable">
          {onRetry === undefined ? null : (
            <Button className="sign-in-primary" onClick={onRetry}>
              Try again
            </Button>
          )}
          <Link
            to="/"
            className={cn(
              buttonVariants({ variant: "outline" }),
              "sign-in-provider",
            )}
          >
            Go to dx
          </Link>
        </section>
      </div>
    </main>
  );
}
