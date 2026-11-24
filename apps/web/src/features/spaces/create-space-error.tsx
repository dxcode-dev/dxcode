import { Link } from "@tanstack/react-router";

/**
 * Why Create Space failed. The Agent row and its picker say why the model
 * is unavailable, so that one shows nothing here; a Claude Code Space with
 * no coordinator Orb links to where one is chosen.
 */
export function CreateSpaceError({ error }: { readonly error: unknown }) {
  const code = (error as { readonly code?: string } | null)?.code;
  if (error === null || error === undefined) return null;
  if (code === "SPACE_MODEL_UNAVAILABLE") return null;
  return (
    <p className="space-dialog-error" role="alert">
      {error instanceof Error
        ? error.message
        : "The Space could not be created."}
      {code === "SPACE_ORB_UNAVAILABLE" ? (
        <>
          {" "}
          <Link to="/settings/$section" params={{ section: "orb-providers" }}>
            Open Orb Providers
          </Link>
        </>
      ) : null}
    </p>
  );
}
