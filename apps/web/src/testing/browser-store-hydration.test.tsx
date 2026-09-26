// @vitest-environment happy-dom

import * as React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommandRegistry,
  keyboardShortcutStorageKey,
  type CommandRegistry,
} from "../shared/commands/command-registry.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

afterEach(() => {
  document.body.replaceChildren();
});

function CommandSnapshot({ store }: { readonly store: CommandRegistry }) {
  const snapshot = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return <span>{Object.keys(snapshot.overrides).length}</span>;
}

const hydrate = async (serverHtml: string, element: React.ReactNode) => {
  const container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.append(container);
  const recoverableError = vi.fn();
  const root = hydrateRoot(container, element, {
    onRecoverableError: recoverableError,
  });
  await React.act(async () => undefined);
  return { container, recoverableError, root };
};

describe("browser external-store hydration", () => {
  it("hydrates shortcut overrides from a stable empty server snapshot", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      keyboardShortcutStorageKey,
      JSON.stringify({
        version: 1,
        overrides: { "navigation.projects": "Mod+Shift+P" },
      }),
    );
    const store = createCommandRegistry({ platform: "linux", storage });
    const element = <CommandSnapshot store={store} />;
    const serverHtml = renderToString(element);

    expect(serverHtml).toContain(">0<");
    const hydrated = await hydrate(serverHtml, element);
    expect(hydrated.container.textContent).toBe("1");
    expect(hydrated.recoverableError).not.toHaveBeenCalled();
    await React.act(() => hydrated.root.unmount());
  });
});
