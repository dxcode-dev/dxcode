import {
  EXECUTION_ENVIRONMENT_DISPLAY_NAME as ORB,
  slowWakingExecutionEnvironmentMessage,
  wakingExecutionEnvironmentMessage,
} from "../../../shared/execution-environment-copy.js";

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
