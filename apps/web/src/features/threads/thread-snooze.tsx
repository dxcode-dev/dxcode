import { Dialog } from "@base-ui/react/dialog";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlarmClock } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  ThreadSnoozeContext,
  type ThreadSnoozeController,
} from "../../shared/thread-snooze.js";
import {
  type CustomSnooze,
  customSnoozeWakeAt,
  snoozeWakeText,
} from "../../shared/thread-snooze-presets.js";
import { Button } from "../../shared/ui/button.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../shared/ui/modal-surface.js";
import { setThreadSnoozedMutationOptions } from "./thread-mutations.js";

/** One toast at a time: each notice replaces the one before it. */
const SNOOZE_TOAST_ID = "thread-snooze";
/** How long a notice stays before it goes away. */
const SNOOZE_TOAST_DURATION = 6_000;

/**
 * A failed snooze or wake. Every call names each option, because a toast
 * updated in place keeps any option the new one leaves out.
 */
const failed = (cause: unknown, fallback: string) =>
  toast.error(
    cause instanceof Error && cause.message ? cause.message : fallback,
    {
      id: SNOOZE_TOAST_ID,
      duration: SNOOZE_TOAST_DURATION,
      icon: undefined,
      action: undefined,
    },
  );

export function ThreadSnoozeProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const { isPending, mutate, variables } = useMutation(
    setThreadSnoozedMutationOptions(queryClient, identity.id),
  );
  const [customThreadId, setCustomThreadId] = React.useState<ThreadId>();

  const controller: ThreadSnoozeController = {
    pendingThreadId: isPending ? variables.threadId : undefined,
    snooze: (threadId, wakeAt) => {
      if (isPending) return;
      mutate(
        { threadId, snoozedUntil: wakeAt },
        {
          onSuccess: () =>
            toast(
              `Snoozed until ${snoozeWakeText(wakeAt.getTime(), Date.now())}`,
              {
                id: SNOOZE_TOAST_ID,
                duration: SNOOZE_TOAST_DURATION,
                icon: <AlarmClock />,
                action: {
                  label: "Undo",
                  onClick: () => controller.wake(threadId),
                },
              },
            ),
          onError: (cause) => failed(cause, "Thread could not be snoozed."),
        },
      );
    },
    snoozeCustom: setCustomThreadId,
    wake: (threadId) => {
      if (isPending) return;
      toast.dismiss(SNOOZE_TOAST_ID);
      mutate(
        { threadId, snoozedUntil: null },
        { onError: (cause) => failed(cause, "Thread could not be woken.") },
      );
    },
  };

  return (
    <ThreadSnoozeContext.Provider value={controller}>
      {children}
      {customThreadId === undefined ? null : (
        <CustomSnoozeDialog
          key={customThreadId}
          onClose={() => setCustomThreadId(undefined)}
          onSnooze={(wakeAt) => {
            controller.snooze(customThreadId, wakeAt);
            setCustomThreadId(undefined);
          }}
        />
      )}
    </ThreadSnoozeContext.Provider>
  );
}

/** Two digits, for a `datetime-local` value in local time. */
const pad = (value: number) => String(value).padStart(2, "0");

const localInputValue = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

function CustomSnoozeDialog({
  onClose,
  onSnooze,
}: {
  readonly onClose: () => void;
  readonly onSnooze: (wakeAt: Date) => void;
}) {
  const [mode, setMode] = React.useState<CustomSnooze["mode"]>("duration");
  const [value, setValue] = React.useState("");
  const [amount, setAmount] = React.useState("30");
  const [unit, setUnit] = React.useState<"minutes" | "hours" | "days">(
    "minutes",
  );
  const [error, setError] = React.useState<string>();
  const choice: CustomSnooze =
    mode === "date" ? { mode, value } : { mode, amount, unit };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // A duration starts when the person confirms it.
    const wakeAt = customSnoozeWakeAt(choice, Date.now());
    if (wakeAt === undefined) {
      setError("Choose a time in the future.");
      return;
    }
    onSnooze(wakeAt);
  };
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <ModalSurface className="custom-snooze-dialog" ariaLabel="Snooze until">
        <ModalSurfaceHeader>
          <strong>Snooze until</strong>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        <form onSubmit={submit}>
          <div className="custom-snooze-modes">
            {(["duration", "date"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                onClick={() => {
                  setMode(option);
                  setError(undefined);
                  // Date and time starts on this time tomorrow.
                  if (option === "date" && value === "")
                    setValue(
                      localInputValue(
                        new Date(Date.now() + 24 * 60 * 60 * 1_000),
                      ),
                    );
                }}
              >
                {option === "duration" ? "Duration" : "Date and time"}
              </button>
            ))}
          </div>
          {mode === "date" ? (
            <input
              type="datetime-local"
              aria-label="Wake date and time"
              value={value}
              onChange={(event) => {
                setValue(event.currentTarget.value);
                setError(undefined);
              }}
            />
          ) : (
            <div className="custom-snooze-duration">
              <input
                type="number"
                min={1}
                inputMode="numeric"
                aria-label="Snooze for"
                value={amount}
                onChange={(event) => {
                  setAmount(event.currentTarget.value);
                  setError(undefined);
                }}
              />
              <select
                aria-label="Unit"
                value={unit}
                onChange={(event) =>
                  setUnit(
                    event.currentTarget.value as "minutes" | "hours" | "days",
                  )
                }
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </div>
          )}
          {error === undefined ? null : (
            <div className="notice error-notice" role="alert">
              {error}
            </div>
          )}
          <footer>
            <Button type="submit" size="xs">
              Snooze
            </Button>
          </footer>
        </form>
      </ModalSurface>
    </Dialog.Root>
  );
}
