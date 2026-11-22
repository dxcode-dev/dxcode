import { Button } from "../../shared/ui/button.js";
import "./auth.css";

/**
 * A sign-in page that can't reach dx: why, and a retry. It ships on the
 * app's first load (the session check shows it), so it draws the signed-out
 * column with plain markup and leaves the wordmark and team panel out.
 */
export function SignInUnavailable({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <main className="auth" data-screen="unavailable" data-solo="">
      <div className="auth-step">
        <h1 className="auth-title">Can't reach dx</h1>
        <div className="auth-body">
          <div className="auth-notice" role="alert">
            <div className="auth-notice-text">
              <p>{message}</p>
            </div>
            <div className="auth-notice-actions">
              <Button
                type="button"
                variant="outline"
                size="lg"
                block
                className="auth-provider"
                onClick={onRetry}
              >
                Try again
              </Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
