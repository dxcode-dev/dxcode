/**
 * A turn the deployment's own billing stopped, as the thread's error card
 * reads it: Core's `(dx_failure:…:<code>)` text in, the card's copy out.
 * A deployment registers one
 * (features/threads/turn-stop-registration.ts); public dx
 * registers none, so such a stop reads as any other failure.
 */
export interface TurnStopNotice {
  readonly title: string;
  readonly message: string;
  /** An app page that fixes it. */
  readonly link?: { readonly actionLabel: string; readonly actionHref: string };
}

export type TurnStop = (failureText: string) => TurnStopNotice | undefined;
