import viewIcons from "@dx/api/views/kit/icons.svg?raw";
import viewKitCss from "@dx/api/views/kit/kit.css?raw";
import viewKitJs from "@dx/api/views/kit/kit.js?raw";
import viewFrame from "@dx/api/views/view-frame.mjs?raw";
import pluginUi from "@dxcode/plugin-ui/plugin-ui.js?raw";
import { defineSkill, type Sandbox, type SkillDefinition } from "@flue/runtime";
import { parse } from "yaml";
import { encodeBase64 } from "../encoding/base64.js";
import { AGENT_SKILLS_DIRECTORY } from "../execution/workspace-context.js";
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
 * into the Worker. In a Thread with an Orb they are written, with the
 * Thread's settings skills, to `~/.agents/skills`, where Flue discovers them
 * like the repository's `.agents/skills` (a sandbox skill directory) and
 * Claude Code mode links them into `~/.claude/skills`. A Space has no Orb, so
 * its dx agent mounts them with Flue's `useSkill`. See
 * wiki/runtime-architecture.md#built-in-skills.
 *
 * Each skill's `SKILL.md` is stored as `skill.md` here: Flue's Vite plugin
 * packages every import of a file named `SKILL.md` and rejects one with
 * `?raw`. The workspace copy is named `SKILL.md`.
 */

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
 * Flue definitions for a Space's dx agent, which has no Orb to discover
 * skills in.
 */
export const builtInSkillDefinitions: ReadonlyArray<SkillDefinition> =
  sources.map(({ name, files }) => {
    const skill = parseSkill(name, files["SKILL.md"] ?? "");
    return defineSkill({
      name: skill.name,
      description: skill.description,
      instructions: skill.body,
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
 * Which installer wrote a skill: dx's built-in skills or the Thread's
 * settings skills. Each keeps a manifest in `~/.agents/skills`, so it removes
 * only skills it wrote itself; a skill the person put there stays.
 */
export type SkillGroup = "built-in" | "settings";

const manifestOf = (group: SkillGroup) => `.dx-${group}`;

/** Skill names are kebab-case, so the install script can use them bare. */
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Shell that writes each skill into a staging directory and swaps it in on
 * its own, so a reader never sees half a skill, then removes the skills this
 * group wrote before and no longer has (never one in `keep`), and records
 * the group's manifest: its version, then its skill names. Base64, so no
 * content is read as shell or rewritten by the local runtime's command-text
 * path mapping.
 */
const installScript = (
  group: SkillGroup,
  files: ReadonlyArray<SkillFile>,
  version: string,
  keep: ReadonlyArray<string>,
  uncoordinated: boolean,
) => {
  const names = [
    ...new Set(files.map(({ path }) => path.slice(0, path.indexOf("/")))),
  ];
  if (!names.every((name) => skillName.test(name)))
    throw new Error("A skill name is not kebab-case.");
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
  // refuses when ~/.agents/skills resolves anywhere else, such as through a
  // symbolic link into the repository, before writing anything.
  const guard = uncoordinated
    ? `if [ "$(canon "$root")" != "$root" ]; then
  echo "~/.agents/skills resolves elsewhere." >&2
  exit ${SKILLS_REDIRECTED_EXIT}
fi
`
    : "";
  const manifest = manifestOf(group);
  return `set -eu
${PORTABLE_HELPERS}
root="$HOME/.agents/skills"
${guard}stage="$root/.dx-stage.${group}.$$"
rm -rf "$stage"
mkdir -p "$stage"
${writes}
for name in ${names.join(" ")}; do
  old="$root/.dx-old.$name.$$"
  if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then mvt "$root/$name" "$old"; fi
  mvt "$stage/$name" "$root/$name"
  rm -rf "$old"
done
rmdir "$stage"
if [ -f "$root/${manifest}" ]; then
  tail -n +2 "$root/${manifest}" | while IFS= read -r name; do
    case "$name" in ""|.*|*/*) continue ;; esac
    case " ${[...names, ...keep].join(" ")} " in *" $name "*) continue ;; esac
    rm -rf "$root/$name"
  done
fi
printf '%s\\n' '${version}' ${names.join(" ")} > "$root/${manifest}.$$"
mvt "$root/${manifest}.$$" "$root/${manifest}"
# Skills lived under ~/.local/share/dx before ~/.agents/skills.
share="$HOME/.local/share/dx"
if [ "$(canon "$share")" = "$share" ]; then rm -rf "$share/skills" "$share/settings-skills"; fi
`;
};

/**
 * GNU's \`realpath -m\` and \`mv -T\`, with a fallback where they are missing
 * (a runner on macOS): \`canon\` resolves the deepest existing folder and
 * keeps the rest; \`mvt\` renames, refusing to move into a real directory.
 */
const PORTABLE_HELPERS = `canon() { realpath -m -- "$1" 2>/dev/null && return 0; d=$1; t=; while [ -n "$d" ] && [ ! -d "$d" ]; do t="/\${d##*/}$t"; d=\${d%/*}; done; printf '%s%s\\n' "$(cd "\${d:-/}" && pwd -P)" "$t"; }
mvt() { if mv -T -- "$1" "$2" 2>/dev/null; then return 0; fi; if [ -d "$2" ] && [ ! -L "$2" ]; then return 1; fi; mv -f -- "$1" "$2"; }`;

/** The install script's exit when ~/.agents/skills resolves elsewhere. */
const SKILLS_REDIRECTED_EXIT = 3;

/**
 * Where skills install. `outside` skips Changes coordination, so it is used
 * only while ~/.agents/skills resolves to itself; otherwise the install runs
 * through `coordinated`, the agent's own sandbox.
 */
export interface SkillInstallTarget {
  readonly coordinated: Sandbox;
  readonly outside?: Sandbox;
}

/**
 * Writes the group's skills into `~/.agents/skills`, one directory each,
 * unless that group's copy there is already `version`; `load` runs only when
 * it is not. An incomplete load is installed under another version, so the
 * next turn tries again. Skills the group wrote before and no longer has are
 * removed, except those named in `keep`.
 */
export const installSkillFiles = async (
  target: SkillInstallTarget,
  group: SkillGroup,
  version: string,
  load: () => Promise<{
    readonly files: ReadonlyArray<SkillFile>;
    readonly complete: boolean;
  }>,
  keep: ReadonlyArray<string> = [],
) => {
  const manifest = `${AGENT_SKILLS_DIRECTORY}/${manifestOf(group)}`;
  const installed = await (target.outside ?? target.coordinated)
    .readFile(manifest)
    .then((content) => content.slice(0, content.indexOf("\n")))
    .catch(() => undefined);
  if (installed === version) return;
  const script = `${AGENT_SKILLS_DIRECTORY}/.dx-install.${group}.sh`;
  const { files, complete } = await load();
  const installedVersion = complete ? version : `${version}.partial`;
  const run = async (sandbox: Sandbox, uncoordinated: boolean) => {
    await sandbox.writeFile(
      script,
      installScript(group, files, installedVersion, keep, uncoordinated),
    );
    return sandbox.exec(
      `bash ${script}; status=$?; rm -f ${script}; exit $status`,
      { timeoutMs: 60_000 },
    );
  };
  let result =
    target.outside === undefined ? undefined : await run(target.outside, true);
  if (result === undefined || result.exitCode === SKILLS_REDIRECTED_EXIT)
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
      "built-in",
      await contentDigest(),
      async () => ({ files, complete: true }),
    );
  } catch (error) {
    builtInSkillsLogger.error("Built-in skills could not be installed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
