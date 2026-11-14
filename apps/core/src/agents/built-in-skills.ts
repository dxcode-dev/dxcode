import viewIcons from "@dx/api/views/kit/icons.svg?raw";
import viewKitCss from "@dx/api/views/kit/kit.css?raw";
import viewKitJs from "@dx/api/views/kit/kit.js?raw";
import viewFrame from "@dx/api/views/view-frame.mjs?raw";
import pluginUi from "@dxcode/plugin-ui/plugin-ui.js?raw";
import { defineSkill, type Sandbox, type SkillDefinition } from "@flue/runtime";
import { parse } from "yaml";
import { encodeBase64 } from "../encoding/base64.js";
import { builtInSkillsLogger } from "../logging.js";
import {
  BUILT_IN_SKILL_NAMES,
  type BuiltInSkillName,
} from "./built-in-skill-names.js";
import browserUse from "./built-in-skills/browser-use/skill.md?raw";
import buildingPluginsApi from "./built-in-skills/building-plugins/reference/plugin-api.ts.txt?raw";
import buildingPluginsUi from "./built-in-skills/building-plugins/reference/plugin-ui.md?raw";
import buildingPluginsReadme from "./built-in-skills/building-plugins/reference/README.md?raw";
import buildingPlugins from "./built-in-skills/building-plugins/skill.md?raw";
import buildingSchedules from "./built-in-skills/building-schedules/skill.md?raw";
import buildingSkills from "./built-in-skills/building-skills/skill.md?raw";
import creatingViewsPreview from "./built-in-skills/creating-views/scripts/preview.mjs?raw";
import creatingViews from "./built-in-skills/creating-views/skill.md?raw";
import drawingBoards from "./built-in-skills/drawing-boards/skill.md?raw";
import explainingCode from "./built-in-skills/explaining-code/skill.md?raw";
import orbSetup from "./built-in-skills/orb-setup/skill.md?raw";
import planningWork from "./built-in-skills/planning-work/skill.md?raw";
import provingChangesAgentInstructions from "./built-in-skills/proving-changes/reference/agent-instructions.md?raw";
import provingChangesTechniques from "./built-in-skills/proving-changes/reference/techniques.md?raw";
import provingChanges from "./built-in-skills/proving-changes/skill.md?raw";
import researchingExternalRepositories from "./built-in-skills/researching-external-repositories/skill.md?raw";
import reviewingCode from "./built-in-skills/reviewing-code/skill.md?raw";
import searchingCode from "./built-in-skills/searching-code/skill.md?raw";
import actionVideo from "./built-in-skills/using-agent-browser/scripts/action-video.mjs?raw";
import usingAgentBrowser from "./built-in-skills/using-agent-browser/skill.md?raw";
import workloadIdentityAws from "./built-in-skills/using-workload-identity/reference/aws.md?raw";
import workloadIdentityAzure from "./built-in-skills/using-workload-identity/reference/azure.md?raw";
import workloadIdentityGcp from "./built-in-skills/using-workload-identity/reference/gcp.md?raw";
import workloadIdentityGeneric from "./built-in-skills/using-workload-identity/reference/generic.md?raw";
import workloadIdentityAwsCredentials from "./built-in-skills/using-workload-identity/scripts/aws-credentials.mjs?raw";
import workloadIdentityAzureAccessToken from "./built-in-skills/using-workload-identity/scripts/azure-access-token.mjs?raw";
import workloadIdentityClaims from "./built-in-skills/using-workload-identity/scripts/claims.mjs?raw";
import workloadIdentityFindConnections from "./built-in-skills/using-workload-identity/scripts/find-connections.mjs?raw";
import workloadIdentityGcpAccessToken from "./built-in-skills/using-workload-identity/scripts/gcp-access-token.mjs?raw";
import workloadIdentityToken from "./built-in-skills/using-workload-identity/scripts/workload-token.mjs?raw";
import usingWorkloadIdentity from "./built-in-skills/using-workload-identity/skill.md?raw";
import writingPrompts from "./built-in-skills/writing-prompts/skill.md?raw";

/**
 * dx's built-in skills: skill directories under `built-in-skills/`, bundled
 * into the Worker and offered in every workspace Thread. The dx agent mounts
 * each with Flue's `useSkill`; Claude Code mode links the same directories
 * into `~/.claude/skills`. Both read supporting files and run scripts from
 * the copy `installBuiltInSkills` writes into the workspace, so the two modes
 * see identical files. See wiki/runtime-architecture.md#built-in-skills.
 *
 * Each skill's `SKILL.md` is stored as `skill.md` here: Flue's Vite plugin
 * packages every import of a file named `SKILL.md` and rejects one with
 * `?raw`. The workspace copy is named `SKILL.md`.
 */
