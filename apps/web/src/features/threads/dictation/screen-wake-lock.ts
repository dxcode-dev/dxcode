type Sentinel = { readonly released: boolean; release(): Promise<void> };
type WakeLockApi = { request(type: "screen"): Promise<Sentinel> };

const wakeLockApi = () =>
  typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;

/**
 * Keeps the screen on between `hold` and `release`, so a phone does not sleep
 * and pause the microphone mid-dictation. Browsers drop the lock whenever the
 * page is hidden; it is requested again when the page is visible while still
 * held. Where the Screen Wake Lock API is missing or refuses the lock (battery
 * saver, permissions policy), the screen follows the device's normal timeout.
 */
export class ScreenWakeLock {
  private held = false;
  private sentinel?: Sentinel;
  private requesting = false;

  hold() {
    if (this.held || !wakeLockApi()) return;
    this.held = true;
    document.addEventListener("visibilitychange", this.reacquire);
    void this.acquire();
  }

  release() {
    if (!this.held) return;
    this.held = false;
    document.removeEventListener("visibilitychange", this.reacquire);
    const sentinel = this.sentinel;
    this.sentinel = undefined;
    void sentinel?.release().catch(() => undefined);
  }

  private readonly reacquire = () => {
    if (document.visibilityState === "visible") void this.acquire();
  };

  private async acquire() {
    const api = wakeLockApi();
    if (
      !api ||
      this.requesting ||
      document.visibilityState !== "visible" ||
      (this.sentinel && !this.sentinel.released)
    )
      return;
    this.requesting = true;
    const sentinel = await api.request("screen").catch(() => undefined);
    this.requesting = false;
    if (!sentinel) return;
    if (this.held) this.sentinel = sentinel;
    else await sentinel.release().catch(() => undefined);
  }
}
