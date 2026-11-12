#!/usr/bin/env node
// AWS credential_process helper: exchanges a fresh dx workload identity token
// for temporary role credentials and prints them in the credential_process
// format. Nothing is written to disk.
import {
  claimsOf,
  fail,
  mintToken,
  parseArguments,
} from "./workload-token.mjs";

const usage =
  "usage: aws-credentials.mjs --role-arn <arn> --audience <audience> [--region <region>] [--duration-seconds <900-43200>]";
// A connection recorded in dx Settings supplies the defaults.
const options = {
  "role-arn": process.env.OIDC_AWS_ROLE_ARN,
  audience: process.env.OIDC_AWS_AUDIENCE,
  region: process.env.OIDC_AWS_REGION,
  ...parseArguments(
    ["role-arn", "audience", "region", "duration-seconds"],
    usage,
  ),
};
if (options["role-arn"] === undefined || options.audience === undefined)
  fail(usage);

const token = mintToken(options.audience);
const endpoint =
  options.region === undefined
    ? "https://sts.amazonaws.com/"
    : `https://sts.${options.region}.amazonaws.com/`;
const form = new URLSearchParams({
  Action: "AssumeRoleWithWebIdentity",
  Version: "2011-06-15",
  RoleArn: options["role-arn"],
  // The Thread ID names the session, so CloudTrail shows which Thread acted.
  RoleSessionName: claimsOf(token).thread_id ?? "dx-workload",
  WebIdentityToken: token,
  ...(options["duration-seconds"] === undefined
    ? {}
    : { DurationSeconds: options["duration-seconds"] }),
});

let body;
try {
  const response = await fetch(endpoint, { method: "POST", body: form });
  body = await response.text();
} catch (error) {
  fail(`STS request failed: ${error.message}`);
}
const field = (name) => {
  const value = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1];
  return value
    ?.replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
};
if (field("AccessKeyId") === undefined)
  fail(
    `STS ${field("Code") ?? "error"}: ${field("Message") ?? "unexpected response"}`,
  );
console.log(
  JSON.stringify({
    Version: 1,
    AccessKeyId: field("AccessKeyId"),
    SecretAccessKey: field("SecretAccessKey"),
    SessionToken: field("SessionToken"),
    Expiration: field("Expiration"),
  }),
);
