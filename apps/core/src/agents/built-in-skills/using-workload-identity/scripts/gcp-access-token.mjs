#!/usr/bin/env node
// Exchanges a fresh dx workload identity token with Google's Security Token
// Service and prints only the federated access token, for command substitution.
import { fail, mintToken, parseArguments } from "./workload-token.mjs";

const usage =
  "usage: gcp-access-token.mjs --provider projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider> --audience <audience>";
// A connection recorded in dx Settings supplies the defaults.
const options = {
  provider: process.env.OIDC_GCP_PROVIDER,
  audience: process.env.OIDC_GCP_AUDIENCE,
  ...parseArguments(["provider", "audience"], usage),
};
if (options.provider === undefined || options.audience === undefined)
  fail(usage);

const provider = options.provider.replace(/^\/\/iam\.googleapis\.com\//, "");
let result;
try {
  const response = await fetch("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/${provider}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType: "urn:ietf:params:oauth:token-type:id_token",
      subjectToken: mintToken(options.audience),
    }),
  });
  result = await response.json();
} catch (error) {
  fail(`Google STS request failed: ${error.message}`);
}
if (typeof result.access_token !== "string")
  fail(
    `Google STS ${result.error ?? "error"}: ${result.error_description ?? "unexpected response"}`,
  );
console.log(result.access_token);
