#!/usr/bin/env node
// Lists OIDC connections this Thread can already use: connections recorded
// as OIDC_* environment variables, AWS profiles and Google credential files
// that mint dx tokens, and repository files that mention dx token exchange.
// Prints identifiers only; it reads no tokens and calls no provider.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
const mintsDxTokens = (text) =>
  /dxd\s+(id-token|gcp-credential)|using-workload-identity\/scripts/.test(text);

const recorded = Object.fromEntries(
  Object.entries(process.env)
    .filter(([name]) => name.startsWith("OIDC_"))
    .sort(([a], [b]) => a.localeCompare(b)),
);

const awsProfiles = [];
const awsConfig = read(
  process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws/config"),
);
let section;
for (const line of awsConfig?.split("\n") ?? []) {
  const header = /^\s*\[(?:profile\s+)?([^\]]+)\]/.exec(line);
  if (header) section = header[1].trim();
  const process_ = /^\s*credential_process\s*=\s*(.+)$/.exec(line)?.[1];
  if (section && process_ && mintsDxTokens(process_))
    awsProfiles.push({ profile: section, credentialProcess: process_.trim() });
}

const googleFiles = [];
const candidates = new Set(
  [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ...[
      join(homedir(), ".config/dx-gcp"),
      join(homedir(), ".config/gcloud"),
    ].flatMap((directory) =>
      existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => name.endsWith(".json"))
            .map((name) => join(directory, name))
        : [],
    ),
  ].filter(Boolean),
);
for (const path of candidates) {
  try {
    const file = JSON.parse(read(path) ?? "");
    const command = file.credential_source?.executable?.command;
    if (file.type === "external_account" && command && mintsDxTokens(command))
      googleFiles.push({ path, provider: file.audience, command });
  } catch {}
}

let repositoryFiles = [];
try {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  repositoryFiles = execFileSync(
    "git",
    [
      "-C",
      root,
      "grep",
      "-l",
      "-I",
      "-E",
      "dxd (id-token|gcp-credential)|AssumeRoleWithWebIdentity|workloadIdentityPools|AzureADTokenExchange|OIDC_(AWS|GCP|AZURE)_",
      "--",
      ".",
      // This skill's own sources, when the repository is dx itself.
      ":(exclude)**/using-workload-identity/**",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  )
    .split("\n")
    .filter(Boolean)
    .slice(0, 30);
} catch {}

console.log(
  JSON.stringify(
    {
      found:
        Object.keys(recorded).length +
          awsProfiles.length +
          googleFiles.length +
          repositoryFiles.length >
        0,
      recordedInSettings: recorded,
      awsProfiles,
      googleCredentialFiles: googleFiles,
      repositoryFiles,
    },
    null,
    2,
  ),
);
