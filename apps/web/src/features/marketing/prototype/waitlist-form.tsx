import { useContext, useId, useRef, useState } from "react";
import {
  accessRequestNotice,
  useAccessRequest,
} from "../../authentication/authentication-mutations.js";

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
  const request = useAccessRequest();
  return (
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
          container: challenge.current,
          callbackURL: "/new",
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
            request.isError || request.isSuccess
              ? `${inputId}-status`
              : undefined
          }
          onInput={() => request.reset()}
        />
        <button className="primary" type="submit" disabled={request.isPending}>
          {request.isPending ? "Please wait…" : "Get early access"}{" "}
          <span aria-hidden="true">↗</span>
        </button>
      </div>
      <div ref={challenge} />
      {(request.isError || request.isSuccess) && (
        <p id={`${inputId}-status`} role={request.isError ? "alert" : "status"}>
          {request.isError
            ? request.error instanceof Error
              ? request.error.message
              : "Request failed. Please try again."
            : request.isSuccess
              ? accessRequestNotice
              : ""}
        </p>
      )}
    </form>
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
          Get early access <span aria-hidden="true">↗</span>
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
