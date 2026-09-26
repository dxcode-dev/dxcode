---
title: Bitbucket source access
description: Register a Bitbucket Cloud OAuth consumer for private repositories and pull requests.
---

Bitbucket integration is optional. Public Git URLs work without it. Configure a
Bitbucket Cloud OAuth consumer when users need private repository discovery,
checkout, pushes, or pull request operations.

## Register the OAuth consumer

You need administrative access to a Bitbucket Cloud workspace. Follow
Atlassian's [OAuth consumer
guide](https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/).

1. Open the workspace's **Settings → OAuth consumers** and choose **Add
   consumer**.
2. Enter a name and the deployment origin as the website.
3. Set the callback URL to
   `<deployment-origin>/v1/integrations/bitbucket/oauth/callback`.
4. Select **Account: Read**, **Repositories: Write**, and **Pull requests:
   Write**. Leave unrelated permissions off.
5. Save the consumer and copy its generated key and secret.

For dxcode.dev, the callback is:

```text
https://dxcode.dev/v1/integrations/bitbucket/oauth/callback
```

The `account` scope lets dx identify the user and inspect accessible workspaces.
`repository:write` includes repository read and HTTPS push access.
`pullrequest:write` includes pull request read, create, update, approve, decline,
and merge access. Atlassian defines these scopes in the [Bitbucket OAuth 2.0
reference](https://developer.atlassian.com/cloud/bitbucket/oauth-2#bitbucket-oauth-2-0-scopes).

## Create the installer JSON

The consumer key is the `clientId`. The installer accepts this exact object:

```json
{
  "version": 1,
  "clientId": "replace-with-consumer-key",
  "clientSecret": "replace-with-consumer-secret",
  "callbackUrl": "https://dx.example.com/v1/integrations/bitbucket/oauth/callback"
}
```

The callback must use HTTPS and exactly match the deployment origin and path.
Extra fields are rejected. Do not commit this JSON or expose the consumer
secret.

Run `pnpm dx:deploy`, answer **Yes** to **Configure Bitbucket OAuth**, and paste
the object at the hidden **Bitbucket OAuth JSON** prompt. Noninteractive runs set
`integrations` to include `bitbucket` and supply the object through
`DX_INTEGRATION_BITBUCKET_OAUTH`.

## Connect and verify

1. Open **Settings → Integrations → Bitbucket** in dx.
2. Choose **Connect** and authorize the consumer as the Bitbucket user whose
   repositories should be available.
3. Create a project from a private Bitbucket repository.
4. Verify checkout from the default branch and create or update a pull request
   from an agent branch.

dx refreshes expiring access tokens. **Refresh** rechecks the account and
repository list. Disconnecting in dx deletes its stored authorization and stops
local access. It does not revoke the grant at Bitbucket; use Bitbucket's app
authorization settings for provider-side revocation.

## Rotate or remove access

Create a replacement consumer, then run `pnpm dx:deploy -- --rotate`, choose
Bitbucket, and provide its JSON. Users must reconnect. Verify access before
deleting the old consumer. To remove Bitbucket from a deployment, remove
`bitbucket` from `integrations`, rerun, disconnect stored connections in dx, and
delete or revoke the consumer in Bitbucket.

## Troubleshooting

- **Configuration rejected:** confirm the object has only the four documented
  fields and the callback exactly matches the deployed HTTPS origin.
- **Authorization returns an error:** compare the callback in Bitbucket with the
  JSON, then start **Connect** again. Authorization state expires after ten
  minutes and cannot be reused.
- **Repositories are missing:** confirm the authorizing user has access and the
  consumer has Account read, Repositories write, and Pull requests write.
- **Connection expires:** choose **Reconnect**. Unused Bitbucket refresh tokens
  expire, and provider-side revocation also requires a new authorization.
- **Disconnect still appears in Bitbucket:** revoke dx from Bitbucket's app
  authorization settings after disconnecting locally.
