import { useContext, useId, useRef, useState } from "react";
import { WaitlistDialog } from "../../../shared/ui/waitlist-dialog.js";
import { useMagicLinkRequest } from "../../authentication/sign-in-mutations.js";
import { ArrowIcon } from "./arrow-icon.js";
import { LiveAccessContext } from "./live-access-context.js";

export function WaitlistForm(props: {
  readonly id?: string;
  readonly hero?: boolean;
}) {
  return useContext(LiveAccessContext) ? (
    <LiveWaitlistForm {...props} />
  ) : (
    <PreviewWaitlistForm {...props} />
  );
}

function LiveWaitlistForm({
  id,
  hero = false,
}: {
  readonly id?: string;
  readonly hero?: boolean;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const challenge = useRef<HTMLDivElement>(null);
  const request = useMagicLinkRequest();
  const sent =
    request.data?.outcome === "sent" ? request.data.email : undefined;
  return (
    <>
      <form
        className={`waitlist-form${hero ? " hero-waitlist" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (request.isPending || !challenge.current) return;
          const email = String(
            new FormData(event.currentTarget).get("email") ?? "",
          ).trim();
          request.mutate({
            email,
            challenge: challenge.current,
            callbackURL: "/new",
            errorCallbackURL: "/signin?next=%2Fnew",
          });
        }}
      >
        <label htmlFor={inputId}>
          {hero
            ? "We handle the infrastructure. Get early access."
            : "Try dx with infrastructure handled for you."}
        </label>
        <div className="waitlist-fields">
          <input
            id={inputId}
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            disabled={request.isPending}
            aria-describedby={
              request.isError || sent !== undefined
                ? `${inputId}-status`
                : undefined
            }
            onInput={() => request.reset()}
          />
          <button
            className="primary"
            type="submit"
            disabled={request.isPending}
          >
            {request.isPending ? "Please wait…" : "Get early access"}{" "}
            <span aria-hidden="true">
              <ArrowIcon direction="up-right" />
            </span>
          </button>
        </div>
        <div ref={challenge} />
        {(request.isError || sent !== undefined) && (
          <p
            id={`${inputId}-status`}
            role={request.isError ? "alert" : "status"}
          >
            {request.isError
              ? request.error instanceof Error
                ? request.error.message
                : "Request failed. Please try again."
              : `Check your email. We sent a sign-in link to ${sent}.`}
          </p>
        )}
      </form>
      <WaitlistDialog
        open={request.data?.outcome === "waitlisted"}
        email={request.data?.email}
        onClose={() => request.reset()}
      />
    </>
  );
}

/** Preview-only signup interaction; never sends or stores the address. */
function PreviewWaitlistForm({
  id,
  hero = false,
}: {
  readonly id?: string;
  readonly hero?: boolean;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [submitted, setSubmitted] = useState(false);
  return (
    <form
      className={`waitlist-form${hero ? " hero-waitlist" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <label htmlFor={inputId}>
        {hero
          ? "We handle the infrastructure. Get early access."
          : "Try dx with infrastructure handled for you."}
      </label>
      <div className="waitlist-fields">
        <input
          id={inputId}
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          aria-describedby={
            submitted && !hero ? `${inputId}-status` : undefined
          }
          onInput={() => setSubmitted(false)}
        />
        <button
          className={`primary${hero && submitted ? " is-launching" : ""}`}
          type="submit"
          onAnimationEnd={() => {
            if (hero) setSubmitted(false);
          }}
        >
          Get early access{" "}
          <span aria-hidden="true">
            <ArrowIcon direction="up-right" />
          </span>
        </button>
      </div>
      {!hero && submitted && (
        <p id={`${inputId}-status`} role="status">
          Signup is not connected yet. Your email has not been submitted.
        </p>
      )}
    </form>
  );
}
