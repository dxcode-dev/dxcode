/**
 * The web side of dx's native shells: the Mac app today, and the iOS,
 * Android, Windows and Linux apps after it. A shell hosts this web app in
 * its platform's web view and injects `window.dxShell` before any script
 * runs; features call this module, never a platform API, so a feature built
 * once here shows up natively on every platform whose shell lists the
 * capability. In a browser `nativeShell()` is undefined and nothing changes.
 *
 * Messages (keep in step with `apps/apple/Sources/Shell/Bridge.swift`):
 * - page → shell: `ready {page, account}`, `badge {count}`,
 *   `notify {id, title, body, url}`, `threads {items}` (recent Threads for
 *   the menu bar), `window-drag {regions, holes}` (where the page's top row
 *   moves the window), `runner.pair {code}`, `runner.status`,
 *   `open-external {url}`, `hosts.list`, `hosts.switch {id}`, `hosts.add`,
 *   `sign-in.prepare`, `sign-in.browser`;
 * - shell → page, as a `dxshell` window event: `navigate {url}`,
 *   `command {id}` (a command palette command id, so native menus run the
 *   same commands as the keyboard), `runner {state, paired, name}`,
 *   `runner.paired {ok, error?}`, `hosts {items}` (the dx installs the app
 *   opens), `sign-in.prepared {app, state, challenge}`.
 */

export type NativeShellPlatform =
  | "macos"
  | "ios"
  | "ipados"
  | "android"
  | "windows"
  | "linux";

export type NativeShellCapability =
  | "badge"
  | "notify"
  | "navigate"
  | "command"
  | "runner"
  | "recent-threads"
  | "window-drag"
  | "hosts"
  | "browser-sign-in";

/** A dx install the app opens, such as a self-host. */
export interface ShellHost {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly active: boolean;
  /** Its keyboard shortcut in the app, such as "⌘2"; empty past nine. */
  readonly shortcut: string;
}

/** A rectangle in CSS pixels from the page's top-left corner. */
export interface ShellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ShellMessage =
  | {
      readonly type: "ready";
      readonly page: string;
      readonly account: { readonly name: string; readonly email: string };
    }
  | {
      readonly type: "threads";
      readonly items: ReadonlyArray<{
        readonly id: string;
        readonly title: string;
        readonly unread: boolean;
      }>;
    }
  | {
      readonly type: "window-drag";
      /** Areas that move the window, such as the sidebar's top row. */
      readonly regions: ReadonlyArray<ShellRect>;
      /** Controls inside those areas, which stay clickable. */
      readonly holes: ReadonlyArray<ShellRect>;
    }
  | { readonly type: "badge"; readonly count: number }
  | {
      readonly type: "notify";
      readonly id: string;
      readonly title: string;
      readonly body: string;
      /** A same-origin path, such as `/threads/thr_1`. */
      readonly url: string;
    }
  | { readonly type: "runner.pair"; readonly code: string }
  | { readonly type: "hosts.list" }
  | { readonly type: "hosts.switch"; readonly id: string }
  | { readonly type: "hosts.add" }
  | { readonly type: "sign-in.prepare" }
  | { readonly type: "sign-in.browser" }
  | { readonly type: "runner.status" }
  | { readonly type: "open-external"; readonly url: string };

export type ShellEvent =
  | { readonly type: "navigate"; readonly url: string }
  | {
      readonly type: "command";
      /** A `CommandId` from `shared/commands/command-registry.ts`. */
      readonly id: string;
    }
  | {
      readonly type: "runner";
      readonly state: string;
      readonly paired: boolean;
      readonly name: string;
    }
  | { readonly type: "hosts"; readonly items: ReadonlyArray<ShellHost> }
  | {
      readonly type: "sign-in.prepared";
      /** The app's URL scheme, such as `dx-preview`. */
      readonly app: string;
      readonly state: string;
      readonly challenge: string;
    }
  | {
      readonly type: "runner.paired";
      readonly ok: boolean;
      readonly error?: string;
    };

export interface NativeShell {
  readonly platform: NativeShellPlatform;
  /** The message protocol's version; 1 today. */
  readonly protocol: number;
  /** The shell app's own version. */
  readonly version: string;
  readonly capabilities: ReadonlyArray<NativeShellCapability>;
  readonly post: (message: ShellMessage) => void;
}

const SHELL_EVENT = "dxshell";

/** The shell hosting this page, or undefined in a browser. */
export const nativeShell = (): NativeShell | undefined => {
  if (typeof window === "undefined") return undefined;
  const shell = (window as { dxShell?: NativeShell }).dxShell;
  return shell !== undefined && typeof shell.post === "function"
    ? shell
    : undefined;
};

/** The shell when it offers `capability`. */
export const nativeShellWith = (capability: NativeShellCapability) => {
  const shell = nativeShell();
  return shell?.capabilities.includes(capability) === true ? shell : undefined;
};

/** Calls `listener` for each event the shell sends; returns the unsubscribe. */
export const onShellEvent = (listener: (event: ShellEvent) => void) => {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (
      typeof detail === "object" &&
      detail !== null &&
      typeof (detail as { type?: unknown }).type === "string"
    )
      listener(detail as ShellEvent);
  };
  window.addEventListener(SHELL_EVENT, handle);
  return () => window.removeEventListener(SHELL_EVENT, handle);
};

/**
 * Posts `message` and resolves with the first `reply` event the shell sends
 * back, or undefined after `timeoutMs`.
 */
export const askShell = <Reply extends ShellEvent["type"]>(
  shell: NativeShell,
  message: ShellMessage,
  reply: Reply,
  timeoutMs = 3000,
) =>
  new Promise<Extract<ShellEvent, { type: Reply }> | undefined>((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(undefined);
    }, timeoutMs);
    const stop = onShellEvent((event) => {
      if (event.type !== reply) return;
      clearTimeout(timer);
      stop();
      resolve(event as Extract<ShellEvent, { type: Reply }>);
    });
    shell.post(message);
  });
