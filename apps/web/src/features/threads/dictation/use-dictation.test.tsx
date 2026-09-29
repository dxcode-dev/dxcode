// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  type Snapshot =
    | {
        state: "idle" | "permission" | "recording";
        waveform: ReadonlyArray<number>;
      }
    | { state: "error"; waveform: ReadonlyArray<number>; error: string };
  class Capture {
    snapshot: Snapshot = { state: "idle", waveform: [] };
    listeners = new Set<() => void>();
    finish = vi.fn(async () => {
      this.publish({ state: "idle", waveform: [] });
      return new Blob([new Uint8Array(45)]);
    });
    cancel = vi.fn(async () => this.publish({ state: "idle", waveform: [] }));
    start = vi.fn(async () =>
      this.publish({ state: "recording", waveform: [0, 0.5, 1] }),
    );
    subscribe = (listener: () => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    getSnapshot = () => this.snapshot;
    getServerSnapshot = () => ({ state: "idle" as const, waveform: [] });
    publish(snapshot: Snapshot) {
      this.snapshot = snapshot;
      this.listeners.forEach((listener) => {
        listener();
      });
    }
  }
  return {
    captures: [] as Capture[],
    Capture,
    transcription:
      vi.fn<
        (input: {
          audio: Blob;
          id: string;
          signal: AbortSignal;
        }) => Promise<string>
      >(),
    cancelJob: vi.fn(),
  };
});

vi.mock("./dictation-capture.js", () => ({
  DictationCapture: class extends fakes.Capture {
    constructor() {
      super();
      fakes.captures.push(this);
    }
  },
}));

vi.mock("./dictation-api.js", () => ({
  cancelDictationJob: fakes.cancelJob,
  dictationMutationOptions: () => ({
    mutationFn: (input: { audio: Blob; id: string; signal: AbortSignal }) =>
      fakes.transcription(input),
    gcTime: 0,
  }),
}));

import { DictationRecoverySession } from "./dictation-session.js";
import { useDictation } from "./use-dictation.js";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
};

type Mounted = {
  container: HTMLDivElement;
  lock: (locked: boolean) => void;
  root: Root;
  submissions: ReturnType<typeof vi.fn<(value: string) => void>>;
  textarea: HTMLTextAreaElement;
};

const setText = async (
  textarea: HTMLTextAreaElement,
  value: string,
  start = value.length,
  end = start,
) => {
  await React.act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  textarea.setSelectionRange(start, end);
};

const mount = async (
  initial = "",
  enabled = true,
  session?: DictationRecoverySession,
): Promise<Mounted> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const submissions = vi.fn<(value: string) => void>();
  let setLocked: React.Dispatch<React.SetStateAction<boolean>> = () => {};
  function Composer() {
    const [draft, setDraft] = React.useState(initial);
    const [locked, updateLocked] = React.useState(false);
    setLocked = updateLocked;
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const dictation = useDictation({
      enabled,
      locked,
      session,
      onChange: setDraft,
      onSend: submissions,
      textareaRef,
    });
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!dictation.interceptSubmit())
            submissions(textareaRef.current?.value ?? "");
        }}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {dictation.controls}
        {dictation.hideSubmit ? null : <button type="submit">Send</button>}
      </form>
    );
  }
  await React.act(() =>
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        }
      >
        <Composer />
      </QueryClientProvider>,
    ),
  );
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Expected textarea");
  return {
    container,
    lock: (locked) => React.act(() => setLocked(locked)),
    root,
    submissions,
    textarea,
  };
};

