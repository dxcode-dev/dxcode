import type { HuddleParticipant } from "./huddle-client.js";

/** Who fills the dock or the main area: a shared screen, then the speaker. */
export const featured = (
  participants: ReadonlyArray<HuddleParticipant>,
): { participant: HuddleParticipant; screen: boolean } | undefined => {
  const sharing = participants.find(
    ({ screenSharing, screenTrack }) =>
      screenSharing && screenTrack !== undefined,
  );
  if (sharing !== undefined) return { participant: sharing, screen: true };
  const speaker =
    participants.find(({ speaking, isSelf }) => speaking && !isSelf) ??
    participants.find(({ isSelf }) => !isSelf) ??
    participants[0];
  return speaker === undefined
    ? undefined
    : { participant: speaker, screen: false };
};
