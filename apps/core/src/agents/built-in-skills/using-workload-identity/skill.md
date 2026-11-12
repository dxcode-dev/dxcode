---
name: using-workload-identity
description: "Connects a Thread to AWS, Google Cloud, Azure, or any OIDC-trusting service through dx's OIDC workload identity, with short-lived tokens instead of stored keys. Use when asked about dx's OIDC support, when setting up an OIDC connection, when a task needs cloud logs or cloud APIs, or when a token exchange fails."
---

# Using Workload Identity

dx supports OIDC workload identity federation. Every Thread's Orb can mint a short-lived token,
signed by this dx deployment, that names the dx workspace, Project, user, and Thread it runs for. A
cloud provider configured to trust dx's issuer exchanges that token for temporary credentials, so no
long-lived cloud key is ever stored in dx.

```text
process in the Orb ── dxd id-token ──▶ dx signs a token (RS256, 60 s to 1 h)
        │
        └── token ──▶ cloud STS: verifies it against dx's public JWKS,
                      checks issuer, audience, and claim conditions
                      ──▶ temporary credentials for one role
```

A cloud admin sets the trust up once in the cloud account. The Thread holds no admin rights, so you
prepare the exact commands, the person runs them, and you verify from the Thread.

## The token

`dxd id-token --audience <audience> [--ttl-seconds 60-3600]` prints a token (default lifetime 300
seconds). It is a secret: pass it through a pipe or command substitution, never echo, log, or save
it, and never run it under `set -x`.

`scripts/claims.mjs` shows the claims without the token, plus the values setup needs: the issuer,
the claim hashes, and AWS condition keys and `sub` patterns. Its output is safe to show. The hashes
are 43 characters and easy to garble, so copy every ID, hash, and pattern verbatim from a run of it
in the current turn; never retype one from memory or assemble a pattern yourself.

| Claim | Value |
| --- | --- |
| `iss` | This deployment's issuer, `https://<dx host>/api/workload-identity`; discovery and JWKS are public under it. It differs per deployment, so always read it from the claims. |
| `aud` | Exactly the `--audience` requested |
| `sub` | `dx:wid:v1:w:<W>:u:<U>:p:<P>:t:<T>`, or `dx:wid:v1:u:<U>:p:<P>:t:<T>` for a personal Project; each part is the unpadded base64url SHA-256 of that ID. Unique per Thread. |
| `workspace_id` | The dx workspace that owns the Project. **Absent** for a personal Project. |
| `project_id` | The Thread's dx Project |
| `user_id` | The user who started the Thread |
| `thread_id` | The Thread |
| `token_use` | Always `dx_workload_identity_v1` |
| `runtime_assurance` | `dx_dxd_channel_v1`, or `dx_provider_attested_v1` when the Orb provider attested the runtime |

dx derives every claim on the server. At each mint it rechecks that the Thread is active and that its
user is still a member of the Project's workspace. A removed member gets no new tokens, but a token
already minted stays valid until `exp`, and credentials exchanged from it last up to an hour.

## Steps

### 1. Look for an existing connection

Run `scripts/find-connections.mjs`. It reports, without secrets:

- `OIDC_*` environment variables that record a connection (see step 5);
- AWS profiles whose `credential_process` mints dx tokens;
- Google external account files whose command runs `dxd`;
- repository files that mention dx token exchange.

Also read the repository's `AGENTS.md`, and ask the user whether a connection exists for the cloud
the task needs. Done when you hold a connection's coordinates (provider, role or pool, audience) or
the user confirmed there is none.

### 2. Verify an existing connection, or diagnose it

