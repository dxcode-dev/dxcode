import {
  PROJECT_ORB_SETUP_KINDS,
  type ProjectId,
  type UserId,
} from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  SpotlightAction,
  SpotlightBand,
  SpotlightLink,
} from "../../shared/ui/spotlight.js";
import { projectOrbScriptsQueryOptions } from "../projects/project-orb-scripts-queries.js";

/**
 * Where a Project's Orb setup stands, as the composer shows it. `missing`:
 * dx has no setup or resume script and the person may add one; `read-only`:
 * none either, but only the Project's creator or a workspace admin may add
 * one.
 */
export type ProjectSetupBannerState = "missing" | "read-only";

export const PROJECT_SETUP_DOCS =
  "/docs/get-started/workspace-tools/#orb-setup";

/**
 * The prompt Set up with dx puts in the composer: one line, since the
 * orb-setup skill carries how to do it.
 */
export const PROJECT_SETUP_PROMPT = "Set up Orbs for this project.";

const COPY = {
  missing: "No setup script yet. dx can write one, so every Orb starts ready.",
  "read-only":
    "No setup script yet. The project's creator or a workspace admin can add one.",
} as const;

/** The spotlight under the composer for a Project without Orb setup. */
export function ProjectSetupBanner({
  state,
  onSetUp,
  onDismiss,
}: {
  readonly state: ProjectSetupBannerState;
  readonly onSetUp: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <SpotlightBand
      title="Set up Orbs"
      description={COPY[state]}
      actions={
        <>
          {state === "missing" ? (
            <SpotlightAction tone="primary" onClick={onSetUp}>
              Set up with dx
            </SpotlightAction>
          ) : null}
          <SpotlightLink href={PROJECT_SETUP_DOCS}>Docs</SpotlightLink>
          <SpotlightAction onClick={onDismiss}>Dismiss</SpotlightAction>
        </>
      }
    />
  );
}

/**
 * The picked Project's setup state, read from its saved scripts, so the
 * composer knows without an Orb or a clone. Undefined while it loads, when
 * no Project is picked, and when the Project is set up.
 */
export function useProjectSetupState(
  userId: UserId,
  projectId: ProjectId | "",
): ProjectSetupBannerState | undefined {
  const scripts = useQuery({
    ...projectOrbScriptsQueryOptions(userId, projectId as ProjectId),
    enabled: projectId !== "",
  });
  if (projectId === "" || scripts.data === undefined) return undefined;
  const configured = scripts.data.scripts.some((script) =>
    (PROJECT_ORB_SETUP_KINDS as ReadonlyArray<string>).includes(script.kind),
  );
  if (configured) return undefined;
  return scripts.data.canManage ? "missing" : "read-only";
}

/**
 * The composer's spotlight for the picked Project: shown each time the
 * composer opens on a Project without Orb setup, and again whenever such a
 * Project is picked; Dismiss hides it until the Project changes. Set up with
 * dx adds the setup prompt to the draft. Undefined when nothing shows.
 */
export function useSetupSpotlight(
  projectId: ProjectId | "",
  draft: {
    readonly getSnapshot: () => { readonly text: string };
    readonly setText: (text: string) => void;
  },
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
): React.ReactNode | undefined {
  const { identity } = useAuthenticatedIdentity();
  const state = useProjectSetupState(identity.id, projectId);
  const [dismissedFor, setDismissedFor] = React.useState<ProjectId | "">();
  if (state === undefined || dismissedFor === projectId) return undefined;
  return (
    <ProjectSetupBanner
      state={state}
      onSetUp={() => {
        // A draft that already asks for the setup keeps its one copy.
        const prompt = draft.getSnapshot().text;
        if (!prompt.includes(PROJECT_SETUP_PROMPT))
          draft.setText(
            prompt.trim() === ""
              ? PROJECT_SETUP_PROMPT
              : `${prompt.trimEnd()}\n\n${PROJECT_SETUP_PROMPT}`,
          );
        textareaRef.current?.focus();
      }}
      onDismiss={() => setDismissedFor(projectId)}
    />
  );
}
