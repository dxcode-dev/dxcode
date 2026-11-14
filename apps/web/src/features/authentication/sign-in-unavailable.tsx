import { Button } from "../../shared/ui/button.js";
import "./sign-in.css";

/** A sign-in page's card that says dx can't be reached, with a retry. */
export function SignInUnavailable({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <main className="sign-in-page">
      <div className="sign-in-column">
        <section className="sign-in-card sign-in-status" role="alert">
          <p>{message}</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </section>
      </div>
    </main>
  );
}
