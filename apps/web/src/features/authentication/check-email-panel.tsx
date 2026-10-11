import { ArrowLeft, Mail, MailCheck } from "lucide-react";
import { Button } from "../../shared/ui/button.js";

/** Replaces the form once a sign-in link or confirmation email is on its way. */
export function CheckEmailPanel({
  icon,
  title,
  email,
  detail,
  note,
  resendLabel,
  resendError,
  onResend,
  onBack,
}: {
  readonly icon: "link" | "verify";
  readonly title: string;
  readonly email: string;
  readonly detail: string;
  readonly note: string;
  readonly resendLabel?: string;
  readonly resendError?: string;
  readonly onResend?: () => void;
  readonly onBack: () => void;
}) {
  return (
    <div className="sign-in-check-email" role="status">
      <div className="sign-in-check-email-icon" aria-hidden="true">
        {icon === "link" ? <Mail /> : <MailCheck />}
      </div>
      <h2>{title}</h2>
      <p>
        {detail} <strong>{email}</strong>.
      </p>
      <p className="sign-in-hint">{note}</p>
      {onResend === undefined ? null : (
        <Button type="button" variant="outline" onClick={onResend}>
          {resendLabel}
        </Button>
      )}
      {resendError === undefined ? null : (
        <p className="sign-in-error" role="alert">
          {resendError}
        </p>
      )}
      <button type="button" className="sign-in-switch" onClick={onBack}>
        <ArrowLeft aria-hidden="true" /> Use a different email
      </button>
    </div>
  );
}
