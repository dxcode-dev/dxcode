// Shared by the scripts beside it: mints a dx workload identity token through
// the resident dxd and reads its claims. The token is a secret; callers hand
// it straight to the provider and never print it.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const dxd = existsSync("/usr/local/bin/dxd") ? "/usr/local/bin/dxd" : "dxd";

export const mintToken = (audience, ttlSeconds = 300) => {
  try {
    return execFileSync(
      dxd,
      ["id-token", "--audience", audience, "--ttl-seconds", String(ttlSeconds)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    fail(
      "dxd id-token failed: check the audience (no whitespace, at most 256 characters) and retry if the Orb just woke.",
    );
  }
};

export const claimsOf = (token) =>
  JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());

export const parseArguments = (names, usage) => {
  const values = {};
  const input = process.argv.slice(2);
  for (let index = 0; index < input.length; index += 2) {
    const name = input[index]?.replace(/^--/, "");
    const value = input[index + 1];
    if (!names.includes(name) || value === undefined) fail(usage);
    values[name] = value;
  }
  return values;
};

export const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
