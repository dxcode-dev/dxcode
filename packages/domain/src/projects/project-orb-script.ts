import { Schema } from "effect";

/**
 * Scripts a Project saves in its Orb settings. Pre-clone runs from
 * `/home/user/workspace` before dx clones the repository; pre-setup runs
 * from the repository root before `.agents/setup`; desktop-resume runs when
 * the Desktop starts, unless the repository has `.agents/desktop/resume`.
 */
export const PROJECT_ORB_SCRIPT_KINDS = [
  "pre-clone",
  "pre-setup",
  "desktop-resume",
] as const;

export const ProjectOrbScriptKind = Schema.Literals(PROJECT_ORB_SCRIPT_KINDS);

export type ProjectOrbScriptKind = typeof ProjectOrbScriptKind.Type;

/** The guest receives each script in a command's environment. */
export const MAX_PROJECT_ORB_SCRIPT_BYTES = 32_768;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/** A saved script's text. The empty string removes the script. */
export const ProjectOrbScriptBody = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      !value.includes("\0") && utf8Bytes(value) <= MAX_PROJECT_ORB_SCRIPT_BYTES,
    {
      description: `a script of at most ${MAX_PROJECT_ORB_SCRIPT_BYTES} bytes without NUL characters`,
    },
  ),
);

/**
 * Files a repository commits to prepare its own Orbs, which Project settings
 * check on the default branch. `.agents/setup` runs once when an Orb is
 * prepared, `.agents/resume` on every activation and wake, the Desktop session
 * runs `.agents/desktop/resume` in place of the Project's desktop-resume
 * script, and `.dx/services.yaml` declares the dev servers Portals start.
 */
export const PROJECT_REPOSITORY_ORB_FILES = [
  ".agents/setup",
  ".agents/resume",
  ".agents/desktop/resume",
  ".dx/services.yaml",
] as const;

export const ProjectRepositoryOrbFile = Schema.Literals(
  PROJECT_REPOSITORY_ORB_FILES,
);

export type ProjectRepositoryOrbFile = typeof ProjectRepositoryOrbFile.Type;
