/** A turn's length in words: "12 seconds", "3 minutes". */
export const formatDuration = (durationMs: number | undefined) => {
  if (durationMs === undefined) return undefined;
  if (durationMs < 30_000) {
    const seconds = Math.max(1, Math.round(durationMs / 1_000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};
