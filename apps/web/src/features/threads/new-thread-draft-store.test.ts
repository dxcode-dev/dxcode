import type { UserId, WorkspaceId } from "@dx/domain";
import { describe, expect, it, vi } from "vitest";
import {
  clearNewThreadDraftsForUser,
  createNewThreadDraftStore,
  NEW_THREAD_DRAFT_MAX_BYTES,
  NEW_THREAD_DRAFT_TTL_MS,
  newThreadDraftStoragePrefix,
} from "./new-thread-draft-store.js";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const userId = "user-1" as UserId;
const workspaceId = "workspace-1" as WorkspaceId;
const scope = { userId, workspaceId };
const key = `${newThreadDraftStoragePrefix}user-1:workspace-1`;

describe("New Thread draft store", () => {
  it("keys prompt-only envelopes by user and workspace, never project or attachments", () => {
    const storage = new MemoryStorage();
    const store = createNewThreadDraftStore({ scope, storage, debounceMs: 0 });
    store.setText("private prompt");
    store.flush();

    expect([...storage.values.keys()]).toEqual([key]);
    expect(JSON.parse(storage.getItem(key) ?? "")).toMatchObject({
      version: 1,
      text: "private prompt",
    });
    expect(storage.getItem(key)).not.toMatch(
      /project|attachment|image|pending/i,
    );
    expect(
      createNewThreadDraftStore({
        scope: { userId: "user-2" as UserId, workspaceId },
        storage,
      }).getSnapshot(),
    ).toEqual({ text: "" });
    expect(
      createNewThreadDraftStore({
        scope: { userId, workspaceId: "workspace-2" as WorkspaceId },
        storage,
      }).getSnapshot(),
    ).toEqual({ text: "" });
  });

  it.each(["not-json", JSON.stringify({ version: 0, text: "old" })])(
    "removes malformed or unsupported data: %s",
    (raw) => {
      const storage = new MemoryStorage();
      storage.setItem(key, raw);
      const store = createNewThreadDraftStore({ scope, storage });
      expect(store.getSnapshot()).toEqual({ text: "" });
      expect(storage.getItem(key)).toBeNull();
    },
  );

  it("expires after seven days and sliding reads refresh the deadline", () => {
    const storage = new MemoryStorage();
    let clock = 1_000;
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        text: "active",
        updatedAt: clock,
        expiresAt: clock + NEW_THREAD_DRAFT_TTL_MS,
      }),
    );
    clock += NEW_THREAD_DRAFT_TTL_MS - 1;
    expect(
      createNewThreadDraftStore({
        scope,
        storage,
        now: () => clock,
      }).getSnapshot().text,
    ).toBe("active");
    expect(JSON.parse(storage.getItem(key) ?? "").expiresAt).toBe(
      clock + NEW_THREAD_DRAFT_TTL_MS,
    );
    clock += NEW_THREAD_DRAFT_TTL_MS + 1;
    expect(
      createNewThreadDraftStore({
        scope,
        storage,
        now: () => clock,
      }).getSnapshot(),
    ).toEqual({ text: "" });
  });

  it("keeps oversized UTF-8 input mount-scoped and warns", () => {
    const storage = new MemoryStorage();
    const store = createNewThreadDraftStore({ scope, storage });
    const text = "🙂".repeat(NEW_THREAD_DRAFT_MAX_BYTES / 4 + 1);
    store.setText(text);
    store.flush();
    expect(store.getSnapshot()).toEqual({ text, warning: "too-large" });
    expect(storage.getItem(key)).toBeNull();
  });

  it("preserves mount-scoped text when storage is unavailable or quota fails", () => {
    const storage = new MemoryStorage();
    storage.setItem = vi.fn(() => {
      throw new DOMException("Quota", "QuotaExceededError");
    });
    const store = createNewThreadDraftStore({ scope, storage });
    store.setText("still here");
    store.flush();
    expect(store.getSnapshot()).toEqual({
      text: "still here",
      warning: "storage-unavailable",
    });
  });

  it("has one referentially stable empty SSR snapshot", () => {
    const store = createNewThreadDraftStore({ scope });
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
    expect(store.getServerSnapshot()).toEqual({ text: "" });
  });

  it("applies live same-scope cross-tab updates with latest-write-wins", () => {
    let receive:
      | ((key: string | null, value: string | null) => void)
      | undefined;
    const store = createNewThreadDraftStore({
      scope,
      subscribeToStorage: (listener) => {
        receive = listener;
        return () => undefined;
      },
      now: () => 100,
    });
    const changed = vi.fn();
    store.subscribe(changed);
    receive?.(
      key,
      JSON.stringify({
        version: 1,
        text: "new",
        updatedAt: 20,
        expiresAt: 200,
      }),
    );
    receive?.(
      key,
      JSON.stringify({
        version: 1,
        text: "stale",
        updatedAt: 10,
        expiresAt: 200,
      }),
    );
    expect(store.getSnapshot()).toEqual({ text: "new" });
    expect(changed).toHaveBeenCalledOnce();
  });

  it("rechecks storage after subscribing so the initial read race is closed", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        text: "initial",
        updatedAt: 10,
        expiresAt: 1_000,
      }),
    );
    const store = createNewThreadDraftStore({
      scope,
      storage,
      now: () => 100,
      subscribeToStorage: () => () => undefined,
    });
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        text: "changed before subscribe",
        updatedAt: 20,
        expiresAt: 1_000,
      }),
    );
    store.subscribe(() => undefined);
    expect(store.getSnapshot().text).toBe("changed before subscribe");
  });

  it("does not let an older storage event overwrite an unflushed local edit", () => {
    let receive:
      | ((key: string | null, value: string | null) => void)
      | undefined;
    const store = createNewThreadDraftStore({
      scope,
      now: () => 100,
      subscribeToStorage: (listener) => {
        receive = listener;
        return () => undefined;
      },
    });
    store.subscribe(() => undefined);
    store.setText("new local text");
    receive?.(
      key,
      JSON.stringify({
        version: 1,
        text: "older tab text",
        updatedAt: 99,
        expiresAt: 1_000,
      }),
    );
    expect(store.getSnapshot().text).toBe("new local text");
  });

  it("does not let an equal-timestamp storage event overwrite a local edit", () => {
    let receive:
      | ((key: string | null, value: string | null) => void)
      | undefined;
    const store = createNewThreadDraftStore({
      scope,
      now: () => 100,
      subscribeToStorage: (listener) => {
        receive = listener;
        return () => undefined;
      },
    });
    store.subscribe(() => undefined);
    store.setText("local");
    receive?.(
      key,
      JSON.stringify({
        version: 1,
        text: "same clock remote",
        updatedAt: 100,
        expiresAt: 1_000,
      }),
    );
    expect(store.getSnapshot().text).toBe("local");
  });

  it("cancels a pending flush when another tab clears the scope", () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    let receive:
      | ((key: string | null, value: string | null) => void)
      | undefined;
    const store = createNewThreadDraftStore({
      scope,
      storage,
      debounceMs: 100,
      subscribeToStorage: (listener) => {
        receive = listener;
        return () => undefined;
      },
    });
    store.subscribe(() => undefined);
    store.setText("must not return");
    receive?.(key, null);
    vi.advanceTimersByTime(200);
    expect(store.getSnapshot()).toEqual({ text: "" });
    expect(storage.getItem(key)).toBeNull();
    vi.useRealTimers();
  });

  it("ignores malformed storage events without discarding local text", () => {
    let receive:
      | ((key: string | null, value: string | null) => void)
      | undefined;
    const store = createNewThreadDraftStore({
      scope,
      now: () => 100,
      subscribeToStorage: (listener) => {
        receive = listener;
        return () => undefined;
      },
    });
    store.subscribe(() => undefined);
    store.setText("unflushed local text");
    receive?.(key, "not-json");
    receive?.(
      key,
      JSON.stringify({
        version: 1,
        text: "expired remote text",
        updatedAt: 99,
        expiresAt: 100,
      }),
    );
    expect(store.getSnapshot().text).toBe("unflushed local text");
  });

  it("flushes pending text on pagehide only while observed and cleans up", () => {
    const storage = new MemoryStorage();
    let pagehide: (() => void) | undefined;
    const cleanup = vi.fn();
    const store = createNewThreadDraftStore({
      scope,
      storage,
      debounceMs: 10_000,
      subscribeToPageHide: (listener) => {
        pagehide = listener;
        return cleanup;
      },
    });
    const unsubscribe = store.subscribe(() => undefined);
    store.setText("survives page close");
    expect(storage.getItem(key)).toBeNull();
    pagehide?.();
    expect(JSON.parse(storage.getItem(key) ?? "").text).toBe(
      "survives page close",
    );
    unsubscribe();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("restores and clears only the active account/workspace scope", () => {
    const storage = new MemoryStorage();
    const otherScope = {
      userId,
      workspaceId: "workspace-2" as WorkspaceId,
    };
    const first = createNewThreadDraftStore({ scope, storage, debounceMs: 0 });
    first.setText("workspace one");
    first.flush();
    const second = createNewThreadDraftStore({
      scope: otherScope,
      storage,
      debounceMs: 0,
    });
    second.setText("workspace two");
    second.flush();

    expect(
      createNewThreadDraftStore({ scope, storage }).getSnapshot().text,
    ).toBe("workspace one");
    expect(second.getSnapshot().text).toBe("workspace two");
    first.clear();
    expect(second.getSnapshot().text).toBe("workspace two");
  });

  it("never throws during user-wide clearing when any storage operation fails", () => {
    const throwingStorage = {
      get length(): number {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("window", { localStorage: throwingStorage });
    expect(() => clearNewThreadDraftsForUser(userId)).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("clears exactly its record on discard or successful-send command", () => {
    const storage = new MemoryStorage();
    storage.setItem("unrelated", "keep");
    const store = createNewThreadDraftStore({ scope, storage });
    store.setText("draft");
    store.flush();
    store.clear();
    expect(store.getSnapshot()).toEqual({ text: "" });
    expect(storage.getItem(key)).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");
  });
});
