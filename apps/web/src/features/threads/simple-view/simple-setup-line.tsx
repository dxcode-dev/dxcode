import { useTheme } from "../../../shared/theme/theme-provider.js";
import { ProcessingIndicator } from "../processing-indicator.js";
import { SIMPLE_SETUP_TEXT } from "./simple-setup-text.js";
import "./simple-view.css";

/** One status line before the agent starts: the Orb starting or waking. */
export function SimpleSetupLine({ status }: { readonly status: string }) {
  const text = SIMPLE_SETUP_TEXT[status] ?? status;
  return (
    <div className="simple-turn-status" data-state="working">
      <ProcessingIndicator
        accessibleLabel={text}
        label={
          <span className="simple-turn-status-text">
            <span key={text} className="simple-turn-activity">
              {text}
            </span>
          </span>
        }
      />
    </div>
  );
}

/**
 * The footer's preparation status: plain words in Simple threads, Core's
 * own words in Detailed ones.
 */
export function ThreadSetupStatus({
  status,
  className,
}: {
  readonly status: string;
  /** The Detailed line's class. */
  readonly className: string;
}) {
  const { threadView } = useTheme();
  return threadView === "simple" ? (
    <SimpleSetupLine status={status} />
  ) : (
    <ProcessingIndicator
      accessibleLabel={status}
      className={className}
      label={status}
    />
  );
}
