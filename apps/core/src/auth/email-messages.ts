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
  readonly action: string;
  readonly url: string;
  readonly footnote: string;
}) => {
  const url = escapeHtml(input.url);
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f5f2e9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#14171a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e3ded1;border-radius:12px;padding:32px;">
          <tr><td style="font-size:22px;font-weight:700;letter-spacing:-0.02em;padding-bottom:24px;">dx</td></tr>
          <tr><td style="font-size:18px;font-weight:600;padding-bottom:8px;">${escapeHtml(input.heading)}</td></tr>
          <tr><td style="font-size:14px;line-height:22px;color:#4a4f55;padding-bottom:24px;">${escapeHtml(input.body)}</td></tr>
          <tr><td style="padding-bottom:24px;">
            <a href="${url}" style="display:inline-block;background:#14171a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">${escapeHtml(input.action)}</a>
          </td></tr>
          <tr><td style="font-size:12px;line-height:18px;color:#7a7f85;">${escapeHtml(input.footnote)}<br /><br />Or paste this link into your browser:<br /><span style="word-break:break-all;">${url}</span></td></tr>
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
    action: "Sign in to dx",
    url,
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
    action: "Confirm email",
    url,
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
    action: "Sign in to dx",
    url: signInUrl,
    footnote: "If this wasn't you, you can ignore this email.",
  }),
});
