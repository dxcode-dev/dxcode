export const GIT_CREDENTIAL_HELPER_PATH =
  "/home/user/.local/libexec/dx-git-credential";
export const SOURCE_WORKSPACE_PROGRAM_PATH =
  "/home/user/.local/libexec/dx-source-workspace.mjs";

/**
 * Verifies in ONE guest command that the template-baked credential helper and
 * source program match the Worker-held digests and that the required runtime
 * tools satisfy the version contract. A requested source action runs under the
 * source lock only after a fresh verdict. Prints one JSON verdict and exits
 * 0 (fresh), 42 (stale assets, tools fine → install fallback), 43 (tool
 * contract violation → typed template error), or 40 (verifier failure).
 */
export const assetVerifierProgram = String.raw`const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fail = () => process.exit(40);
const parseVersion = text => {
  const match = text.match(/(?:^|\s|\/)(\d+)\.(\d+)\.(\d+)(?:\s|$|\))/m);
  return match === null ? undefined : match.slice(1).map(Number);
};
const atLeast = (actual, minimum) => actual[0] > minimum[0] || (actual[0] === minimum[0] && (actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2])));
const hashAsset = path => {
  let stat;
  try { stat = fs.lstatSync(path); } catch (error) { return error?.code === "ENOENT" ? undefined : null; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 262144) return null;
  let descriptor;
  try {
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return createHash("sha256").update(fs.readFileSync(descriptor)).digest("hex");
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
};
const executable = path => {
  try {
    const stat = fs.lstatSync(path);
    return !stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch { return false; }
};
const realDirectory = path => {
  try {
    const stat = fs.lstatSync(path);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch { return false; }
};
const requiredDigest = name => {
  const value = process.env[name];
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail();
  return value;
};
const expectedHelper = requiredDigest("DX_ASSET_HELPER_DIGEST");
const expectedProgram = requiredDigest("DX_ASSET_PROGRAM_DIGEST");
const toolContract = (() => { try { return JSON.parse(process.env.DX_ASSET_TOOL_CONTRACT); } catch { return fail(); } })();
const requiredTools = (() => { try { return JSON.parse(process.env.DX_ASSET_TOOLS); } catch { return fail(); } })();
if (!Array.isArray(requiredTools)) fail();
const commands = { git: ["git", ["--version"]], gh: ["gh", ["--version"]], "git-lfs": ["git", ["lfs", "version"]] };
const tools = [];
for (const tool of requiredTools) {
  const entry = commands[tool];
  const contract = toolContract[tool === "git-lfs" ? "gitLfs" : tool];
  if (entry === undefined || !Array.isArray(entry[1]) || typeof contract?.maximumMajor !== "number" || !Array.isArray(contract?.minimum) || contract.minimum.length !== 3) fail();
  const result = spawnSync(entry[0], entry[1], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" }, encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
  const output = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  if (result.error !== undefined || (result.status ?? 1) !== 0) tools.push({ tool, status: "missing" });
  else {
    const version = parseVersion(output);
    if (version === undefined) tools.push({ tool, status: "invalid-output" });
    else if (version[0] > contract.maximumMajor || !atLeast(version, contract.minimum)) tools.push({ tool, status: "unsupported-version" });
    else tools.push({ tool, status: "ok", version: version.join(".") });
  }
}
const helperDigest = hashAsset(process.env.DX_ASSET_HELPER_PATH);
const programDigest = hashAsset(process.env.DX_ASSET_PROGRAM_PATH);
const assets = helperDigest === expectedHelper && programDigest === expectedProgram && executable(process.env.DX_ASSET_HELPER_PATH) && realDirectory(process.env.DX_ASSET_STATE_DIRECTORY) ? "fresh" : "stale";
const broken = tools.find(item => item.status !== "ok");
let operation;
if (broken === undefined && assets === "fresh" && process.env.DX_ASSET_ACTION !== undefined) {
  const action = process.env.DX_ASSET_ACTION;
  const timeout = Number(process.env.DX_ASSET_ACTION_TIMEOUT_MS);
  if ((action !== "snapshot" && action !== "activate") || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 660000) fail();
  const result = spawnSync(process.execPath, [process.env.DX_ASSET_PROGRAM_PATH, action], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout, maxBuffer: 65536 });
  if (result.error !== undefined || result.status === null) fail();
  operation = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status };
}
process.stdout.write(JSON.stringify({ assets, tools, ...(operation === undefined ? {} : { operation }) }));
process.exit(broken !== undefined ? 43 : assets === "fresh" ? 0 : 42);
`;

