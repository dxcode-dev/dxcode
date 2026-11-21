import { Schema } from "effect";

/**
 * Scripts a Project saves in dx and runs in the Orb of every Thread in it;
 * the repository commits none of them. Pre-clone runs from
 * `/home/user/workspace` before dx clones the repository. Setup runs once
 * from the repository root when dx prepares a fresh Orb. Resume runs from
 * the repository root each time the Orb starts or wakes. Desktop-resume runs
 * when the Desktop starts.
 */
export const PROJECT_ORB_SCRIPT_KINDS = [
  "pre-clone",
  "setup",
  "resume",
  "desktop-resume",
] as const;

/** A Project with either script is set up for Orbs. */
export const PROJECT_ORB_SETUP_KINDS = ["setup", "resume"] as const;

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
