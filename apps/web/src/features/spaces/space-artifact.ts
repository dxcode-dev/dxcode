import { useNavigate } from "@tanstack/react-router";
import { sheetOpened } from "../../shared/navigation/open-artifact.js";

/** The `sheet` value of a Space's own artifact, apart from a thread's. */
export const SPACE_ARTIFACT_SHEET = "space-artifact" as const;

/**
 * Opens one of a Space's own artifacts full screen over the Space's page,
 * at any width: the page has no Artifacts view to show it in. Close or Back
 * returns to the Space.
 */
export const useOpenSpaceArtifact = () => {
  const navigate = useNavigate();
  return (artifactId: string) =>
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        artifact: artifactId,
        sheet: SPACE_ARTIFACT_SHEET,
      }),
      state: sheetOpened,
    });
};
