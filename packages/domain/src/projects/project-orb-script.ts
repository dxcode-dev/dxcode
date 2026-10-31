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
