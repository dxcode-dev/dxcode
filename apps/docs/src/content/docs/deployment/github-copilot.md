---
title: GitHub Copilot
description: Configure device authorization for personal GitHub Copilot subscriptions.
---

GitHub Copilot is an optional personal model connection. It is separate from
the GitHub App used for source repositories. Each user authorizes their own
Copilot subscription.

:::caution[Compatibility limitation]
GitHub documents the OAuth device flow used for authorization, but it does not
publish a supported Copilot inference API for this integration. dx currently
uses compatibility endpoints and headers observed in GitHub's developer tools.
GitHub can change or block that behavior. Treat Copilot as optional and keep a
documented model route through a supported provider.
:::

## Register an OAuth App

Create an operator-owned GitHub OAuth App. Do not copy a client ID from another
application. Follow GitHub's [OAuth App registration
guide](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

1. Open **Settings → Developer settings → OAuth apps → New OAuth App**.
2. Set the application name and homepage URL. Use `<deployment-origin>` for the
   homepage.
3. Set the authorization callback URL to `<deployment-origin>/`. GitHub requires
   this registration field, although device authorization does not redirect to
   it.
4. Enable **Device Flow**.
5. Keep expiring user access tokens enabled, then register the app.
6. Copy the OAuth App's client ID. dx does not need or accept its client secret.

GitHub's [device flow
reference](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
documents the endpoints, polling interval, code expiry, and token refresh flow.

For dxcode.dev, both homepage and callback use `https://dxcode.dev`, with a
trailing slash accepted for the callback field.

`DX_GITHUB_COPILOT_CLIENT_ID` is this OAuth App client ID. During device
authorization, dx requests the documented `read:user` scope from
`https://github.com/login/device/code`, directs the user to
`https://github.com/login/device`, and polls
`https://github.com/login/oauth/access_token`.

## Configure the deployment

Run `pnpm dx:deploy`, answer **Yes** to **Configure GitHub Copilot sign-in**, and
enter the client ID at **GitHub Copilot OAuth client ID**. This value is an
identifier, not a secret. Noninteractive runs set `githubCopilotClientId` in
`deploy.selfhost.json`.

Without a nonempty client ID, Copilot authorization endpoints return
unavailable and users cannot start the connection flow. Other model providers
continue to work.

## Connect and verify

1. Confirm the GitHub account has an active Copilot subscription.
2. Open **Settings → Model routing** in dx and choose **Connect GitHub Copilot**.
3. Open the displayed `https://github.com/login/device` link and enter the
   one-time code.
4. Return to dx and wait for the connection to complete.
5. Assign an available Copilot model to one agent slot and run a small prompt.

dx encrypts the resulting personal OAuth credential. Refresh rechecks the
GitHub identity, subscription access, and model catalog. Disconnect is blocked
while a model route still uses the connection; remove those routes first.

## Rotate or disconnect

To replace the OAuth App, update `githubCopilotClientId` in
`deploy.selfhost.json` and rerun `pnpm dx:deploy`. Ask users to disconnect and
authorize through the replacement app, then delete the old OAuth App after
verification. A user disconnects from **Settings → Model routing** after
removing routes that use the subscription. They can also revoke the grant in
GitHub's application settings.

## Troubleshooting

- **Connect is unavailable:** set a nonempty `githubCopilotClientId` and rerun
  the deployment.
- **Device code fails:** confirm Device Flow is enabled on the same OAuth App
  whose client ID was deployed, then start a new code. Codes expire and cannot
  be reused.
- **GitHub authorizes but no models appear:** confirm the signed-in account has
  Copilot access. Organization policy can restrict models.
- **Inference fails after a successful connection:** the compatibility API may
  have changed or rejected the client. Use another configured provider; a
  successful OAuth grant does not prove Copilot inference compatibility.
- **Disconnect is blocked:** remove every model route that uses the Copilot
  connection, then disconnect again.
