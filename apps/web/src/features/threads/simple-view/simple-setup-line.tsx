import {
  EXECUTION_ENVIRONMENT_DISPLAY_NAME as ORB,
  slowWakingExecutionEnvironmentMessage,
  wakingExecutionEnvironmentMessage,
} from "../../../shared/execution-environment-copy.js";
import { useTheme } from "../../../shared/theme/theme-provider.js";
import { ProcessingIndicator } from "../processing-indicator.js";
import "./simple-view.css";

/**
 * The Simple view's words for each Orb preparation status, by the text Core
 * reports (`apps/core/src/execution/activation.ts`) or the web shows while
 * an Orb wakes. Starting, copying the code, and setting up stay three
 * distinct steps; a status not listed here shows as Core wrote it.
 */
export const SIMPLE_SETUP_TEXT: Readonly<Record<string, string>> = {
  "Preparing workspace…": `Starting the ${ORB}`,
  "Starting machine…": `Starting the ${ORB}`,
  "Still starting machine…": `Starting the ${ORB}`,
  "Restarting machine…": `Starting the ${ORB}`,
  "Preparing source…": "Copying your code",
  "Cloning repository…": "Copying your code",
  "Setting up machine…": `Setting up the ${ORB}`,
  [wakingExecutionEnvironmentMessage]: `Waking up the ${ORB}`,
  [slowWakingExecutionEnvironmentMessage]: `Still waking up the ${ORB}`,
};

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