Exchange a token and make one call the connection should allow, using the provider reference below.
When it works, go to step 6. When it fails, read [Diagnose a connection](#diagnose-a-connection):
it was often built for a different scope than this Thread's.

### 3. Agree on a new connection with the user

Ask these questions, and propose an answer for each:

1. **Which cloud, account or project, and resources?** For example, Cloud Logging in two Google
   Cloud projects.
2. **Which access?** The narrowest role that does the job, such as read-only logs. Any code running
   in a trusted Thread can use that access, and the Orb has internet access, so readable data can
   leave.
3. **Which dx Threads?** All Threads of a dx workspace (`workspace_id`), specific Projects
   (`project_id`), specific users (`user_id`), or one Thread. Check `scripts/claims.mjs` first:
   a personal Project's token has no `workspace_id`, so workspace scope excludes it.
4. **Who runs the setup?** They need admin rights in the cloud account; a browser shell such as AWS
   CloudShell or Google Cloud Shell is enough.

Choose one audience per receiving integration, such as `urn:dx:aws:<account-id>` or
`urn:dx:gcp:<pool>`. Any Thread can ask for any audience, so the claim conditions are what restrict
access; the audience only names the recipient. Done when the user agrees to all four answers and
the audience.

### 4. Prepare the setup, have the person run it, verify

Fill every placeholder from the claims and the agreed answers, using the provider's reference:

- AWS: [reference/aws.md](reference/aws.md)
- Google Cloud: [reference/gcp.md](reference/gcp.md)
- Azure: [reference/azure.md](reference/azure.md)
- Any other provider or your own service: [reference/generic.md](reference/generic.md)

Give the person the filled-in commands and where to run them, and wait for their output. Then prove
from this Thread that the exchange succeeds, an allowed call succeeds, and a disallowed call (a
write, another service) is denied. When a Thread outside the scope is at hand, prove its exchange is
rejected too. Done when all of these hold.

### 5. Record the connection

Ask the person to save the connection's coordinates as environment variables in dx Settings →
Secrets & Env Vars, at workspace scope for a workspace connection or Project scope for one Project.
They are identifiers, not secrets, so save them as plain variables. Later Threads then find them in
step 1, and the helper scripts read them as defaults.

| Provider | Variables |
| --- | --- |
| AWS | `OIDC_AWS_ROLE_ARN`, `OIDC_AWS_AUDIENCE`, `OIDC_AWS_REGION` |
| Google Cloud | `OIDC_GCP_PROVIDER` (the provider resource name), `OIDC_GCP_AUDIENCE`, `OIDC_GCP_PROJECTS` (resource projects, comma-separated) |
| Azure | `OIDC_AZURE_TENANT_ID`, `OIDC_AZURE_CLIENT_ID`, `OIDC_AZURE_AUDIENCE` |

For a second connection to the same provider, insert a name: `OIDC_AWS_PROD_ROLE_ARN`. Done when
the person confirms the variables are saved, or declines.

### 6. Use it

Configure the provider's credential helper from its reference, then use the cloud's normal CLI or
SDK. Keep configuration files outside the repository unless the person asks to commit them. To set
the helper up in every new Thread of a Project, write the configuration from the Project's
`.agents/setup` (see `orb-setup`); tokens are minted when the CLI needs credentials, never during
setup.

## Diagnose a connection

A connection someone else built encodes choices this skill cannot know: which claim it matches,
which audience, which resources. Work from evidence:

1. Run `scripts/claims.mjs` and note which claims this Thread's token has.
2. Exchange a token and read the provider's exact error. The provider reference maps each error to
   the setting that rejected the token.
3. Ask the person to print the provider's configuration with the read-only command in the provider
   reference, and compare it with the claims: issuer URL against `iss`, allowed audiences against
   the audience you requested, and each claim condition against the claim values.
4. State the mismatch, then propose the smallest change that admits this Thread without widening
   access beyond what the person intends: request the configured audience, run the task from a
   Thread in the scoped Project or workspace, or have the person add this Project to the condition.

Common mismatches:

| Symptom | Likely cause |
| --- | --- |
| Rejected by the claim condition from a personal Project | The condition matches `workspace_id`, which personal Projects lack |
| Rejected from one Project, accepted from another | The condition or `sub` pattern names specific Projects |
| Audience error | The helper requests a different audience than the provider allows |
| Issuer or key error | The provider trusts another dx deployment's issuer, such as a preview |
| Exchange succeeds, call denied | The grant is on another resource, or is still propagating (allow a few minutes) |

## When `dxd id-token` fails

It exits with `command failed` and no detail. The cause is one of: whitespace in the audience or
more than 256 characters, a TTL outside 60–3600, dxd reconnecting after the Orb woke (retry after a
few seconds), an archived Thread, a Thread user who left the workspace, or a deployment policy that
requires provider attestation for that audience.
