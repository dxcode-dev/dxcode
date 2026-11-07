// What the agent is told when a Project's additional repository could not be
// cloned before its turn (#1689). Without it the agent finds
// ~/workspace/repos empty and guesses, and it once blamed GitHub for a
// Bitbucket clone that had stalled.

import type { ThreadId } from "@dx/domain";

export const ADDITIONAL_REPOSITORIES_SIGNAL = "additional_repositories";

export type AdditionalRepositoryFailureReason =
  | "stalled"
  | "timed-out"
  | "authorization"
  | "credentials-unavailable"
  | "not-found"
  | "failed";

export interface AdditionalRepositoryFailure {
  readonly provider: string;
  readonly fullName: string;
  readonly cloneUrl: string;
  readonly directory: string;
  readonly reason: AdditionalRepositoryFailureReason;
  /** Whether the clone sent the Thread owner's credential for its provider. */
  readonly authenticated: boolean;
  /** The last lines Git printed, with any URL credentials removed. */
  readonly detail?: string;
}

const providerName = (provider: string) =>
  provider === "github"
    ? "GitHub"
    : provider === "bitbucket"
      ? "Bitbucket"
      : "its Git host";

const reasonText = (failure: AdditionalRepositoryFailure) => {
  const name = providerName(failure.provider);
  switch (failure.reason) {
    case "stalled":
      return `${name} stopped sending data partway through, so dx stopped the clone`;
    case "timed-out":
      return "the clone did not finish within 5 minutes, so dx stopped it";
    case "authorization":
      // Bitbucket and GitHub answer a missing repository the same way.
      if (failure.provider !== "github" && failure.provider !== "bitbucket")
        return `${name} asked for credentials dx does not have`;
      return failure.authenticated
        ? `${name} refused the Thread owner's authorization for it: the repository does not exist, is not shared with them, or their ${name} connection lapsed. If other ${name} repositories fail too, the person needs to reconnect ${name} in Settings → Integrations`
        : `${name} asked for credentials, and the Thread owner's ${name} connection is missing or needs reconnecting: the person needs to connect or reconnect ${name} in Settings → Integrations (or the repository does not exist)`;
    case "credentials-unavailable":
      // The connection stands; only this attempt to renew its token failed.
      return `dx could not get a working ${name} token for the Thread owner just now (${name} did not answer), so dx did not clone it; their ${name} connection does not need reconnecting, and dx retries on the Orb's next start`;
    case "not-found":
      return `${name} says the repository does not exist or the Thread owner's account cannot read it`;
    case "failed":
      return `git clone failed${failure.detail === undefined ? "" : `: ${failure.detail}`}`;
  }
};

/** The note for these failures, for the turn the activation starts. */
export const additionalRepositoryNote = (
  failures: ReadonlyArray<AdditionalRepositoryFailure>,
  present: ReadonlyArray<string> = [],
) => {
  const lines = failures.map(
    (failure) =>
      `- ${failure.fullName} (${providerName(failure.provider)}), for ~/workspace/repos/${failure.directory}: ${reasonText(failure)}.`,
  );
  const retry = failures
    .filter(
      ({ reason }) =>
        reason !== "authorization" && reason !== "credentials-unavailable",
    )
    .map(
      ({ cloneUrl, directory }) =>
        `\`git clone ${cloneUrl} ~/workspace/repos/${directory}\``,
    );
  return `dx could not clone ${failures.length === 1 ? "this Project's additional repository" : "these additional repositories of this Project"} before this turn:
${lines.join("\n")}
${
  present.length === 0
    ? "No other additional repository is in ~/workspace/repos."
    : `~/workspace/repos holds the others: ${present.join(", ")}.`
} The Thread's main repository and every other provider are unaffected: do not attribute this to another provider, and check ~/workspace/repos before saying any other repository is missing. Begin your final reply, the text after any tool calls, by telling the person in one sentence which repository could not be cloned, its provider, and why.${
    retry.length === 0
      ? ""
      : ` Offer to retry; to retry, run ${retry.join(" and ")}. dx also retries on the Orb's next start.`
  } Then continue with the request below.`;
};

/**
 * The failures of each Thread's latest clone run in this isolate. Taken once,
 * as the disk reading is; a run with no failures clears an older entry.
 */
const failuresByThread = new Map<
  string,
  {
    readonly failures: ReadonlyArray<AdditionalRepositoryFailure>;
    readonly present: ReadonlyArray<string>;
  }
>();

/** `present` names the directories that exist after the run. */
export const rememberAdditionalRepositoryFailures = (
  threadId: ThreadId | string,
  failures: ReadonlyArray<AdditionalRepositoryFailure>,
  present: ReadonlyArray<string> = [],
) => {
  if (failures.length === 0) failuresByThread.delete(threadId);
  else failuresByThread.set(threadId, { failures, present });
};

export const takeAdditionalRepositoryNote = (threadId: ThreadId | string) => {
  const run = failuresByThread.get(threadId);
  failuresByThread.delete(threadId);
  return run === undefined
    ? undefined
    : additionalRepositoryNote(run.failures, run.present);
};
