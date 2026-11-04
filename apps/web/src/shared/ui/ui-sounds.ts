/**
 * Short interface sounds, synthesized so they need no audio files. Callers
 * play them only when the person turned on UI Sounds.
 */
export type UiSound = "start" | "stop" | "tick";

// Each sound is a few short sine tones, a step apart.
const tones: Record<UiSound, ReadonlyArray<number>> = {
  start: [660, 990],
  stop: [990, 660],
  tick: [1_400],
};
const toneSeconds = 0.05;

let context: AudioContext | undefined;

export const playUiSound = (sound: UiSound) => {
  if (typeof AudioContext === "undefined") return;
  context ??= new AudioContext();
  const audio = context;
  // A context made before any gesture starts suspended; a click resumes it.
  if (audio.state === "suspended") void audio.resume();
  tones[sound].forEach((frequency, index) => {
    const startsAt = audio.currentTime + index * toneSeconds;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(0.06, startsAt + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + toneSeconds);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + toneSeconds);
  });
};