const click = async (element: Element | null) => {
  if (!element) throw new Error("Expected control");
  await React.act(() =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
};

const start = (mounted: Mounted) =>
  click(mounted.container.querySelector('[aria-label="Start dictation"]'));

beforeEach(() => {
  fakes.captures.length = 0;
  fakes.transcription.mockReset();
  fakes.cancelJob.mockReset();
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useDictation lifecycle", () => {
  it("leaves the composer usable without a configured dictation provider", async () => {
    const mounted = await mount("message", false);

    expect(
      mounted.container.querySelector('[aria-label="Start dictation"]'),
    ).toBeNull();
    await React.act(() =>
      mounted.container.querySelector<HTMLFormElement>("form")?.requestSubmit(),
    );
    expect(mounted.submissions).toHaveBeenCalledWith("message");
  });

  it("shows a full waveform with only a stop control, then the shared processing dot", async () => {
    const result = deferred<string>();
    fakes.transcription.mockReturnValue(result.promise);
    const mounted = await mount();

    await start(mounted);
    expect(
      mounted.container.querySelector(".dictation-waveform"),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    ).not.toBeNull();
    expect(
      mounted.container
        .querySelector('[aria-label="Stop dictation"]')
        ?.classList.contains("size-8"),
    ).toBe(true);
    expect(
      mounted.container.querySelector('[aria-label="Cancel dictation"]'),
    ).toBeNull();

    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await vi.waitFor(() =>
      expect(
        mounted.container.querySelector(".dictation-processing-dot"),
      ).not.toBeNull(),
    );
    expect(
      mounted.container.querySelector('button[type="submit"]'),
    ).not.toBeNull();
    await React.act(() => result.resolve("done"));
  });

  it("inserts at the current selection when a stopped recording resolves, without submitting", async () => {
    const result = deferred<string>();
    fakes.transcription.mockReturnValue(result.promise);
    const mounted = await mount("old selection");
    await start(mounted);
    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await setText(mounted.textarea, "hello brave world", 6, 11);
    await React.act(() => result.resolve("new"));

    expect(mounted.textarea.value).toBe("hello new world");
    expect(mounted.submissions).not.toHaveBeenCalled();
  });

  it("does not insert a late transcription after locking and retains its audio", async () => {
    const result = deferred<string>();
    fakes.transcription.mockReturnValue(result.promise);
    const mounted = await mount("keep this draft");
    await start(mounted);
    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await mounted.lock(true);
    await mounted.lock(false);

    await React.act(() => result.resolve("discarded transcript"));

    expect(mounted.textarea.value).toBe("keep this draft");
    expect(
      mounted.container.querySelector('[aria-label="Retry dictation"]'),
    ).not.toBeNull();
    expect(mounted.submissions).not.toHaveBeenCalled();
  });

  it("keeps an aborted locked transcription recoverable after unlock", async () => {
    const result = deferred<string>();
    fakes.transcription.mockReturnValue(result.promise);
    const mounted = await mount("keep this draft");
    await start(mounted);
    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await mounted.lock(true);
    await mounted.lock(false);

    await React.act(() =>
      result.reject(new DOMException("Aborted", "AbortError")),
    );

    expect(mounted.textarea.value).toBe("keep this draft");
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Dictation was saved after leaving the composer.",
    );
    expect(
      mounted.container.querySelector('[aria-label="Retry dictation"]'),
    ).not.toBeNull();
    expect(mounted.submissions).not.toHaveBeenCalled();
  });

  it("distinguishes microphone capture failure from translation failure", async () => {
    const captureFailure = await mount();
    await start(captureFailure);
    await React.act(() =>
      fakes.captures[0]?.publish({
        state: "error",
        waveform: [],
        error: "Microphone access denied.",
      }),
    );
    expect(
      captureFailure.container.querySelector('[role="alert"]')?.textContent,
    ).toBe("Microphone access denied.");

    fakes.transcription.mockRejectedValueOnce(
      new Error("Dictation could not be translated."),
    );
    const translationFailure = await mount();
    await start(translationFailure);
    await click(
      translationFailure.container.querySelector(
        '[aria-label="Stop dictation"]',
      ),
    );
    await vi.waitFor(() =>
      expect(
        translationFailure.container.querySelector('[role="alert"]')
          ?.textContent,
      ).toBe("Dictation could not be translated."),
    );
    expect(fakes.cancelJob).toHaveBeenCalledOnce();
    expect(fakes.cancelJob).toHaveBeenCalledWith(expect.any(String));
  });

  it("retains failed audio and retries the same recording", async () => {
    fakes.transcription
      .mockRejectedValueOnce(new Error("Network unavailable."))
      .mockResolvedValueOnce("recovered transcript");
    const mounted = await mount();

    await start(mounted);
    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await vi.waitFor(() =>
      expect(
        mounted.container.querySelector('[aria-label="Retry dictation"]'),
      ).not.toBeNull(),
    );
    const retry = mounted.container.querySelector(
      '[aria-label="Retry dictation"]',
    );
    expect(retry?.closest(".dictation-controls")?.classList).toContain(
      "is-recoverable",
    );
    const firstAudio = fakes.transcription.mock.calls[0]?.[0].audio;

    await click(
      mounted.container.querySelector('[aria-label="Retry dictation"]'),
    );
    await vi.waitFor(() =>
      expect(mounted.textarea.value).toBe("recovered transcript"),
    );

    expect(fakes.captures[0]?.start).toHaveBeenCalledTimes(1);
    expect(fakes.transcription).toHaveBeenCalledTimes(2);
    expect(fakes.transcription.mock.calls[1]?.[0].audio).toBe(firstAudio);
    expect(
      mounted.container.querySelector('[aria-label="Retry dictation"]'),
    ).toBeNull();
  });

  it("offers download without removing retry after repeated failures", async () => {
    fakes.transcription.mockRejectedValue(new Error("Network unavailable."));
    const createObjectURL = vi.fn(() => "blob:saved-dictation");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const clickAnchor = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const mounted = await mount();

    await start(mounted);
    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await vi.waitFor(() =>
      expect(
        mounted.container.querySelector('[aria-label="Retry dictation"]'),
      ).not.toBeNull(),
    );
    await click(
      mounted.container.querySelector('[aria-label="Retry dictation"]'),
    );
    await vi.waitFor(() =>
      expect(fakes.transcription).toHaveBeenCalledTimes(2),
    );
    await click(
      mounted.container.querySelector(
        '[aria-label="Download saved dictation"]',
      ),
    );

    expect(createObjectURL).toHaveBeenCalledWith(
      fakes.transcription.mock.calls[0]?.[0].audio,
    );
    expect(clickAnchor).toHaveBeenCalledOnce();
    expect(
      mounted.container.querySelector('[aria-label="Retry dictation"]'),
    ).not.toBeNull();
  });

  it("only discards failed audio when the user explicitly records again", async () => {
    fakes.transcription.mockRejectedValueOnce(
      new Error("Dictation returned no speech."),
    );
    const mounted = await mount();

    await start(mounted);
    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await vi.waitFor(() =>
      expect(
        mounted.container.querySelector('[aria-label="Retry dictation"]'),
      ).not.toBeNull(),
    );
    await click(
      mounted.container.querySelector(
        '[aria-label="Discard saved dictation and record again"]',
      ),
    );

    expect(fakes.captures[0]?.start).toHaveBeenCalledTimes(2);
    expect(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[aria-label="Retry dictation"]'),
    ).toBeNull();
    expect(fakes.transcription).toHaveBeenCalledOnce();
  });

  it("does not offer replacement while another recording is active", async () => {
    const session = new DictationRecoverySession();
    const mounted = await mount("", true, session);
    await start(mounted);

    await React.act(() =>
      session.retain(
        new Blob([new Uint8Array(45)]),
        "insert",
        "Older recording saved.",
      ),
    );

    expect(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector(
        '[aria-label="Discard saved dictation and record again"]',
      ),
    ).toBeNull();
    expect(fakes.captures[0]?.start).toHaveBeenCalledOnce();
  });

  it("does not overwrite an older saved clip when an active recording finishes", async () => {
    fakes.transcription.mockResolvedValueOnce("new transcript");
    const session = new DictationRecoverySession();
    const mounted = await mount("", true, session);
    await start(mounted);
    const olderAudio = new Blob([new Uint8Array(45)]);
    await React.act(() =>
      session.retain(olderAudio, "insert", "Older recording saved."),
    );

    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await vi.waitFor(() =>
      expect(mounted.textarea.value).toBe("new transcript"),
    );

    expect(session.getSnapshot()).toMatchObject({
      state: "retained",
      audio: olderAudio,
      error: "Older recording saved.",
    });
    expect(
      mounted.container.querySelector('[aria-label="Retry dictation"]'),
    ).not.toBeNull();
  });

  it("retains in-flight audio when its composer unmounts", async () => {
    const result = deferred<string>();
    fakes.transcription.mockReturnValue(result.promise);
    const session = new DictationRecoverySession();
    const mounted = await mount("", true, session);
    await start(mounted);
    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await vi.waitFor(() => expect(fakes.transcription).toHaveBeenCalledOnce());

    await React.act(() => mounted.root.unmount());
    expect(session.getSnapshot()).toMatchObject({
      state: "retained",
      error: "Dictation was saved after leaving the composer.",
    });
    const restored = await mount("", true, session);

    expect(
      restored.container.querySelector('[aria-label="Retry dictation"]'),
    ).not.toBeNull();
  });

  it("finishes and retains a recording when its composer unmounts", async () => {
    const session = new DictationRecoverySession();
    const mounted = await mount("", true, session);
    await start(mounted);

    await React.act(() => mounted.root.unmount());
    await vi.waitFor(() =>
      expect(session.getSnapshot()).toMatchObject({
        state: "retained",
        error: "Dictation was saved after leaving the composer.",
      }),
    );
    const restored = await mount("", true, session);

    expect(
      restored.container.querySelector('[aria-label="Retry dictation"]'),
    ).not.toBeNull();
    expect(fakes.transcription).not.toHaveBeenCalled();
  });

  it("does not restore a deleted transcript during the next recording cycle", async () => {
    const setRangeText = vi.spyOn(
      HTMLTextAreaElement.prototype,
      "setRangeText",
    );
    fakes.transcription
      .mockResolvedValueOnce("first transcript")
      .mockResolvedValueOnce("second transcript");
    const mounted = await mount();

    await start(mounted);
    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await vi.waitFor(() =>
      expect(mounted.textarea.value).toBe("first transcript"),
    );
    await setText(mounted.textarea, "");

    await start(mounted);
    expect(mounted.textarea.value).toBe("");
    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await vi.waitFor(() =>
      expect(mounted.textarea.value).toBe("second transcript"),
    );
    expect(setRangeText).not.toHaveBeenCalled();
  });

  it("Send uses the latest full draft once and keeps its original send intent", async () => {
    const result = deferred<string>();
    fakes.transcription.mockReturnValue(result.promise);
    const mounted = await mount("first");
    await start(mounted);
    await click(mounted.container.querySelector('button[type="submit"]'));
    await setText(mounted.textarea, "latest ");
    expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
    await React.act(() => result.resolve("words"));

    expect(mounted.submissions).toHaveBeenCalledTimes(1);
    expect(mounted.submissions).toHaveBeenCalledWith("latest words");
    expect(fakes.captures[0]?.finish).toHaveBeenCalledTimes(1);
  });

  it("does not replace selected text or submit for an empty result", async () => {
    const result = deferred<string>();
    fakes.transcription.mockReturnValue(result.promise);
    const mounted = await mount("keep this text");
    await start(mounted);
    mounted.textarea.setSelectionRange(5, 9);
    await click(mounted.container.querySelector('button[type="submit"]'));
    await React.act(() => result.resolve("   "));

    expect(mounted.textarea.value).toBe("keep this text");
    expect(mounted.submissions).not.toHaveBeenCalled();
  });

  it("drops a late result after unmount", async () => {
    const result = deferred<string>();
    fakes.transcription.mockReturnValue(result.promise);
    const mounted = await mount("draft");
    await start(mounted);
    await click(
      mounted.container.querySelector('[aria-label="Stop dictation"]'),
    );
    await React.act(() => mounted.root.unmount());
    await React.act(() => result.resolve("late"));

    expect(mounted.submissions).not.toHaveBeenCalled();
    expect(fakes.cancelJob).toHaveBeenCalledOnce();
  });

  it("blocks submission while microphone permission is pending", async () => {
    const mounted = await mount("ready");
    fakes.captures[0]?.start.mockImplementationOnce(async function (
      this: InstanceType<typeof fakes.Capture>,
    ) {
      this.publish({ state: "permission", waveform: [] });
    });
    await start(mounted);
    await click(mounted.container.querySelector('button[type="submit"]'));

    expect(mounted.submissions).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain(
      "Waiting for microphone permission",
    );
  });
});
