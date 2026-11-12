# Any other provider, or your own service

## Fit dx tokens to a provider

Any system that supports OIDC or JWT workload federation can trust dx. Find its federation
documentation (search its docs for "workload identity federation", "OIDC identity provider", or "JWT
auth") and map these settings:

| Provider setting | dx value |
| --- | --- |
| Issuer or discovery URL | The `iss` claim; discovery is `<iss>/.well-known/openid-configuration`, keys are `<iss>/jwks.json` |
| Algorithm | RS256 |
| Audience | One value chosen for this integration, requested with `--audience` |
| Claim conditions | See below |
| Subject or principal name | `thread_id` when the provider limits length or needs readable names; `sub` otherwise |

How the provider can restrict access decides the design:

1. **It matches custom claims** (Google Cloud, HashiCorp Vault): require `token_use ==
   dx_workload_identity_v1` and match `workspace_id`, `project_id`, or `user_id`. This is the best fit.
2. **It matches `sub` with wildcards only** (AWS): use the `sub` patterns in
   [aws.md](aws.md#sub-patterns); the hashed layers keep workspace, user, and Project scopes exact.
3. **It matches `sub` exactly only** (Azure): one credential per Thread; see [azure.md](azure.md).

Check the provider's length limits on subjects and attributes against dx's `sub`, which is about 170
characters. When it lists audiences or issuers per connection, one issuer per dx deployment is the
norm.

### Example: HashiCorp Vault

```sh
vault auth enable jwt
vault write auth/jwt/config oidc_discovery_url='<iss>' bound_issuer='<iss>'
vault write auth/jwt/role/dx-reader role_type=jwt \
  bound_audiences='<audience>' user_claim=thread_id \
  bound_claims='{"workspace_id":"<workspace_id>","token_use":"dx_workload_identity_v1"}' \
  token_policies='<read-only-policy>' token_ttl=15m
```

From a Thread: `vault write -field=token auth/jwt/login role=dx-reader jwt="$(dxd id-token --audience
'<audience>')"`.

## Your own service

A service verifies dx tokens as an OIDC relying party. On every request it checks:

1. The signature is RS256 under the JWKS key matching the token's `kid` (fetch `jwks_uri` from the
   discovery document; refetch on an unknown `kid`).
2. `iss` equals the dx issuer exactly.
3. `aud` equals this service's audience exactly.
4. `exp` is in the future, with a small clock-skew allowance; a token without `exp` is rejected.
5. `token_use` equals `dx_workload_identity_v1`.
6. The identity claims its policy needs (`workspace_id`, `project_id`, `user_id`, or `thread_id`)
   match the allowed values. Use these immutable IDs, never names.

Use a maintained JOSE library (`jose` for JavaScript, `PyJWT` with its JWKS client for Python) with
the algorithm pinned to RS256. Tokens cannot be revoked before `exp`, so keep the requested TTL short.
From a Thread, send `Authorization: Bearer $(dxd id-token --audience <audience>)`.