export const assetInstallerProgram = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const fail = () => process.exit(1);
const entry = value => {
  try { return fs.lstatSync(value); } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail();
  }
};
const directory = value => {
  const stat = entry(value);
  return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink();
};
const ensure = value => {
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  if (!directory(root)) fail();
  let current = root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = path.join(current, part);
    if (entry(current) === undefined) {
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch { fail(); }
    }
    if (!directory(current)) fail();
  }
};
const regular = value => {
  const stat = entry(value);
  if (stat === undefined || stat.isSymbolicLink() || !stat.isFile() || stat.size > 262144) fail();
};
const mode = process.argv[1];
const [helperTemporary, helperFinal, programTemporary, programFinal, stateDirectory] = process.argv.slice(2);
if (![helperTemporary, helperFinal, programTemporary, programFinal, stateDirectory].every(Boolean)) fail();
if (mode === "prepare") {
  ensure(path.dirname(helperFinal));
  ensure(path.dirname(programFinal));
  ensure(stateDirectory);
  if (entry(helperTemporary) !== undefined || entry(programTemporary) !== undefined) fail();
  try {
    fs.writeFileSync(helperTemporary, "", { flag: "wx", mode: 0o600 });
    fs.writeFileSync(programTemporary, "", { flag: "wx", mode: 0o600 });
  } catch { fail(); }
} else if (mode === "finalize") {
  ensure(path.dirname(helperFinal));
  ensure(path.dirname(programFinal));
  ensure(stateDirectory);
  regular(helperTemporary);
  regular(programTemporary);
  fs.chmodSync(helperTemporary, 0o555);
  fs.chmodSync(programTemporary, 0o555);
  fs.renameSync(helperTemporary, helperFinal);
  fs.renameSync(programTemporary, programFinal);
} else if (mode === "cleanup") {
  for (const temporary of [helperTemporary, programTemporary]) {
    const stat = entry(temporary);
    if (stat?.isFile() && !stat.isSymbolicLink()) fs.rmSync(temporary);
  }
} else fail();
`;

export interface SourceWorkspaceProgramConfiguration {
  readonly root: string;
  readonly state: string;
  readonly claim: string;
  readonly logDirectory: string;
  readonly helper: string;
  readonly templateDirectory: string;
  readonly home: string;
  readonly workspaceParent: string;
  readonly gitHome: string;
  /** Compile-time test fixture transport. Production permanently uses canonical origin. */
  readonly fixtureRemote?: string;
  readonly shallowClone?: boolean;
}

export const gitCredentialHelperProgram = String.raw`#!/usr/bin/env node
const process = require("node:process");

