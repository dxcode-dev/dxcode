import { useSyncExternalStore } from "react";
import {
  nativeShellWith,
  onShellEvent,
  type ShellHost,
} from "./native-shell.js";

/**
 * The dx installs the app opens (each one a host), from the shell that
 * hosts this page; empty in a browser. The shell sends the list when the
 * page asks and again whenever it changes.
 */
let hosts: ReadonlyArray<ShellHost> = [];
const listeners = new Set<() => void>();
let stopListening: (() => void) | undefined;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const shell = nativeShellWith("hosts");
  if (stopListening === undefined && shell !== undefined) {
    stopListening = onShellEvent((event) => {
      if (event.type !== "hosts") return;
      hosts = event.items;
      for (const notify of listeners) notify();
    });
    shell.post({ type: "hosts.list" });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = undefined;
    }
  };
};

const snapshot = () => hosts;

export const useShellHosts = () =>
  useSyncExternalStore(subscribe, snapshot, snapshot);

export const switchShellHost = (id: string) =>
  nativeShellWith("hosts")?.post({ type: "hosts.switch", id });

export const addShellHost = () =>
  nativeShellWith("hosts")?.post({ type: "hosts.add" });
