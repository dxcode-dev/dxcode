import type { ChoicesData, OrbResolvedProvider } from "@dx/api";
import type { ModeId, RunnerProfile, RunnerProfileId } from "@dx/domain";

/** What a new Thread still needs before Core will start it. */
export type NewThreadSetupGap = "orb" | "model";

/**
 * The setup a new Thread is missing, read from the lists Core builds with
 * the same checks it runs at creation: the resolved Orb providers
 * (`orbProviderSet`, so 409 ORB_UNAVAILABLE) and the model choices
 * (`findServingConnection`, so 422 MODEL_NOT_SERVED). Core stays the source
 * of truth: a list that has not loaded, or failed, blocks nothing here.
 */
export const newThreadSetupGaps = (input: {
  readonly runnerOrbs: ReadonlyArray<OrbResolvedProvider> | undefined;
  /** Core never refuses a Thread for its Orb in the local runtime. */
  readonly localRuntime: boolean | undefined;
  readonly runnerProfiles: ReadonlyArray<RunnerProfile> | undefined;
  readonly runnerProfileId: RunnerProfileId | undefined;
  readonly choices: ChoicesData | undefined;
  readonly profile: ModeId;
  readonly model: string | undefined;
}): ReadonlyArray<NewThreadSetupGap> => {
  const gaps: Array<NewThreadSetupGap> = [];
  if (orbMissing(input)) gaps.push("orb");
  if (modelMissing(input)) gaps.push("model");
  return gaps;
};

const orbMissing = ({
  runnerOrbs,
  localRuntime,
  runnerProfiles,
  runnerProfileId,
}: Parameters<typeof newThreadSetupGaps>[0]) => {
  if (runnerOrbs === undefined || localRuntime === true) return false;
  const size = runnerProfiles?.find(({ id }) => id === runnerProfileId);
  // The local runtime's own size never needs a provider.
  if (size?.adapter === "local") return false;
  if (runnerOrbs.length === 0) return true;
  if (size === undefined) return false;
  const provider = runnerOrbs.find(
    ({ providerId }) => providerId === size.adapter,
  );
  return (
    provider === undefined ||
    provider.status !== "ready" ||
    provider.unavailableSizes.some(({ id }) => id === size.id)
  );
};

const modelMissing = ({
  choices,
  profile,
  model,
}: Parameters<typeof newThreadSetupGaps>[0]) => {
  if (choices === undefined) return false;
  if (model !== undefined)
    return !choices.models.some(({ canonical }) => canonical === model);
  const mode = choices.modes.find((choice) => choice.mode === profile);
  return mode !== undefined && !mode.served;
};
