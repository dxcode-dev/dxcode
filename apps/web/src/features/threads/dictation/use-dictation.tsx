import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Mic, RotateCcw, Square } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import type { DictationSlot } from "../../../shared/dictation/dictation-slot.js";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { useTheme } from "../../../shared/theme/theme-provider.js";
import { Button } from "../../../shared/ui/button.js";
import { playUiSound } from "../../../shared/ui/ui-sounds.js";
import { Waveform } from "../../../shared/ui/waveform.js";
import { settingsContextQueryOptions } from "../../settings/settings-context-queries.js";
import { ThreadPresentationContext } from "../thread-session-context.js";
import {
  cancelDictationJob,
  dictationMutationOptions,
} from "./dictation-api.js";
import { DictationCapture } from "./dictation-capture.js";
import {
  type DictationIntent,
  DictationRecoverySession,
  downloadDictation,
} from "./dictation-session.js";
import {
  type LiveDictation,
  type LiveRecording,
  liveRecording,
} from "./dictation-stream.js";

const CaretMarker = ({
  textarea,
}: {
  readonly textarea: HTMLTextAreaElement;
}) => {
  const markerRef = React.useRef<HTMLSpanElement>(null);
  useMountEffect(() => {
    const marker = markerRef.current;
    const form = textarea.closest("form");
    if (!marker || !form) return;
    const previousPosition = form.style.position;
    if (getComputedStyle(form).position === "static")
      form.style.position = "relative";
    const mirror = document.createElement("div");
    mirror.className = "dictation-caret-mirror";
    form.append(mirror);
    const update = () => {
      const style = getComputedStyle(textarea);
      const formRect = form.getBoundingClientRect();
      const rect = textarea.getBoundingClientRect();
      for (const property of [
        "font",
        "letter-spacing",
        "line-height",
        "padding",
        "border",
        "box-sizing",
        "white-space",
        "word-break",
        "overflow-wrap",
        "tab-size",
      ])
        mirror.style.setProperty(property, style.getPropertyValue(property));
      mirror.style.width = `${rect.width}px`;
      mirror.textContent = textarea.value.slice(0, textarea.selectionStart);
      const end = document.createElement("span");
      end.textContent = "\u200b";
      mirror.append(end);
      const x =
        rect.left - formRect.left + end.offsetLeft - textarea.scrollLeft;
      const y = rect.top - formRect.top + end.offsetTop - textarea.scrollTop;
      const caretHeight =
        end.getBoundingClientRect().height || Number.parseFloat(style.fontSize);
      const visible =
        x >= rect.left - formRect.left &&
        x <= rect.right - formRect.left &&
        y >= rect.top - formRect.top &&
        y + caretHeight <= rect.bottom - formRect.top;
      marker.style.height = `${caretHeight}px`;
      marker.style.transform = `translate(${x}px, ${y}px)`;
      marker.hidden = !visible;
    };
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (scrollTimer !== undefined) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = undefined;
        update();
      }, 16);
    };
    textarea.addEventListener("select", update);
    textarea.addEventListener("input", update);
    textarea.addEventListener("keyup", update);
    textarea.addEventListener("pointerup", update);
    textarea.addEventListener("scroll", onScroll);
    document.addEventListener("selectionchange", update);
    const observer = new ResizeObserver(update);
    observer.observe(textarea);
    update();
    return () => {
      clearTimeout(scrollTimer);
      observer.disconnect();
      textarea.removeEventListener("select", update);
      textarea.removeEventListener("input", update);
      textarea.removeEventListener("keyup", update);
      textarea.removeEventListener("pointerup", update);
      textarea.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", update);
      mirror.remove();
      form.style.position = previousPosition;
    };
  });
  const form = textarea.closest("form");
  return form
    ? createPortal(
        <span
          className="dictation-caret-marker"
          ref={markerRef}
          aria-hidden="true"
        >
          <Mic />
        </span>,
        form,
      )
    : null;
};

