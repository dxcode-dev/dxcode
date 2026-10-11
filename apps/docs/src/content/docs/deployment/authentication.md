---
title: Sign-in and authentication
description: Choose sign-in methods, who may create an account, allowed email domains, Google sign-in, and the sender for sign-in email.
---

Each deployment chooses how people sign in and who may create an account.
`pnpm dx:deploy` asks on the first deploy and records the answers in the
`signIn` block of `deploy.selfhost.json`. The sign-in page at `/signin` shows
exactly the configured methods, plus links to your Terms of Service and
Privacy Policy when you set them.

## Methods

| Method | `providers` value | Needs |
| --- | --- | --- |
| Magic link | `magic-link` | A sender address, `authEmailFrom` |
| Email and password | `email-password` | `authEmailFrom`, unless `admission` is `invite` |
| Google | `google` | `googleClientId` and the `DX_GOOGLE_CLIENT_SECRET` secret |

A deployment can offer any combination. With more than one, the sign-in page
puts the email field first and the other methods below it. With both magic
link and password, a link under the email field switches between them.

Every new password account confirms its address through a verification email
before its first session, so public password sign-up needs `authEmailFrom`.
A Google account must have an email Google has verified.

## Who may create an account

`admission` decides who may create an account. People who already have one
can always sign in.

- `invite` (the default): only the administrator and people who open a
  [workspace invite link](/docs/get-started/workspace-members/).
- `waitlist`: an unknown address is recorded on the waitlist, and the page
  tells the person so. It can create an account after you approve it or send
  it an invite link.
- `open`: anyone.

`allowedEmailDomains` limits new accounts to the listed domains, matched
exactly: `example.com` does not admit `team.example.com`. An empty list allows
any domain. The administrator, approved waitlist addresses, and invite links
bypass the waitlist and the domain list.

dx applies these rules before it creates any account, whichever method is
used, so Google cannot bypass the waitlist or the domain list.

## One account per email

Sign-in methods share accounts by verified email. The administrator created
by the deploy can sign in with Google using the same address and lands in the
same account; so can anyone whose account a magic link created. New accounts
take their name from the sign-up form or from Google. Google fills in a name a
magic-link account never had, but never replaces a name someone already set.

Someone who tries to sign up with an email that already has an account gets an
email with a sign-in link instead; the page does not reveal that the account
exists.

Google links only to an account whose email is confirmed. A magic link
confirms it, and so does the confirmation email a password sign-in sends when
the deployment has a sender. The deploy marks the administrator's address
confirmed.

### Accounts created before v0.2.12

Releases before v0.2.12 stored every self-host account with an unconfirmed
email, so Google cannot link to them; the sign-in page says so. The next
`pnpm dx:deploy` confirms the administrator's address. For other people,
either let them confirm it themselves (a magic link, or a password sign-in on
a deployment with a sender) or, when you know the address belongs to them,
confirm it in the deployment's D1 database:

```sh
pnpm --filter @dx/core exec wrangler d1 execute dx-db-selfhost-<name> --remote \
  --command "UPDATE \"user\" SET emailVerified = 1, updatedAt = datetime('now') WHERE email = 'person@example.com'"
```

Confirm only addresses you trust: on a deployment that allowed open password
sign-up without verification, anyone could have registered someone else's
email.

## Send sign-in email

Magic links and verification emails come from `authEmailFrom` through
Cloudflare Email Sending. Email Routing handles inbound mail and is not
required.

1. Choose a sender domain: the deployment zone or one of its subdomains, such
   as `mail.example.com`. A dedicated subdomain keeps Cloudflare's sending
   records separate from your existing mail records.