const DX_SHARE = "/home/user/.local/share/dx";
export const BUILT_IN_SKILLS_DIRECTORY = `${DX_SHARE}/skills`;
const DIGEST_FILE = ".dx-digest";

/** Every file of every built-in skill, keyed by its path in the skill. */
const sources: ReadonlyArray<{
  readonly name: BuiltInSkillName;
  readonly files: Readonly<Record<string, string>>;
}> = [
  { name: "browser-use", files: { "SKILL.md": browserUse } },
  {
    name: "building-plugins",
    // The full @dxcode/plugin reference, kept equal to packages/plugin by
    // building-plugins-reference.test.ts; manage_dx plugins docs serves it too.
    files: {
      "SKILL.md": buildingPlugins,
      "reference/README.md": buildingPluginsReadme,
      "reference/plugin-api.ts.txt": buildingPluginsApi,
      "reference/plugin-ui.md": buildingPluginsUi,
    },
  },
  { name: "building-schedules", files: { "SKILL.md": buildingSchedules } },
  { name: "building-skills", files: { "SKILL.md": buildingSkills } },
  {
    name: "creating-views",
    // The frame and kits are the web app's own (@dx/api/views and
    // @dxcode/plugin-ui), so a preview frames a view exactly as the
    // transcript does.
    files: {
      "SKILL.md": creatingViews,
      "scripts/preview.mjs": creatingViewsPreview,
      "scripts/view-frame.mjs": viewFrame,
      "scripts/kit/kit.css": viewKitCss,
      "scripts/kit/kit.js": viewKitJs,
      "scripts/kit/icons.svg": viewIcons,
      "scripts/plugin-ui.js": pluginUi,
    },
  },
  { name: "drawing-boards", files: { "SKILL.md": drawingBoards } },
  { name: "explaining-code", files: { "SKILL.md": explainingCode } },
  { name: "orb-setup", files: { "SKILL.md": orbSetup } },
  { name: "planning-work", files: { "SKILL.md": planningWork } },
  {
    name: "proving-changes",
    files: {
      "SKILL.md": provingChanges,
      "reference/agent-instructions.md": provingChangesAgentInstructions,
      "reference/techniques.md": provingChangesTechniques,
    },
  },
  {
    name: "researching-external-repositories",
    files: { "SKILL.md": researchingExternalRepositories },
  },
  { name: "reviewing-code", files: { "SKILL.md": reviewingCode } },
  { name: "searching-code", files: { "SKILL.md": searchingCode } },
  {
    name: "using-agent-browser",
    files: {
      "SKILL.md": usingAgentBrowser,
      "scripts/action-video.mjs": actionVideo,
    },
  },
  {
    name: "using-workload-identity",
    files: {
      "SKILL.md": usingWorkloadIdentity,
      "reference/aws.md": workloadIdentityAws,
      "reference/azure.md": workloadIdentityAzure,
      "reference/gcp.md": workloadIdentityGcp,
      "reference/generic.md": workloadIdentityGeneric,
      "scripts/aws-credentials.mjs": workloadIdentityAwsCredentials,
      "scripts/azure-access-token.mjs": workloadIdentityAzureAccessToken,
      "scripts/claims.mjs": workloadIdentityClaims,
      "scripts/find-connections.mjs": workloadIdentityFindConnections,
      "scripts/gcp-access-token.mjs": workloadIdentityGcpAccessToken,
      "scripts/workload-token.mjs": workloadIdentityToken,
    },
  },
  { name: "writing-prompts", files: { "SKILL.md": writingPrompts } },
];

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

const parseSkill = (directory: string, content: string) => {
  const match = frontmatter.exec(content);
  const data = match === null ? undefined : parse(match[1] ?? "");
  const name = data?.name;
  const description = data?.description;
  if (
    match === null ||
    name !== directory ||
    typeof description !== "string" ||
    description.length === 0
  )
    throw new Error(`Built-in skill ${directory} has invalid frontmatter.`);
  return { name, description, body: (match[2] ?? "").trim() };
};

if (sources.map(({ name }) => name).join() !== BUILT_IN_SKILL_NAMES.join())
  throw new Error("Built-in skill sources and names disagree.");

/**
 * Flue definitions for the dx agent. The body names the skill's directory in
 * the workspace, where its relative paths and scripts resolve.
 */
export const builtInSkillDefinitions: ReadonlyArray<SkillDefinition> =
  sources.map(({ name, files }) => {
    const skill = parseSkill(name, files["SKILL.md"] ?? "");
    return defineSkill({
      name: skill.name,
      description: skill.description,
      instructions: `This skill's directory is \`${BUILT_IN_SKILLS_DIRECTORY}/${name}/\`; resolve relative paths in these instructions from there.\n\n${skill.body}`,
    });
  });

const encoder = new TextEncoder();

