interface Turnstile {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: "interaction-only";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      "timeout-callback": () => void;
    },
  ) => string;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}
let scriptPromise: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const fail = () => {
      clearTimeout(timeout);
      script.remove();
      reject(new Error("Security check could not load. Please try again."));
    };
    const timeout = setTimeout(fail, 15_000);
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timeout);
      if (window.turnstile) resolve(window.turnstile);
      else fail();
    };
    document.head.append(script);
  }).catch((error: unknown) => {
    scriptPromise = undefined;
    throw error;
  });
  return scriptPromise;
}

/** Lazy, fresh challenge for each submission; normally occupies no space. */
export async function requestTurnstileToken(
  container: HTMLElement,
  sitekey: string,
) {
  if (!container.isConnected) throw new Error("Please try again.");
  const turnstile = await loadTurnstile();
  return new Promise<string>((resolve, reject) => {
    let widget: string | undefined;
    const finish = (token?: string) => {
      clearTimeout(timeout);
      if (widget !== undefined) turnstile.remove(widget);
      if (token) resolve(token);
      else
        reject(
          new Error("Security check failed or expired. Please try again."),
        );
    };
    const timeout = setTimeout(() => finish(), 120_000);
    try {
      widget = turnstile.render(container, {
        sitekey,
        action: "dx-access",
        appearance: "interaction-only",
        callback: (token) => finish(token),
        "error-callback": () => finish(),
        "expired-callback": () => finish(),
        "timeout-callback": () => finish(),
      });
    } catch {
      finish();
    }
  });
}
