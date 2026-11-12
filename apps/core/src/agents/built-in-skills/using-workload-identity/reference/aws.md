# AWS

AWS IAM trusts dx through an IAM OIDC identity provider and a role whose trust policy allows
`sts:AssumeRoleWithWebIdentity`. IAM trust policies read only the standard `aud` and `sub` claims,
never `workspace_id` or the other dx claims, so scope is expressed as a `sub` pattern.

## `sub` patterns

`scripts/claims.mjs` prints these with the hashes filled in for the current Thread, as
`awsSubPatterns`, and the condition keys they belong under as `awsConditionKeys`. `<W>`, `<U>`,
`<P>`, and `<T>` are the hashes of the workspace, user, Project, and Thread IDs. A hash of another
ID is `printf '%s' '<id>' | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='`.

| Scope | `StringLike` value for `<issuer-host-and-path>:sub` |
| --- | --- |
| A workspace | `dx:wid:v1:w:<W>:*` |
| A workspace, one user | `dx:wid:v1:w:<W>:u:<U>:*` |
| A workspace Project | `dx:wid:v1:w:<W>:u:*:p:<P>:t:*` |
| A personal Project | `dx:wid:v1:u:<U>:p:<P>:t:*` |
| All of a user's personal Projects | `dx:wid:v1:u:<U>:*` |
| One Thread | the Thread's exact `sub`, with `StringEquals` |

The hashes contain no colons, so these patterns cannot match another workspace, user, or Project.

## Setup (the person runs this in AWS CloudShell)

Fill in `ISSUER` (the `iss` claim), `AUDIENCE`, `SUB_PATTERN`, and the role and policy. The example
grants read-only CloudWatch Logs.

```sh
export ISSUER='https://<host>/api/workload-identity'
export ISSUER_HOST="${ISSUER#https://}"
export AUDIENCE='urn:dx:aws:<account-id>'
export SUB_PATTERN='dx:wid:v1:w:<W>:*'
export ROLE_NAME='dx-logs-readonly'
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

# One OIDC provider per issuer per account. If it already exists, add the audience instead:
#   aws iam add-client-id-to-open-id-connect-provider \
#     --open-id-connect-provider-arn "arn:aws:iam::$ACCOUNT_ID:oidc-provider/$ISSUER_HOST" \
#     --client-id "$AUDIENCE"
aws iam create-open-id-connect-provider --url "$ISSUER" --client-id-list "$AUDIENCE"

cat > dx-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::$ACCOUNT_ID:oidc-provider/$ISSUER_HOST" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "$ISSUER_HOST:aud": "$AUDIENCE" },
      "StringLike": { "$ISSUER_HOST:sub": "$SUB_PATTERN" }
    }
  }]
}
EOF

aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document file://dx-trust.json --max-session-duration 3600
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsReadOnlyAccess

echo "ROLE_ARN=arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME AUDIENCE=$AUDIENCE"
```

- Current IAM validates the issuer's TLS chain itself; no thumbprint is needed.
- `CloudWatchLogsReadOnlyAccess` reads every log group in the account. For less, attach an inline
  policy limited to specific log group ARNs.
- Repeat in each AWS account the Threads should reach.
- An `EntityAlreadyExists` error on a rerun means that resource was created by the earlier run.

## Use from a Thread

`scripts/aws-credentials.mjs` is an AWS `credential_process` helper: on each call it mints a fresh dx
token, exchanges it with STS, and prints the temporary credentials as JSON. Nothing is written to
disk. Add a profile to `~/.aws/config`:

```ini
[profile dx-logs]
region = <region>
credential_process = node /home/user/.local/share/dx/skills/using-workload-identity/scripts/aws-credentials.mjs --role-arn <role-arn> --audience <audience> --region <region>
```

When the connection is recorded as `OIDC_AWS_ROLE_ARN`, `OIDC_AWS_AUDIENCE`, and `OIDC_AWS_REGION`,
the helper reads them as defaults, so `credential_process = node <same path>` is enough. It names
each role session after the Thread ID, so CloudTrail shows which Thread acted.

Then use any AWS CLI or SDK with that profile:

```sh
aws sts get-caller-identity --profile dx-logs
aws logs tail <log-group> --profile dx-logs --since 1h --format short
aws logs filter-log-events --profile dx-logs --log-group-name <log-group> --filter-pattern ERROR
```

Install the AWS CLI v2 under `~/.local` if `aws` is missing (official zip, `./aws/install -i
~/.local/aws-cli -b ~/.local/bin`). SDKs (boto3, the JavaScript SDK) read the same profile through
`AWS_PROFILE=dx-logs`.

## Verify

1. `aws sts get-caller-identity --profile dx-logs` returns
   `arn:aws:sts::<account>:assumed-role/<role>/<session>`.
2. A read the role allows succeeds.
3. A write fails with `AccessDeniedException`, and `aws s3 ls --profile dx-logs` fails with
   `AccessDenied` (for a logs-only role).

## Read the existing configuration

For diagnosis, the person prints the provider and the role's trust policy (read-only):

```sh
aws iam list-open-id-connect-providers
aws iam get-open-id-connect-provider --open-id-connect-provider-arn '<provider-arn>'   # ClientIDList = allowed audiences
aws iam get-role --role-name '<role>' --query 'Role.AssumeRolePolicyDocument'          # aud and sub conditions
aws iam list-attached-role-policies --role-name '<role>'
```

Compare the provider URL with `iss`, the `ClientIDList` with the audience the helper requests, and the
`sub` condition with the patterns `scripts/claims.mjs` prints for this Thread.

## Errors

| STS error | Cause |
| --- | --- |
| `InvalidIdentityToken`: No OpenIDConnect provider found | No IAM OIDC provider for this exact issuer URL in the account |
| `InvalidIdentityToken`: The web identity token provided could not be validated | Usually the token's `aud` is not in the provider's client ID list; also an issuer whose keys AWS could not fetch. Compare `aud` with `aws iam get-open-id-connect-provider` first |
| `AccessDenied`: Not authorized to perform sts:AssumeRoleWithWebIdentity | The token verified, but the trust policy's `aud` or `sub` condition did not match |
| `ValidationError` on `DurationSeconds` | The helper's `--duration-seconds` exceeds the role's maximum session duration |
