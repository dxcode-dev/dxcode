export const EXECUTION_ENVIRONMENT_DISPLAY_NAME = "Orb";

export const wakingExecutionEnvironmentMessage = `Waking up the ${EXECUTION_ENVIRONMENT_DISPLAY_NAME}…`;

/**
 * A wake that runs past 90 s (#1956). Waking ends once the Orb's resume
 * hooks finish, and every provider says it, so it promises no limit.
 */
export const slowWakingExecutionEnvironmentMessage = `The ${EXECUTION_ENVIRONMENT_DISPLAY_NAME} is taking longer than usual to get ready. Still waiting…`;
