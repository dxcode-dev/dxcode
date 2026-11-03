/** A microphone this browser may record from. */
export interface AudioInputDevice {
  readonly deviceId: string;
  readonly label: string;
}

// Chrome lists the current default again as "default" (and Windows'
// communications device as "communications"); System Default covers them.
const aliases = new Set(["", "default", "communications"]);

/**
 * This browser's microphones, refreshed while someone watches and whenever
 * one is plugged in or removed; undefined until the first listing answers.
 * Before microphone permission, browsers hide device IDs and names, so the
 * list stays empty until `requestAccess`.
 */
class AudioInputDevices {
  // Undefined until the first listing answers.
  private devices: ReadonlyArray<AudioInputDevice> | undefined;
  private readonly listeners = new Set<() => void>();
  private publish(devices: ReadonlyArray<AudioInputDevice>) {
    // An unchanged list keeps its identity, so nothing re-renders.
    if (JSON.stringify(devices) === JSON.stringify(this.devices)) return;
    this.devices = devices;
    for (const listener of this.listeners) listener();
  }
  private readonly refresh = () => {
    const media = navigator.mediaDevices;
    // Without media devices (an insecure origin), nothing can be listed.
    if (media === undefined) {
      this.publish([]);
      return;
    }
    void media.enumerateDevices().then(
      (all) =>
        this.publish(
          all.flatMap(({ kind, deviceId, label }) =>
            kind === "audioinput" && !aliases.has(deviceId) && label !== ""
              ? [{ deviceId, label }]
              : [],
          ),
        ),
      // Unlisted, Audio Input offers to ask for the microphone instead.
      () => this.publish(this.devices ?? []),
    );
  };
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      navigator.mediaDevices?.addEventListener("devicechange", this.refresh);
      this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0)
        navigator.mediaDevices?.removeEventListener(
          "devicechange",
          this.refresh,
        );
    };
  };
  readonly getSnapshot = () => this.devices;
  readonly getServerSnapshot = ():
    | ReadonlyArray<AudioInputDevice>
    | undefined => undefined;
  /** Asks for microphone permission so the list can name each device. */
  readonly requestAccess = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    this.refresh();
  };
}

export const audioInputDevices = new AudioInputDevices();
