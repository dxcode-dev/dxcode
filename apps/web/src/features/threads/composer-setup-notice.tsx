import type { NewThreadSetupGap } from "@dx/client";
import { Link } from "@tanstack/react-router";
import "./composer-setup-notice.css";

const GAP_COPY = {
  orb: {
    text: "No Orb can start yet.",
    link: "Set up an Orb",
    section: "orb-providers",
  },
  model: {
    text: "No model serves this choice.",
    link: "Set up a model",
    section: "models",
  },
} as const;

/**
 * One short line per missing piece, linking to the setting that adds it.
 * `orbNotice` is the deployment's own sentence for a missing Orb, such as
 * a hosted offer whose Orbs aren't set up yet; the person's own provider
 * is then the second way in, not the only one.
 */
export function NewThreadSetupNotice({
  gaps,
  orbNotice,
}: {
  readonly gaps: ReadonlyArray<NewThreadSetupGap>;
  readonly orbNotice?: string | undefined;
}) {
  if (gaps.length === 0) return null;
  return (
    <div className="new-thread-setup-notice" role="status">
      {gaps.map((gap) => {
        const own = gap === "orb" && orbNotice !== undefined;
        return (
          <p key={gap}>
            {own ? orbNotice : GAP_COPY[gap].text}{" "}
            <Link
              to="/settings/$section"
              params={{ section: GAP_COPY[gap].section }}
            >
              {own ? "Use your own Orb provider" : GAP_COPY[gap].link}
            </Link>
          </p>
        );
      })}
    </div>
  );
}