const fail = () => process.exit(1);
const operation = process.argv[2];
if (operation !== "get") fail();
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  if (input.length > 4096) fail();
});
process.stdin.on("end", () => {
  if (/[^\x20-\x7e\n]/.test(input)) fail();
  const values = new Map();
  for (const line of input.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) fail();
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (values.has(key) || !["protocol", "host", "path"].includes(key)) fail();
    values.set(key, value);
  }
  const allowed = process.env.DX_GIT_ALLOWED_PATH;
  const path = values.get("path");
  if (!allowed || !path || /[?#%@\\]/.test(path)) fail();
  const normalize = value => value.replace(/^\/+/, "").replace(/\.git$/, "").toLowerCase();
  const normalizedAllowed = normalize(allowed);
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalizedAllowed)) fail();
  const provider = process.env.DX_SOURCE_PROVIDER;
  if (provider === "github") {
    const token = process.env.GH_TOKEN;
    const normalizedPath = normalize(path.replace(/\/info\/lfs(?:\/.*)?$/, ""));
    if (!token || values.get("protocol") !== "https" || values.get("host")?.toLowerCase() !== "github.com" || normalizedPath !== normalizedAllowed) fail();
    process.stdout.write("username=x-access-token\npassword=" + token + "\n\n");
    return;
  }
  if (provider !== "bitbucket") fail();
  const token = process.env.DX_BITBUCKET_GIT_TOKEN;
  const origin = process.env.DX_BITBUCKET_GIT_ORIGIN;
  const gatewayPath = process.env.DX_BITBUCKET_GIT_PATH;
  let parsed;
  try { parsed = new URL(origin); } catch { fail(); }
  if (!token || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/" || values.get("protocol") !== "https" || values.get("host")?.toLowerCase() !== parsed.host.toLowerCase()) fail();
  if (!gatewayPath || !/^\/[A-Za-z0-9._/-]+$/.test(gatewayPath) || gatewayPath.endsWith("/")) fail();
  const expectedPath = gatewayPath.replace(/^\//, "") + "/" + allowed + ".git";
  const credentialPath = path.replace(/^\/+/, "").replace(/\/info\/lfs(?:\/.*)?$/, "");
  if (credentialPath !== expectedPath) fail();
  process.stdout.write("username=dx\npassword=" + token + "\n\n");
});
`;

const sourceWorkspaceTemplate = String.raw`#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const ROOT = __ROOT__;
const STATE = __STATE__;
const CLAIM = __CLAIM__;
const LOG_DIR = __LOG_DIRECTORY__;
const HELPER = __HELPER__;
const TEMPLATE = __TEMPLATE_DIRECTORY__;
const HOME = __HOME__;
const WORKSPACE_PARENT = __WORKSPACE_PARENT__;
const GIT_HOME = __GIT_HOME__;
const FIXTURE_REMOTE = __FIXTURE_REMOTE__;
// Platform-neutral mutex: mkdir is atomic on every POSIX host (no flock
// dependency). A dead holder is reclaimed via its recorded pid; a holder that
// crashed before writing its pid is reclaimed once the dir ages out.
const LOCK = join(dirname(STATE), "source-control.lock.d");
const LOCK_STALE_MS = 30000;
const lockSleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const holderAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};
const releaseLock = () => {
  try {
    if (readFileSync(join(LOCK, "pid"), "utf8").trim() === String(process.pid)) rmSync(LOCK, { recursive: true });
  } catch {}
};
const acquireLock = () => {
  process.on("exit", releaseLock);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(124));
  while (true) {
    try {
      mkdirSync(LOCK, { mode: 0o700 });
      try { writeFileSync(join(LOCK, "pid"), String(process.pid), { mode: 0o600, flag: "wx" }); }
      catch { rmSync(LOCK, { recursive: true }); fail("conflict"); }
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") fail("conflict");
    }
    const entry = lstat(LOCK);
    if (entry === undefined) continue;
    if (!entry.isDirectory()) fail("conflict");
    let holder;
    try { holder = readFileSync(join(LOCK, "pid"), "utf8").trim(); } catch { holder = undefined; }
    const pid = Number(holder);
    if (holder !== undefined && Number.isSafeInteger(pid) && pid > 1) {
      if (!holderAlive(pid)) {
        try { rmSync(LOCK, { recursive: true }); } catch { fail("conflict"); }
        continue;
      }
    } else if (Date.now() - entry.mtimeMs > LOCK_STALE_MS) {
      try { rmSync(LOCK, { recursive: true }); } catch { fail("conflict"); }
      continue;
    }
    lockSleep(50);
  }
};
const MAX_OUTPUT = 32768;
const MAX_MARKER = 65536;
const FULL_HISTORY_DIRECTIVE = "# dx-requires: full-history";
const SHALLOW_CLONE = __SHALLOW_CLONE__ || process.env.DX_SOURCE_SHALLOW_CLONE === "true";
class SourceWorkspaceFailure extends Error {
  constructor(kind, detail = "") {
    super(kind + (detail ? ":" + detail : ""));
    this.kind = kind;
    this.detail = detail;
  }
}
const fail = (kind, detail = "") => {
  throw new SourceWorkspaceFailure(kind, detail);
};
const required = name => {
  const value = process.env[name];
  if (!value || /[\0\r\n]/.test(value)) fail("invalid-input", name);
  return value;
};
const lstat = path => {
  try { return lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail("conflict");
  }
};
const isRealDirectory = path => {
  const value = lstat(path);
  return value !== undefined && value.isDirectory() && !value.isSymbolicLink();
};
const assertDirectoryChain = path => {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  if (!isRealDirectory(root)) fail("conflict");
  let current = root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    if (!isRealDirectory(current)) fail("conflict");
  }
};
const ensureDirectoryChain = path => {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  if (!isRealDirectory(root)) fail("conflict");
  let current = root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    if (lstat(current) === undefined) {
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if (error?.code !== "EEXIST") fail("conflict"); }
    }
    if (!isRealDirectory(current)) fail("conflict");
  }
};
const readRegular = (path, maximum = MAX_MARKER) => {
  const value = lstat(path);
  if (value === undefined || value.isSymbolicLink() || !value.isFile() || value.size > maximum) fail("conflict");
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return readFileSync(descriptor, "utf8");
  } catch { fail("conflict"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
};
const sha = value => createHash("sha256").update(value).digest("hex");
const identity = () => {
  const threadId = required("DX_THREAD_ID");
  const repositoryName = required("DX_REPOSITORY_NAME");
  const cloneUrl = required("DX_CLONE_URL");
  const provider = required("DX_SOURCE_PROVIDER");
  const bindingRevision = Number(required("DX_BINDING_REVISION"));
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repositoryName) || !Number.isSafeInteger(bindingRevision) || bindingRevision < 1) fail("invalid-input");
  if (provider !== "git" && provider !== "github" && provider !== "bitbucket") fail("invalid-input");
  if (provider === "git") {
    let parsed;
    try { parsed = new URL(cloneUrl); } catch { fail("invalid-input"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== "/" + repositoryName + ".git") fail("invalid-input");
  } else {
    const host = provider === "github" ? "github.com" : "bitbucket.org";
    if (cloneUrl !== "https://" + host + "/" + repositoryName + ".git") fail("invalid-input");
  }
  return { version: 2, threadId, provider, repositoryName, bindingRevision, cloneUrl, originHash: sha(cloneUrl) };
};
const snapshot = sourceIdentity => {
  const sourceSha = required("DX_SOURCE_SHA");
  const defaultBranch = required("DX_DEFAULT_BRANCH");
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(defaultBranch) || defaultBranch.includes("..")) fail("invalid-input");
  return { ...sourceIdentity, sourceSha, defaultBranch, initialRef: "refs/heads/" + defaultBranch };
};
const gitEnv = (repositoryName, credential = false) => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: GIT_HOME,
  XDG_CONFIG_HOME: join(GIT_HOME, "config"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  GIT_SSH_COMMAND: "/bin/false",
  SSH_AUTH_SOCK: "",
  GIT_TEMPLATE_DIR: TEMPLATE,
  GIT_LFS_SKIP_SMUDGE: "1",
  ...(credential ? process.env.DX_SOURCE_PROVIDER === "bitbucket" ? {
    DX_SOURCE_PROVIDER: "bitbucket", DX_BITBUCKET_GIT_TOKEN: required("DX_BITBUCKET_GIT_TOKEN"),
    DX_BITBUCKET_GIT_ORIGIN: required("DX_BITBUCKET_GIT_ORIGIN"), DX_BITBUCKET_GIT_PATH: required("DX_BITBUCKET_GIT_PATH"),
    DX_GIT_ALLOWED_PATH: repositoryName
  } : { DX_SOURCE_PROVIDER: "github", GH_TOKEN: required("GH_TOKEN"), DX_GIT_ALLOWED_PATH: repositoryName } : {}),
});
const hardening = (repositoryName, credential) => [
  "-c", "credential.helper=",
  ...(credential ? ["-c", "credential.helper=" + HELPER] : []),
  "-c", "credential.useHttpPath=true", "-c", "credential.interactive=false",
  "-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=" + TEMPLATE,
  "-c", "http.extraHeader=",
  "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never",
  "-c", "protocol.ssh.allow=never", "-c", "protocol.git.allow=never",
  "-c", "http.followRedirects=" + (credential ? "initial" : "false"),
  ...(credential && process.env.DX_SOURCE_PROVIDER === "bitbucket" ? [
    "-c", "url." + required("DX_BITBUCKET_GIT_ORIGIN") + required("DX_BITBUCKET_GIT_PATH") + "/" + repositoryName + ".git.insteadOf=https://bitbucket.org/" + repositoryName + ".git"
  ] : []),
  ...(FIXTURE_REMOTE === null ? [] : ["-c", "protocol.file.allow=always"])
];
const git = (cwd, repositoryName, args, credential = false, timeout = 120000, allowedStatuses = [0], deferFailure = false) => {
  assertDirectoryChain(dirname(HELPER));
  readRegular(HELPER, MAX_MARKER);
  const result = spawnSync("git", [...hardening(repositoryName, credential), ...args], { cwd, env: gitEnv(repositoryName, credential), encoding: "utf8", timeout, maxBuffer: MAX_OUTPUT });
  if (!allowedStatuses.includes(result.status)) {
    if (deferFailure) throw new Error("git-command-failed");
    fail("initialization", String(result.status));
  }
  return (result.stdout ?? "").slice(0, MAX_OUTPUT);
};
const readJson = path => {
  try { return JSON.parse(readRegular(path)); } catch { fail("conflict"); }
};
const invocation = value => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail("conflict");
  return value;
};
const sameIdentity = (left, right) => ["version","threadId","provider","repositoryName","bindingRevision","cloneUrl","originHash"].every(key => left[key] === right[key]);
const validSnapshot = value => /^[0-9a-f]{40}$/.test(value?.sourceSha ?? "") && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(value?.defaultBranch ?? "") && !value.defaultBranch.includes("..") && value.initialRef === "refs/heads/" + value.defaultBranch;
const sameSnapshot = (left, right) => sameIdentity(left, right) && ["sourceSha","defaultBranch","initialRef"].every(key => left[key] === right[key]);
const verifyCheckout = expected => {
  if (!validSnapshot(expected)) fail("conflict");
  assertDirectoryChain(WORKSPACE_PARENT);
  if (!isRealDirectory(ROOT)) fail("conflict");
  assertDirectoryChain(ROOT);
  if (!isRealDirectory(join(ROOT, ".git"))) fail("conflict");
  const origin = git(ROOT, expected.repositoryName, ["config", "--local", "--get", "remote.origin.url"]).trim();
  if (origin !== expected.cloneUrl) fail("conflict");
  git(ROOT, expected.repositoryName, ["cat-file", "-e", expected.sourceSha + "^{commit}"]);
  try {
    git(ROOT, expected.repositoryName, ["merge-base", "--is-ancestor", expected.sourceSha, "HEAD"], false, 120000, [0], true);
  } catch { fail("conflict"); }
};
const assertNetworkConfiguration = (cwd, repositoryName) => {
  const keys = git(cwd, repositoryName, ["config", "--local", "--name-only", "--list"]);
  if (keys.split("\n").some(key => {
    const normalized = key.toLowerCase();
    return normalized.startsWith("url.") && (normalized.endsWith(".insteadof") || normalized.endsWith(".pushinsteadof"));
  })) fail("conflict");
};
const writeLog = (name, output) => {
  assertDirectoryChain(LOG_DIR);
  const path = join(LOG_DIR, name + ".log");
  if (lstat(path) !== undefined) readRegular(path, MAX_OUTPUT);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, output);
  } catch { fail("conflict"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
};
const atomicJson = (path, state) => {
  assertDirectoryChain(dirname(path));
  if (lstat(path) !== undefined) readRegular(path);
  const temporary = path + "." + required("DX_INVOCATION_ID") + ".tmp";
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600, flag: "wx" });
    created = true;
    renameSync(temporary, path);
    created = false;
  } catch { fail("conflict"); }
  finally { if (created && lstat(temporary)?.isFile()) rmSync(temporary); }
};
const atomicState = state => atomicJson(STATE, state);
const atomicClaim = state => atomicJson(CLAIM, state);
const removeRegular = path => {
  readRegular(path);
  rmSync(path);
};
const ownedTemporary = (temporary, ownership, owner) => {
  if (!isRealDirectory(temporary) || readRegular(ownership, 128) !== owner) return false;
  assertDirectoryChain(temporary);
  return true;
};
const readyState = expected => ({
  version: expected.version,
  threadId: expected.threadId,
  provider: expected.provider,
  repositoryName: expected.repositoryName,
  bindingRevision: expected.bindingRevision,
  cloneUrl: expected.cloneUrl,
  originHash: expected.originHash,
  sourceSha: expected.sourceSha,
  defaultBranch: expected.defaultBranch,
  initialRef: expected.initialRef,
  state: "ready",
  setup: { status: "pending" }
});
const resolveExisting = sourceIdentity => {
  assertDirectoryChain(dirname(STATE));
  if (lstat(WORKSPACE_PARENT) === undefined) {
    if (lstat(STATE) !== undefined || lstat(CLAIM) !== undefined) fail("conflict");
    fail("absent");
  }
  assertDirectoryChain(WORKSPACE_PARENT);
  const rootEntry = lstat(ROOT);
  if (rootEntry === undefined) {
    if (lstat(STATE) !== undefined) fail("conflict");
    if (lstat(CLAIM) === undefined) fail("absent");
    const claim = readJson(CLAIM);
    if (!sameIdentity(claim, sourceIdentity) || !validSnapshot(claim)) fail("conflict");
    const claimInvocation = invocation(claim.invocationId);
    const temporary = join(WORKSPACE_PARENT, ".dx-repo-" + claimInvocation + ".tmp");
    const ownership = temporary + ".owner";
    if (!ownedTemporary(temporary, ownership, claimInvocation)) fail("conflict");
    renameSync(temporary, ROOT);
    verifyCheckout(claim);
    atomicState(readyState(claim));
    removeRegular(CLAIM);
    removeRegular(ownership);
  } else if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) fail("conflict");
  if (lstat(STATE) === undefined) {
    if (lstat(CLAIM) === undefined) fail("conflict");
    const claim = readJson(CLAIM);
    if (!sameIdentity(claim, sourceIdentity) || !validSnapshot(claim)) fail("conflict");
    verifyCheckout(claim);
    atomicState(readyState(claim));
    const claimInvocation = invocation(claim.invocationId);
    const ownership = join(WORKSPACE_PARENT, ".dx-repo-" + claimInvocation + ".tmp.owner");
    if (lstat(ownership) !== undefined && readRegular(ownership, 128) === claimInvocation) removeRegular(ownership);
    removeRegular(CLAIM);
  }
  const current = readJson(STATE);
  if (!sameIdentity(current, sourceIdentity) || !validSnapshot(current)) fail("conflict");
  verifyCheckout(current);
  return current;
};
const verify = expected => {
  const current = resolveExisting(expected);
  if (!sameSnapshot(current, expected)) fail("conflict");
  return current;
};
const isShallow = (expected, verified = verify(expected)) => {
  const value = git(ROOT, expected.repositoryName, ["rev-parse", "--is-shallow-repository"]).trim();
  if (value !== "true" && value !== "false") fail("conflict");
  return value === "true";
};
const hookRequiresFullHistory = (expected, name) => {
  const path = ".agents/" + name;
  const tree = git(ROOT, expected.repositoryName, ["ls-tree", expected.sourceSha, "--", path]).trim();
  if (!tree.startsWith("100755 blob ")) return false;
  const source = git(ROOT, expected.repositoryName, ["show", expected.sourceSha + ":" + path]);
  return source.split("\n").some(line => line.trim() === FULL_HISTORY_DIRECTIVE);
};
const historyNeeded = (expected, shallow = isShallow(expected)) => shallow && ["setup", "resume"].some(name => hookRequiresFullHistory(expected, name));
const unshallow = (expected, credential) => {
  if (!isShallow(expected)) return;
  assertNetworkConfiguration(ROOT, expected.repositoryName);
  try {
    git(ROOT, expected.repositoryName, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--unshallow", FIXTURE_REMOTE ?? "origin", expected.sourceSha], credential, 300000, [0], true);
  } catch { fail("history", "unavailable"); }
  if (isShallow(expected)) fail("history", "unavailable");
  verify(expected);
};
const initialize = (expected, credential) => {
  const rootEntry = lstat(ROOT);
  if (rootEntry !== undefined) return verify(expected);
  if (lstat(STATE) !== undefined) fail("conflict");
  ensureDirectoryChain(WORKSPACE_PARENT);
  ensureDirectoryChain(TEMPLATE);
  ensureDirectoryChain(GIT_HOME);
  const temporary = join(WORKSPACE_PARENT, ".dx-repo-" + required("DX_INVOCATION_ID") + ".tmp");
  const ownership = temporary + ".owner";
  if (lstat(temporary) !== undefined || lstat(ownership) !== undefined) fail("conflict");
  mkdirSync(temporary, { mode: 0o700 });
  writeFileSync(ownership, required("DX_INVOCATION_ID"), { mode: 0o600, flag: "wx" });
  let claimedFinal = false;
  try {
    git(temporary, expected.repositoryName, ["init", "--template=" + TEMPLATE], false, 120000, [0], true);
    git(temporary, expected.repositoryName, ["remote", "add", "origin", expected.cloneUrl], false, 120000, [0], true);
    assertNetworkConfiguration(temporary, expected.repositoryName);
    git(temporary, expected.repositoryName, ["fetch", ...(SHALLOW_CLONE ? ["--depth=1"] : []), "--no-tags", "--no-recurse-submodules", FIXTURE_REMOTE ?? "origin", expected.sourceSha], credential, 120000, [0], true);
    git(temporary, expected.repositoryName, ["cat-file", "-e", expected.sourceSha + "^{commit}"], false, 120000, [0], true);
    git(temporary, expected.repositoryName, ["checkout", "--no-recurse-submodules", "-b", expected.defaultBranch, expected.sourceSha], false, 120000, [0], true);
    git(temporary, expected.repositoryName, ["update-ref", "refs/remotes/origin/" + expected.defaultBranch, expected.sourceSha], false, 120000, [0], true);
    git(temporary, expected.repositoryName, ["config", "branch." + expected.defaultBranch + ".remote", "origin"], false, 120000, [0], true);
    git(temporary, expected.repositoryName, ["config", "branch." + expected.defaultBranch + ".merge", "refs/heads/" + expected.defaultBranch], false, 120000, [0], true);
    atomicClaim({ ...expected, invocationId: required("DX_INVOCATION_ID") });
    if (lstat(ROOT) !== undefined) fail("conflict");
    renameSync(temporary, ROOT);
    claimedFinal = true;
    atomicState(readyState(expected));
    removeRegular(CLAIM);
    removeRegular(ownership);
    return verify(expected);
  } catch (cause) {
    if (!claimedFinal && ownedTemporary(temporary, ownership, required("DX_INVOCATION_ID"))) rmSync(temporary, { recursive: true });
    if (lstat(ownership) !== undefined && readRegular(ownership, 128) === required("DX_INVOCATION_ID")) removeRegular(ownership);
    if (!claimedFinal && lstat(CLAIM) !== undefined && readJson(CLAIM).invocationId === required("DX_INVOCATION_ID")) removeRegular(CLAIM);
    if (cause instanceof SourceWorkspaceFailure && cause.kind === "conflict") throw cause;
    fail("initialization");
  }
};
const initializeAnonymous = sourceIdentity => {
  if (lstat(ROOT) !== undefined) return resolveExisting(sourceIdentity);
  if (lstat(STATE) !== undefined) fail("conflict");
  ensureDirectoryChain(WORKSPACE_PARENT);
  ensureDirectoryChain(TEMPLATE);
  ensureDirectoryChain(GIT_HOME);
  const invocationId = required("DX_INVOCATION_ID");
  const temporary = join(WORKSPACE_PARENT, ".dx-repo-" + invocationId + ".tmp");
  const ownership = temporary + ".owner";
  if (lstat(temporary) !== undefined || lstat(ownership) !== undefined) fail("conflict");
  mkdirSync(temporary, { mode: 0o700 });
  writeFileSync(ownership, invocationId, { mode: 0o600, flag: "wx" });
  let claimedFinal = false;
  try {
    git(temporary, sourceIdentity.repositoryName, ["clone", ...(SHALLOW_CLONE ? ["--depth=1"] : []), "--no-tags", "--no-recurse-submodules", FIXTURE_REMOTE ?? sourceIdentity.cloneUrl, "."], false, 120000, [0], true);
    git(temporary, sourceIdentity.repositoryName, ["remote", "set-url", "origin", sourceIdentity.cloneUrl], false, 120000, [0], true);
    assertNetworkConfiguration(temporary, sourceIdentity.repositoryName);
    const sourceSha = git(temporary, sourceIdentity.repositoryName, ["rev-parse", "HEAD"], false, 120000, [0], true).trim();
    const defaultBranch = git(temporary, sourceIdentity.repositoryName, ["symbolic-ref", "--short", "HEAD"], false, 120000, [0], true).trim();
    const discovered = { ...sourceIdentity, sourceSha, defaultBranch, initialRef: "refs/heads/" + defaultBranch };
    if (!validSnapshot(discovered)) throw new Error("invalid-discovery");
    atomicClaim({ ...discovered, invocationId });
    if (lstat(ROOT) !== undefined) fail("conflict");
    renameSync(temporary, ROOT);
    claimedFinal = true;
    verifyCheckout(discovered);
    atomicState(readyState(discovered));
    removeRegular(CLAIM);
    removeRegular(ownership);
    return discovered;
  } catch (cause) {
    if (!claimedFinal && ownedTemporary(temporary, ownership, invocationId)) rmSync(temporary, { recursive: true });
    if (lstat(ownership) !== undefined && readRegular(ownership, 128) === invocationId) removeRegular(ownership);
    if (!claimedFinal && lstat(CLAIM) !== undefined && readJson(CLAIM).invocationId === invocationId) removeRegular(CLAIM);
    if (cause instanceof SourceWorkspaceFailure && cause.kind === "conflict") throw cause;
    fail("initialization");
  }
};
const canonicalRepository = (url, provider) => {
  if (provider === "git") {
    let parsed;
    try { parsed = new URL(url); } catch { return undefined; }
    const path = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path) ? path : undefined;
  }
  const host = provider === "github" ? "github\\.com" : "bitbucket\\.org";
  const match = url.match(new RegExp("^https://" + host + "/([^/]+)/([^/]+?)\\.git$", "i"));
  return match ? (match[1] + "/" + match[2]).toLowerCase() : undefined;
};
const modules = (expected, verified = verify(expected)) => {
  const file = join(ROOT, ".gitmodules");
  if (lstat(file) === undefined) return [];
  const fileStat = lstat(file);
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > 65536) fail("conflict");
  const output = git(ROOT, required("DX_REPOSITORY_NAME"), ["config", "--null", "--file", ".gitmodules", "--get-regexp", "^submodule\..*\.(path|url)$"]);
  const records = new Map();
  for (const entry of output.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n") >= 0 ? entry.indexOf("\n") : entry.indexOf(" ");
    if (separator <= 0) fail("conflict");
    const key = entry.slice(0, separator), value = entry.slice(separator + 1);
    const match = key.match(/^submodule\.(.+)\.(path|url)$/);
    if (!match) fail("conflict");
    const record = records.get(match[1]) ?? {};
    record[match[2]] = value; records.set(match[1], record);
  }
  if (records.size > 16) fail("conflict");
  const parsed = [...records.entries()].map(([key, record]) => {
    const path = record.path, repositoryName = canonicalRepository(record.url ?? "", expected.provider);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key) || !path || !repositoryName || path.includes("\\") || posix.isAbsolute(path) || posix.normalize(path) !== path || path === "." || path.startsWith("../") || path.includes("/../") || path.split("/").some(part => part === "" || part === "." || part === ".git") || path.split("/").length > 8) fail("conflict");
    let parent = ROOT;
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      if (lstat(parent) !== undefined && !isRealDirectory(parent)) fail("conflict");
    }
    const target = join(ROOT, path);
    if (lstat(target)?.isSymbolicLink()) fail("conflict");
    return { key, path, repositoryName };
  });
  const paths = parsed.map(module => module.path).sort();
  if (new Set(paths).size !== paths.length || paths.some((path, index) => paths[index + 1]?.startsWith(path + "/"))) fail("conflict");
  return parsed;
};
const runSubmodule = expected => {
  verify(expected);
  if (expected.provider !== "github") fail("initialization");
  const path = required("DX_SUBMODULE_PATH"), repositoryName = required("DX_SUBMODULE_NAME").toLowerCase();
  const selected = modules(expected).find(module => module.path === path && module.repositoryName === repositoryName);
  if (!selected) fail("conflict");
  git(ROOT, repositoryName, ["submodule", "sync", "--", path]);
  git(ROOT, repositoryName, ["config", "submodule." + required("DX_SUBMODULE_KEY") + ".url", "https://github.com/" + repositoryName + ".git"]);
  assertNetworkConfiguration(ROOT, repositoryName);
  git(ROOT, repositoryName, ["-c", "submodule.recurse=false", "submodule", "update", "--init", "--", path], true);
};
const lfsNeeded = (expected, verified = verify(expected)) => {
  const attributes = join(ROOT, ".gitattributes");
  if (lstat(attributes) === undefined) return false;
  return readRegular(attributes, MAX_MARKER).split("\n").some(line => !line.trimStart().startsWith("#") && /filter=lfs/.test(line));
};
const runLfs = expected => {
  verify(expected);
  git(ROOT, required("DX_REPOSITORY_NAME"), ["lfs", "install", "--local", "--skip-smudge"]);
  assertNetworkConfiguration(ROOT, required("DX_REPOSITORY_NAME"));
  git(ROOT, required("DX_REPOSITORY_NAME"), ["lfs", "fetch", "origin", expected.sourceSha], true);
  git(ROOT, required("DX_REPOSITORY_NAME"), ["lfs", "checkout"]);
};
const hook = (expected, name, current) => {
  const agents = join(ROOT, ".agents");
  const path = join(agents, name);
  if (lstat(agents) !== undefined && !isRealDirectory(agents)) fail("conflict");
  if (lstat(path)?.isSymbolicLink()) fail("conflict");
  let digest;
  if (name === "setup") {
    const tree = git(ROOT, required("DX_REPOSITORY_NAME"), ["ls-tree", expected.sourceSha, "--", ".agents/setup"]).trim();
    if (tree === "" || !tree.startsWith("100755 blob ")) return current;
    const immutableSetup = git(ROOT, required("DX_REPOSITORY_NAME"), ["show", expected.sourceSha + ":.agents/setup"]);
    digest = sha(expected.sourceSha + "\0" + required("DX_SOURCE_CONFIG_DIGEST") + "\0" + immutableSetup);
    if (current.setup?.status === "success" && current.setup?.digest === digest) return current;
    if (lstat(path) === undefined || readRegular(path, MAX_MARKER) !== immutableSetup) fail("hook", name);
  }
  if (lstat(path) === undefined) name === "setup" ? fail("hook", name) : undefined;
  if (lstat(path) === undefined) return current;
  const hookStat = lstat(path);
  if (!hookStat.isFile() || hookStat.isSymbolicLink() || (hookStat.mode & 0o111) === 0) {
    if (name === "setup") fail("hook", name);
    return current;
  }
  ensureDirectoryChain(LOG_DIR);
  const environment = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME, USER: "user", LOGNAME: "user", SHELL: "/bin/bash", GIT_TERMINAL_PROMPT: "0" };
  const result = spawnSync(path, [], { cwd: ROOT, env: environment, encoding: "utf8", timeout: 300000, maxBuffer: MAX_OUTPUT });
  const output = ((result.stdout ?? "") + (result.stderr ?? "")).slice(0, MAX_OUTPUT).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?");
  writeLog(name, output);
  const afterHook = verify(expected);
  if (result.status !== 0) {
    if (name === "setup") atomicState({ ...afterHook, setup: { status: "failed", digest } });
    fail("hook", name);
  }
  if (name === "setup") atomicState({ ...afterHook, setup: { status: "success", digest } });
  return afterHook;
};

