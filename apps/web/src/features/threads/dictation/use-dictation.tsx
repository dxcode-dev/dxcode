import { useMutation } from "@tanstack/react-query";
import { Download, Mic, RotateCcw, Square } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { Button } from "../../../shared/ui/button.js";
import { Waveform } from "../../../shared/ui/waveform.js";
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

const CaretMarker = ({
  textarea,
}: {
  readonly textarea: HTMLTextAreaElement;
}) => {
  const form = textarea.closest("form");
  const markerRef = React.useRef<HTMLSpanElement>(null);
  useMountEffect(() => {
    const marker = markerRef.current;
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

export const useDictation = ({
  enabled = false,
  locked = false,
  onChange,
  onSend,
  session,
  textareaRef,
}: {
  readonly enabled?: boolean;
  readonly locked?: boolean;
  readonly onChange: (value: string) => void;
  readonly session?: DictationRecoverySession;
  readonly onSend: (value: string) => void;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) => {
  const send = React.useRef(onSend);
  const lockedRef = React.useRef(false);
  const thread = React.useContext(ThreadPresentationContext);
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
  const insert = (text: string, intent: DictationIntent) => {
    if (lockedRef.current) return false;
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
  ) => {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    abort.current = controller;
    jobId.current = id;
    setProcessingIntent(intent);
    mutation.mutate(
      { audio, id, signal: controller.signal },
      {
        onSuccess: (text) => {
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
    setProcessingIntent(intent);
    const ownGeneration = generation.current;
    const audio = await capture.finish();
    if (audio.size > 44) recovery.retain(audio, intent);
    if (ownGeneration !== generation.current || audio.size <= 44) {
      finishing.current = false;
      if (audio.size > 44)
        recovery.fail(audio, "Dictation was saved after leaving the composer.");
      if (ownGeneration === generation.current) setProcessingIntent(undefined);
      return;
    }
    transcribe(audio, intent, ownGeneration);
  };

  const preserveOnExit = React.useCallback(
    (deferPublication = false) => {
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
          if (audio.size > 44)
            recovery.retain(
              audio,
              "insert",
              "Dictation was saved after leaving the composer.",
            );
        });
        return;
      }
      if (!finishing.current) void capture.cancel();
    },
    [capture, recovery],
  );

  const sendRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      if (node === null) return;
      send.current = onSend;
      if (locked && !lockedRef.current) {
        preserveOnExit();
        mutation.reset();
        finishing.current = false;
        setProcessingIntent(undefined);
      }
      lockedRef.current = locked;
    },
    [locked, mutation, onSend, preserveOnExit],
  );

  const lifetimeRef = React.useCallback(
    (node: HTMLSpanElement | null) => {
      if (node === null) return;
      return () => preserveOnExit(true);
    },
    [preserveOnExit],
  );
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
    void capture.start(() => void finish("insert"));
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
    void capture.start(() => void finish("insert"));
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
      {status ? (
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
      {snapshot.state === "recording" && processingIntent === undefined ? (
        textareaRef.current ? (
          <CaretMarker textarea={textareaRef.current} />
        ) : null
      ) : null}
    </span>
  ) : undefined;

  return {
    active,
    controls,
    hideSubmit: processingIntent === "send",
    interceptSubmit,
  };
};
