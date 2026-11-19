import type { UserId } from "@dx/domain";
import { describe, expect, it, vi } from "vitest";
import {
  clearNewThreadDraftsForUser,
  createNewThreadDraftStore,
  NEW_THREAD_DRAFT_MAX_BYTES,
  type NewThreadDraftText,
} from "./new-thread-draft-store.js";

/** Core's New Thread draft, as the composer sees it: loads when asked. */
const coreText = (saved: string) => {
  let text = "";
  let loaded = false;
  const listeners = new Set<() => void>();
  const writes: string[] = [];
  const value: NewThreadDraftText = {
    get: () => text,
    set: (next) => {
      text = next;
      loaded = true;
      writes.push(next);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loaded: () => loaded,
    flush: vi.fn(),
  };
  return {
    value,
    writes,
    /** Core answers the load. */
    arrive: () => {
      text = saved;
      loaded = true;
      for (const listener of listeners) listener();
    },
  };
};

describe("New Thread draft store", () => {
  it("shows Core's draft once it arrives and saves each edit there", () => {
    const core = coreText("from my phone");
    const store = createNewThreadDraftStore({ text: core.value });
    store.subscribe(() => undefined);
    expect(store.getSnapshot()).toEqual({ text: "" });
    core.arrive();
    expect(store.getSnapshot()).toEqual({ text: "from my phone" });
    store.setText("from my phone, then my laptop");
    expect(core.writes).toEqual(["from my phone, then my laptop"]);
    // Same text, same snapshot: React does not render again.
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("adds an opener's prompt after Core's draft, never in place of it", () => {
    const core = coreText("saved draft");
    const store = createNewThreadDraftStore({ text: core.value });
    store.subscribe(() => undefined);
    store.appendPrompt("Review this file");
    expect(core.writes).toEqual([]);
    core.arrive();
    expect(store.getSnapshot().text).toBe("saved draft\n\nReview this file");
    // Opening again with the same prompt does not repeat it.
    store.appendPrompt("Review this file");
    expect(core.writes).toEqual(["saved draft\n\nReview this file"]);
  });

  it("keeps an oversized prompt open but unsaved, and warns", () => {
    const core = coreText("");
    const store = createNewThreadDraftStore({ text: core.value });
    const oversized = "€".repeat(NEW_THREAD_DRAFT_MAX_BYTES / 3 + 1);
    store.setText(oversized);
    expect(store.getSnapshot()).toEqual({
      text: oversized,
      warning: "too-large",
    });
    expect(core.writes).toEqual([]);
    store.setText("short");
    expect(store.getSnapshot()).toEqual({ text: "short" });
    expect(core.writes).toEqual(["short"]);
  });

  it("moves a prompt this browser kept to an empty Core draft, and only then forgets it", () => {
    const core = coreText("");
    const settled = vi.fn();
    const store = createNewThreadDraftStore({
      text: core.value,
      legacyText: "typed before the upgrade",
      onLegacySettled: settled,
    });
    store.subscribe(() => undefined);
    expect(settled).not.toHaveBeenCalled();
    core.arrive();
    expect(store.getSnapshot().text).toBe("typed before the upgrade");
    expect(settled).toHaveBeenCalledOnce();
  });

  it("never lets a prompt this browser kept replace Core's newer draft", () => {
    const core = coreText("written on another device");
    const settled = vi.fn();
    const store = createNewThreadDraftStore({
      text: core.value,
      legacyText: "stale",
      onLegacySettled: settled,
    });
    store.subscribe(() => undefined);
    core.arrive();
    expect(store.getSnapshot().text).toBe("written on another device");
    expect(core.writes).toEqual([]);
    expect(settled).toHaveBeenCalledOnce();
  });

  it("clears Core's draft when the Thread is sent", () => {
    const core = coreText("draft");
    const store = createNewThreadDraftStore({ text: core.value });
    store.subscribe(() => undefined);
    core.arrive();
    store.clear();
    expect(store.getSnapshot()).toEqual({ text: "" });
    expect(core.writes).toEqual([""]);
  });

  it("never throws during user-wide clearing when storage is blocked", () => {
    const throwingStorage = {
      get length(): number {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("window", { localStorage: throwingStorage });
    expect(() => clearNewThreadDraftsForUser("user-1" as UserId)).not.toThrow();
    vi.unstubAllGlobals();
  });
});