const action = process.argv[2];
const inspectCheckout = expected => {
  const verified = verify(expected);
  const shallow = isShallow(expected, verified);
  return {
    verified,
    payload: { status: "ready", modules: modules(expected, verified), lfsNeeded: lfsNeeded(expected, verified), shallow, fullHistoryNeeded: historyNeeded(expected, shallow) }
  };
};
const checkoutPayload = expected => inspectCheckout(expected).payload;
const checkoutFailure = kind => ({
  status: kind === "absent" ? "absent" : kind === "conflict" ? "conflict" : "failed",
  modules: [],
  lfsNeeded: false,
  shallow: false,
  fullHistoryNeeded: false
});
const hookFailure = failure => ({
  status: failure.kind === "conflict" ? "conflict" : failure.kind === "hook" ? "hook-failed" : "failed",
  hook: failure.kind === "hook" && (failure.detail === "setup" || failure.detail === "resume") ? failure.detail : undefined
});
const exitCode = failure => failure.kind === "absent" ? 10 : failure.kind === "conflict" ? 20 : failure.kind === "hook" ? (failure.detail === "resume" ? 31 : 30) : failure.kind === "history" ? 50 : 40;
try {
  const sourceIdentity = identity();
  ensureDirectoryChain(dirname(STATE));
  acquireLock();
  if (action === "initialize-anonymous") {
    const discovered = initializeAnonymous(sourceIdentity);
    process.stdout.write(JSON.stringify({ sourceRevision: discovered.sourceSha, defaultBranch: discovered.defaultBranch, initialRef: discovered.initialRef }));
  } else {
    const expected = snapshot(sourceIdentity);
    if (action === "snapshot") process.stdout.write(JSON.stringify(checkoutPayload(expected)));
    else if (action === "activate") {
      const inspected = inspectCheckout(expected);
      if (process.env.DX_ALLOW_COMBINED_HOOKS !== "true" || inspected.payload.modules.length > 0 || inspected.payload.lfsNeeded || inspected.payload.fullHistoryNeeded)
        process.stdout.write(JSON.stringify({ checkout: inspected.payload }));
      else {
        try {
          const afterSetup = hook(expected, "setup", inspected.verified);
          if (process.env.DX_RUN_RESUME !== "false") hook(expected, "resume", afterSetup);
          process.stdout.write(JSON.stringify({ checkout: inspected.payload, hooks: { status: "ready" } }));
        } catch (cause) {
          const failure = cause instanceof SourceWorkspaceFailure ? cause : new SourceWorkspaceFailure("initialization");
          process.stderr.write(failure.kind + (failure.detail ? ":" + failure.detail.slice(0, 160) : ""));
          process.stdout.write(JSON.stringify({ checkout: inspected.payload, hooks: hookFailure(failure) }));
        }
      }
    }
    else if (action === "initialize") {
      initialize(expected, true);
      process.stdout.write(JSON.stringify(checkoutPayload(expected)));
    }
    else if (action === "initialize-exact-anonymous") {
      initialize(expected, false);
      process.stdout.write(JSON.stringify(checkoutPayload(expected)));
    }
    else if (action === "submodule") runSubmodule(expected);
    else if (action === "lfs") runLfs(expected);
    else if (action === "unshallow") {
      unshallow(expected, true);
      process.stdout.write(JSON.stringify(checkoutPayload(expected)));
    }
    else if (action === "unshallow-anonymous") {
      unshallow(expected, false);
      process.stdout.write(JSON.stringify(checkoutPayload(expected)));
    }
    else if (action === "hooks") {
      const current = verify(expected);
      const afterSetup = hook(expected, "setup", current);
      if (process.env.DX_RUN_RESUME !== "false") hook(expected, "resume", afterSetup);
      process.stdout.write(JSON.stringify({ status: "ready" }));
    }
    else fail("invalid-input", "action");
  }
} catch (cause) {
  const failure = cause instanceof SourceWorkspaceFailure ? cause : new SourceWorkspaceFailure("initialization");
  process.stderr.write(failure.kind + (failure.detail ? ":" + failure.detail.slice(0, 160) : ""));
  if (action === "snapshot") process.stdout.write(JSON.stringify(checkoutFailure(failure.kind)));
  else if (action === "activate") process.stdout.write(JSON.stringify({ checkout: checkoutFailure(failure.kind) }));
  else if (action === "hooks") process.stdout.write(JSON.stringify(hookFailure(failure)));
  process.exit(action === "snapshot" || action === "activate" || action === "hooks" ? 0 : exitCode(failure));
}
`;

export const createSourceWorkspaceProgram = (
  configuration: SourceWorkspaceProgramConfiguration,
) =>
  sourceWorkspaceTemplate
    .replaceAll("__ROOT__", JSON.stringify(configuration.root))
    .replaceAll("__STATE__", JSON.stringify(configuration.state))
    .replaceAll("__CLAIM__", JSON.stringify(configuration.claim))
    .replaceAll("__LOG_DIRECTORY__", JSON.stringify(configuration.logDirectory))
    .replaceAll("__HELPER__", JSON.stringify(configuration.helper))
    .replaceAll(
      "__TEMPLATE_DIRECTORY__",
      JSON.stringify(configuration.templateDirectory),
    )
    .replaceAll("__HOME__", JSON.stringify(configuration.home))
    .replaceAll(
      "__WORKSPACE_PARENT__",
      JSON.stringify(configuration.workspaceParent),
    )
    .replaceAll("__GIT_HOME__", JSON.stringify(configuration.gitHome))
    .replaceAll(
      "__FIXTURE_REMOTE__",
      JSON.stringify(configuration.fixtureRemote ?? null),
    )
    .replaceAll(
      "__SHALLOW_CLONE__",
      JSON.stringify(configuration.shallowClone === true),
    );

export const createProductionSourceWorkspaceProgram = () =>
  createSourceWorkspaceProgram({
    root: "/home/user/workspace/repo",
    state: "/home/user/.local/state/dx/source-control-v1.json",
    claim: "/home/user/.local/state/dx/source-control-claim-v1.json",
    logDirectory: "/home/user/.cache/dx/logs",
    helper: GIT_CREDENTIAL_HELPER_PATH,
    templateDirectory: "/home/user/.local/state/dx/empty-git-template",
    home: "/home/user",
    workspaceParent: "/home/user/workspace",
    gitHome: "/home/user/.local/state/dx/git-home",
  });

export const sourceWorkspaceProgram = createProductionSourceWorkspaceProgram();
