#!/usr/bin/env node
// Exchanges a fresh dx workload identity token for a Microsoft Entra access
// token through a federated identity credential and prints only the access
// token, for command substitution.
import { fail, mintToken, parseArguments } from "./workload-token.mjs";

const usage =
  "usage: azure-access-token.mjs --scope <resource>/.default [--tenant <tenant-id>] [--client-id <client-id>] [--audience api://AzureADTokenExchange]";
// A connection recorded in dx Settings supplies the defaults.
const options = {
  tenant: process.env.OIDC_AZURE_TENANT_ID,
  "client-id": process.env.OIDC_AZURE_CLIENT_ID,
  audience: process.env.OIDC_AZURE_AUDIENCE ?? "api://AzureADTokenExchange",
  ...parseArguments(["tenant", "client-id", "audience", "scope"], usage),
};
if (
  options.tenant === undefined ||
  options["client-id"] === undefined ||
  options.scope === undefined
)
  fail(usage);

let result;
try {
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(options.tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: options["client-id"],
        scope: options.scope,
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: mintToken(options.audience),
      }),
    },
  );
  result = await response.json();
} catch (error) {
  fail(`Entra token request failed: ${error.message}`);
}
if (typeof result.access_token !== "string")
  fail(
    `Entra ${result.error ?? "error"}: ${result.error_description?.split("\r\n")[0] ?? "unexpected response"}`,
  );
console.log(result.access_token);
