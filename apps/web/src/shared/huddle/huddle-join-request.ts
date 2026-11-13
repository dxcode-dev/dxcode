/**
 * A huddle link asks the thread it opens to show the huddle's Join dialog.
 * The link's route sets the request before it opens the thread; the thread's
 * or Space's Huddle control shows the dialog while the request names its
 * thread, and clears it when the dialog closes, so a reload of the thread
 * alone never asks again.
 */
let requested: string | undefined;

export const huddleJoinRequest = {
  ask: (threadId: string) => {
    requested = threadId;
  },
  isFor: (threadId: string) => requested === threadId,
  clear: () => {
    requested = undefined;
  },
};