/** Render must not read the textarea ref, so the marker waits for mount. */
const DictationCaret = ({
  textareaRef,
}: {
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) => {
  const [textarea, setTextarea] = React.useState<HTMLTextAreaElement | null>(
    null,
  );
  useMountEffect(() => setTextarea(textareaRef.current));
  return textarea === null ? null : <CaretMarker textarea={textarea} />;
};

/**
 * Where a transcript goes: a textarea, at its cursor (`textareaRef` with
 * `onChange`), or anything else that inserts text itself (`insertText`,
 * which returns false when it could not), such as the artifact editor.
 */
type DictationTarget =
  | {
      readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
      readonly onChange: (value: string) => void;
      readonly insertText?: never;
    }
  | {
      readonly insertText: (text: string) => boolean;
      readonly textareaRef?: never;
      readonly onChange?: never;
    };

/** What the mic is doing, in words, for a surface that shows it itself. */
export interface DictationNotice {
  readonly tone: "progress" | "error";
  readonly text: string;
}

export const useDictation = ({
  enabled = false,
  locked = false,
  noticeOutside = false,
  onChange,
  onSend,
  session,
  textareaRef,
  insertText,
}: {
  readonly enabled?: boolean;
  readonly locked?: boolean;
  /**
   * The surface shows `notice` itself, so the controls draw no floating
   * status: in a toolbar that scrolls, a bubble above the mic is cut off.
   */
  readonly noticeOutside?: boolean;
  readonly session?: DictationRecoverySession;
  readonly onSend: (value: string) => void;
} & DictationTarget) => {
  const send = React.useRef(onSend);
  const lockedRef = React.useRef(false);
  const thread = React.useContext(ThreadPresentationContext);
  const { uiSounds } = useTheme();
  const [fallbackRecovery] = React.useState(
    () => new DictationRecoverySession(),
  );
  const recovery = session ?? thread?.dictation ?? fallbackRecovery;
  const recoverySnapshot = React.useSyncExternalStore(
    recovery.subscribe,
    recovery.getSnapshot,
    recovery.getServerSnapshot,
  );
  const [capture] = React.useState(() => new DictationCapture());
  const snapshot = React.useSyncExternalStore(
    capture.subscribe,
    capture.getSnapshot,
    capture.getServerSnapshot,
  );
  const mutation = useMutation(dictationMutationOptions());
  const [processingIntent, setProcessingIntent] =
    React.useState<DictationIntent>();
  const generation = React.useRef(0);
  const abort = React.useRef<AbortController | undefined>(undefined);
  const jobId = React.useRef<string | undefined>(undefined);
  const finishing = React.useRef(false);
  const recording = React.useRef<LiveRecording | undefined>(undefined);
  const insert = (text: string, intent: DictationIntent) => {
    if (lockedRef.current) return false;
    if (insertText !== undefined) return insertText(text);
    if (textareaRef === undefined || onChange === undefined) return false;
    const textarea = textareaRef.current;
    if (textarea === null) return false;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
    onChange(next);
    const caret = start + text.length;
    requestAnimationFrame(() => {
      if (!textarea.isConnected) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
    if (intent === "send") send.current(next);
    return true;
  };

  const transcribe = (
    audio: Blob,
    intent: DictationIntent,
    ownGeneration: number,
    live?: LiveDictation,
  ) => {
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const mode = live === undefined ? "upload" : "live";
    const controller = new AbortController();
    abort.current = controller;
    jobId.current = id;
    setProcessingIntent(intent);
    mutation.mutate(
      { audio, id, live, signal: controller.signal },
      {
        onSuccess: (text) => {
          recovery.remember({
            audio,
            transcript: text,
            outcome: "completed",
            mode,
            jobId: id,
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          if (
            generation.current === ownGeneration &&
            text.trim() &&
            insert(text, intent)
          ) {
            recovery.release(audio);
            mutation.reset();
          }
        },
        onError: (cause) => {
          recovery.remember({
            audio,
            outcome: "failed",
            error:
              cause instanceof Error
                ? cause.message
                : "Dictation could not be completed.",
            mode,
            jobId: id,
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          if (generation.current === ownGeneration)
            recovery.fail(
              audio,
              cause instanceof Error
                ? cause.message
                : "Dictation could not be completed.",
            );
          void cancelDictationJob(id);
        },
        onSettled: () => {
          if (generation.current === ownGeneration) {
            finishing.current = false;
            setProcessingIntent(undefined);
          }
          if (jobId.current === id) jobId.current = undefined;
        },
      },
    );
  };

  const finish = async (intent: DictationIntent) => {
    if (capture.getSnapshot().state !== "recording" || finishing.current)
      return;
    finishing.current = true;
    if (uiSounds) playUiSound("stop");
    setProcessingIntent(intent);
    const ownGeneration = generation.current;
    const audio = await capture.finish();
    const live = recording.current?.take();
    if (audio.size > 44) recovery.retain(audio, intent);
    if (ownGeneration !== generation.current || audio.size <= 44) {
      live?.close();
      finishing.current = false;
      if (audio.size > 44)
        recovery.fail(audio, "Dictation was saved after leaving the composer.");
      if (ownGeneration === generation.current) setProcessingIntent(undefined);
      return;
    }
    transcribe(audio, intent, ownGeneration, live);
  };

  const record = () => {
    if (uiSounds) playUiSound("start");
    recording.current?.take()?.close();
    const live = liveRecording();
    recording.current = live;
    void capture.start(() => void finish("insert"), live.push);
  };

  const preserveOnExit = (deferPublication = false) => {
    generation.current += 1;
    abort.current?.abort();
    if (jobId.current) void cancelDictationJob(jobId.current);
    jobId.current = undefined;
    const retained = recovery.getSnapshot();
    if (retained.state === "retained") {
      const fail = () =>
        recovery.fail(
          retained.audio,
          "Dictation was saved after leaving the composer.",
        );
      if (deferPublication) queueMicrotask(fail);
      else fail();
    }
    if (capture.getSnapshot().state === "recording" && !finishing.current) {
      finishing.current = true;
      void capture.finish().then((audio) => {
        recording.current?.take()?.close();
        if (audio.size > 44)
          recovery.retain(
            audio,
            "insert",
            "Dictation was saved after leaving the composer.",
          );
      });
      return;
    }
    if (!finishing.current) {
      recording.current?.take()?.close();
      void capture.cancel();
    }
  };

  const sendRef = (node: HTMLButtonElement | null) => {
    if (node === null) return;
    send.current = onSend;
    if (locked && !lockedRef.current) {
      preserveOnExit();
      mutation.reset();
      finishing.current = false;
      setProcessingIntent(undefined);
    }
    lockedRef.current = locked;
  };

  const lifetimeRef = (node: HTMLSpanElement | null) => {
    if (node === null) return;
    return () => preserveOnExit(true);
  };
  const start = () => {
    if (!enabled || locked) return;
    if (
      processingIntent !== undefined ||
      finishing.current ||
      snapshot.state === "permission"
    )
      return;
    if (snapshot.state === "recording") {
      void finish("insert");
      return;
    }
    if (recoverySnapshot.state === "retained") {
      const ownGeneration = ++generation.current;
      mutation.reset();
      transcribe(
        recoverySnapshot.audio,
        recoverySnapshot.intent,
        ownGeneration,
      );
      return;
    }
    generation.current += 1;
    mutation.reset();
    record();
  };
  const recordNew = () => {
    if (
      !enabled ||
      locked ||
      processingIntent !== undefined ||
      finishing.current ||
      capture.getSnapshot().state === "permission" ||
      capture.getSnapshot().state === "recording"
    )
      return;
    if (recoverySnapshot.state !== "retained") return;
    recovery.release(recoverySnapshot.audio);
    generation.current += 1;
    mutation.reset();
    record();
  };

  const interceptSubmit = () => {
    if (!enabled) return false;
    if (snapshot.state === "recording") {
      void finish("send");
      return true;
    }
    return (
      snapshot.state === "permission" ||
      processingIntent !== undefined ||
      finishing.current
    );
  };

  const active =
    snapshot.state === "recording" ||
    snapshot.state === "permission" ||
    processingIntent !== undefined;
  const status =
    snapshot.state === "permission"
      ? "Waiting for microphone permission…"
      : processingIntent !== undefined
        ? "Transcribing dictation…"
        : snapshot.state === "recording"
          ? "Recording dictation"
          : snapshot.state === "error"
            ? snapshot.error
            : recoverySnapshot.state === "retained" && recoverySnapshot.error
              ? recoverySnapshot.error
              : mutation.error instanceof Error
                ? mutation.error.message
                : undefined;
  const recoverable =
    recoverySnapshot.state === "retained" &&
    processingIntent === undefined &&
    snapshot.state !== "permission" &&
    snapshot.state !== "recording";

  const controls = enabled ? (
    <span
      className={`dictation-controls ${snapshot.state === "recording" && processingIntent === undefined ? "is-recording" : processingIntent !== undefined ? "is-processing" : recoverable ? "is-recoverable" : ""}`}
      ref={lifetimeRef}
    >
      {snapshot.state === "recording" && processingIntent === undefined ? (
        <Waveform
          className="dictation-waveform"
          data={snapshot.waveform}
          barColor="currentColor"
        />
      ) : null}
      <Button
        ref={sendRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        className="dictation-action"
        aria-label={
          processingIntent !== undefined
            ? "Transcribing dictation"
            : snapshot.state === "recording"
              ? "Stop dictation"
              : recoverable
                ? "Retry dictation"
                : "Start dictation"
        }
        title={
          processingIntent !== undefined
            ? "Transcribing dictation"
            : snapshot.state === "recording"
              ? "Stop dictation"
              : recoverable
                ? "Retry saved dictation"
                : "Dictate"
        }
        disabled={
          processingIntent !== undefined ||
          snapshot.state === "permission" ||
          (locked && snapshot.state !== "recording")
        }
        onMouseDown={(event) => event.preventDefault()}
        onClick={start}
      >
        {processingIntent !== undefined ? (
          <span className="processing-dot dictation-processing-dot" />
        ) : snapshot.state === "recording" ? (
          <Square />
        ) : (
          <Mic />
        )}
      </Button>
      {recoverable ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Discard saved dictation and record again"
            title="Discard saved dictation and record again"
            onMouseDown={(event) => event.preventDefault()}
            onClick={recordNew}
          >
            <RotateCcw />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="dictation-download"
            aria-label="Download saved dictation"
            title="Download saved dictation"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => downloadDictation(recoverySnapshot.audio)}
          >
            <Download />
          </Button>
        </>
      ) : null}
      {status && !noticeOutside ? (
        <span
          className={
            snapshot.state === "error" || mutation.isError || recoverable
              ? "dictation-status dictation-error"
              : "visually-hidden"
          }
          role={
            snapshot.state === "error" || mutation.isError || recoverable
              ? "alert"
              : "status"
          }
        >
          {status}
        </span>
      ) : null}
      {snapshot.state === "recording" &&
      processingIntent === undefined &&
      textareaRef !== undefined ? (
        <DictationCaret textareaRef={textareaRef} />
      ) : null}
    </span>
  ) : undefined;

  const failed = snapshot.state === "error" || mutation.isError || recoverable;
  const notice: DictationNotice | undefined =
    !enabled || status === undefined
      ? undefined
      : failed
        ? {
            tone: "error",
            text: recoverable ? `${status} Retry, or record again.` : status,
          }
        : {
            tone: "progress",
            text:
              snapshot.state === "recording" && processingIntent === undefined
                ? "Listening… Stop when you're done."
                : processingIntent !== undefined
                  ? "Transcribing…"
                  : status,
          };

  return {
    active,
    controls,
    notice,
    hideSubmit: processingIntent === "send",
    interceptSubmit,
  };
};

// The composer's mic for the Thread page's other surfaces, in this module so
// it ships with the hook (the composer's chunk), not with the Thread page.

const sendNothing = () => undefined;

/** The mic's words, where the surface asked for them, or after the mic. */
function Notice({
  notice,
  host,
}: {
  readonly notice: DictationNotice | undefined;
  readonly host: HTMLElement | null | undefined;
}) {
  if (notice === undefined) return null;
  const line = (
    <p
      className="dictation-notice"
      data-tone={notice.tone}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      {notice.text}
    </p>
  );
  return host ? createPortal(line, host) : line;
}

/**
 * The composer's mic for the Thread page's other surfaces. Each keeps its
 * own recovery session, so a dictation saved there never shows up in the
 * composer.
 */
export function InsertDictation({
  insertText,
  noticeHost,
}: {
  readonly insertText: (text: string) => boolean;
  readonly noticeHost?: HTMLElement | null;
}) {
  const [session] = React.useState(() => new DictationRecoverySession());
  const dictation = useDictation({
    enabled: true,
    noticeOutside: true,
    insertText,
    onSend: sendNothing,
    session,
  });
  return (
    <span className="dictation-slot">
      {dictation.controls}
      <Notice notice={dictation.notice} host={noticeHost} />
    </span>
  );
}

export function TextareaDictation({
  textareaRef,
  onChange,
  noticeHost,
}: {
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly onChange: (value: string) => void;
  readonly noticeHost?: HTMLElement | null;
}) {
  const [session] = React.useState(() => new DictationRecoverySession());
  const dictation = useDictation({
    enabled: true,
    noticeOutside: true,
    textareaRef,
    onChange,
    onSend: sendNothing,
    session,
  });
  return (
    <span className="dictation-slot">
      {dictation.controls}
      <Notice notice={dictation.notice} host={noticeHost} />
    </span>
  );
}

/** The composer's mic for the Thread page's other surfaces. */
const dictationSlot: DictationSlot = {
  Insert: InsertDictation,
  Textarea: TextareaDictation,
};

/**
 * Dictation for surfaces such as artifacts, by the composer's rule: the
 * deployment serves a speech provider and the person's dictation switch is
 * on. The components wrap the composer's hook, which the page loads anyway.
 */
export const useDictationSlot = () => {
  const { identity } = useAuthenticatedIdentity();
  const settings = useQuery(settingsContextQueryOptions(identity.id));
  return settings.data?.dictationAvailable === true ? dictationSlot : undefined;
};
