/**
 * Where a video is and how it sounds, so a second player of the same file
 * can take over from it: the full-window viewer from a message's gallery,
 * and the gallery again when the viewer closes.
 */
export interface MediaPlayback {
  readonly time: number;
  readonly playing: boolean;
  readonly muted: boolean;
  readonly volume: number;
}

export const readPlayback = (media: HTMLMediaElement): MediaPlayback => ({
  time: media.currentTime,
  playing: !media.paused && !media.ended,
  muted: media.muted,
  volume: media.volume,
});

/**
 * Moves `media` to `playback`: its sound now, its time once the file's
 * length is known, and play when the other player was playing. A browser
 * that refuses to start without a tap leaves it paused at that time.
 */
export const applyPlayback = (
  media: HTMLMediaElement,
  playback: MediaPlayback,
) => {
  media.muted = playback.muted;
  media.volume = playback.volume;
  const seek = () => {
    media.currentTime = playback.time;
  };
  if (media.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
  else media.addEventListener("loadedmetadata", seek, { once: true });
  if (playback.playing) media.play().catch(() => undefined);
  else media.pause();
};

/** Pauses every other player on the page, so two never sound at once. */
export const pauseOtherMedia = (media: HTMLMediaElement) => {
  for (const other of media.ownerDocument.querySelectorAll<HTMLMediaElement>(
    "video, audio",
  ))
    if (other !== media && !other.paused) other.pause();
};