export const sha256 = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** One file of an installed skill, at `<skill name>/<path in the skill>`. */
export interface SkillFile {
  readonly path: string;
  readonly content: string;
}

const files: ReadonlyArray<SkillFile> = sources.flatMap(({ name, files }) =>
  Object.entries(files).map(([path, content]) => ({
    path: `${name}/${path}`,
    content,
  })),
);

let digest: Promise<string> | undefined;
const contentDigest = () => {
  digest ??= sha256(
    JSON.stringify(files.map(({ path, content }) => [path, content])),
  );
  return digest;
};

/**
 * Shell that writes every file into a fresh directory and swaps it in, so a
 * reader never sees half an install. Base64, so no content is read as shell
 * or rewritten by the local runtime's command-text path mapping.
 */
const installScript = (
  directory: string,
  files: ReadonlyArray<SkillFile>,
  version: string,
  uncoordinated: boolean,
) => {
  const writes = files
    .map(({ path, content }) => {
      const directory = path.slice(0, path.lastIndexOf("/"));
      const encoded = (
        encodeBase64(encoder.encode(content)).match(/.{1,76}/g) ?? []
      ).join("\n");
      const mode = path.includes("/scripts/") ? "755" : "644";
      return `mkdir -p "$stage/${directory}"\nbase64 -d > "$stage/${path}" <<'DX_FILE'\n${encoded}\nDX_FILE\nchmod ${mode} "$stage/${path}"`;
    })
    .join("\n");
  // An uncoordinated install may write only where Changes never looks: it
  // refuses when ~/.local/share/dx resolves anywhere else, such as through a
  // symbolic link into the repository, before writing anything.
  const guard = uncoordinated
    ? `share="$HOME/.local/share/dx"
if [ "$(realpath -m -- "$share")" != "$share" ]; then
  echo "~/.local/share/dx resolves elsewhere." >&2
  exit ${SHARE_REDIRECTED_EXIT}
fi
`
    : "";
  return `set -eu
${guard}root="$HOME/.local/share/dx/${directory}"
stage="$root.stage.$$"
old="$root.old.$$"
rm -rf "$stage"
mkdir -p "$stage" "$(dirname "$root")"
${writes}
printf '%s' '${version}' > "$stage/${DIGEST_FILE}"
if [ -e "$root" ]; then mv -T "$root" "$old"; fi
mv -T "$stage" "$root"
rm -rf "$old"
`;
};

/** The install script's exit when ~/.local/share/dx resolves elsewhere. */
const SHARE_REDIRECTED_EXIT = 3;

/**
 * Where skills install. `outside` skips Changes coordination, so it is used
 * only while ~/.local/share/dx resolves to itself; otherwise the install runs
 * through `coordinated`, the agent's own sandbox.
 */
export interface SkillInstallTarget {
  readonly coordinated: Sandbox;
  readonly outside?: Sandbox;
}

/**
 * Replaces `~/.local/share/dx/<directory>` with the loaded files unless the
 * copy there is already `version`; `load` runs only when it is not. An
 * incomplete load is installed under another version, so the next turn
 * tries again.
 */
export const installSkillFiles = async (
  target: SkillInstallTarget,
  directory: string,
  version: string,
  load: () => Promise<{
    readonly files: ReadonlyArray<SkillFile>;
    readonly complete: boolean;
  }>,
) => {
  const root = `${DX_SHARE}/${directory}`;
  const installed = await (target.outside ?? target.coordinated)
    .readFile(`${root}/${DIGEST_FILE}`)
    .catch(() => undefined);
  if (installed === version) return;
  const script = `${root}.install.sh`;
  const { files, complete } = await load();
  const installedVersion = complete ? version : `${version}.partial`;
  const run = async (sandbox: Sandbox, uncoordinated: boolean) => {
    await sandbox.writeFile(
      script,
      installScript(directory, files, installedVersion, uncoordinated),
    );
    return sandbox.exec(
      `bash ${script}; status=$?; rm -f ${script}; exit $status`,
      { timeoutMs: 60_000 },
    );
  };
  let result =
    target.outside === undefined ? undefined : await run(target.outside, true);
  if (result === undefined || result.exitCode === SHARE_REDIRECTED_EXIT)
    result = await run(target.coordinated, false);
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || "install script failed");
};

/**
 * Writes the built-in skills into the workspace unless the copy there is
 * already this version. A failure is logged, not thrown: the instructions
 * still load, only their supporting files and scripts are missing.
 */
export const installBuiltInSkills = async (target: SkillInstallTarget) => {
  try {
    await installSkillFiles(
      target,
      "skills",
      await contentDigest(),
      async () => ({ files, complete: true }),
    );
  } catch (error) {
    builtInSkillsLogger.error("Built-in skills could not be installed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