2. In the Cloudflare dashboard for the deployment account, onboard that domain
   to Email Sending and add the DNS records Cloudflare lists. See Cloudflare's
   [Email Service documentation](https://developers.cloudflare.com/email-service/)
   and [sending-subdomain guide](https://developers.cloudflare.com/email-service/configuration/subdomains/).
3. Wait until Cloudflare marks the domain enabled.
4. Use a Cloudflare API token with the permissions in
   [deployment configuration](/docs/deployment/configuration/#cloudflare-authentication).
   Alchemy's browser login cannot manage Email Sending or Turnstile.

With `authEmailFrom`, the deploy also creates and manages a Turnstile widget
that protects sign-in email requests. The installer checks the exact sender
domain before it asks for other secrets.

## Create a Google OAuth client

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   pick or create a project and configure the OAuth consent screen. dx asks
   only for the `openid`, `email`, and `profile` scopes.
2. Create an OAuth client ID of type **Web application**.
3. Under **Authorized redirect URIs**, add
   `https://<your-domain>/api/auth/callback/google`, for example
   `https://dx.example.com/api/auth/callback/google`. The wizard and the
   deploy output print the exact value. No JavaScript origin is needed.
4. Copy the client ID and client secret. The client ID is stored in
   `deploy.selfhost.json`; the secret is held in deployment state after the
   first deploy that uses it.

While the consent screen is in testing mode, only the test users you list can
sign in with Google. Publish it for everyone else.

## First deploy

The wizard asks, in order:

1. whether dx sends sign-in email from your domain, and if so the sender
   address;
2. which methods to offer: magic link (only when sending email), email and
   password, Google (client ID and hidden client secret);
3. who can create an account: `open`, `waitlist`, or `invite`;
4. allowed email domains (blank allows any);
5. optional Terms of Service and Privacy Policy URLs.

The administrator password is asked only when email and password is offered.

## Change sign-in on an existing deployment

Rerun the wizard with `--sign-in` to answer the sign-in questions again:

```sh
pnpm dx:deploy -- --sign-in
```

A deployment created before these settings existed is offered the same step
once on its next `pnpm dx:deploy`. Its earlier behavior is kept if you decline:
a sender meant magic link behind the waitlist; otherwise email and password,
invite only.

- **Adding Google** asks for the client ID and secret in the wizard. To edit
  the file instead, add `google` and `googleClientId`, and set
  `DX_GOOGLE_CLIENT_SECRET` in the environment for that run. Rotate the secret
  later with `pnpm dx:deploy -- --rotate`.
- **Adding email and password** to a deployment that ran without it: the
  wizard offers to set the administrator password, which attaches to the
  administrator account that already signed in by magic link or Google.
- **Adding a sender** (for magic link or public password sign-up): add
  `authEmailFrom` to `deploy.selfhost.json`, deploy with an API token, then
  run `--sign-in`.

## Configuration reference

```json
{
  "authEmailFrom": "sign-in@mail.example.com",
  "signIn": {
    "providers": ["magic-link", "email-password", "google"],
    "admission": "waitlist",
    "allowedEmailDomains": ["example.com"],
    "googleClientId": "1234567890-abc.apps.googleusercontent.com",
    "termsUrl": "https://example.com/terms",
    "privacyUrl": "https://example.com/privacy"
  }
}
```

| Field | Rule |
| --- | --- |
| `providers` | One or more of `magic-link`, `email-password`, `google`, each once |
| `admission` | `open`, `waitlist`, or `invite`; defaults to `invite` |
| `allowedEmailDomains` | Lowercase domains, each once; empty allows any |
| `googleClientId` | Required with, and only with, `google` |
| `termsUrl`, `privacyUrl` | Optional `https` URLs |

`allowSignup` from earlier releases still works with `authEmailFrom`. Without
a sender, `allowSignup: true` now fails validation, because public password
sign-up verifies each email.

## Approve waitlist entries

dx has no approval screen yet. Waitlist entries are rows in the deployment's
D1 database, named `dx-db-selfhost-<name>`. Approve one from the Cloudflare
dashboard's D1 console, or with Wrangler:

```sh
pnpm --filter @dx/core exec wrangler d1 execute dx-db-selfhost-<name> --remote \
  --command "UPDATE auth_waitlist SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now') WHERE email = 'person@example.com'"
```

The person then signs in with any offered method. Sending them a workspace
invite link also admits them.

## Sign-in messages

| Message | Cause |
| --- | --- |
| You're on the waitlist | `admission` is `waitlist` and the address is not approved |
| This email domain can't be used to sign in here | The domain is not in `allowedEmailDomains` |
| No dx account uses this email | `admission` is `invite` and there is no invite link |
| Google hasn't verified this email address | The Google account's email is unverified |
| That link is invalid or was already used | A magic link or confirmation link was reused or replaced |
| An account already uses this email … isn't confirmed yet | A Google sign-in matched an account whose email is not confirmed; see [accounts created before v0.2.12](#accounts-created-before-v0212) |
