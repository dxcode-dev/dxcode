import * as React from "react";

/** How long typing must pause before Autosave Files writes the edit. */
export const AUTOSAVE_DELAY_MS = 5_000;

/** One pending autosave; each keystroke restarts it. */
class AutosaveTimer {
  private timer: number | undefined;
  private listener: (() => void) | undefined;
  schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.listener?.(), AUTOSAVE_DELAY_MS);
  }
  cancel() {
    window.clearTimeout(this.timer);
  }
  subscribe(listener: () => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
      this.cancel();
    };
  }
}

/**
 * Autosave Files' timer. `schedule` restarts the delay; when it ends, `save`
 * runs as the latest render defines it, so it writes the latest edit against
 * the version the last save returned. While `busy` (a save still running),
 * it waits another delay. Unmounting drops a pending save.
 */
export const useAutosave = (save: () => void, busy: () => boolean) => {
  const [timer] = React.useState(() => new AutosaveTimer());
  const fire = React.useEffectEvent(() => {
    if (busy()) timer.schedule();
    else save();
  });
  React.useEffect(() => timer.subscribe(() => fire()), [timer]);
  return timer;
};
