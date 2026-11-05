import { Link } from "@tanstack/react-router";
import type { NewThreadSetupGap } from "./composer-readiness.js";
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
    section: "model-routing",
  },
} as const;

/** One short line per missing piece, linking to the setting that adds it. */
export function NewThreadSetupNotice({
  gaps,
}: {
  readonly gaps: ReadonlyArray<NewThreadSetupGap>;
}) {
  if (gaps.length === 0) return null;
  return (
    <div className="new-thread-setup-notice" role="status">
      {gaps.map((gap) => (
        <p key={gap}>
          {GAP_COPY[gap].text}{" "}
          <Link
            to="/settings/$section"
            params={{ section: GAP_COPY[gap].section }}
          >
            {GAP_COPY[gap].link}
          </Link>
        </p>
      ))}
    </div>
  );
}
