/**
 * The session check, sent by `bootstrap.ts` before the app's code loads, so
 * its round trip overlaps the code's download (#1599). The boot's shell reads
 * wait for it, so a signed-out visitor sends no authenticated read; sending it
 * this early keeps that wait off a signed-in first load. The first session
 * check (`getBrowserSession`) takes its answer; every later one asks again.
 * Kept free of dependencies: it runs before anything else loads.
 */
let bootSessionRead: Promise<unknown> | undefined;

export const startBootSessionRead = () => {
  bootSessionRead = fetch("/api/auth/get-session", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }).then((response) => (response.ok ? response.json() : undefined));
  // An unread failure is not an error: the first check asks again.
  bootSessionRead.catch(() => undefined);
};

/**
 * Better Auth's answer to the boot read (`null` when nobody is signed in), or
 * undefined when there is none to take or it failed.
 */
export const takeBootSessionRead = async (): Promise<unknown> => {
  const pending = bootSessionRead;
  bootSessionRead = undefined;
  return pending?.catch(() => undefined);
};

/**
 * The boot read's answer without taking it, so `main-entry.tsx` can start the
 * boot's shell reads as soon as it shows someone signed in, before the app's
 * code evaluates. Undefined when there is none or it failed.
 */
export const peekBootSessionRead = async (): Promise<unknown> =>
  bootSessionRead?.catch(() => undefined);
