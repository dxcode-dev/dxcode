import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const adminCredentialPath = (workspaceRoot) =>
  resolve(workspaceRoot, ".dx/secrets/selfhost-admin.txt");

export const generateAdminPassword = () =>
  randomBytes(24).toString("base64url");

const assertAdminPassword = (password) => {
  if (password.length < 8 || password.length > 128)
    throw new Error("Administrator password must be 8-128 characters.");
};

export const collectAdminPassword = async ({ readSecret, reset = false }) => {
  const password = await readSecret(
    `${reset ? "New" : "First"} administrator password (leave blank to generate)`,
  );
  if (password === "") return generateAdminPassword();
  assertAdminPassword(password);
  const confirmation = await readSecret("Confirm administrator password");
  if (confirmation !== password)
    throw new Error("Administrator passwords do not match.");
  return password;
};

export const writeAdminCredentialFile = ({ path, url, email, password }) => {
  assertAdminPassword(password);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(
    path,
    `Login URL: ${url}\nAdministrator email: ${email}\nCurrent administrator password: ${password}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
};
