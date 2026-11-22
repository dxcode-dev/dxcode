/** Plain, branded transactional email for sign-in. Product name stays lowercase `dx`. */
export interface AuthEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const layout = (input: {
  readonly heading: string;
  readonly body: string;
  readonly footnote: string;
  /** The button and its pasteable link; an email with nothing to click has none. */
  readonly action?: { readonly label: string; readonly url: string };
}) => {
  const url =
    input.action === undefined ? undefined : escapeHtml(input.action.url);
  const button =
    input.action === undefined
      ? ""
      : `
          <tr><td style="padding-bottom:24px;">
            <a href="${url}" style="display:inline-block;background:#14171a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">${escapeHtml(input.action.label)}</a>
          </td></tr>`;
  const pasteable =
    url === undefined
      ? ""
      : `<br /><br />Or paste this link into your browser:<br /><span style="word-break:break-all;">${url}</span>`;
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f5f2e9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#14171a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e3ded1;border-radius:12px;padding:32px;">
          <tr><td style="font-size:22px;font-weight:700;letter-spacing:-0.02em;padding-bottom:24px;">dx</td></tr>
          <tr><td style="font-size:18px;font-weight:600;padding-bottom:8px;">${escapeHtml(input.heading)}</td></tr>
          <tr><td style="font-size:14px;line-height:22px;color:#4a4f55;padding-bottom:24px;">${escapeHtml(input.body)}</td></tr>${button}
          <tr><td style="font-size:12px;line-height:18px;color:#7a7f85;">${escapeHtml(input.footnote)}${pasteable}</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
};

export const signInLinkEmail = (url: string): AuthEmail => ({
  subject: "Sign in to dx",
  text: `Sign in to dx:\n\n${url}\n\nThis link expires in 10 minutes and can be used once. If you did not request it, ignore this email.`,
  html: layout({
    heading: "Sign in to dx",
    body: "Use the button below to finish signing in.",
    action: { label: "Sign in to dx", url },
    footnote:
      "This link expires in 10 minutes and can be used once. If you did not request it, ignore this email.",
  }),
});

export const emailVerificationEmail = (url: string): AuthEmail => ({
  subject: "Confirm your email for dx",
  text: `Confirm your email to finish creating your dx account:\n\n${url}\n\nThis link expires in 1 hour. If you did not create an account, ignore this email.`,
  html: layout({
    heading: "Confirm your email",
    body: "Confirm this address to finish creating your dx account.",
    action: { label: "Confirm email", url },
    footnote:
      "This link expires in 1 hour. If you did not create an account, ignore this email.",
  }),
});

export const existingAccountEmail = (signInUrl: string): AuthEmail => ({
  subject: "You already have a dx account",
  text: `Someone tried to create a dx account with this email, which already has one. Sign in instead:\n\n${signInUrl}\n\nIf this wasn't you, you can ignore this email.`,
  html: layout({
    heading: "You already have a dx account",
    body: "Someone tried to create a dx account with this email, which already has one.",
    action: { label: "Sign in to dx", url: signInUrl },
    footnote: "If this wasn't you, you can ignore this email.",
  }),
});

/** Sent once, when an unknown address first joins the waitlist. */
export const waitlistJoinedEmail = (): AuthEmail => ({
  subject: "You're on the dx waitlist",
  text: "Thanks for your interest in dx. You're on the waitlist, and we'll email you as soon as your access is ready.\n\nYou don't need to do anything until then.",
  html: layout({
    heading: "You're on the waitlist",
    body: "Thanks for your interest in dx. We'll email you as soon as your access is ready.",
    footnote: "You don't need to do anything until then.",
  }),
});

/** Sent when an administrator approves an address; signing in creates the account. */
export const waitlistApprovedEmail = (signInUrl: string): AuthEmail => ({
  subject: "You're in: your dx access is ready",
  text: `Your dx access is ready. Sign in with this email address to get started:\n\n${signInUrl}`,
  html: layout({
    heading: "You're in",
    body: "Your dx access is ready. Sign in with this email address to get started.",
    action: { label: "Sign in to dx", url: signInUrl },
    footnote: "If you didn't ask to join dx, you can ignore this email.",
  }),
});
